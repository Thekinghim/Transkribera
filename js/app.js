import { openAudioSource, UserFacingError, formatBytes } from './audio.js';
import { db, fileKey, requestPersistence } from './db.js';
import {
  fmtTime, fmtDuration, cleanSegments, isCue, keywords, chapters, paragraphs, makeCards,
  PROMPTS, transcriptForAI, toTXT, toSRT, toMarkdown, toWordHTML, escapeHtml, escapeRe, newId,
} from './study.js';
import { hasKey, setKey, testKey, streamAnswer, generateCards, gradeAnswer, renderMarkdown, estimateCostSEK, parseTimestamp } from './ai.js';

const BLOCK_SECONDS = 300;       // avkoda och transkribera ca 5 min åt gången
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- tillstånd
const state = {
  lecture: null,      // aktuell post från IndexedDB
  file: null,         // kopplad fil (för video och fortsättning)
  videoUrl: null,
  running: false,
  stopRequested: false,
  filter: 'all',
  mode: 'segments',
  search: '',
  searchHits: [],     // index i segments
  searchPos: -1,
  keyword: null,
  currentIdx: -1,
  chapters: [],
  keywords: [],
  derivedDirty: true,
  lastUserScroll: 0,
  editing: null,
};

// ---------------------------------------------------------------- worker
let worker = null;
let workerReady = null;
let workerModel = null;
let workerDevice = null;
let reqId = 0;
const pending = new Map();
const downloads = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'download') {
      downloads.set(m.file, { loaded: m.loaded, total: m.total });
      let l = 0, t = 0;
      for (const d of downloads.values()) { l += d.loaded; t += d.total; }
      if (!state.running || $('progressTitle').textContent !== 'Transkriberar…') setStatus(`Laddar modellen: ${Math.round(100 * l / t)} % av ${formatBytes(t)} (laddas ner första gången, sedan sparad i webbläsaren)`);
    } else if (m.type === 'status') {
      setStatus(m.text);
    } else if (m.type === 'ready') {
      workerDevice = m.device;
      const p = pending.get('load'); pending.delete('load'); p?.resolve();
    } else if (m.type === 'result') {
      const p = pending.get(m.id); pending.delete(m.id); p?.resolve(m.segments);
    } else if (m.type === 'error') {
      const key = m.id ?? 'load';
      const p = pending.get(key); pending.delete(key); p?.reject(new Error(m.message));
    }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Workern kraschade'));
    pending.clear();
    worker = null; workerReady = null; workerModel = null;
  };
  return worker;
}

function loadModel(model) {
  if (workerReady && workerModel === model) return workerReady;
  const w = getWorker();
  workerModel = model;
  downloads.clear();
  workerReady = new Promise((resolve, reject) => {
    pending.set('load', { resolve, reject });
    w.postMessage({ type: 'load', model });
  }).catch(e => { workerReady = null; workerModel = null; throw e; });
  return workerReady;
}

function transcribeBlock(audio) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}

// ---------------------------------------------------------------- hjälpare
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function setStatus(text) { $('progressStatus').textContent = text || ''; }
function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function safeName(s) { return (s || 'transkript').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120); }
function selectedModel() { return document.querySelector('input[name=model]:checked')?.value || 'base'; }
function sameFile(file, lec) { return !!file && !!lec && file.name === lec.name && file.size === lec.size; }
function segs() { return state.lecture?.segments || []; }
function withHours() { return (state.lecture?.duration || 0) >= 3600; }

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.lecture) return;
  state.lecture.updatedAt = Date.now();
  try { await db.put(state.lecture); } catch (e) { console.error(e); toast('Kunde inte spara: ' + e.message); }
}

// ---------------------------------------------------------------- systeminfo
async function showSysInfo() {
  const el = $('sysinfo');
  const parts = [];
  let gpu = false;
  try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch {}
  parts.push(gpu
    ? '<span class="ok">✓ Grafikkortet (WebGPU) kan användas</span> – snabb transkribering.'
    : '<span class="warn">WebGPU saknas</span> – det fungerar ändå, men långsammare (processorn används).');
  if (typeof AudioDecoder === 'undefined') parts.push('<span class="warn">WebCodecs saknas – använd Chrome eller Edge.</span>');
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) $('storageInfo').textContent = `Sparat lokalt: ${formatBytes(est.usage || 0)}`;
  } catch {}
  el.innerHTML = parts.join('<br>');
}

// ---------------------------------------------------------------- vyer
function showStart() {
  $('startView').classList.remove('hidden');
  $('workView').classList.add('hidden');
  renderLibrary();
}
function showWork() {
  $('startView').classList.add('hidden');
  $('workView').classList.remove('hidden');
  window.scrollTo(0, 0);
}

async function renderLibrary() {
  const list = $('library');
  let items = [];
  try { items = await db.all(); } catch (e) { list.innerHTML = `<div class="card lib-empty">Kunde inte läsa sparade föreläsningar (${escapeHtml(e.message)}).</div>`; return; }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!items.length) {
    list.innerHTML = '<div class="card lib-empty">Inga föreläsningar än. Släpp en fil ovan för att börja.</div>';
    return;
  }
  list.innerHTML = '';
  // repetition över alla föreläsningar
  let dueTotal = 0, newTotal = 0;
  for (const lec of items) { const d = dueInfo(lec); dueTotal += d.due.length; newTotal += Math.min(5, d.fresh.length); }
  if (dueTotal + newTotal) {
    const r = document.createElement('div');
    r.className = 'card review-banner';
    r.innerHTML = `<div><b>🧠 Repetera idag</b><span class="muted">${dueTotal ? `${dueTotal} kort är redo för repetition` : 'Inga repetitioner idag'}${newTotal ? ` · ${newTotal} nya att lära` : ''}. Några minuter om dagen slår en lång plugg-kväll.</span></div>
      <button class="btn primary">Starta</button>`;
    r.querySelector('button').onclick = openGlobalReview;
    list.appendChild(r);
  }
  for (const lec of items) {
    const pct = lec.duration ? Math.min(100, Math.round(100 * (lec.cursor || 0) / lec.duration)) : 0;
    const stars = (lec.segments || []).filter(s => s.star).length;
    const el = document.createElement('div');
    el.className = 'card lib-item';
    el.innerHTML = `
      <div class="lib-main">
        <div class="lib-name"></div>
        <div class="lib-meta">${lec.duration ? fmtDuration(lec.duration) + ' · ' : ''}${new Date(lec.updatedAt || lec.createdAt).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' })}${stars ? ` · ⭐ ${stars}` : ''} · ${lec.model === 'small' ? 'Noggrann' : 'Snabb'}</div>
      </div>
      ${(() => { const d = dueInfo(lec); return d.due.length ? `<span class="pill due" title="Kort att repetera">🧠 ${d.due.length}</span>` : ''; })()}
      <span class="pill ${lec.done ? 'done' : 'partial'}">${lec.done ? 'Klar' : `Pausad ${pct} %`}</span>
      <button class="btn small">Öppna</button>
      <button class="icon-btn" title="Ta bort">🗑</button>`;
    el.querySelector('.lib-name').textContent = lec.title || lec.name;
    el.querySelector('.lib-main').onclick = () => openLecture(lec);
    el.querySelector('.btn').onclick = () => openLecture(lec);
    el.querySelector('.icon-btn').onclick = async () => {
      if (state.running && state.lecture?.id === lec.id) { toast('Pausa transkriberingen först.'); return; }
      if (!confirm(`Ta bort "${lec.title || lec.name}"? Texten och dina markeringar raderas.`)) return;
      if (state.lecture?.id === lec.id) { clearTimeout(saveTimer); detachFile(); state.lecture = null; }
      await db.delete(lec.id);
      renderLibrary();
    };
    list.appendChild(el);
  }
}

