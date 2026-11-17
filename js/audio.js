// Ljudkällor: läser ljud ur stora filer utan att någonsin läsa in hela filen.
// Alla källor exponerar samma gränssnitt:
//   await src.open()            -> laddar metadata / bygger index
//   src.duration                -> längd i sekunder
//   src.codec                   -> t.ex. 'mp4a.40.2'
//   await src.read(start, end)  -> Float32Array, mono, 16 kHz, för [start, end)
//   src.close()
//
// Format som läses i bitar (fungerar för filer på många GB):
//   - vanlig MP4/M4A/MOV                  (Mp4AudioSource)
//   - fragmenterad MP4 (HLS-fMP4, DASH)   (Mp4AudioSource, index byggs från moof-boxarna)
//   - MPEG-TS (.ts/.mts/.m2ts, HLS)       (TsAudioSource, AAC i ADTS eller MP3)
// Övriga format avkodas i ett svep med decodeAudioData (bara små filer).

import { createFile, MP4BoxBuffer } from 'https://cdn.jsdelivr.net/npm/mp4box@2.5.0/dist/mp4box.all.mjs';

export const TARGET_RATE = 16000;
const SMALL_FILE_LIMIT = 400 * 1024 * 1024; // decodeAudioData läser in hela filen – bara för små filer
const READ_BATCH = 1024 * 1024;               // ca 1 MB per file.slice
const MAX_GAP = 64 * 1024;                    // slå ihop sampel som ligger nära varandra i filen
const BOX_WINDOW = 32 * 1024;                 // läsfönster när MP4-boxar gås igenom
const TS_CHUNK = 8 * 1024 * 1024;             // läsbitar för MPEG-TS

export class UserFacingError extends Error {}

const MP4_EXT = /\.(mp4|m4a|m4v|mov|3gp|3g2|m4b|m4s|cmfv|cmfa)$/i;
const MP4_BRANDS = /^(ftyp|styp)$/;

// options.onProgress(andel 0–1) anropas medan stora filer indexeras.
export async function openAudioSource(file, options = {}) {
  const ts = (await startsWithFtyp(file)) ? null : await detectTs(file);
  if (ts) {
    const src = new TsAudioSource(file, ts, options);
    await src.open();
    return src;
  }
  if (await looksLikeMp4(file)) {
    const src = new Mp4AudioSource(file, options);
    await src.open();
    return src;
  }
  if (file.size > SMALL_FILE_LIMIT) {
    throw new UserFacingError(
      `Filen är ${formatBytes(file.size)} och i ett format som inte kan läsas i bitar. ` +
      'Konvertera den till MP4 (t.ex. med HandBrake eller VLC → "Konvertera/Spara") eller ' +
      'extrahera ljudet till M4A, så fungerar även mycket stora filer.');
  }
  const src = new DecodedAudioSource(file);
  await src.open();
  return src;
}

async function startsWithFtyp(file) {
  if (file.size < 12) return false;
  const h = new Uint8Array(await file.slice(4, 8).arrayBuffer());
  return MP4_BRANDS.test(String.fromCharCode(...h));
}

