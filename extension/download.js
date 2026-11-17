// Nedladdningssida för HLS-strömmar: hämtar segmenten i ordning och skriver dem direkt
// till en fil på disken (lite minne även för flera GB). Ingen dekryptering.
import {
  parsePlaylist, pickAudioOnly, variantLabel, formatBytes, formatDuration,
  describeEncryption, sanitizeFilename, isAudioOnlyCodecs,
} from './hls.js';
import { TsAudioExtractor, probeTsAudio } from './tsaudio.js';

const PARALLEL = 4;
const RETRIES = 3;
const FETCH_TIMEOUT = 120000; // ms per segment och försök
const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const $ = id => document.getElementById(id);

window.__result = { status: 'starting' };

// ---------- Skrivmål (abstraherat så att det går att testa utan filväljare) ----------
async function pickerWriter(suggestedName, ext) {
  const types = {
    ts: { description: 'MPEG-TS-video', accept: { 'video/mp2t': ['.ts'] } },
    mp4: { description: 'MP4-video', accept: { 'video/mp4': ['.mp4'] } },
    m4a: { description: 'M4A-ljud', accept: { 'audio/mp4': ['.m4a'] } },
    aac: { description: 'AAC-ljud', accept: { 'audio/aac': ['.aac'] } },
    mp3: { description: 'MP3-ljud', accept: { 'audio/mpeg': ['.mp3'] } },
  };
  const handle = await window.showSaveFilePicker({ suggestedName, types: types[ext] ? [types[ext]] : undefined });
  const w = await handle.createWritable();
  return { name: handle.name, write: d => w.write(d), close: () => w.close(), abort: () => w.abort() };
}

async function opfsWriter(name) {
  // Testläge: OPFS i headless Chromium klarar inte alltid icke-ASCII-namn, så förenkla namnet.
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '_');
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  return { name, write: d => w.write(d), close: () => w.close(), abort: () => w.abort() };
}

export function memoryWriter(name) {
  const chunks = [];
  return { name, chunks, write: async d => { chunks.push(d); }, close: async () => {}, abort: async () => {} };
}

// ---------- Nätverk ----------
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Avbrutet', 'AbortError')); }, { once: true });
});

async function fetchText(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`Kunde inte hämta spellistan (HTTP ${r.status}).`);
  return { text: await r.text(), url: r.url || url };
}

async function fetchBytes(uri, byterange, signal) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1), signal);
    try {
      const headers = {};
      if (byterange) headers.Range = `bytes=${byterange.offset}-${byterange.offset + byterange.length - 1}`;
      // Tidsgräns per försök: en anslutning som hänger sig ska ge ett nytt försök, inte stå still för evigt.
      const attemptSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]) : AbortSignal.timeout(FETCH_TIMEOUT);
      const r = await fetch(uri, { credentials: 'include', headers, signal: attemptSignal });
      if (r.status === 401 || r.status === 403) {
        const e = new Error(`Servern nekade åtkomst (HTTP ${r.status}). Inloggningen kan ha gått ut – ladda om föreläsningssidan och försök igen.`);
        e.fatal = attempt >= 1; // ett nytt försök, sedan ge upp
        throw e;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let buf = new Uint8Array(await r.arrayBuffer());
      if (byterange && r.status === 200 && buf.length > byterange.length) {
        buf = buf.slice(byterange.offset, byterange.offset + byterange.length);
      }
      return buf;
    } catch (e) {
      // Bara användarens Avbryt stoppar; tidsgränsen kan ge AbortError eller TimeoutError och ska ge nytt försök.
      if (signal?.aborted) throw new DOMException('Avbrutet', 'AbortError');
      if (e.fatal) throw e;
      lastErr = (e.name === 'TimeoutError' || e.name === 'AbortError') ? new Error('servern svarade inte i tid') : e;
    }
  }
  throw new Error(`Ett segment gick inte att hämta efter ${RETRIES + 1} försök (${lastErr?.message || lastErr}).`);
}

