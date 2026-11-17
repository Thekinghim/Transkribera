import { sanitizeFilename, formatBytes, formatDuration, variantLabel, describeEncryption, pickAudioOnly } from './hls.js';

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const listEl = document.getElementById('list');
const nameEl = document.getElementById('filename');
let nameTouched = false;
nameEl.addEventListener('input', () => { nameTouched = true; });

const MIME_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'video/ogg': 'ogv', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/x-matroska': 'mkv',
};
const KNOWN_EXT = ['mp4', 'm4a', 'm4v', 'mov', 'webm', 'mp3', 'ogg', 'oga', 'ogv', 'mkv', 'wav', 'flac'];

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

async function getTabId() {
  if (params.get('tabId')) return Number(params.get('tabId'));
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id;
}

function directExt(item) {
  if (KNOWN_EXT.includes(item.ext)) return item.ext;
  const mime = (item.mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[mime] || (mime.startsWith('audio/') ? 'm4a' : 'mp4');
}

function typeLabel(item) {
  if (item.kind === 'hls') return { text: 'HLS-ström', audio: false };
  const ext = directExt(item);
  const audio = ['m4a', 'mp3', 'ogg', 'oga', 'wav', 'flac'].includes(ext) || (item.mime || '').startsWith('audio/');
  return { text: ext.toUpperCase() + (audio ? ' · ljud' : ''), audio };
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return `${u.host} · ${file}`;
  } catch { return url; }
}

function currentName() {
  return sanitizeFilename(nameEl.value);
}

async function load() {
  const tabId = await getTabId();
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'list', tabId });
  } catch (e) {
    res = { items: [], title: '' };
  }
  if (!nameTouched) nameEl.value = sanitizeFilename(res.title || '');
  render(res.items || []);
}

function render(items) {
  listEl.replaceChildren();
  if (!items.length) {
    listEl.append(el('div', { class: 'card empty' },
      el('strong', {}, 'Ingen video hittades ännu'),
      el('span', { class: 'muted small' },
        'Starta uppspelningen av föreläsningen en kort stund och tryck sedan på ”Sök igen”. ' +
        'Har sidan laddats innan tillägget installerades behöver du ladda om sidan.')));
    return;
  }
  for (const item of items) listEl.append(item.kind === 'hls' ? hlsCard(item) : directCard(item));
}

function directCard(item) {
  const t = typeLabel(item);
  const sizeEl = el('span', { class: 'size' }, item.size ? formatBytes(item.size) : 'okänd storlek');
  const status = el('span', { class: 'status' });
  const btn = el('button', { class: 'btn primary' }, 'Ladda ner');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Startar…';
    const filename = `${currentName()}.${directExt(item)}`;
    try {
      let id;
      try {
        id = await chrome.downloads.download({ url: item.url, filename, saveAs: !TEST });
      } catch {
        id = await chrome.downloads.download({ url: item.url, saveAs: !TEST });
      }
      status.textContent = 'Nedladdningen har startat – följ den i Chromes nedladdningar.';
      document.body.dataset.lastDownload = String(id);
    } catch (e) {
      status.textContent = 'Kunde inte starta nedladdningen: ' + (e.message || e);
      btn.disabled = false;
    }
  });
  if (!item.size) fillSize(item, sizeEl);
  return el('div', { class: 'card media-card', 'data-kind': 'direct' },
    el('div', { class: 'media-head' }, el('span', { class: 'tag' + (t.audio ? ' audio' : '') }, t.text), sizeEl),
    el('div', { class: 'media-url', title: item.url }, shortUrl(item.url)),
    el('div', { class: 'actions' }, btn, status));
}

async function fillSize(item, sizeEl) {
  try {
    const r = await fetch(item.url, { method: 'HEAD', credentials: 'include' });
    const n = Number(r.headers.get('content-length'));
    if (r.ok && n) { item.size = n; sizeEl.textContent = formatBytes(n); }
  } catch {}
}

function hlsCard(item) {
  const h = item.hls || {};
  const card = el('div', { class: 'card media-card', 'data-kind': 'hls' });
  const head = el('div', { class: 'media-head' }, el('span', { class: 'tag' }, 'HLS-ström'));
  const info = [];
  if (h.duration) info.push(formatDuration(h.duration));
  if (h.endList === false) info.push('direktsändning');
  head.append(el('span', { class: 'size' }, info.join(' · ')));
  card.append(head, el('div', { class: 'media-url', title: item.url }, shortUrl(item.url)));

  if (h.encrypted) {
    card.append(el('div', { class: 'notice error' }, describeEncryption(h.encrypted)));
    card.append(el('div', { class: 'actions' }, el('button', { class: 'btn primary', disabled: true }, 'Ladda ner')));
    return card;
  }
  if (h.error) card.append(el('div', { class: 'notice' }, 'Kunde inte läsa strömmens kvaliteter i förväg – försök ändå.'));

  const select = el('select', { 'aria-label': 'Kvalitet' });
  if (h.type === 'master' && h.variants?.length) {
    const sorted = [...h.variants].sort((a, b) => b.bandwidth - a.bandwidth);
    const audioGroups = new Set((h.audio || []).map(a => a.groupId));
    let separateAudio = false;
    sorted.forEach((v, i) => {
      const est = v.bandwidth && h.duration ? ` (ca ${formatBytes(v.bandwidth * h.duration / 8)})` : '';
      // Ljudet ligger i en egen ström => videofilen blir utan ljud.
      const noAudio = v.audio && audioGroups.has(v.audio);
      if (noAudio) separateAudio = true;
      select.append(el('option', { value: v.uri, title: variantLabel(v) }, (i === 0 ? 'Bästa: ' : '') + variantLabel(v, true) + est + (noAudio ? ' – utan ljud' : '')));
    });
    const audio = pickAudioOnly({ variants: h.variants, media: (h.audio || []).map(a => ({ ...a, type: 'AUDIO' })) });
    if (audio) {
      const opt = el('option', { value: 'audio' }, 'Bara ljud (minst fil, räcker för transkribering)');
      select.append(opt);
      if (separateAudio) {
        opt.selected = true;
        card.append(el('div', { class: 'notice' }, 'Den här strömmen har ljud och bild i separata delar. För transkribering: välj ”Bara ljud”. Videoalternativen sparas utan ljud.'));
      }
    }
  } else {
    select.append(el('option', { value: 'best' }, h.type === 'media' ? 'Video och ljud' : 'Enda tillgängliga kvalitet'));
    if (h.type === 'media' && h.format === 'ts') {
      select.append(el('option', { value: 'audio' }, 'Bara ljud (minst fil, räcker för transkribering)'));
    }
  }
  const btn = el('button', { class: 'btn primary' }, 'Ladda ner');
  const status = el('span', { class: 'status' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const id = Math.random().toString(36).slice(2);
    const job = { url: item.url, choice: select.value, name: currentName(), created: Date.now() };
    await chrome.storage.session.set({ ['job:' + id]: job });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`download.html?job=${id}`) });
    status.textContent = 'Öppnade nedladdningssidan.';
  });
  card.append(select, el('div', { class: 'actions' }, btn, status));
  return card;
}

document.getElementById('refresh').addEventListener('click', () => {
  listEl.replaceChildren(el('p', { class: 'muted center' }, 'Letar efter video…'));
  load();
});

load();