async function looksLikeMp4(file) {
  if (file.size < 12) return false;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (MP4_BRANDS.test(type)) return true;
  // vissa MOV-filer börjar med wide/mdat/moov/free, fragment kan börja med moof/sidx
  if (MP4_EXT.test(file.name) && /^(moov|mdat|wide|free|skip|moof|sidx)$/.test(type)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Gemensamt: avkoda en följd av kodade ljudramar till mono 16 kHz för [start, end).
// feed(push) anropar `await push(bytes, tidSek, längdSek)` för varje ram i tidsordning.
// Anroparen ska börja ett par ramar före `start` så att AAC-avkodarens överlapp blir
// rätt – överskottet kastas här.

async function decodeRange(src, start, end, feed) {
  const rate = src.sampleRate;
  let mono = new Float32Array(Math.ceil((end - start + 1) * rate) + 8192);
  let written = 0;
  let decodeError = null;
  let monoStart = null; // tid (s) för första avkodade frame
  let outRate = rate;

  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        const n = data.numberOfFrames;
        const ch = data.numberOfChannels;
        if (data.sampleRate && data.sampleRate !== outRate && written === 0) outRate = data.sampleRate;
        if (monoStart === null) monoStart = data.timestamp / 1e6;
        // Placera enligt tidsstämpel så att eventuella luckor blir tystnad
        const pos = Math.max(written, Math.round((data.timestamp / 1e6 - monoStart) * outRate));
        if (pos + n > mono.length) {
          const bigger = new Float32Array(Math.max(mono.length * 1.5, pos + n + outRate) | 0);
          bigger.set(mono.subarray(0, written));
          mono = bigger;
        }
        const tmp = new Float32Array(n);
        // copyTo med format 'f32-planar' konverterar även interfolierade format
        for (let c = 0; c < ch; c++) {
          data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
          for (let k = 0; k < n; k++) mono[pos + k] += tmp[k] / ch;
        }
        written = pos + n;
      } catch (e) {
        decodeError = e;
      } finally {
        data.close();
      }
    },
    error: (e) => { decodeError = e; },
  });
  decoder.configure(src.config);

  const push = async (data, t, dur) => {
    if (decodeError) throw decodeError;
    decoder.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: Math.round(t * 1e6),
      duration: Math.round(dur * 1e6),
      data,
    }));
    if (decoder.decodeQueueSize > 256) await waitForDequeue(decoder, 64);
  };

  try {
    await feed(push);
    if (decodeError) throw decodeError;
    await decoder.flush();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (decodeError) throw decodeError;
  if (monoStart === null) return new Float32Array(Math.round((end - start) * TARGET_RATE));

  // Klipp ut exakt [start, end)
  const from = Math.max(0, Math.round((start - monoStart) * outRate));
  const to = Math.min(written, Math.round((end - monoStart) * outRate));
  const cut = mono.subarray(from, Math.max(from, to));
  return resampleTo16k(cut, outRate);
}

function waitForDequeue(decoder, target) {
  return new Promise(resolve => {
    const check = () => {
      if (decoder.decodeQueueSize <= target || decoder.state !== 'configured') {
        decoder.removeEventListener('dequeue', check);
        resolve();
      }
    };
    decoder.addEventListener('dequeue', check);
    check();
  });
}

async function checkDecoderConfig(config) {
  if (typeof AudioDecoder === 'undefined') {
    throw new UserFacingError('Din webbläsare saknar WebCodecs. Använd en aktuell version av Chrome eller Edge.');
  }
  let support;
  try { support = await AudioDecoder.isConfigSupported(config); } catch { support = null; }
  if (!support?.supported) {
    throw new UserFacingError(`Ljudformatet (${config.codec || 'okänt'}) kan inte avkodas av webbläsaren. Konvertera filen till MP4 med AAC-ljud.`);
  }
}

// första index i den sorterade arrayen med a[i] >= x
function lowerBound(a, n, x) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Växande typad array (för index med hundratusentals poster).
class Grow {
  constructor(Type, cap = 4096) { this.Type = Type; this.a = new Type(cap); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() { return this.a.subarray(0, this.n); }
}

function concatBytes(parts, total) {
  if (parts.length === 1) return parts[0];
  if (total === undefined) total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// MP4. Steg 1: hitta toppnivåboxar genom att bara läsa huvudena.

// Läser små bitar ur filen via ett fönster, så att många små boxar i rad bara kostar en läsning.
class WindowReader {
  constructor(file, win = BOX_WINDOW) { this.file = file; this.size = file.size; this.win = win; this.start = 0; this.buf = new Uint8Array(0); }
  async bytes(off, len) {
    if (off >= this.start && off + len <= this.start + this.buf.length) {
      return this.buf.subarray(off - this.start, off - this.start + len);
    }
    const end = Math.min(this.size, off + Math.max(len, this.win));
    this.buf = new Uint8Array(await this.file.slice(off, end).arrayBuffer());
    this.start = off;
    return this.buf.subarray(0, Math.min(len, this.buf.length));
  }
}

async function walkTopLevelBoxes(reader, cb) {
  let off = 0;
  const size = reader.size;
  while (off + 8 <= size) {
    const h = await reader.bytes(off, Math.min(16, size - off));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let boxSize = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    let header = 8;
    if (boxSize === 1) {
      if (h.length < 16) break;
      boxSize = Number(dv.getBigUint64(8));
      header = 16;
    } else if (boxSize === 0) {
      boxSize = size - off; // boxen sträcker sig till filens slut
    }
    if (boxSize < header || !/^[\x20-\x7e]{4}$/.test(type)) break; // trasig/okänd data
    await cb({ type, offset: off, size: Math.min(boxSize, size - off), header });
    off += boxSize;
  }
}

export async function scanTopLevelBoxes(file) {
  const boxes = [];
  await walkTopLevelBoxes(new WindowReader(file), b => { boxes.push(b); });
  return boxes;
}

// Itererar över barnboxar i buf[start, end): cb(typ, innehållsStart, boxSlut)
function forEachChild(dv, start, end, cb) {
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(off + 8)); hdr = 16; } else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) break;
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
    cb(type, off + hdr, off + size);
    off += size;
  }
}