// ---------- Välj spellista ----------
async function resolveJob(job) {
  const first = await fetchText(job.url);
  let pl = parsePlaylist(first.text, first.url);
  let label = 'Enda tillgängliga kvalitet';
  let audioOnly = false, audioKind = null;
  if (pl.type === 'master') {
    if (pl.encrypted) return { encrypted: pl.encrypted };
    let uri;
    if (job.choice === 'audio') {
      const a = pickAudioOnly(pl);
      if (!a) throw new Error('Hittade ingen ljudström.');
      uri = a.uri; audioOnly = true; audioKind = a.kind;
      label = a.kind === 'lowest-variant' ? `Bara ljud (från lägsta kvaliteten, ${a.label})` : 'Bara ljud';
    } else {
      const sorted = [...pl.variants].sort((a, b) => b.bandwidth - a.bandwidth);
      const v = findVariant(sorted, job) || sorted[0];
      uri = v.uri; label = variantLabel(v);
      if (isAudioOnlyCodecs(v.codecs)) audioOnly = true;
      if (v.audio && pl.media.some(m => m.type === 'AUDIO' && m.groupId === v.audio && m.uri)) {
        label += ' – obs: ljudet ligger i en separat ström, välj ”Bara ljud” för att få ljudet';
      }
    }
    const sub = await fetchText(uri);
    pl = parsePlaylist(sub.text, sub.url);
    if (pl.type !== 'media') throw new Error('Oväntad spellista (nästlad huvudspellista).');
  }
  else if (job.choice === 'audio') {
    // En enda spellista: ljudet plockas ur TS-segmenten om det går.
    audioOnly = true; audioKind = 'same-stream'; label = 'Bara ljud';
  }
  if (pl.encrypted) return { encrypted: pl.encrypted };
  if (!pl.segments.length) throw new Error('Spellistan innehåller inga segment.');
  return { playlist: pl, label, audioOnly, audioKind };
}

// Hitta den valda kvaliteten igen. Adressen räcker inte alltid: delspellistornas adresser kan
// innehålla engångsnycklar (t.ex. hos Kaltura/CDN) som är nya när spellistan hämtas på nytt.
export function findVariant(sorted, job) {
  if (!job.choice || job.choice === 'best' || job.choice === 'audio') return null;
  const byUri = sorted.find(x => x.uri === job.choice);
  if (byUri) return byUri;
  const w = job.variant;
  if (!w) return null;
  return sorted.find(x => x.bandwidth === w.bandwidth && x.height === w.height && x.width === w.width)
    || sorted.find(x => x.bandwidth === w.bandwidth)
    || (w.height ? sorted.find(x => x.height === w.height) : null)
    || null;
}

function sniff(bytes) {
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return 'ts';
  const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (['ftyp', 'styp', 'moof', 'sidx', 'moov'].includes(box)) return 'fmp4';
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'packed'; // ID3 + rå AAC/MP3
  if (bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0) return 'packed';
  return 'unknown';
}

// ---------- Huvudflöde ----------
let controller = null;
let running = false;

