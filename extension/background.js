// Bakgrundsskript: hittar video/ljud som laddas i varje flik.
import { parsePlaylist, pickAudioOnly } from './hls.js';

const MIN_SIZE = 500 * 1024;               // ignorera små filer (ikoner, ljudeffekter, init-segment)
const RANGE_PARAMS = ['range', 'bytes', 'byterange'];
const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const SEGMENT_TYPES = ['video/mp2t', 'video/iso.segment', 'audio/iso.segment', 'audio/mp2t', 'video/mp2ts'];
const SEGMENT_EXT = /\.(ts|m4s|m4f|cmfv|cmfa|aac|ac3|ec3|vtt|webvtt)$/i;
const MEDIA_EXT = /\.(mp4|m4a|m4v|mov|webm|mp3|ogg|oga|ogv|mkv|wav|flac)$/i;

// tabId -> { items: {key: item}, hidden: [hash...], title }
const state = {};
const ready = chrome.storage.session.get(null).then(all => {
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('tab:')) state[k.slice(4)] = v;
  }
}).catch(() => {});

function tab(tabId) {
  return (state[tabId] ||= { items: {}, hidden: [], title: '' });
}

const pendingSave = new Set();
function save(tabId) {
  if (pendingSave.has(tabId)) return;
  pendingSave.add(tabId);
  setTimeout(() => {
    pendingSave.delete(tabId);
    const t = state[tabId];
    if (t) chrome.storage.session.set({ ['tab:' + tabId]: t }).catch(() => {});
    else chrome.storage.session.remove('tab:' + tabId).catch(() => {});
  }, 50);
}

// Kort hash så att tusentals segment-adresser får plats i storage.session.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export function dedupeKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of RANGE_PARAMS) u.searchParams.delete(p);
    return u.href;
  } catch { return url; }
}