class Mp4AudioSource {
  constructor(file, options = {}) {
    this.file = file;
    this.kind = 'mp4';
    this.onProgress = options.onProgress;
  }

  async open() {
    const file = this.file;
    const reader = new WindowReader(file);
    let ftyp = null, moov = null;
    const moofOff = new Grow(Float64Array, 256), moofSize = new Grow(Float64Array, 256);
    let lastReport = 0;
    await walkTopLevelBoxes(reader, b => {
      if (b.type === 'ftyp' && !ftyp) ftyp = b;
      else if (b.type === 'moov' && !moov) moov = b;
      else if (b.type === 'moof') { moofOff.push(b.offset); moofSize.push(b.size); }
      if (this.onProgress && b.offset - lastReport > 64 * 1024 * 1024) {
        lastReport = b.offset;
        this.onProgress(0.5 * b.offset / file.size);
      }
    });
    if (!moov) {
      throw new UserFacingError('Hittade ingen "moov"-box i filen. Filen kan vara trasig eller ofullständigt nedladdad.');
    }
    if (moov.size > 512 * 1024 * 1024) {
      throw new UserFacingError('Filens metadata är orimligt stor – filen verkar vara trasig.');
    }
    const parts = [ftyp, moov].filter(Boolean);
    const joined = new Uint8Array(parts.reduce((n, b) => n + b.size, 0));
    let pos = 0;
    for (const b of parts) {
      joined.set(new Uint8Array(await file.slice(b.offset, b.offset + b.size).arrayBuffer()), pos);
      pos += b.size;
    }

    // Steg 2: mp4box får ftyp+moov som om de låg först i filen
    const mp4 = createFile();
    let info = null, err = null;
    mp4.onReady = i => { info = i; };
    mp4.onError = e => { err = e; };
    mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(joined.buffer, 0));
    mp4.flush();
    if (err) throw new UserFacingError('Kunde inte läsa MP4-filens struktur: ' + err);
    if (!info) throw new UserFacingError('Kunde inte läsa MP4-filens struktur.');