async function main() {
  let job;
  if (params.get('job')) {
    const key = 'job:' + params.get('job');
    job = (await chrome.storage.session.get(key))[key];
  } else if (params.get('url')) {
    job = { url: params.get('url'), choice: params.get('choice') || 'best', name: params.get('name') || 'forelasning' };
  }
  if (!job) return fail('Hittade ingen nedladdning att göra. Öppna tillägget på föreläsningssidan igen.');
  const name = sanitizeFilename(job.name);
  $('fileTitle').textContent = name;
  document.title = `${name} – Hämtar`;

  let r;
  try {
    r = await resolveJob(job);
  } catch (e) {
    return fail(e.message || String(e));
  }
  if (r.encrypted) return fail(describeEncryption(r.encrypted) + ' Tillägget kan bara spara video som inte är krypterad.', 'encrypted');

  const pl = r.playlist;
  // Titta på första segmentet för att se formatet (och ljudkodek för TS).
  const controllerProbe = new AbortController();
  let firstBytes;
  try {
    firstBytes = await fetchBytes(pl.segments[0].uri, pl.segments[0].byterange, controllerProbe.signal);
  } catch (e) {
    return fail(e.message || String(e));
  }
  let format = sniff(firstBytes);
  if (format === 'unknown') format = pl.format;
  if (pl.segments[0].map) format = 'fmp4';

  let ext, mode = 'copy';
  if (format === 'fmp4') {
    ext = r.audioOnly && (r.audioKind === 'audio-rendition' || r.audioKind === 'audio-variant') ? 'm4a' : 'mp4';
    if (r.audioOnly && ext === 'mp4') r.label = 'Ljud och bild (ljudet går inte att separera i den här strömmen)';
  }
  else if (format === 'packed') ext = /\.mp3(\?|$)/i.test(pl.segments[0].uri) ? 'mp3' : 'aac';
  else {
    ext = 'ts';
    if (r.audioOnly) {
      const codec = probeTsAudio(firstBytes);
      if (codec) { ext = codec; mode = 'ts-audio'; }
    }
  }

  const avgSeg = firstBytes.length * (mode === 'ts-audio' ? 0.15 : 1);
  const facts = [
    ['Kvalitet', r.label],
    ['Längd', formatDuration(pl.duration) || 'okänd'],
    ['Segment', String(pl.segments.length)],
    ['Format', {
      ts: 'MPEG-TS (.ts) – video och ljud',
      mp4: 'MP4 (.mp4)', m4a: 'M4A-ljud (.m4a)',
      aac: 'AAC-ljud (.aac) – bara ljudspåret', mp3: 'MP3-ljud (.mp3)',
    }[ext] || ext],
    ['Uppskattad storlek', 'ca ' + formatBytes(avgSeg * pl.segments.length)],
  ];
  if (!pl.endList) facts.push(['Obs', 'Direktsändning – sparar det som finns hittills.']);
  $('facts').replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
  if (ext === 'ts') {
    showMessage('Strömmen sparas som .ts (MPEG-TS), som spelas i t.ex. VLC. För transkribering räcker ”Bara ljud”, som ger en mycket mindre ljudfil.');
  }

  const fileName = `${name}.${ext}`;
  const ctx = { pl, firstBytes, mode, ext, fileName };

  if (TEST) {
    const writer = params.get('writer') === 'memory' ? memoryWriter(fileName) : await opfsWriter(fileName);
    return run(ctx, writer);
  }
  const btn = $('start');
  btn.hidden = false;
  btn.onclick = async () => {
    let writer;
    try {
      writer = await pickerWriter(fileName, ext);
    } catch (e) {
      if (e.name === 'AbortError') return; // användaren avbröt filväljaren
      return fail('Kunde inte öppna filen för skrivning: ' + (e.message || e));
    }
    btn.hidden = true;
    run(ctx, writer);
  };
}

async function keepAlive(promise) {
  try {
    const t = await chrome.tabs.getCurrent();
    if (t) chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
  } catch {}
  // Ett Web Lock hindrar att fliken fryses medan nedladdningen pågår.
  if (navigator.locks) navigator.locks.request('transkribera-hamtning-' + Math.random(), () => promise.catch(() => {}));
}