// ---------------------------------------------------------------- filer
async function handleFile(file) {
  if (!file) return;
  if (state.running) { toast('En transkribering pågår redan. Pausa den först.'); return; }
  const id = fileKey(file);
  let lec = await db.get(id).catch(() => null);
  if (!lec) {
    // samma fil men nytt datum (t.ex. nedladdad igen eller kopierad)? Fortsätt på den sparade.
    const all = await db.all().catch(() => []);
    const twin = all.find(x => x.name === file.name && x.size === file.size);
    if (twin && confirm(`Du har redan "${twin.title || twin.name}" sparad. Öppna den (och fortsätt där du var) i stället för att börja om?`)) lec = twin;
  }
  if (!lec) {
    lec = {
      id, name: file.name, size: file.size, lastModified: file.lastModified,
      title: file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '),
      model: selectedModel(), duration: 0, cursor: 0, done: false, segments: [], cards: {},
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await db.put(lec);
  }
  await openLecture(lec, file);
  if (!lec.done) startTranscription();
}

async function openLecture(lec, file = null) {
  if (state.running && state.lecture?.id !== lec.id) { toast('En transkribering pågår. Pausa den först.'); return; }
  if (state.lecture !== lec) {
    if (state.lecture?.id !== lec.id) { detachFile(); $('progressCard').classList.add('hidden'); }
    if (drawerOpen()) closeDrawer();
    state.lecture = lec;
    state.search = ''; $('searchInput').value = '';
    state.keyword = null;
    state.currentIdx = -1;
    state.derivedDirty = true;
  }
  if (file) attachFile(file);
  $('lectureTitle').value = lec.title || lec.name;
  showWork();
  renderAll();
  updateResumeCard();
}

function attachFile(file) {
  if (state.lecture && !sameFile(file, state.lecture)) {
    {
      if (!confirm('Den här filen verkar inte vara samma som föreläsningen transkriberades från. Koppla den ändå för uppspelning?')) return false;
    }
  }
  detachFile();
  state.file = file;
  state.videoUrl = URL.createObjectURL(file);
  const v = $('video');
  v.src = state.videoUrl;
  v.playbackRate = Number($('rate').value);
  $('noVideo').classList.add('hidden');
  $('videoWrap').classList.toggle('audio-only', /^audio\//.test(file.type) || /\.(m4a|mp3|wav|ogg|aac|flac)$/i.test(file.name));
  return true;
}
function detachFile() {
  const v = $('video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = null;
  state.file = null;
  $('noVideo').classList.remove('hidden');
  $('videoWrap').classList.remove('audio-only');
}

function updateResumeCard() {
  const lec = state.lecture;
  const card = $('resumeCard');
  if (!lec || lec.done || state.running) { card.classList.add('hidden'); return; }
  const pct = lec.duration ? Math.round(100 * lec.cursor / lec.duration) : 0;
  $('resumeText').textContent = state.file && sameFile(state.file, lec)
    ? `Transkriberingen är pausad vid ${pct} %.`
    : `Transkriberingen är pausad vid ${pct} %. Välj samma fil (${lec.name}) igen för att fortsätta där du slutade.`;
  const label = card.querySelector('label');
  if (state.file && sameFile(state.file, lec)) {
    label.firstChild.textContent = 'Fortsätt transkribera';
  } else {
    label.firstChild.textContent = 'Välj filen och fortsätt';
  }
  card.classList.remove('hidden');
}

// ---------------------------------------------------------------- transkribering
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      $('wakeInfo').textContent = '☕ Datorn hålls vaken';
      wakeLock.addEventListener('release', () => { wakeLock = null; if (state.running) $('wakeInfo').textContent = '⚠️ Håll fliken öppen och synlig så att datorn inte somnar'; });
    }
  } catch { $('wakeInfo').textContent = ''; }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; $('wakeInfo').textContent = ''; }
document.addEventListener('visibilitychange', () => {
  if (state.running && document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
});

async function startTranscription() {
  const lec = state.lecture;
  if (!lec || state.running) return;
  if (!state.file || !sameFile(state.file, lec)) { updateResumeCard(); return; }
  state.running = true;
  state.stopRequested = false;
  updateResumeCard();
  const card = $('progressCard');
  card.classList.remove('hidden');
  $('pauseBtn').disabled = false;
  $('pauseBtn').textContent = 'Pausa';
  $('progressTitle').textContent = 'Förbereder…';
  setStatus('Läser filen…');
  acquireWakeLock();
  requestPersistence();

  let src = null;
  const t0 = performance.now();
  let processed = 0;      // sekunder ljud transkriberat i den här körningen
  let ticker = null;
  try {
    src = await openAudioSource(state.file);
    lec.duration = src.duration;
    updateProgress(lec.cursor / lec.duration);
    $('progressTitle').textContent = 'Laddar modellen…';
    await loadModel(lec.model || 'base');
    $('progressTitle').textContent = 'Transkriberar…';
    setStatus(workerDevice === 'webgpu' ? 'Använder grafikkortet (WebGPU).' : (lec.model === 'small' ? 'Använder processorn (WASM) – Noggrann blir mycket långsam utan grafikkort. Välj hellre Snabb för nästa föreläsning.' : 'Använder processorn (WASM) – det tar längre tid än med grafikkort.'));

    while (lec.cursor < lec.duration - 0.3 && !state.stopRequested) {
      const start = lec.cursor;
      const end = Math.min(start + BLOCK_SECONDS, lec.duration);
      const isLast = end >= lec.duration - 0.3;
      const audio = await src.read(start, end);
      if (state.stopRequested) break;
      const blockT = performance.now();
      // jämn progress mellan blocken, baserat på hittills uppmätt hastighet
      const speedSoFar = processed > 0 ? processed / ((blockT - t0) / 1000) : null;
      clearInterval(ticker);
      if (speedSoFar) {
        ticker = setInterval(() => {
          const est = Math.min(end - 1, start + speedSoFar * (performance.now() - blockT) / 1000);
          updateProgress(est / lec.duration, speedSoFar, (lec.duration - est) / speedSoFar);
        }, 1000);
      }
      const raw = await transcribeBlock(audio);
      clearInterval(ticker);
      let seg = cleanSegments(raw, start, end);
      let next = end;
      if (!isLast && seg.length > 1) {
        // sista meningen i blocket kan vara avklippt – gör om den i nästa block
        let j = -1;
        for (let k = seg.length - 2; k >= 0; k--) {
          if (seg[k].e <= end - 2) { j = k; break; }
        }
        if (j >= 0 && seg[j].e > start + 60) {
          next = seg[j].e;
          seg = seg.slice(0, j + 1);
        }
      }
      lec.segments.push(...seg);
      processed += next - start;
      lec.cursor = isLast ? lec.duration : next;
      state.derivedDirty = true;
      await saveNow();
      appendSegments(seg);
      const elapsed = (performance.now() - t0) / 1000;
      const speed = processed / elapsed;
      updateProgress(lec.cursor / lec.duration, speed, (lec.duration - lec.cursor) / speed);
    }
    if (lec.cursor >= lec.duration - 0.3) {
      lec.done = true;
      lec.cursor = lec.duration;
      await saveNow();
      $('progressTitle').textContent = 'Klart!';
      updateProgress(1);
      setStatus(`Hela föreläsningen (${fmtDuration(lec.duration)}) är transkriberad.`);
      toast('Transkriberingen är klar 🎉');
      if (hasKey()) setStatus('Klart! Tips: öppna ✨ Plugga med AI och skapa en sammanfattning och förhörskort direkt.');
      notifyDone(lec);
      setTimeout(() => { if (!state.running) $('progressCard').classList.add('hidden'); }, 8000);
    } else {
      $('progressTitle').textContent = 'Pausad';
      setStatus('Allt hittills är sparat. Du kan fortsätta när du vill – även efter att ha stängt fliken.');
    }
  } catch (e) {
    console.error(e);
    $('progressTitle').textContent = 'Något gick fel';
    const msg = e instanceof UserFacingError ? e.message : `Fel: ${e.message || e}`;
    setStatus(msg + (lec.segments.length ? ' Det som hunnit transkriberas är sparat.' : ''));
    toast(msg, 6000);
  } finally {
    clearInterval(ticker);
    try { src?.close(); } catch {}
    state.running = false;
    $('pauseBtn').disabled = true;
    releaseWakeLock();
    document.title = 'Transkribera – föreläsningar till text';
    renderAll();
    updateResumeCard();
    if (lec.done) $('pauseBtn').disabled = true;
  }
}

function updateProgress(frac, speed, etaSec) {
  frac = Math.max(0, Math.min(1, frac || 0));
  $('progressBar').style.width = (frac * 100).toFixed(1) + '%';
  $('progressPct').textContent = Math.floor(frac * 100) + ' %';
  if (speed) {
    $('progressSpeed').textContent = `${speed.toFixed(1).replace('.', ',')}× realtid`;
    $('progressEta').textContent = etaSec > 1 ? `ca ${fmtDuration(etaSec)} kvar` : '';
  } else {
    $('progressSpeed').textContent = frac > 0 && frac < 1 ? 'Mäter hastighet…' : '';
    $('progressEta').textContent = '';
  }
  document.title = state.running && frac < 1 ? `${Math.floor(frac * 100)} % – Transkribera` : 'Transkribera – föreläsningar till text';
}

function notifyDone(lec) {
  if (document.visibilityState === 'visible') return;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Transkriberingen är klar', { body: lec.title || lec.name });
    }
  } catch {}
}