    const track = info.audioTracks?.[0];
    if (!track) throw new UserFacingError('Filen innehåller inget ljudspår.');
    const trak = mp4.getTrackById(track.id);
    const timescale = trak?.mdia?.mdhd?.timescale || track.timescale;
    const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];

    // Steg 3: samplelista med absoluta filoffset, i typade arrayer
    const offsets = new Grow(Float64Array), sizes = new Grow(Uint32Array);
    const ticks = new Grow(Float64Array), durs = new Grow(Float64Array);
    for (const s of trak?.samples || []) {
      offsets.push(s.offset); sizes.push(s.size); ticks.push(s.cts); durs.push(s.duration || 1024);
    }

    // Fragmenterad MP4: sampel finns i moof/mdat-par efter moov
    if (moofOff.n) {
      this.kind = 'fmp4';
      const trex = mp4.moov?.mvex?.trexs?.find(t => t.track_id === track.id) || {};
      const state = { nextDts: ticks.n ? ticks.a[ticks.n - 1] + durs.a[durs.n - 1] : 0 };
      const mo = moofOff.done(), ms = moofSize.done();
      for (let i = 0; i < mo.length; i++) {
        if (ms[i] > 64 * 1024 * 1024) throw new UserFacingError('En "moof"-box i filen är orimligt stor – filen verkar vara trasig.');
        const buf = await reader.bytes(mo[i], ms[i]);
        parseMoof(buf, mo[i], track.id, trex, state, { offsets, sizes, ticks, durs });
        if (this.onProgress && (i & 255) === 0) this.onProgress(0.5 + 0.5 * i / mo.length);
      }
    }
    if (!offsets.n) throw new UserFacingError('Ljudspåret innehåller inga ljuddata.');

    let codec = track.codec || '';
    let description;
    const dsi = entry?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    if (dsi) description = new Uint8Array(dsi);
    if (/^mp4a\.40$/.test(codec)) codec = 'mp4a.40.2';
    if (codec === 'mp4a') codec = 'mp4a.40.2';

    const sampleRate = track.audio?.sample_rate || entry?.samplerate || 48000;
    const channels = track.audio?.channel_count || entry?.channel_count || 2;
    const config = { codec, sampleRate, numberOfChannels: channels };
    if (description) config.description = description;
    await checkDecoderConfig(config);

    this.config = config;
    this.sampleRate = sampleRate;
    this.codec = codec;
    this.timescale = timescale;
    this.offsets = offsets.done();
    this.sizes = sizes.done();
    this.sampleCount = this.offsets.length;
    // Tid räknas från första samplets cts (ignorerar edit lists, skillnaden är några ms)
    const tk = ticks.done(), du = durs.done();
    const t0 = tk[0];
    this.times = new Float64Array(tk.length);
    this.durs = new Float32Array(du.length);
    for (let i = 0; i < tk.length; i++) { this.times[i] = (tk[i] - t0) / timescale; this.durs[i] = du[i] / timescale; }
    const last = tk.length - 1;
    this.duration = this.times[last] + this.durs[last];
    if (this.onProgress) this.onProgress(1);
  }

  indexAt(sec) { return lowerBound(this.times, this.sampleCount, sec); } // första sample med tid >= sec

  // Steg 4: läs ljudsamplen med file.slice, avkoda med WebCodecs, mixa till mono, resampla.
  async read(start, end) {
    end = Math.min(end, this.duration);
    if (end <= start) return new Float32Array(0);
    const n = this.sampleCount;
    // Starta två sampel tidigare så att AAC-avkodarens överlapp blir rätt, och kasta sedan överskottet
    const i0 = Math.max(0, this.indexAt(start) - 2);
    let i1 = this.indexAt(end);
    if (i1 < n) i1 += 1;
    i1 = Math.min(i1, n);
    const { offsets, sizes, times, durs } = this;

    return decodeRange(this, start, end, async (push) => {
      let i = i0;
      while (i < i1) {
        // gruppera sampel som ligger nära varandra i filen, upp till ~1 MB per läsning
        const bStart = offsets[i];
        let bEnd = bStart + sizes[i];
        let j = i + 1;
        while (j < i1) {
          const o = offsets[j];
          if (o < bEnd || o - bEnd > MAX_GAP) break;
          if (o + sizes[j] - bStart > READ_BATCH) break;
          bEnd = o + sizes[j];
          j++;
        }
        const buf = new Uint8Array(await this.file.slice(bStart, bEnd).arrayBuffer());
        if (buf.byteLength < bEnd - bStart) {
          throw new UserFacingError('Filen tog slut tidigare än väntat – den kan vara ofullständigt nedladdad.');
        }
        for (let k = i; k < j; k++) {
          const rel = offsets[k] - bStart;
          await push(buf.subarray(rel, rel + sizes[k]), times[k], durs[k]);
        }
        i = j;
      }
    });
  }

  close() { this.offsets = this.sizes = this.times = this.durs = null; }
}

// Läser en moof-box och lägger till ljudspårets sampel (absolut filoffset, storlek, cts, längd).
function parseMoof(buf, moofOffset, trackId, trex, state, out) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let prevTrafEnd = moofOffset; // standard: data börjar där föregående trafs data slutade
  let firstTraf = true;
  forEachChild(dv, 8, buf.length, (type, s, e) => {
    if (type !== 'traf') return;
    let tid = -1, flags = 0, base = 0, defDur = trex.default_sample_duration || 0, defSize = trex.default_sample_size || 0;
    let tfdt = null;
    let dataPtr = null, dataEnd = null;
    forEachChild(dv, s, e, (t, bs) => {
      if (t === 'tfhd') {
        flags = dv.getUint32(bs) & 0xffffff;
        tid = dv.getUint32(bs + 4);
        let p = bs + 8;
        if (flags & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; } else if (flags & 0x20000) base = moofOffset; else base = firstTraf ? moofOffset : prevTrafEnd;
        if (flags & 0x2) p += 4;
        if (flags & 0x8) { defDur = dv.getUint32(p); p += 4; }
        if (flags & 0x10) { defSize = dv.getUint32(p); p += 4; }
      } else if (t === 'tfdt') {
        const v = dv.getUint8(bs);
        tfdt = v === 1 ? Number(dv.getBigUint64(bs + 4)) : dv.getUint32(bs + 4);
      } else if (t === 'trun') {
        const vf = dv.getUint32(bs);
        const version = vf >>> 24, tf = vf & 0xffffff;
        const count = dv.getUint32(bs + 4);
        let p = bs + 8;
        if (tf & 0x1) { dataPtr = base + dv.getInt32(p); p += 4; } else if (dataPtr === null) dataPtr = base;
        if (tf & 0x4) p += 4;
        const mine = tid === trackId;
        if (mine && tfdt !== null) { state.nextDts = tfdt; tfdt = null; }
        for (let k = 0; k < count; k++) {
          let dur = defDur, size = defSize, cto = 0;
          if (tf & 0x100) { dur = dv.getUint32(p); p += 4; }
          if (tf & 0x200) { size = dv.getUint32(p); p += 4; }
          if (tf & 0x400) p += 4;
          if (tf & 0x800) { cto = version ? dv.getInt32(p) : dv.getUint32(p); p += 4; }
          if (mine) {
            out.offsets.push(dataPtr); out.sizes.push(size);
            out.ticks.push(state.nextDts + cto); out.durs.push(dur || 1024);
            state.nextDts += dur;
          }
          dataPtr += size;
        }
        dataEnd = dataPtr;
      }
    });
    if (tid === trackId && tfdt !== null) state.nextDts = tfdt; // tfdt utan trun
    if (dataEnd !== null) prevTrafEnd = dataEnd;
    firstTraf = false;
  });
}

