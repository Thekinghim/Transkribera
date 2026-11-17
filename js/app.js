import { openAudioSource, UserFacingError, formatBytes } from './audio.js';
import { db, fileKey, requestPersistence } from './db.js';
import {
  fmtTime, fmtDuration, cleanSegments, isCue, keywords, chapters, paragraphs, makeCards,
  PROMPTS, transcriptForAI, toTXT, toSRT, toMarkdown, toWordHTML, escapeHtml, escapeRe,
} from './study.js';

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
      setStatus(`Laddar ner modellen (bara första gången): ${Math.round(100 * l / t)} % av ${formatBytes(t)}`);
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
      <span class="pill ${lec.done ? 'done' : 'partial'}">${lec.done ? 'Klar' : `Pausad ${pct} %`}</span>
      <button class="btn small">Öppna</button>
      <button class="icon-btn" title="Ta bort">🗑</button>`;
    el.querySelector('.lib-name').textContent = lec.title || lec.name;
    el.querySelector('.lib-main').onclick = () => openLecture(lec);
    el.querySelector('.btn').onclick = () => openLecture(lec);
    el.querySelector('.icon-btn').onclick = async () => {
      if (state.running && state.lecture?.id === lec.id) { toast('Pausa transkriberingen först.'); return; }
      if (!confirm(`Ta bort "${lec.title || lec.name}"? Texten och dina markeringar raderas.`)) return;
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
  if (state.lecture?.id !== lec.id) {
    detachFile();
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
  if (state.lecture && fileKey(file) !== state.lecture.id) {
    // samma föreläsning men annan fil – tillåt för uppspelning om namnet/storleken stämmer ungefär
    if (file.size !== state.lecture.size) {
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
  $('resumeText').textContent = state.file && fileKey(state.file) === lec.id
    ? `Transkriberingen är pausad vid ${pct} %.`
    : `Transkriberingen är pausad vid ${pct} %. Välj samma fil (${lec.name}) igen för att fortsätta där du slutade.`;
  const label = card.querySelector('label');
  if (state.file && fileKey(state.file) === lec.id) {
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
      wakeLock.addEventListener('release', () => { wakeLock = null; });
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
  if (!state.file || fileKey(state.file) !== lec.id) { updateResumeCard(); return; }
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
    setStatus(workerDevice === 'webgpu' ? 'Använder grafikkortet (WebGPU).' : 'Använder processorn (WASM) – det tar längre tid.');

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
  let html = escapeHtml(text);
  const terms = [];
  if (state.search.trim()) terms.push(escapeRe(escapeHtml(state.search.trim())));
  if (state.keyword) terms.push(...state.keyword.forms.map(f => escapeRe(f)));
  if (!terms.length) return html;
  const re = new RegExp(`(${terms.join('|')})`, 'giu');
  // ersätt inte inne i HTML-entiteter
  return html.split(/(&[a-z#0-9]+;)/i).map(part => part.startsWith('&') && part.endsWith(';') ? part : part.replace(re, '<mark>$1</mark>')).join('');
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
      <button class="icon-btn" data-act="copy" title="Kopiera med tidsstämpel">📋</button>
    </div>
    ${seg.note ? `<div class="note"><div class="note-view" data-act="note">${escapeHtml(seg.note)}</div></div>` : ''}
  </div>`;
}

function renderTranscript() {
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
        if ($('followToggle').checked && !video.paused) scrollToSegment(idx);
      }
      const ci = state.chapters.findIndex(c => idx >= c.from && idx < c.to);
      document.querySelectorAll('#chapterList button').forEach((b, k) => b.classList.toggle('active', k === ci));
    }
  }
}
let seekDragging = false;