function header(details, name) {
  const h = (details.responseHeaders || []).find(x => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function extOf(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

// Avgör om en nätverksförfrågan är media som går att spara.
export function classify(url, contentType, status) {
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { return null; }
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (/\/playmanifest\//.test(path)) {
    // Kaltura: /playManifest/entryId/.../format/applehttp/... => HLS, format/url|download => fil
    if (/\/format\/(applehttp|hls)/.test(path) || HLS_TYPES.includes(ct)) return 'hls';
    if (/\/format\/(mpegdash|hdnetwork|rtmp|hds)/.test(path)) return null;
    if (status >= 300 && status < 400) return 'direct';
    if (ct.startsWith('video/') || ct.startsWith('audio/') || /\/format\/(url|download|http)/.test(path)) return 'direct';
    return null;
  }
  if (status >= 300) return null;
  if (HLS_TYPES.includes(ct) || path.endsWith('.m3u8')) return 'hls';
  if (SEGMENT_TYPES.includes(ct) || SEGMENT_EXT.test(path)) return null;
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'direct';
  if (MEDIA_EXT.test(path) && (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream')) return 'direct';
  return null;
}

function totalSize(details) {
  const cr = header(details, 'content-range');
  const m = cr.match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const cl = header(details, 'content-length');
  if (cl && details.statusCode === 200) return Number(cl);
  return null;
}

function updateBadge(tabId) {
  const n = visibleItems(tabId).length;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b5bdb' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

function visibleItems(tabId) {
  const t = state[tabId];
  if (!t) return [];
  const hidden = new Set(t.hidden);
  return Object.values(t.items)
    .filter(it => !hidden.has(hash(it.key)))
    .filter(it => !(it.size != null && it.size < MIN_SIZE && it.kind === 'direct'))
    .sort((a, b) => a.seen - b.seen);
}

async function addItem(tabId, data) {
  await ready;
  const t = tab(tabId);
  const key = dedupeKey(data.url);
  const prev = t.items[key];
  if (prev) {
    if (data.size && (!prev.size || data.size > prev.size)) prev.size = data.size;
    if (data.mime && !prev.mime) prev.mime = data.mime;
    if (data.source === 'net') prev.source = 'net';
  } else {
    t.items[key] = {
      key, url: data.url, kind: data.kind, mime: data.mime || '', size: data.size ?? null,
      ext: extOf(data.url), source: data.source, seen: data.time || Date.now(), pageUrl: data.pageUrl || '',
    };
  }
  try {
    const tb = await chrome.tabs.get(Number(tabId));
    if (tb?.title) t.title = tb.title;
  } catch {}
  save(tabId);
  updateBadge(tabId);
  if (data.kind === 'hls') analyzeHls(tabId, key);
  else if (!prev && t.items[key].size == null) probeSize(tabId, key);
}

// <video src> som innehållsskriptet hittat: hämta storleken (för att kunna sålla bort små filer).
async function probeSize(tabId, key) {
  const it = state[tabId]?.items[key];
  if (!it) return;
  try {
    const r = await fetch(it.url, { method: 'HEAD', credentials: 'include' });
    const n = Number(r.headers.get('content-length'));
    if (r.ok && n && it.size == null) {
      it.size = n;
      if (!it.mime) it.mime = (r.headers.get('content-type') || '').split(';')[0];
      save(tabId);
      updateBadge(tabId);
    }
  } catch {}
}

const analyzing = new Map(); // key -> tidpunkt
async function analyzeHls(tabId, key) {
  const t = state[tabId];
  const it = t?.items[key];
  if (!it) return;
  const last = analyzing.get(key);
  if (last && (Date.now() - last < 15000 || it.hls?.endList)) return;
  analyzing.set(key, Date.now());
  try {
    const res = await fetch(it.url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const pl = parsePlaylist(await res.text(), res.url || it.url);
    const hidden = new Set(); // läggs ihop med t.hidden synkront i slutet (undviker kapplöpning)
    if (pl.type === 'master') {
      // Delspellistor ska inte visas som egna rader – bara huvudspellistan.
      for (const v of pl.variants) hidden.add(hash(dedupeKey(v.uri)));
      for (const m of pl.media) if (m.uri) hidden.add(hash(dedupeKey(m.uri)));
      it.hls = {
        type: 'master',
        variants: pl.variants.map(v => ({ uri: v.uri, bandwidth: v.bandwidth, width: v.width, height: v.height, codecs: v.codecs, audio: v.audio })),
        audio: pl.media.filter(m => m.type === 'AUDIO' && m.uri).map(m => ({ uri: m.uri, name: m.name, groupId: m.groupId, language: m.language, default: m.default })),
        encrypted: pl.encrypted,
      };
      // Kolla minsta varianten för kryptering och längd.
      const smallest = [...pl.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
      const audio = pickAudioOnly(pl);
      const probeUri = audio?.uri || smallest?.uri;
      if (probeUri) {
        try {
          const r2 = await fetch(probeUri, { credentials: 'include' });
          const sub = parsePlaylist(await r2.text(), r2.url || probeUri);
          if (sub.type === 'media') {
            it.hls.duration = sub.duration;
            it.hls.endList = sub.endList;
            it.hls.format = sub.format;
            it.hls.encrypted = it.hls.encrypted || sub.encrypted;
            for (const s of sub.segments) hidden.add(hash(dedupeKey(s.uri)));
          }
        } catch {}
      }
    } else {
      for (const s of pl.segments) {
        hidden.add(hash(dedupeKey(s.uri)));
        if (s.map) hidden.add(hash(dedupeKey(s.map.uri)));
      }
      it.hls = {
        type: 'media', duration: pl.duration, endList: pl.endList, format: pl.format,
        encrypted: pl.encrypted, segments: pl.segments.length,
      };
    }
    t.hidden = [...new Set([...t.hidden, ...hidden])];
    save(tabId);
    updateBadge(tabId);
  } catch (e) {
    it.hls = it.hls || { error: String(e.message || e) };
    save(tabId);
  }
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0) return;
  if (details.initiator && details.initiator.startsWith('chrome-extension://')) return;
  if (details.type === 'main_frame') return;
  const ct = header(details, 'content-type');
  const kind = classify(details.url, ct, details.statusCode);
  if (!kind) return;
  const size = kind === 'direct' ? totalSize(details) : null;
  // Små filer ignoreras (men bara när storleken är känd).
  if (kind === 'direct' && size != null && size < MIN_SIZE) return;
  addItem(details.tabId, { url: details.url, kind, mime: ct, size, source: 'net', pageUrl: details.documentUrl || '', time: details.timeStamp });
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

// Ny sida i fliken => töm listan. Händelser kan komma i oväntad ordning när
// service workern just startat, så bara poster som syntes före navigeringen tas bort.
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.type !== 'main_frame' || details.tabId < 0) return;
  const navTime = details.timeStamp || Date.now();
  ready.then(() => {
    const t = state[details.tabId];
    if (!t) return;
    for (const [k, it] of Object.entries(t.items)) if (it.seen < navTime) delete t.items[k];
    if (!Object.keys(t.items).length) delete state[details.tabId];
    save(details.tabId);
    updateBadge(details.tabId);
  });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.tabs.onRemoved.addListener(tabId => {
  ready.then(() => { delete state[tabId]; save(tabId); });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Vänta på sparat tillstånd: annars kan en nyss väckt service worker nollställa märket.
  ready.then(() => {
    if (info.title && state[tabId]) { state[tabId].title = info.title; save(tabId); }
    if (info.status === 'complete') updateBadge(tabId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'dom-media' && sender.tab) {
    const tabId = sender.tab.id;
    (async () => {
      await ready;
      for (const url of msg.urls || []) {
        if (!/^https?:/i.test(url)) continue;
        let kind = classify(url, '', 200);
        if (!kind) {
          // <video src> utan känd filändelse – visa ändå, storleken hämtas i popupen.
          if (SEGMENT_EXT.test(url.split('?')[0])) continue;
          kind = 'direct';
        }
        await addItem(tabId, { url, kind, mime: '', size: null, source: 'dom', pageUrl: sender.url || '' });
      }
    })();
    return false;
  }
  if (msg?.type === 'list') {
    (async () => {
      await ready;
      const tabId = Number(msg.tabId);
      let title = state[tabId]?.title || '';
      try { title = (await chrome.tabs.get(tabId)).title || title; } catch {}
      // Analysera HLS som inte hunnit analyseras.
      const items = visibleItems(tabId);
      const pending = items.filter(it => it.kind === 'hls' && !it.hls).map(it => analyzeHls(tabId, it.key));
      if (pending.length) await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, 4000))]);
      sendResponse({ items: visibleItems(tabId), title });
    })();
    return true;
  }
  return false;
});