// ---------------------------------------------------------------------------
// MPEG-TS (t.ex. från HLS-nedladdare). Index: för varje PES-paket i ljudströmmen sparas
// filoffset för dess första TS-paket och dess tid (PTS). read() läser om TS-intervallet som
// täcker den begärda tiden och demuxar det på nytt.

async function detectTs(file) {
  const n = Math.min(file.size, 4096);
  if (n < 188 * 3) return null;
  const b = new Uint8Array(await file.slice(0, n).arrayBuffer());
  for (const [ps, so] of [[188, 0], [192, 4]]) {
    for (let o = 0; o < ps && o + so + 3 * ps < n; o++) {
      if (b[o + so] === 0x47 && b[o + so + ps] === 0x47 && b[o + so + 2 * ps] === 0x47 && b[o + so + 3 * ps] === 0x47) {
        return { ps, so, start: o };
      }
    }
  }
  return null;
}

function tsResync(buf, from, ps, so) {
  for (let j = from; j + so < buf.length; j++) {
    if (buf[j + so] === 0x47 && (j + so + ps >= buf.length || buf[j + so + ps] === 0x47)) return j;
  }
  return -1;
}

// Går igenom TS-paket i [from, to) i bitar om ~8 MB. cb(buf, syncIndex, paketetsFiloffset, pid)
// anropas bara för paket vars PID är markerad i mask – övriga paket kostar bara en PID-läsning.
// onChunk(filposition) anropas (och inväntas) efter varje bit.
async function forEachTsPacket(file, layout, from, to, mask, cb, onChunk) {
  const { ps, so } = layout;
  to = Math.min(to, file.size);
  const chunk = Math.floor(TS_CHUNK / ps) * ps;
  let pos = from;
  while (pos + ps <= to) {
    const buf = new Uint8Array(await file.slice(pos, Math.min(to, pos + chunk)).arrayBuffer());
    const lim = buf.length - ps;
    let i = 0;
    while (i <= lim) {
      const p = i + so;
      if (buf[p] !== 0x47) {
        const r = tsResync(buf, i + 1, ps, so);
        if (r < 0 || r > lim) { i = Math.max(i + 1, lim + 1); break; }
        i = r;
        continue;
      }
      const b1 = buf[p + 1];
      const pid = ((b1 & 0x1f) << 8) | buf[p + 2];
      if (mask[pid] && !(b1 & 0x80)) cb(buf, p, pos + i, pid);
      i += ps;
    }
    if (i === 0) break;
    pos += i;
    if (onChunk) await onChunk(pos);
  }
}

// Index för nyttolasten i ett TS-paket, eller -1
function tsPayload(buf, p) {
  const afc = (buf[p + 3] >> 4) & 3;
  if (!(afc & 1)) return -1;
  let o = p + 4;
  if (afc & 2) o += 1 + buf[p + 4];
  return o < p + 188 ? o : -1;
}

function readPts(b, o) {
  return ((b[o] >> 1) & 7) * 1073741824 + ((b[o + 1] << 22) | ((b[o + 2] >> 1) << 15) | (b[o + 3] << 7) | (b[o + 4] >> 1));
}