// ---------------------------------------------------------------- AI
function aiScopeSegments() {
  const scope = document.querySelector('input[name=scope]:checked')?.value || 'all';
  const s = segs();
  if (scope === 'star') return s.filter(x => x.star);
  if (scope === 'chapter') {
    const idx = state.currentIdx >= 0 ? state.currentIdx : 0;
    const c = chapterAt(idx);
    return c ? s.slice(c.from, c.to) : s;
  }
  return s;
}
function openAI(promptKey, segList, label) {
  if (!segList.length) { toast('Det finns ingen text i det valet än.'); return; }
  const title = state.lecture?.title || 'Föreläsning';
  const text = PROMPTS[promptKey].text + '\n\n---\n\n' + transcriptForAI(segList, title + (label ? ` – ${label}` : ''));
  const opened = window.open('https://claude.ai/new', '_blank', 'noopener');
  copyText(text).then(ok => {
    toast(ok ? 'Kopierat! Klistra in i Claude med Ctrl+V och tryck Enter.' : 'Kunde inte kopiera automatiskt – texten laddas ner som fil i stället.', 5000);
    if (!ok) download(safeName(title) + ' – AI-prompt.txt', text, 'text/plain;charset=utf-8');
  });
  if (!opened) toast('Tillåt popup-fönster för att öppna claude.ai automatiskt.');
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
function openAIDialog() {
  const grid = $('aiGrid');
  const descr = {
    summary: 'Strukturerad sammanfattning med rubriker, begrepp och tidsstämplar',
    flashcards: 'Fråga/svar-kort, även i Anki/Quizlet-format',
    quiz: 'Övningstenta med flerval, kortsvar och essäfrågor + facit',
    concepts: 'Svåra begrepp förklarade enkelt med exempel',
    plan: 'Pluggplan med pass och repetition',
    explain: 'Gå igenom texten steg för steg',
  };
  grid.innerHTML = '';
  for (const key of Object.keys(PROMPTS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-card';
    b.innerHTML = `<b>${PROMPTS[key].label}</b><small>${descr[key]}</small>`;
    b.onclick = () => {
      const list = aiScopeSegments();
      const scope = document.querySelector('input[name=scope]:checked')?.value;
      const c = scope === 'chapter' ? chapterAt(Math.max(0, state.currentIdx)) : null;
      openAI(key, list, scope === 'star' ? 'stjärnmärkta delar' : c ? `avsnitt: ${c.title}` : '');
      $('aiDialog').close();
    };
    grid.appendChild(b);
  }
  const c = chapterAt(Math.max(0, state.currentIdx));
  $('scopeChapterName').textContent = c ? `(${c.title})` : '';
  const words = segs().reduce((n, x) => n + x.t.split(/\s+/).length, 0);
  $('aiInfo').textContent = `Hela texten är ca ${words.toLocaleString('sv-SE')} ord. Mycket långa föreläsningar kan behöva ett betalt Claude-konto – välj då ett avsnitt eller det stjärnmärkta.`;
  $('aiDialog').showModal();
}

// ---------------------------------------------------------------- förhör
let quiz = null;
function openQuiz() {
  ensureDerived();
  const lec = state.lecture;
  const all = makeCards(segs(), state.keywords);
  lec.cards = lec.cards || {};
  // svårast först: låg låda, sedan senast sedda sist
  const order = all.map(c => ({ c, p: lec.cards[c.id] || { box: 0, seen: 0 } }))
    .sort((a, b) => a.p.box - b.p.box || a.p.seen - b.p.seen || a.c.s - b.c.s)
    .map(x => x.c);
  quiz = { cards: order.slice(0, 20), pos: 0, right: 0, wrong: 0, total: all.length };
  renderQuiz();
  $('quizDialog').showModal();
}
function renderQuiz() {
  const body = $('quizBody');
  const lec = state.lecture;
  if (!quiz.cards.length) {
    body.innerHTML = `<p>Förhöret bygger på meningar som du har <b>stjärnmärkt ⭐</b> och meningar där föreläsaren säger att något är <b>viktigt</b>. Hittade inga sådana än.</p>
    <p class="muted">Stjärnmärk de viktigaste meningarna i texten och försök igen – eller använd <b>✨ Plugga med AI → Flashcards</b>.</p>`;
    return;
  }
  if (quiz.pos >= quiz.cards.length) {
    const mastered = Object.values(lec.cards || {}).filter(p => p.box >= 3).length;
    body.innerHTML = `<div class="quiz-card"><div class="quiz-q">Bra jobbat! 🎉</div>
      <p>Du kunde <b>${quiz.right}</b> av ${quiz.cards.length}. ${quiz.wrong ? 'De du inte kunde kommer först nästa gång.' : ''}</p>
      <p class="muted">${mastered} av ${quiz.total} kort sitter riktigt bra (rätt 3 gånger i rad).</p></div>
      <div class="quiz-actions"><span></span><span><button class="btn" id="qAgain">Kör igen</button> <button class="btn primary" id="qDone">Klar</button></span></div>`;
    $('qAgain').onclick = openQuiz;
    $('qDone').onclick = () => $('quizDialog').close();
    return;
  }
  const card = quiz.cards[quiz.pos];
  const p = lec.cards[card.id] || { box: 0 };
  body.innerHTML = `
    <div class="quiz-actions"><span class="quiz-progress">Kort ${quiz.pos + 1} av ${quiz.cards.length}${card.starred ? ' · ⭐' : ''} · ${'●'.repeat(Math.min(p.box, 3))}${'○'.repeat(3 - Math.min(p.box, 3))}</span>
      <span class="quiz-stats"><span>✓ ${quiz.right}</span><span>✗ ${quiz.wrong}</span></span></div>
    <div class="quiz-card">
      <div class="quiz-q">${escapeHtml(card.question).replace('_____', '<b>_____</b>')}</div>
      <input class="quiz-input" id="qInput" placeholder="Skriv ordet som fattas (valfritt) och tryck Enter" autocomplete="off">
      <div class="quiz-a hidden" id="qA">
        <div class="answer">${escapeHtml(card.answer)}</div>
        <div id="qJudge" class="muted"></div>
        <button class="btn small ghost" id="qListen">▶ Lyssna på stället (${fmtTime(card.s, withHours())})</button>
      </div>
    </div>
    <div class="quiz-actions" id="qBtns">
      <button class="btn" id="qSkip">Hoppa över</button>
      <button class="btn primary" id="qShow">Visa svar</button>
    </div>`;
  const input = $('qInput');
  setTimeout(() => input.focus(), 50);
  const show = () => {
    $('qA').classList.remove('hidden');
    const guess = input.value.trim().toLowerCase();
    if (guess) {
      const ok = guess === card.answer.toLowerCase() || (guess.length >= 4 && card.answer.toLowerCase().startsWith(guess.slice(0, Math.max(4, guess.length - 2))));
      $('qJudge').textContent = ok ? '✓ Rätt!' : `Du skrev: ${input.value.trim()}`;
    }
    $('qBtns').innerHTML = `<button class="btn" id="qWrong">✗ Kunde inte</button><button class="btn primary" id="qRight">✓ Kunde</button>`;
    $('qWrong').onclick = () => grade(false);
    $('qRight').onclick = () => grade(true);
    $('qRight').focus();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if ($('qA').classList.contains('hidden')) show(); } };
  $('qShow').onclick = show;
  $('qSkip').onclick = () => { quiz.pos++; renderQuiz(); };
  $('qListen').onclick = () => { $('quizDialog').close(); seekTo(card.s); scrollToSegment(findIdx(card.s), true); };
  function grade(ok) {
    const prev = lec.cards[card.id] || { box: 0, seen: 0 };
    lec.cards[card.id] = { box: ok ? prev.box + 1 : 0, seen: Date.now() };
    ok ? quiz.right++ : quiz.wrong++;
    quiz.pos++;
    saveSoon();
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
    el.outerHTML = segHTML(seg, i);
    updateCounts();
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
  const done = () => {
    seg.note = ta.value.trim();
    saveSoon();
    el.outerHTML = segHTML(seg, i);
  };
  ta.addEventListener('blur', done, { once: true });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); ta.value = seg.note || ''; ta.blur(); }
  });
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
    if (!$('workView').classList.contains('hidden') && state.lecture && fileKey(f) === state.lecture.id) {
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
    if (fileKey(f) !== state.lecture.id) {
      toast('Det är inte samma fil som föreläsningen påbörjades med (namn, storlek eller datum skiljer sig).', 5000);
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
      else openAI('explain', segs().slice(c.from, c.to), `avsnitt: ${c.title}`);
      return;
    }
    const host = actEl.closest('[data-i]');
    if (!host) return;
    const i = Number(host.dataset.i);
    const seg = segs()[i];
    if (act === 'seek') {
      if (getSelection()?.toString()) return; // markerar text – hoppa inte
      seekTo(seg.s);
    } else if (act === 'star') toggleStar(i);
    else if (act === 'edit') startEdit(i);
    else if (act === 'note') editNote(i);
    else if (act === 'copy') copyText(`[${fmtTime(seg.s, withHours())}] ${seg.t}`).then(ok => ok && toast('Kopierat.'));
  });
  box.addEventListener('dblclick', (e) => {
    const txt = e.target.closest('.seg .txt');
    if (!txt || state.editing !== null) return;
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

  $('aiBtn').onclick = () => { if (!segs().length) { toast('Vänta tills det finns lite text.'); return; } openAIDialog(); };
  $('quizBtn').onclick = () => { if (!segs().length) { toast('Vänta tills det finns lite text.'); return; } openQuiz(); };
  $('quizClose').onclick = () => $('quizDialog').close();

  // kortkommandon
  document.addEventListener('keydown', (e) => {
    if ($('workView').classList.contains('hidden')) return;
    if (document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('searchInput').focus(); }
    else if (e.key === ' ' && state.file) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    else if (e.key === 'ArrowLeft' && state.file) { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); }
    else if (e.key === 'ArrowRight' && state.file) { e.preventDefault(); video.currentTime += 5; }
    else if ((e.key === 's' || e.key === 'S') && state.currentIdx >= 0 && !e.ctrlKey && !e.metaKey) { toggleStar(state.currentIdx); toast(segs()[state.currentIdx].star ? '⭐ Stjärnmärkt' : 'Stjärna borttagen', 1200); }
  });

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