// ---------------------------------------------------------------- härledda data
function ensureDerived() {
  if (!state.derivedDirty) return;
  const s = segs();
  state.chapters = chapters(s);
  state.keywords = keywords(s, 24);
  state.derivedDirty = false;
}

function chapterAt(idx) {
  return state.chapters.find(c => idx >= c.from && idx < c.to) || null;
}

// ---------------------------------------------------------------- rendering
function visibleIndices() {
  const s = segs();
  const idx = [];
  const kwRe = state.keyword ? new RegExp(`(^|[^\\p{L}])(${state.keyword.forms.map(escapeRe).join('|')})(?![\\p{L}])`, 'iu') : null;
  for (let i = 0; i < s.length; i++) {
    if (state.filter === 'star' && !s[i].star) continue;
    if (state.filter === 'cue' && !isCue(s[i].t)) continue;
    if (kwRe && !kwRe.test(s[i].t)) continue;
    idx.push(i);
  }
  return idx;
}

function highlight(text) {
  const terms = [];
  if (state.search.trim()) terms.push(escapeRe(state.search.trim()));
  if (state.keyword) terms.push(...state.keyword.forms.map(f => escapeRe(f)));
  if (!terms.length) return escapeHtml(text);
  const re = new RegExp(`(${terms.join('|')})`, 'giu');
  // dela på råtexten och escapa varje bit för sig – då fungerar även sökningar med & < > " '
  return text.split(re).map((part, k) => k % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)).join('');
}

function renderAll() {
  ensureDerived();
  renderChapters();
  renderKeywords();
  renderTranscript();
  updateCounts();
}

function updateCounts() {
  const s = segs();
  const stars = s.filter(x => x.star).length;
  const cues = s.filter(x => isCue(x.t)).length;
  $('starCount').textContent = stars ? `(${stars})` : '';
  $('cueCount').textContent = cues ? `(${cues})` : '';
  const words = s.reduce((n, x) => n + x.t.split(/\s+/).length, 0);
  $('transcriptFoot').textContent = s.length
    ? `${s.length} avsnitt · ${words.toLocaleString('sv-SE')} ord${state.lecture?.done ? '' : ' · transkriberingen pågår eller är pausad'} · Tips: dubbelklicka på en mening för att redigera, mellanslag spelar/pausar.`
    : '';
}