// Ljudramsdelare. parse(data, pos) -> { len, hdr, dur, ... } | null (behöver fler byte) | false (ingen synk)
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseAdts(d, pos) {
  if (pos + 7 > d.length) return null;
  if (d[pos] !== 0xff || (d[pos + 1] & 0xf6) !== 0xf0) return false;
  const hdr = (d[pos + 1] & 1) ? 7 : 9;
  const len = ((d[pos + 3] & 3) << 11) | (d[pos + 4] << 3) | (d[pos + 5] >> 5);
  const sfi = (d[pos + 2] >> 2) & 0xf;
  if (len <= hdr || sfi >= AAC_RATES.length) return false;
  if (pos + len > d.length) return null;
  const rate = AAC_RATES[sfi];
  return {
    len, hdr, rate, sfi,
    profile: d[pos + 2] >> 6,
    chan: ((d[pos + 2] & 1) << 2) | (d[pos + 3] >> 6),
    dur: 1024 * ((d[pos + 6] & 3) + 1) / rate,
  };
}

const MP3_BITRATES = {
  '3-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseMpegAudio(d, pos) {
  if (pos + 4 > d.length) return null;
  if (d[pos] !== 0xff || (d[pos + 1] & 0xe0) !== 0xe0) return false;
  const ver = (d[pos + 1] >> 3) & 3, layer = (d[pos + 1] >> 1) & 3;
  const bri = d[pos + 2] >> 4, sri = (d[pos + 2] >> 2) & 3, pad = (d[pos + 2] >> 1) & 1;
  if (ver === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) return false;
  const v1 = ver === 3;
  const br = MP3_BITRATES[(v1 ? 3 : 2) + '-' + (v1 ? layer : (layer === 3 ? 3 : 2))][bri] * 1000;
  const rate = MP3_RATES[ver][sri];
  let len, samples;
  if (layer === 3) { len = (Math.floor(12 * br / rate) + pad) * 4; samples = 384; }
  else if (layer === 2) { len = Math.floor(144 * br / rate) + pad; samples = 1152; }
  else { len = Math.floor((v1 ? 144 : 72) * br / rate) + pad; samples = v1 ? 1152 : 576; }
  if (len < 4) return false;
  if (pos + len > d.length) return null;
  return { len, hdr: 0, rate, chan: (d[pos + 3] >> 6) === 3 ? 1 : 2, dur: samples / rate };
}

// Delar upp PES-nyttolaster i ramar. En ram kan sträcka sig över två PES-paket.
// PTS gäller första ramen som *börjar* i PES-paketet; ramar utan egen PTS får föregående + längd.
class FrameSplitter {
  constructor(parse) { this.parse = parse; this.carry = null; this.nextTime = null; }
  push(payload, time, emit) {
    let data = payload, at = 0;
    if (this.carry) { data = concatBytes([this.carry, payload]); at = this.carry.length; this.carry = null; }
    let pending = time !== null ? at : -1;
    let pos = 0;
    while (pos < data.length) {
      const f = this.parse(data, pos);
      if (f === null) { this.carry = data.slice(pos); break; }
      if (f === false) { pos++; continue; } // tappad synk – leta vidare
      if (pending >= 0 && pos >= pending) { this.nextTime = time; pending = -1; }
      if (this.nextTime !== null) {
        emit(data.subarray(pos + f.hdr, pos + f.len), this.nextTime, f);
        this.nextTime += f.dur;
      }
      pos += f.len;
    }
    if (pending >= 0) this.nextTime = time;
  }
}

const TS_AUDIO_TYPES = { 0x0f: 'aac', 0x03: 'mp3', 0x04: 'mp3' };
const TS_UNSUPPORTED_AUDIO = { 0x11: 'AAC-LATM', 0x81: 'AC-3', 0x87: 'E-AC-3', 0x1c: 'AAC (rå)', 0x80: 'LPCM' };

class TsAudioSource {
  constructor(file, layout, options = {}) {
    this.file = file;
    this.layout = layout;
    this.kind = 'ts';
    this.onProgress = options.onProgress;
  }