async function run({ pl, firstBytes, mode, ext, fileName }, writer) {
  running = true;
  controller = new AbortController();
  const { signal } = controller;
  $('progressCard').hidden = false;
  $('cancel').hidden = false;
  $('cancel').onclick = () => controller.abort();
  hideMessage();

  const segs = pl.segments;
  const N = segs.length;
  const extractor = mode === 'ts-audio' ? new TsAudioExtractor() : null;
  const inflight = new Map();
  const mapCache = new Map();
  let written = 0, downloaded = 0, done = 0, lastMapKey = null;
  const samples = [{ t: performance.now(), b: 0 }];
  const t0 = performance.now();

  const startFetch = i => {
    if (i >= N || inflight.has(i)) return;
    const p = i === 0 ? Promise.resolve(firstBytes) : fetchBytes(segs[i].uri, segs[i].byterange, signal);
    p.catch(() => {}); // fel hanteras när vi väntar på segmentet
    inflight.set(i, p);
  };

  const work = (async () => {
    for (let i = 0; i < Math.min(PARALLEL, N); i++) startFetch(i);
    for (let i = 0; i < N; i++) {
      if (signal.aborted) throw new DOMException('Avbrutet', 'AbortError');
      const s = segs[i];
      if (s.map && !extractor) {
        const key = s.map.uri + '|' + (s.map.byterange ? s.map.byterange.offset : '');
        if (key !== lastMapKey) {
          let init = mapCache.get(key);
          if (!init) { init = await fetchBytes(s.map.uri, s.map.byterange, signal); mapCache.set(key, init); }
          await writer.write(init);
          written += init.length; downloaded += init.length;
          lastMapKey = key;
        }
      }
      const data = await inflight.get(i);
      inflight.delete(i);
      startFetch(i + PARALLEL);
      downloaded += data.length;
      const out = extractor ? extractor.push(data) : data;
      if (out.length) { await writer.write(out); written += out.length; }
      done = i + 1;
      updateProgress();
    }
  })();

  function updateProgress() {
    const now = performance.now();
    samples.push({ t: now, b: downloaded });
    while (samples.length > 2 && now - samples[0].t > 8000) samples.shift();
    const dt = (now - samples[0].t) / 1000;
    const speed = dt > 0.2 ? (downloaded - samples[0].b) / dt : 0;
    $('bar').style.width = `${(done / N * 100).toFixed(1)}%`;
    $('segs').textContent = `${done} / ${N}`;
    $('mb').textContent = formatBytes(downloaded).replace('okänd storlek', '0 MB');
    $('speed').textContent = speed ? `${formatBytes(speed)}/s` : '–';
    const remainingBytes = (downloaded / done) * (N - done);
    $('eta').textContent = speed && done < N ? (formatDuration(remainingBytes / speed) || 'under 1 s') : '–';
    document.title = `${Math.round(done / N * 100)} % – ${fileName}`;
    window.__result = { status: 'running', done, total: N, downloaded, written };
  }

  keepAlive(work);
  try {
    await work;
    await writer.close();
    running = false;
    $('cancel').hidden = true;
    $('progressCard').hidden = true;
    $('doneCard').hidden = false;
    const secs = (performance.now() - t0) / 1000;
    $('doneText').textContent =
      `Klart! ”${writer.name}” är sparad (${formatBytes(written)}, ${N} segment på ${secs < 1 ? 'under 1 s' : formatDuration(secs)}). ` +
      (ext === 'ts'
        ? 'Filen är i .ts-format. Transkribera kan läsa .ts-filer upp till 400 MB – för längre föreläsningar, välj ”Bara ljud” (mycket mindre fil).'
        : 'Öppna Transkribera och välj filen för att transkribera föreläsningen.');
    document.title = `Klart – ${fileName}`;
    window.__result = { status: 'done', file: writer.name, written, downloaded, segments: N, ext, mode };
  } catch (e) {
    running = false;
    controller.abort(); // stoppa segment som fortfarande hämtas i förväg
    try { await writer.abort(); } catch {}
    $('cancel').hidden = true;
    if (e.name === 'AbortError') {
      fail('Nedladdningen avbröts. Ingen fil sparades.', 'cancelled');
    } else {
      fail((e.message || String(e)) + ' Den halvfärdiga filen sparades inte.');
    }
  }
}

function showMessage(text, kind = '') {
  const m = $('message');
  m.className = 'notice' + (kind ? ' ' + kind : '');
  m.textContent = text;
  m.hidden = false;
}
function hideMessage() { $('message').hidden = true; }

function fail(text, status = 'error') {
  showMessage(text, 'error');
  $('start').hidden = true;
  if ($('fileTitle').textContent === 'Förbereder…') $('fileTitle').textContent = 'Kan inte hämta';
  document.title = 'Kan inte hämta – Transkribera';
  window.__result = { status, message: text };
}

window.addEventListener('beforeunload', e => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

main().catch(e => fail(e.message || String(e)));