function renderChapters() {
  const ol = $('chapterList');
  if (!state.chapters.length) { ol.innerHTML = '<li class="muted">Visas när texten finns.</li>'; return; }
  ol.innerHTML = '';
  state.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button data-ch="${i}"><span class="ch-title"></span><span class="ch-time">${fmtTime(c.start, withHours())}</span></button>`;
    li.querySelector('.ch-title').textContent = c.title;
    li.querySelector('button').onclick = () => {
      seekTo(c.start, false);
      scrollToSegment(c.from, true);
    };
    ol.appendChild(li);
  });
}

function renderKeywords() {
  const box = $('keywordList');
  if (!state.keywords.length) { box.innerHTML = '<span class="muted">Visas när det finns tillräckligt med text.</span>'; return; }
  box.innerHTML = '';
  for (const k of state.keywords) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.keyword?.word === k.word ? ' active' : '');
    b.innerHTML = `${escapeHtml(k.word)}<small>${k.count}</small>`;
    b.title = `Nämns ${k.count} gånger – klicka för att visa var`;
    b.onclick = () => {
      state.keyword = state.keyword?.word === k.word ? null : k;
      renderKeywords();
      renderTranscript();
      if (state.keyword) {
        const first = visibleIndices()[0];
        if (first !== undefined) scrollToSegment(first, true);
        toast(`Visar ${visibleIndices().length} ställen där "${k.word}" nämns. Klicka igen för att visa allt.`);
      }
    };
    box.appendChild(b);
  }
}

function segHTML(seg, i) {
  const cue = isCue(seg.t);
  return `<div class="seg${seg.star ? ' starred' : ''}${seg.note ? ' has-note' : ''}${i === state.currentIdx ? ' current' : ''}" data-i="${i}">
    <button class="ts" data-act="seek" title="Spela härifrån">${fmtTime(seg.s, withHours())}</button>
    <div class="txt" data-act="seek">${cue ? '<span class="badge" title="Föreläsaren verkar betona det här">Viktigt</span>' : ''}${highlight(seg.t)}</div>
    <div class="acts">
      <button class="icon-btn star-btn${seg.star ? ' on' : ''}" data-act="star" title="Stjärnmärk (S)">⭐</button>
      <button class="icon-btn" data-act="edit" title="Redigera">✏️</button>
      <button class="icon-btn note-btn${seg.note ? ' on' : ''}" data-act="note" title="Anteckning">📝</button>
      <button class="icon-btn" data-act="ask" title="Fråga Claude vad som menas här">💬</button>
      <button class="icon-btn" data-act="copy" title="Kopiera med tidsstämpel">📋</button>
    </div>
    ${seg.note ? `<div class="note"><div class="note-view" data-act="note">${escapeHtml(seg.note)}</div></div>` : ''}
  </div>`;
}

function renderTranscript() {
  if (state.editing !== null) { state.pendingRender = true; return; }
  const box = $('transcript');
  const s = segs();
  if (!s.length) {
    box.innerHTML = `<div class="empty-state">${state.running || !state.lecture?.done
      ? 'Texten dyker upp här efter hand – första delen brukar ta någon minut (modellen laddas ner första gången).'
      : 'Ingen text hittades i den här filen.'}</div>`;
    updateSearchHits();
    return;
  }
  const vis = visibleIndices();
  if (!vis.length) {
    const why = state.filter === 'star' ? 'Inga stjärnmärkta meningar än. Klicka på ⭐ vid en mening för att markera den.'
      : state.filter === 'cue' ? 'Hittade inga ställen där föreläsaren uttryckligen betonar något.'
      : 'Inget matchar.';
    box.innerHTML = `<div class="empty-state">${why}</div>`;
    updateSearchHits();
    return;
  }
  const showChapterHeads = state.filter === 'all' && !state.keyword && state.chapters.length > 1;
  const chStart = new Map(state.chapters.map((c, i) => [c.from, i]));
  let html = '';
  if (state.mode === 'segments') {
    for (const i of vis) {
      if (showChapterHeads && chStart.has(i)) html += chapterHead(chStart.get(i));
      html += segHTML(s[i], i);
    }
  } else {
    html += '<div class="reading">';
    const visSet = new Set(vis);
    const chs = showChapterHeads ? state.chapters : [{ from: 0, to: s.length }];
    chs.forEach((c, ci) => {
      if (showChapterHeads) html += chapterHead(ci);
      const sub = [];
      for (let i = c.from; i < c.to; i++) if (visSet.has(i)) sub.push(i);
      const subSegs = sub.map(i => ({ ...s[i], _i: i }));
      for (const p of paragraphs(subSegs)) {
        html += `<p><button class="ts p-ts" data-i="${p[0]._i}" data-act="seek">${fmtTime(p[0].s, withHours())}</button>` +
          p.map(x => `<span class="sp${x.star ? ' starred' : ''}${isCue(x.t) ? ' cue' : ''}${x._i === state.currentIdx ? ' current' : ''}" data-i="${x._i}" data-act="seek">${highlight(x.t)}</span>`).join(' ') +
          '</p>';
      }
    });
    html += '</div>';
  }
  box.innerHTML = html;
  updateSearchHits();
}

function chapterHead(ci) {
  const c = state.chapters[ci];
  return `<div class="ch-head" data-ch="${ci}"><h3>${escapeHtml(c.title)}</h3>
    <button class="ts" data-act="seek-ch" data-ch="${ci}">${fmtTime(c.start, withHours())}</button>
    <button class="btn small ghost ai-mini" data-act="ai-ch" data-ch="${ci}" title="Få avsnittet förklarat av AI">✨ Förklara</button></div>`;
}

// lägger till nya segment under transkribering utan att rita om allt
function appendSegments(newSegs) {
  const s = segs();
  if (state.editing !== null) { state.pendingRender = true; ensureDerived(); renderChapters(); renderKeywords(); updateCounts(); return; }
  if (state.filter !== 'all' || state.keyword || state.search || state.mode !== 'segments' || s.length === newSegs.length) {
    renderAll();
    return;
  }
  const box = $('transcript');
  const startIdx = s.length - newSegs.length;
  const html = newSegs.map((seg, k) => segHTML(seg, startIdx + k)).join('');
  box.insertAdjacentHTML('beforeend', html);
  ensureDerived();
  renderChapters();
  renderKeywords();
  updateCounts();
}

// ---------------------------------------------------------------- sök
function updateSearchHits() {
  const q = state.search.trim().toLowerCase();
  state.searchHits = [];
  if (q) {
    const s = segs();
    for (const i of visibleIndices()) if (s[i].t.toLowerCase().includes(q)) state.searchHits.push(i);
  }
  state.searchPos = -1;
  $('searchCount').textContent = q ? (state.searchHits.length ? `${state.searchHits.length} träffar` : 'Inga träffar') : '';
}
function gotoHit(dir) {
  if (!state.searchHits.length) return;
  state.searchPos = (state.searchPos + dir + state.searchHits.length) % state.searchHits.length;
  const i = state.searchHits[state.searchPos];
  $('searchCount').textContent = `${state.searchPos + 1} av ${state.searchHits.length}`;
  document.querySelectorAll('mark.focus').forEach(m => m.classList.remove('focus'));
  const el = segElement(i);
  el?.querySelector('mark')?.classList.add('focus');
  scrollToSegment(i, true);
}

// ---------------------------------------------------------------- uppspelning
const video = $('video');
function seekTo(t, play = true) {
  if (!state.file) { toast('Koppla videofilen för att kunna lyssna (knappen i spelaren).'); return; }
  video.currentTime = Math.max(0, t);
  if (play) video.play().catch(() => {});
  state.lastUserScroll = 0;
}
function segElement(i) {
  return $('transcript').querySelector(`[data-i="${i}"]${state.mode === 'segments' ? '.seg' : '.sp'}`);
}
function scrollToSegment(i, force = false) {
  const el = segElement(i);
  if (!el) return;
  if (!force && Date.now() - state.lastUserScroll < 4000) return; // låt användaren läsa i fred
  const r = el.getBoundingClientRect();
  const top = 150, bottom = window.innerHeight - 60;
  if (force || r.top < top || r.bottom > bottom) {
    el.scrollIntoView({ block: 'center', behavior: force ? 'smooth' : 'smooth' });
  }
}
function findIdx(t) {
  const s = segs();
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].s <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function onTime() {
  const t = video.currentTime;
  const d = video.duration || state.lecture?.duration || 0;
  $('timeLabel').textContent = `${fmtTime(t, d >= 3600)} / ${fmtTime(d, d >= 3600)}`;
  if (!seekDragging && d) $('seek').value = Math.round(1000 * t / d);
  const idx = findIdx(t);
  if (idx !== state.currentIdx) {
    const box = $('transcript');
    box.querySelectorAll('.current').forEach(e => e.classList.remove('current'));
    state.currentIdx = idx;
    if (idx >= 0) {
      const el = segElement(idx);
      if (el) {
        el.classList.add('current');
        if ($('followToggle').checked && !video.paused && state.editing === null) scrollToSegment(idx);
      }
      const ci = state.chapters.findIndex(c => idx >= c.from && idx < c.to);
      document.querySelectorAll('#chapterList button').forEach((b, k) => b.classList.toggle('active', k === ci));
    }
  }
}
let seekDragging = false;

// ---------------------------------------------------------------- AI: utan nyckel (kopiera till claude.ai)
async function copyToClaude(promptKey, segList, label) {
  if (!segList.length) { toast('Det finns ingen text i det valet än.'); return; }
  const title = state.lecture?.title || 'Föreläsning';
  const text = PROMPTS[promptKey].text + '\n\n---\n\n' + transcriptForAI(segList, title + (label ? ` – ${label}` : ''));
  // kopiera först (inom samma klick), öppna sedan claude.ai
  const ok = await copyText(text);
  const w = window.open('https://claude.ai/new', '_blank');
  if (w) { try { w.opener = null; } catch {} }
  if (ok) toast('Kopierat! Klistra in i Claude med Ctrl+V och tryck Enter.', 5000);
  else {
    download(safeName(title) + ' – AI-prompt.txt', text, 'text/plain;charset=utf-8');
    toast('Kunde inte kopiera automatiskt – texten laddades ner som fil i stället.', 5000);
  }
  if (!w) toast('Tillåt popup-fönster för att öppna claude.ai automatiskt.', 5000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- AI: pluggassistent med Claude
const AI_TOOLS = [
  { key: 'summary', label: 'Sammanfattning', descr: 'Rubriker, begrepp och tidsstämplar' },
  { key: 'cards', label: 'Förhörskort', descr: 'Fråga/svar-kort till 🧠 Förhör' },
  { key: 'quiz', label: 'Övningstenta', descr: 'Flerval, kortsvar, essä + facit' },
  { key: 'concepts', label: 'Förklara begrepp', descr: 'Enkelt, med exempel' },
  { key: 'plan', label: 'Pluggplan', descr: 'Pass och repetition' },
];
const aiState = { scope: 'all', controller: null, busy: false, chapter: null };

function lecAI() {
  const l = state.lecture;
  l.ai = l.ai || { items: [] };
  return l.ai;
}
function aiTranscript() {
  return transcriptForAI(segs(), state.lecture?.title || 'Föreläsning', { stars: false });
}
function focusFor(scope, chapter) {
  const wh = withHours();
  if (scope === 'chapter' && chapter) {
    return { label: `Avsnitt: ${chapter.title}`, text: `Fokusera på avsnittet "${chapter.title}" (${fmtTime(chapter.start, wh)}–${fmtTime(chapter.end, wh)}) i föreläsningen.` };
  }
  if (scope === 'star') {
    const st = segs().filter(x => x.star);
    if (!st.length) return null;
    return { label: 'Stjärnmärkta delar', text: 'Fokusera på de delar jag har markerat som viktiga:\n' + st.map(x => `- [${fmtTime(x.s, wh)}] ${x.t}`).join('\n') };
  }
  return { label: 'Hela föreläsningen', text: '' };
}
function currentChapter() { return aiState.chapter || chapterAt(Math.max(0, state.currentIdx)); }

function openDrawer() {
  if (!segs().length) { toast('Vänta tills det finns lite text.'); return; }
  ensureDerived();
  $('aiDrawer').classList.add('open');
  $('aiDrawer').setAttribute('aria-hidden', 'false');
  $('drawerShade').classList.remove('hidden');
  document.body.classList.add('drawer-open');
  showAIView(hasKey() ? 'main' : 'setup');
}
function closeDrawer() {
  $('aiDrawer').classList.remove('open');
  $('aiDrawer').setAttribute('aria-hidden', 'true');
  $('drawerShade').classList.add('hidden');
  document.body.classList.remove('drawer-open');
}
function drawerOpen() { return $('aiDrawer').classList.contains('open'); }

function showAIView(view) {
  const setup = view === 'setup';
  $('aiSetup').classList.toggle('hidden', !setup);
  $('aiMain').classList.toggle('hidden', setup);
  $('aiAsk').classList.toggle('hidden', setup);
  if (setup) {
    $('aiKeyInput').value = '';
    $('aiKeyInput').placeholder = hasKey() ? 'Nyckel sparad ✓ – klistra in en ny för att byta' : 'sk-ant-…';
    $('aiKeyActions').classList.toggle('hidden', !hasKey());
    $('aiKeyStatus').textContent = '';
    renderCopyGrid();
  } else {
    renderAITools();
    renderThread();
    setTimeout(() => $('aiQuestion').focus(), 50);
  }
}

function renderCopyGrid() {
  const grid = $('aiCopyGrid');
  grid.innerHTML = '';
  for (const key of ['summary', 'flashcards', 'quiz', 'concepts', 'plan']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-card';
    b.innerHTML = `<b>${PROMPTS[key].label}</b>`;
    b.onclick = () => copyToClaude(key, segs(), '');
    grid.appendChild(b);
  }
}

function renderAITools() {
  const c = currentChapter();
  $('scopeChapterBtn').title = c ? c.title : '';
  document.querySelectorAll('[data-scope]').forEach(b => b.classList.toggle('active', b.dataset.scope === aiState.scope));
  const box = $('aiTools');
  box.innerHTML = '';
  for (const t of AI_TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-card';
    b.disabled = aiState.busy;
    b.innerHTML = `<b>${t.label}</b><small>${t.descr}</small>`;
    b.onclick = () => runTool(t.key);
    box.appendChild(b);
  }
}

const itemTime = (ms) => new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
function costLabel(kr) { return kr ? ` · ≈ ${kr < 0.1 ? '<0,1' : kr.toFixed(1).replace('.', ',')} kr` : ''; }

async function itemHTML(it) {
  if (it.role === 'user') {
    return `<div class="ai-msg user" data-id="${it.id}"><div class="bubble">${escapeHtml(it.display || it.prompt)}</div></div>`;
  }
  const body = it.text ? await renderMarkdown(it.text) : '<p class="muted">…</p>';
  return `<div class="ai-msg bot" data-id="${it.id}">
    <div class="ai-meta"><b>${escapeHtml(it.label || 'Svar')}</b><span class="muted tiny">${it.focus ? escapeHtml(it.focus) + ' · ' : ''}${itemTime(it.at)}${costLabel(it.cost)}</span>
      <span class="spacer"></span>
      <button class="icon-btn small" data-ai="copy" title="Kopiera">📋</button>
      <button class="icon-btn small" data-ai="doc" title="Spara som Word">⬇</button>
      <button class="icon-btn small" data-ai="del" title="Ta bort">🗑</button></div>
    <div class="md">${body}</div>
    ${it.cards ? `<button class="btn small accent" data-ai="quiz">🧠 Öva på korten nu</button>` : ''}
    ${it.truncated ? '<p class="muted tiny">Svaret blev avkortat – be om "fortsätt" i rutan nedan.</p>' : ''}
  </div>`;
}

async function renderThread() {
  const items = lecAI().items;
  const box = $('aiThread');
  if (!items.length) {
    box.innerHTML = `<div class="ai-empty">
      <p><b>Välj ett verktyg ovan</b> eller ställ en fråga nedan, till exempel:</p>
      <ul>
        <li><a href="#" data-q="Vad är det viktigaste jag måste kunna från den här föreläsningen?">Vad är det viktigaste jag måste kunna?</a></li>
        <li><a href="#" data-q="Vad kommer troligen på tentan, utifrån vad föreläsaren betonar?">Vad kommer troligen på tentan?</a></li>
        <li><a href="#" data-q="Förklara det svåraste resonemanget i föreläsningen steg för steg, enkelt.">Förklara det svåraste steg för steg</a></li>
      </ul></div>`;
    return;
  }
  const html = await Promise.all(items.map(itemHTML));
  box.innerHTML = html.join('');
  box.scrollTop = box.scrollHeight;
}

async function updateStreamingItem(it) {
  const el = $('aiThread').querySelector(`[data-id="${it.id}"] .md`);
  if (el) el.innerHTML = await renderMarkdown(it.text || '…');
  const box = $('aiThread');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

function setBusy(b) {
  aiState.busy = b;
  $('aiSend').classList.toggle('hidden', b);
  $('aiStop').classList.toggle('hidden', !b);
  $('aiQuestion').disabled = b;
  document.querySelectorAll('#aiTools button').forEach(x => { x.disabled = b; });
}

// Bygger konversationen till API:t av tidigare frågor och svar (senaste 12 inläggen).
function historyMessages() {
  const msgs = [];
  for (const it of lecAI().items.slice(-12)) {
    if (it.role === 'user') msgs.push({ role: 'user', content: it.prompt });
    else if (it.text) msgs.push({ role: 'assistant', content: it.text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

async function ask(prompt, { display, label = 'Svar', focus = '', effort = 'medium' } = {}) {
  if (aiState.busy) return;
  const items = lecAI().items;
  const history = historyMessages();
  const q = { id: newId(), role: 'user', prompt, display: display || prompt, at: Date.now() };
  const a = { id: newId(), role: 'assistant', label, focus, text: '', at: Date.now() };
  items.push(q, a);
  await renderThread();
  setBusy(true);
  aiState.controller = new AbortController();
  let pending = null;
  try {
    const res = await streamAnswer({
      transcript: aiTranscript(),
      messages: [...history, { role: 'user', content: prompt }],
      effort,
      signal: aiState.controller.signal,
      onText: (t) => {
        a.text = t;
        if (!pending) pending = setTimeout(() => { pending = null; updateStreamingItem(a); }, 120);
      },
    });
    clearTimeout(pending);
    a.text = res.text;
    a.truncated = res.truncated;
    a.cost = estimateCostSEK(res.usage);
  } catch (e) {
    clearTimeout(pending);
    if (!a.text) { items.splice(items.indexOf(q), 2); }
    toast(e.message, 7000);
    if (/API-nyckeln/.test(e.message)) showAIView('setup');
  } finally {
    setBusy(false);
    aiState.controller = null;
    saveSoon();
    if (!$('aiMain').classList.contains('hidden')) renderThread();
  }
}

async function runTool(key) {
  if (aiState.busy) return;
  const f = focusFor(aiState.scope, currentChapter());
  if (!f) { toast('Du har inte stjärnmärkt något än. Klicka ⭐ vid viktiga meningar.'); return; }
  const tool = AI_TOOLS.find(t => t.key === key);
  if (key === 'cards') return makeAICards(f);
  const task = PROMPTS[key].text.split('\n\n').slice(1).join('\n\n');
  await ask((f.text ? f.text + '\n\n' : '') + task, { display: `${tool.label}${aiState.scope !== 'all' ? ' – ' + f.label.toLowerCase() : ''}`, label: tool.label, focus: f.label, effort: 'high' });
}

async function explainChapter(c) {
  if (!hasKey()) { copyToClaude('explain', segs().slice(c.from, c.to), `avsnitt: ${c.title}`); return; }
  openDrawer();
  const f = focusFor('chapter', c);
  const task = PROMPTS.explain.text.split('\n\n').slice(1).join('\n\n').replace('i det här utdraget', 'i det här avsnittet');
  await ask(f.text + '\n\n' + task, { display: `Förklara avsnittet "${c.title}"`, label: 'Förklaring', focus: f.label, effort: 'high' });
}

async function askAboutSegment(i) {
  const seg = segs()[i];
  const wh = withHours();
  if (!hasKey()) {
    const from = Math.max(0, i - 6), to = Math.min(segs().length, i + 7);
    copyToClaude('explain', segs().slice(from, to), `runt ${fmtTime(seg.s, wh)}`);
    return;
  }
  openDrawer();
  await ask(`Förklara vad föreläsaren menar här, i sitt sammanhang: [${fmtTime(seg.s, wh)}] "${seg.t}"`, { label: 'Förklaring', focus: `Vid ${fmtTime(seg.s, wh)}` });
}

async function makeAICards(f) {
  const items = lecAI().items;
  const q = { id: newId(), role: 'user', prompt: 'Skapa förhörskort' + (f.text ? ' – ' + f.label : ''), display: 'Förhörskort' + (aiState.scope !== 'all' ? ' – ' + f.label.toLowerCase() : ''), at: Date.now() };
  const a = { id: newId(), role: 'assistant', label: 'Förhörskort', focus: f.label, text: '_Claude skapar förhörskort… (tar ofta 1–2 minuter)_', at: Date.now() };
  items.push(q, a);
  await renderThread();
  setBusy(true);
  aiState.controller = new AbortController();
  try {
    const res = await generateCards({ transcript: aiTranscript(), focus: f.text ? f.label.toLowerCase() + (aiState.scope === 'star' ? ':\n' + f.text : ` (${f.text})`) : '', signal: aiState.controller.signal });
    const lec = state.lecture;
    lec.aiCards = lec.aiCards || [];
    const wh = withHours();
    const added = res.cards.filter(c => c.q && c.a).map(c => {
      const sec = parseTimestamp(String(c.t || '').replace(/[\[\]]/g, ''));
      return { id: 'ai-' + newId(), q: c.q, a: c.a, s: sec ?? 0 };
    });
    lec.aiCards.push(...added);
    a.text = `Skapade **${added.length} förhörskort**. De finns nu i 🧠 Förhör tillsammans med de automatiska lucktesten.\n\n` +
      added.slice(0, 5).map(c => `- **${c.q}**${c.s ? ` [${fmtTime(c.s, wh)}]` : ''}`).join('\n') + (added.length > 5 ? `\n- … och ${added.length - 5} till` : '');
    a.cards = added.length;
    a.cost = estimateCostSEK(res.usage);
  } catch (e) {
    items.splice(items.indexOf(q), 2);
    toast(e.message, 7000);
    if (/API-nyckeln/.test(e.message)) showAIView('setup');
  } finally {
    setBusy(false);
    aiState.controller = null;
    saveSoon();
    renderThread();
  }
}

// ---------------------------------------------------------------- förhör
// Utspridd repetition: varje kort får en ny tid för repetition efter hur det gick.
const DAY = 86400000;
const INTERVAL_DAYS = [0, 1, 3, 7, 16, 35, 90];
const NEW_PER_SESSION = 15;
const SESSION_MAX = 25;

function cardsForLecture(lec) {
  const segsL = lec.segments || [];
  const ai = (lec.aiCards || []).map(c => ({ id: c.id, kind: 'ai', q: c.q, a: c.a, s: c.s }));
  const cloze = segsL.length ? makeCards(segsL, keywords(segsL, 24)).map(c => ({ id: c.id, kind: 'cloze', q: c.question, a: c.answer, s: c.s, starred: c.starred })) : [];
  return [...ai, ...cloze];
}
function dueInfo(lec, now = Date.now()) {
  const prog = lec.cards || {};
  const all = cardsForLecture(lec);
  const due = [], fresh = [];
  for (const c of all) {
    const p = prog[c.id];
    if (!p || !p.seen) fresh.push(c);
    else if ((p.due || 0) <= now) due.push(c);
  }
  due.sort((x, y) => (prog[x.id].due || 0) - (prog[y.id].due || 0));
  return { all, due, fresh, mastered: all.filter(c => (prog[c.id]?.box || 0) >= 3).length };
}

let quiz = null;
function openQuiz() {
  const lec = state.lecture;
  if (!lec) return;
  const info = dueInfo(lec);
  const queue = [...info.due, ...info.fresh.slice(0, NEW_PER_SESSION)].slice(0, SESSION_MAX).map(card => ({ lec, card }));
  startQuiz(queue, info.all.length, lec.title || lec.name);
}
async function openGlobalReview() {
  const lecs = await db.all().catch(() => []);
  const queue = [];
  let total = 0;
  for (const lec of lecs) {
    const info = dueInfo(lec);
    total += info.all.length;
    queue.push(...info.due.map(card => ({ lec, card })));
  }
  // därefter nya kort, några per föreläsning
  for (const lec of lecs) queue.push(...dueInfo(lec).fresh.slice(0, 5).map(card => ({ lec, card })));
  startQuiz(queue.slice(0, 40), total, 'Alla föreläsningar');
}
function startQuiz(queue, total, title) {
  quiz = { queue, pos: 0, right: 0, wrong: 0, total, title, retried: new Set(), dirty: new Set() };
  renderQuiz();
  if (!$('quizDialog').open) $('quizDialog').showModal();
}
function saveLecture(lec) {
  if (lec === state.lecture) saveSoon();
  else { lec.updatedAt = Date.now(); db.put(lec).catch(e => console.error(e)); }
}
function nextReviewLabel(box) {
  const d = INTERVAL_DAYS[Math.min(box, INTERVAL_DAYS.length - 1)];
  return d === 1 ? 'i morgon' : d < 7 ? `om ${d} dagar` : d < 30 ? `om ${Math.round(d / 7)} veckor` : `om ${Math.round(d / 30)} månader`;
}

function renderQuiz() {
  const body = $('quizBody');
  if (!quiz.queue.length) {
    body.innerHTML = `<div class="quiz-card"><div class="quiz-q">Inget att repetera just nu 🎉</div>
      <p>Förhörskort skapas på två sätt:</p>
      <ul><li><b>✨ Plugga med AI → Förhörskort</b> – Claude skriver riktiga fråga/svar-kort av hela föreläsningen (bäst).</li>
      <li>Automatiska lucktest av meningar du <b>stjärnmärkt ⭐</b> och där föreläsaren säger att något är <b>viktigt</b>.</li></ul>
      <p class="muted">Kort du redan kan dyker upp igen när det är dags att repetera dem.</p></div>`;
    return;
  }
  if (quiz.pos >= quiz.queue.length) {
    const lec = state.lecture;
    const left = lec ? dueInfo(lec).fresh.length : 0;
    body.innerHTML = `<div class="quiz-card"><div class="quiz-q">Bra jobbat! 🎉</div>
      <p>Du kunde <b>${quiz.right}</b> av ${quiz.right + quiz.wrong} kort. ${quiz.wrong ? 'Korten du inte kunde kommer tillbaka snart.' : ''}</p>
      <p class="muted">Korten är schemalagda för repetition – kom tillbaka i morgon, då är minnet som mest mottagligt.${left ? ` ${left} nya kort finns kvar att lära.` : ''}</p></div>
      <div class="quiz-actions"><span></span><span>${left ? '<button class="btn" id="qAgain">Fler kort</button> ' : ''}<button class="btn primary" id="qDone">Klar</button></span></div>`;
    if ($('qAgain')) $('qAgain').onclick = openQuiz;
    $('qDone').onclick = () => $('quizDialog').close();
    return;
  }
  const { lec, card } = quiz.queue[quiz.pos];
  const p = (lec.cards || {})[card.id] || { box: 0 };
  const wh = (lec.duration || 0) >= 3600;
  const canListen = lec === state.lecture && state.file;
  const isAI = card.kind === 'ai';
  body.innerHTML = `
    <div class="quiz-actions"><span class="quiz-progress">Kort ${quiz.pos + 1} av ${quiz.queue.length}${quiz.title && lec !== state.lecture ? ' · ' + escapeHtml(lec.title || lec.name) : ''} · ${isAI ? 'fråga' : 'lucktest'} · ${p.seen ? 'repetition' : 'nytt'}</span>
      <span class="quiz-stats"><span>✓ ${quiz.right}</span><span>✗ ${quiz.wrong}</span></span></div>
    <div class="quiz-card">
      <div class="quiz-q">${isAI ? escapeHtml(card.q) : escapeHtml(card.q).replace('_____', '<b>_____</b>')}</div>
      ${isAI
        ? '<textarea class="quiz-input" id="qInput" rows="3" placeholder="Svara med egna ord – att formulera svaret själv är det som får det att fastna. (Ctrl+Enter)"></textarea>'
        : '<input class="quiz-input" id="qInput" placeholder="Skriv ordet som fattas och tryck Enter" autocomplete="off">'}
      <div class="quiz-a hidden" id="qA">
        <div class="${isAI ? 'answer-text' : 'answer'}">${escapeHtml(card.a)}</div>
        <div id="qJudge" class="judge"></div>
        ${canListen ? `<button class="btn small ghost" id="qListen">▶ Lyssna på stället (${fmtTime(card.s, wh)})</button>` : `<span class="muted tiny">Tas upp vid ${fmtTime(card.s, wh)}</span>`}
      </div>
    </div>
    <div class="quiz-actions" id="qBtns">
      <button class="btn" id="qSkip">Hoppa över</button>
      <span>${isAI && hasKey() ? '<button class="btn accent" id="qGrade">✨ Rätta mitt svar</button> ' : ''}<button class="btn primary" id="qShow">Visa svar</button></span>
    </div>`;
  const input = $('qInput');
  setTimeout(() => input.focus(), 50);
  const show = () => {
    $('qA').classList.remove('hidden');
    const guess = input.value.trim().toLowerCase();
    if (!isAI && guess) {
      const ans = card.a.toLowerCase();
      const ok = guess === ans || (guess.length >= 4 && ans.startsWith(guess.slice(0, Math.max(4, guess.length - 2))));
      $('qJudge').innerHTML = ok ? '<span class="ok">✓ Rätt!</span>' : `<span class="muted">Du skrev: ${escapeHtml(input.value.trim())}</span>`;
    }
    const box = p.box || 0;
    $('qBtns').innerHTML = `<button class="btn" id="qWrong" title="Kortet kommer tillbaka strax">✗ Kunde inte</button>
      <button class="btn" id="qHard" title="Repeteras ${nextReviewLabel(Math.max(1, box))}">😐 Svårt</button>
      <button class="btn primary" id="qRight" title="Repeteras ${nextReviewLabel(box + 1)}">✓ Kunde</button>`;
    $('qWrong').onclick = () => grade(0);
    $('qHard').onclick = () => grade(1);
    $('qRight').onclick = () => grade(2);
    $('qRight').focus();
  };
  input.onkeydown = (e) => {
    const submit = isAI ? (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) : e.key === 'Enter';
    if (submit) { e.preventDefault(); if ($('qA').classList.contains('hidden')) ($('qGrade') && input.value.trim() ? $('qGrade').click() : show()); }
  };
  $('qShow').onclick = show;
  $('qSkip').onclick = () => { quiz.pos++; renderQuiz(); };
  if ($('qListen')) $('qListen').onclick = () => { $('quizDialog').close(); seekTo(card.s); scrollToSegment(findIdx(card.s), true); };
  if ($('qGrade')) $('qGrade').onclick = async () => {
    const ans = input.value.trim();
    if (!ans) { toast('Skriv ditt svar först.'); input.focus(); return; }
    $('qGrade').disabled = true;
    $('qGrade').textContent = 'Rättar…';
    try {
      const r = await gradeAnswer({ question: card.q, answer: card.a, studentAnswer: ans });
      show();
      const icon = r.verdict === 'rätt' ? '✓' : r.verdict === 'delvis' ? '◐' : '✗';
      const cls = r.verdict === 'rätt' ? 'ok' : r.verdict === 'delvis' ? 'partial' : 'warn';
      $('qJudge').innerHTML = `<div class="grade ${cls}"><b>${icon} ${r.verdict === 'rätt' ? 'Rätt' : r.verdict === 'delvis' ? 'Delvis rätt' : 'Inte riktigt'}</b> – ${escapeHtml(r.feedback)}</div>`;
      const target = r.verdict === 'rätt' ? 'qRight' : r.verdict === 'delvis' ? 'qHard' : 'qWrong';
      $(target)?.classList.add('suggested');
      $(target)?.focus();
    } catch (e) {
      toast(e.message, 6000);
      if ($('qGrade')) { $('qGrade').disabled = false; $('qGrade').textContent = '✨ Rätta mitt svar'; }
    }
  };
  function grade(level) {
    lec.cards = lec.cards || {};
    const prev = lec.cards[card.id] || { box: 0, seen: 0 };
    const now = Date.now();
    let box;
    if (level === 0) box = 0;
    else if (level === 1) box = Math.max(1, prev.box);
    else box = prev.box + 1;
    const days = level === 0 ? 0 : INTERVAL_DAYS[Math.min(box, INTERVAL_DAYS.length - 1)] * (level === 1 ? 0.6 : 1);
    lec.cards[card.id] = { box, seen: now, due: level === 0 ? now + 10 * 60000 : now + days * DAY };
    if (level === 0) {
      quiz.wrong++;
      // kom tillbaka senare i samma pass (en gång)
      if (!quiz.retried.has(card.id)) { quiz.retried.add(card.id); quiz.queue.push({ lec, card }); }
    } else quiz.right++;
    quiz.pos++;
    saveLecture(lec);
    renderQuiz();
  }
}

// ---------------------------------------------------------------- export
function exportAs(kind) {
  const lec = state.lecture;
  const s = segs();
  if (!s.length) { toast('Det finns ingen text att exportera än.'); return; }
  ensureDerived();
  const title = lec.title || lec.name;
  const base = safeName(title);
  if (kind === 'txt') download(base + '.txt', toTXT(s, title), 'text/plain;charset=utf-8');
  if (kind === 'srt') download(base + '.srt', toSRT(s), 'application/x-subrip;charset=utf-8');
  if (kind === 'md') download(base + '.md', toMarkdown(s, title, state.chapters), 'text/markdown;charset=utf-8');
  if (kind === 'doc') download(base + '.doc', '﻿' + toWordHTML(s, title, state.chapters), 'application/msword');
  if (kind === 'copy') copyText(toTXT(s, title)).then(ok => toast(ok ? 'All text är kopierad.' : 'Kunde inte kopiera.'));
}

// ---------------------------------------------------------------- redigering och anteckningar
function startEdit(i) {
  const el = segElement(i);
  if (!el || state.mode !== 'segments') return;
  const txt = el.querySelector('.txt');
  const seg = segs()[i];
  txt.textContent = seg.t;
  txt.contentEditable = 'true';
  txt.spellcheck = true;
  txt.focus();
  const range = document.createRange();
  range.selectNodeContents(txt);
  range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  state.editing = i;
  const finish = (save) => {
    txt.removeEventListener('blur', onBlur);
    txt.removeEventListener('keydown', onKey);
    txt.contentEditable = 'false';
    state.editing = null;
    if (save) {
      const v = txt.textContent.replace(/\s+/g, ' ').trim();
      if (v && v !== seg.t) { seg.t = v; seg.edited = true; state.derivedDirty = true; saveSoon(); }
    }
    if (el.isConnected) el.outerHTML = segHTML(seg, i);
    updateCounts();
    flushPendingRender();
  };
  const onBlur = () => finish(true);
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  txt.addEventListener('blur', onBlur);
  txt.addEventListener('keydown', onKey);
}

function editNote(i) {
  const el = segElement(i);
  if (!el || state.mode !== 'segments') return;
  const seg = segs()[i];
  let note = el.querySelector('.note');
  if (!note) { note = document.createElement('div'); note.className = 'note'; el.appendChild(note); }
  note.innerHTML = '<textarea placeholder="Skriv en egen anteckning… (Ctrl+Enter sparar)"></textarea>';
  const ta = note.querySelector('textarea');
  ta.value = seg.note || '';
  ta.focus();
  state.editing = i;
  const done = () => {
    seg.note = ta.value.trim();
    state.editing = null;
    saveSoon();
    if (el.isConnected) el.outerHTML = segHTML(seg, i);
    flushPendingRender();
  };
  ta.addEventListener('blur', done, { once: true });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); ta.value = seg.note || ''; ta.blur(); }
  });
}

function flushPendingRender() {
  if (!state.pendingRender) return;
  state.pendingRender = false;
  renderAll();
}

function toggleStar(i) {
  const seg = segs()[i];
  seg.star = !seg.star;
  saveSoon();
  if (state.filter === 'star' && !seg.star) { renderTranscript(); updateCounts(); return; }
  const el = segElement(i);
  if (el) {
    el.classList.toggle('starred', seg.star);
    el.querySelector('.star-btn')?.classList.toggle('on', seg.star);
  }
  updateCounts();
}

// ---------------------------------------------------------------- händelser: assistent
function bindAI() {
  $('aiClose').onclick = closeDrawer;
  $('drawerShade').onclick = () => { if (!aiState.busy) closeDrawer(); };
  $('aiSettingsBtn').onclick = () => showAIView($('aiSetup').classList.contains('hidden') ? 'setup' : (hasKey() ? 'main' : 'setup'));
  $('aiSetupDone').onclick = () => showAIView('main');
  $('aiKeyRemove').onclick = () => { setKey(''); toast('Nyckeln är borttagen från den här webbläsaren.'); showAIView('setup'); };
  $('aiKeyForm').onsubmit = async (e) => {
    e.preventDefault();
    const k = $('aiKeyInput').value.trim();
    if (!k) return;
    if (!/^sk-ant-/.test(k)) { $('aiKeyStatus').innerHTML = '<span class="warn">Det ser inte ut som en Anthropic-nyckel (de börjar med sk-ant-).</span>'; return; }
    const prev = (await import('./ai.js')).getKey();
    setKey(k);
    $('aiKeyStatus').textContent = 'Kontrollerar nyckeln…';
    try {
      await testKey();
      $('aiKeyStatus').innerHTML = '<span class="ok">✓ Nyckeln fungerar!</span>';
      $('aiKeyInput').value = '';
      setTimeout(() => showAIView('main'), 700);
    } catch (err) {
      setKey(prev);
      $('aiKeyStatus').innerHTML = `<span class="warn">${escapeHtml(err.message)}</span>`;
    }
  };
  document.querySelectorAll('[data-scope]').forEach(b => b.onclick = () => {
    aiState.scope = b.dataset.scope;
    aiState.chapter = null;
    renderAITools();
    if (aiState.scope === 'chapter') { const c = currentChapter(); if (c) toast(`Fokus: ${c.title}`, 1800); }
  });
  $('aiAsk').onsubmit = (e) => {
    e.preventDefault();
    const q = $('aiQuestion').value.trim();
    if (!q || aiState.busy) return;
    $('aiQuestion').value = '';
    $('aiQuestion').style.height = '';
    const f = focusFor(aiState.scope, currentChapter());
    const prefix = f && f.text && aiState.scope !== 'all' ? f.text + '\n\n' : '';
    ask(prefix + q, { display: q, label: 'Svar', focus: aiState.scope !== 'all' && f ? f.label : '' });
  };
  $('aiQuestion').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('aiAsk').requestSubmit(); }
  });
  $('aiQuestion').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px';
  });
  $('aiStop').onclick = () => aiState.controller?.abort();
  $('aiThread').addEventListener('click', async (e) => {
    const t = e.target.closest('a[href^="#t="]');
    if (t) { e.preventDefault(); const sec = Number(t.getAttribute('href').slice(3)); seekTo(sec); scrollToSegment(findIdx(sec), true); return; }
    const q = e.target.closest('[data-q]');
    if (q) { e.preventDefault(); $('aiQuestion').value = q.dataset.q; $('aiAsk').requestSubmit(); return; }
    const btn = e.target.closest('[data-ai]');
    if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id;
    const items = lecAI().items;
    const k = items.findIndex(x => x.id === id);
    if (k < 0) return;
    const it = items[k];
    const act = btn.dataset.ai;
    if (act === 'copy') copyText(it.text).then(ok => ok && toast('Kopierat.'));
    else if (act === 'quiz') { closeDrawer(); openQuiz(); }
    else if (act === 'doc') {
      const html = await renderMarkdown(it.text);
      const title = `${state.lecture.title} – ${it.label}`;
      download(safeName(title) + '.doc', '\ufeff<html><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5}</style></head><body><h1>' + escapeHtml(title) + '</h1>' + html + '</body></html>', 'application/msword');
    } else if (act === 'del') {
      // ta bort svaret och frågan som hörde till
      const start = k > 0 && items[k - 1].role === 'user' ? k - 1 : k;
      items.splice(start, k - start + 1);
      saveSoon();
      renderThread();
    }
  });
}

// ---------------------------------------------------------------- händelser
function bind() {
  $('homeLink').onclick = (e) => { e.preventDefault(); showStart(); };
  $('navLibrary').onclick = () => { showStart(); setTimeout(() => $('librarySection').scrollIntoView({ behavior: 'smooth' }), 50); };
  $('navNew').onclick = () => { showStart(); $('fileInput').click(); };

  $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; handleFile(f); };
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
  // släpp fil var som helst
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f || e.target.closest?.('#drop')) return;
    if (!$('workView').classList.contains('hidden') && sameFile(f, state.lecture)) {
      attachFile(f); updateResumeCard(); if (!state.lecture.done) startTranscription();
    } else handleFile(f);
  });

  $('attachInput').onchange = (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f && attachFile(f)) updateResumeCard();
  };
  $('resumeInput').onchange = (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!sameFile(f, state.lecture)) {
      toast('Det är inte samma fil som föreläsningen påbörjades med (namn eller storlek skiljer sig).', 5000);
      return;
    }
    attachFile(f);
    startTranscription();
  };
  $('resumeCard').querySelector('label').addEventListener('click', (e) => {
    if (state.file && state.lecture && fileKey(state.file) === state.lecture.id) { e.preventDefault(); startTranscription(); }
  });
  $('pauseBtn').onclick = () => {
    state.stopRequested = true;
    $('pauseBtn').disabled = true;
    $('progressTitle').textContent = 'Pausar efter nuvarande del…';
  };

  $('lectureTitle').addEventListener('change', (e) => {
    if (!state.lecture) return;
    state.lecture.title = e.target.value.trim() || state.lecture.name;
    saveSoon();
  });

  // spelare
  $('playBtn').onclick = () => {
    if (!state.file) { toast('Koppla videofilen först.'); return; }
    video.paused ? video.play() : video.pause();
  };
  video.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; });
  video.addEventListener('pause', () => { $('playBtn').textContent = '▶'; });
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('loadedmetadata', onTime);
  $('back10').onclick = () => { if (state.file) video.currentTime = Math.max(0, video.currentTime - 10); };
  $('fwd10').onclick = () => { if (state.file) video.currentTime += 10; };
  $('rate').onchange = (e) => { video.playbackRate = Number(e.target.value); };
  const seek = $('seek');
  seek.addEventListener('input', () => { seekDragging = true; });
  seek.addEventListener('change', () => {
    seekDragging = false;
    if (state.file && video.duration) video.currentTime = video.duration * seek.value / 1000;
  });

  // transkript – händelsedelegering
  const box = $('transcript');
  box.addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (!actEl || state.editing !== null) return;
    const act = actEl.dataset.act;
    if (act === 'seek-ch' || act === 'ai-ch') {
      const c = state.chapters[Number(actEl.dataset.ch)];
      if (act === 'seek-ch') seekTo(c.start);
      else explainChapter(c);
      return;
    }
    const host = actEl.closest('[data-i]');
    if (!host) return;
    const i = Number(host.dataset.i);
    const seg = segs()[i];
    if (act === 'seek') {
      if (e.detail > 1) return;                 // del av en dubbelklick
      if (getSelection()?.toString()) return;   // markerar text – hoppa inte
      // vänta lite så att en dubbelklick (redigera) inte först startar uppspelning
      clearTimeout(state.clickTimer);
      state.clickTimer = setTimeout(() => seekTo(seg.s), actEl.classList.contains('txt') ? 230 : 0);
    } else if (act === 'star') toggleStar(i);
    else if (act === 'ask') askAboutSegment(i);
    else if (act === 'edit') startEdit(i);
    else if (act === 'note') editNote(i);
    else if (act === 'copy') copyText(`[${fmtTime(seg.s, withHours())}] ${seg.t}`).then(ok => ok && toast('Kopierat.'));
  });
  box.addEventListener('dblclick', (e) => {
    const txt = e.target.closest('.seg .txt');
    if (!txt || state.editing !== null) return;
    clearTimeout(state.clickTimer);
    startEdit(Number(txt.closest('[data-i]').dataset.i));
  });
  window.addEventListener('wheel', () => { state.lastUserScroll = Date.now(); }, { passive: true });
  window.addEventListener('touchmove', () => { state.lastUserScroll = Date.now(); }, { passive: true });

  // filter / läge
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    state.filter = b.dataset.filter;
    renderTranscript();
  });
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === b));
    state.mode = b.dataset.mode;
    renderTranscript();
    if (state.currentIdx >= 0) scrollToSegment(state.currentIdx, true);
  });

  // sök
  let st = null;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(st);
    st = setTimeout(() => {
      state.search = e.target.value;
      renderTranscript();
      if (state.searchHits.length) gotoHit(1);
    }, 180);
  });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoHit(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.target.value = ''; state.search = ''; renderTranscript(); e.target.blur(); }
  });
  $('searchNext').onclick = () => gotoHit(1);
  $('searchPrev').onclick = () => gotoHit(-1);

  // export
  $('exportBtn').onclick = (e) => { e.stopPropagation(); $('exportMenu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('exportMenu').classList.add('hidden'));
  $('exportMenu').addEventListener('click', (e) => {
    const k = e.target.closest('[data-export]')?.dataset.export;
    if (k) exportAs(k);
  });

  $('aiBtn').onclick = () => openDrawer();
  bindAI();
  $('quizBtn').onclick = () => { if (!segs().length) { toast('Vänta tills det finns lite text.'); return; } openQuiz(); };
  $('quizClose').onclick = () => $('quizDialog').close();

  // kortkommandon
  document.addEventListener('keydown', (e) => {
    if ($('workView').classList.contains('hidden')) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && drawerOpen()) { if (aiState.busy) aiState.controller?.abort(); else closeDrawer(); return; }
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('searchInput').focus(); }
    else if (e.key === ' ' && state.file) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    else if (e.key === 'ArrowLeft' && state.file) { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); }
    else if (e.key === 'ArrowRight' && state.file) { e.preventDefault(); video.currentTime += 5; }
    else if ((e.key === 's' || e.key === 'S') && state.currentIdx >= 0 && !e.ctrlKey && !e.metaKey) { toggleStar(state.currentIdx); toast(segs()[state.currentIdx].star ? '⭐ Stjärnmärkt' : 'Stjärna borttagen', 1200); }
  });

  // spara direkt när fliken göms eller stängs
  window.addEventListener('pagehide', () => { saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  window.addEventListener('beforeunload', (e) => {
    if (state.running) { saveNow(); e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------------------------------------------------------------- start
bind();
showSysInfo();
renderLibrary();
if ('Notification' in window && Notification.permission === 'default') {
  // be om tillstånd först när användaren startar en transkribering
  $('fileInput').addEventListener('change', () => { try { Notification.requestPermission(); } catch {} }, { once: true });
}