  async open() {
    const file = this.file, layout = this.layout;
    const mask = new Uint8Array(8192);
    mask[0] = 1;
    let pmtPid = -1, audioPid = -1, streamType = 0, unsupported = null;
    const offsets = new Grow(Float64Array), times = new Grow(Float64Array);
    let prevRaw = -1, prevT = 0, lastDelta = 0;

    const t0 = performance.now();
    await forEachTsPacket(file, layout, layout.start, file.size, mask, (buf, p, off, pid) => {
      if (!(buf[p + 1] & 0x40)) return; // bara paket som startar en PES/sektion är intressanta
      const pl = tsPayload(buf, p);
      if (pl < 0) return;
      const end = p + 188;
      if (pid === audioPid) {
        // PES-huvud: 00 00 01 id len(2) flaggor(2) huvudlängd PTS(5)
        if (pl + 14 > end || buf[pl] !== 0 || buf[pl + 1] !== 0 || buf[pl + 2] !== 1) return;
        if (!(buf[pl + 7] & 0x80)) return;
        const raw = readPts(buf, pl + 9);
        let t;
        if (prevRaw < 0) t = 0;
        else {
          let d = raw - prevRaw;
          if (d < -4294967296) d += 8589934592; else if (d > 4294967296) d -= 8589934592; // 33-bitars omslag
          if (d < 0 || d > 90000 * 10) d = lastDelta; // diskontinuitet (t.ex. hopklistrade strömmar)
          else lastDelta = d;
          t = prevT + d / 90000;
        }
        prevRaw = raw; prevT = t;
        offsets.push(off); times.push(t);
        return;
      }
      if (audioPid >= 0) return;
      const ptr = pl + 1 + buf[pl];
      if (ptr + 12 > end) return;
      const secEnd = Math.min(end, ptr + 3 + (((buf[ptr + 1] & 0x0f) << 8) | buf[ptr + 2])) - 4;
      if (pid === 0 && buf[ptr] === 0x00 && pmtPid < 0) {
        for (let q = ptr + 8; q + 4 <= secEnd; q += 4) {
          const prog = (buf[q] << 8) | buf[q + 1];
          if (prog !== 0) { pmtPid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3]; mask[pmtPid] = 1; break; }
        }
      } else if (pid === pmtPid && buf[ptr] === 0x02) {
        let q = ptr + 12 + (((buf[ptr + 10] & 0x0f) << 8) | buf[ptr + 11]);
        while (q + 5 <= secEnd) {
          const st = buf[q], epid = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2];
          if (TS_AUDIO_TYPES[st]) { audioPid = epid; streamType = st; mask[audioPid] = 1; break; }
          if (TS_UNSUPPORTED_AUDIO[st] && !unsupported) unsupported = TS_UNSUPPORTED_AUDIO[st];
          q += 5 + (((buf[q + 3] & 0x0f) << 8) | buf[q + 4]);
        }
      }
    }, (pos) => { if (this.onProgress) this.onProgress(pos / file.size); });
    this.indexMs = performance.now() - t0;

    if (audioPid < 0) {
      if (unsupported) {
        throw new UserFacingError(`Ljudet i filen är i formatet ${unsupported}, som inte stöds. Konvertera filen till MP4 med AAC-ljud (t.ex. med HandBrake eller VLC) och försök igen.`);
      }
      throw new UserFacingError(pmtPid < 0
        ? 'Kunde inte läsa MPEG-TS-filens struktur (hittade ingen programtabell). Filen kan vara trasig.'
        : 'Hittade inget ljudspår i MPEG-TS-filen.');
    }
    if (!offsets.n) throw new UserFacingError('Ljudströmmen i filen innehåller inga ljuddata.');

    this.audioPid = audioPid;
    this.streamType = streamType;
    this.parse = streamType === 0x0f ? parseAdts : parseMpegAudio;
    this.offsets = offsets.done();
    this.times = times.done();
    this.pesCount = this.offsets.length;
    const n = this.pesCount;

    // Första ramen ger avkodarens inställningar
    let first = null;
    await this.demux(0, n > 8 ? this.offsets[8] : file.size, (data, t, f) => { if (!first) first = f; });
    if (!first) throw new UserFacingError('Kunde inte hitta några ljudramar i MPEG-TS-filen. Filen kan vara trasig.');
    let config;
    if (streamType === 0x0f) {
      const ot = first.profile + 1; // ADTS-profil 0–3 => AAC-objekttyp 1–4
      const chan = first.chan || 2;
      const asc = new Uint8Array([(ot << 3) | (first.sfi >> 1), ((first.sfi & 1) << 7) | (chan << 3)]);
      config = { codec: 'mp4a.40.' + ot, sampleRate: first.rate, numberOfChannels: chan === 7 ? 8 : chan, description: asc };
    } else {
      config = { codec: 'mp3', sampleRate: first.rate, numberOfChannels: first.chan };
    }
    await checkDecoderConfig(config);
    this.config = config;
    this.codec = config.codec;
    this.sampleRate = first.rate;
    this.frameDur = first.dur;

    // Längd: sista PES-paketets sista ram
    let lastEnd = this.times[n - 1];
    await this.demux(n - 1, file.size, (data, t, f) => { lastEnd = Math.max(lastEnd, t + f.dur); });
    this.duration = lastEnd;
    if (this.onProgress) this.onProgress(1);
  }

  // Demuxar ljudströmmen från PES-paket nr p0 fram till filoffset byteEnd.
  // onFrame(bytes, tid, ram) anropas synkront; onChunk inväntas efter varje läst bit.
  async demux(p0, byteEnd, onFrame, onChunk) {
    const { offsets, times, pesCount: n } = this;
    const mask = new Uint8Array(8192);
    mask[this.audioPid] = 1;
    const splitter = new FrameSplitter(this.parse);
    let pieces = [], pesOff = -1, k = p0;
    const finish = () => {
      if (pesOff < 0) return;
      const b = concatBytes(pieces);
      pieces = [];
      const off = pesOff;
      pesOff = -1;
      if (b.length < 9 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1) return;
      const plen = (b[4] << 8) | b[5];
      const end = plen ? Math.min(b.length, 6 + plen) : b.length;
      const payload = b.subarray(Math.min(end, 9 + b[8]), end);
      while (k < n && offsets[k] < off) k++;
      const time = k < n && offsets[k] === off ? times[k] : null;
      splitter.push(payload, time, onFrame);
    };
    await forEachTsPacket(this.file, this.layout, offsets[p0], byteEnd, mask, (buf, p, off) => {
      const pl = tsPayload(buf, p);
      if (buf[p + 1] & 0x40) { finish(); pesOff = off; }
      if (pl < 0 || pesOff < 0) return;
      pieces.push(buf.subarray(pl, p + 188));
    }, onChunk);
    finish();
  }

  async read(start, end) {
    end = Math.min(end, this.duration);
    if (end <= start) return new Float32Array(0);
    const fd = this.frameDur, n = this.pesCount;
    // PES-paketet som innehåller tiden start - 3 ramar, till och med det som når end + 3 ramar
    const p0 = Math.max(0, lowerBound(this.times, n, start - 3 * fd + 1e-9) - 1);
    const p1 = lowerBound(this.times, n, end + 3 * fd);
    const byteEnd = p1 < n ? this.offsets[p1] : this.file.size;
    const from = start - 2.5 * fd, to = end + fd;

    return decodeRange(this, start, end, async (push) => {
      let queue = [];
      const onFrame = (data, t, f) => { if (t >= from && t < to) queue.push([data, t, f.dur]); };
      const drain = async () => {
        const q = queue;
        queue = [];
        for (const [data, t, dur] of q) await push(data, t, dur);
      };
      await this.demux(p0, byteEnd, onFrame, drain);
      await drain();
    });
  }

  close() { this.offsets = this.times = null; }
}

// ---------------------------------------------------------------------------
// Små filer i andra format (mp3, wav, webm, ogg ...): decodeAudioData.
class DecodedAudioSource {
  constructor(file) { this.file = file; this.kind = 'decoded'; this.codec = 'decodeAudioData'; }
  async open() {
    const ab = await this.file.arrayBuffer();
    const ctx = new AudioContext({ sampleRate: TARGET_RATE });
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(ab);
    } catch {
      throw new UserFacingError('Webbläsaren kunde inte avkoda filen. Konvertera den till MP4 eller M4A och försök igen.');
    } finally {
      ctx.close();
    }
    // mixa till mono (AudioContext med 16 kHz har redan resamplat)
    let pcm;
    if (buffer.sampleRate === TARGET_RATE) {
      pcm = mixToMono(buffer);
    } else {
      pcm = await resampleTo16k(mixToMono(buffer), buffer.sampleRate);
    }
    this.pcm = pcm;
    this.duration = pcm.length / TARGET_RATE;
  }
  async read(start, end) {
    const a = Math.max(0, Math.round(start * TARGET_RATE));
    const b = Math.min(this.pcm.length, Math.round(end * TARGET_RATE));
    return this.pcm.slice(a, Math.max(a, b));
  }
  close() { this.pcm = null; }
}

function mixToMono(buffer) {
  const n = buffer.length, ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

// Steg 4b: resampla till 16 kHz med OfflineAudioContext.
export async function resampleTo16k(pcm, rate) {
  if (!pcm.length) return new Float32Array(0);
  if (rate === TARGET_RATE) return pcm.slice();
  const outLen = Math.max(1, Math.round(pcm.length * TARGET_RATE / rate));
  const ctx = new OfflineAudioContext(1, outLen, TARGET_RATE);
  const buf = ctx.createBuffer(1, pcm.length, rate);
  buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export function formatBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB';
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB';
  return Math.round(n / 1024) + ' kB';
}
