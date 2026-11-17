// HLS-hjälpfunktioner (delas av bakgrundsskriptet, popupen och nedladdningssidan).
// Tolkar m3u8-spellistor. Ingen dekryptering: krypterade strömmar markeras bara.

export function parseAttributes(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function resolve(uri, base) {
  try { return new URL(uri, base).href; } catch { return uri; }
}

function parseByteRange(str, lastEnd) {
  // "längd[@start]"
  const [len, off] = str.split('@');
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : lastEnd;
  return { offset: offset || 0, length };
}

// Returnerar { type: 'master' | 'media', ... }
export function parsePlaylist(text, baseUrl) {
  const lines = String(text).replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('Inte en giltig HLS-spellista');
  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, base) {
  const variants = [], media = [];
  let sessionKey = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(l.slice(18));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) break;
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        uri: resolve(lines[j], base),
        bandwidth: Number(a.BANDWIDTH) || 0,
        averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || 0,
        width: w || 0, height: h || 0,
        codecs: a.CODECS || '',
        audio: a.AUDIO || '',
        frameRate: Number(a['FRAME-RATE']) || 0,
      });
      i = j;
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(l.slice(13));
      media.push({
        type: a.TYPE, groupId: a['GROUP-ID'] || '', name: a.NAME || '', language: a.LANGUAGE || '',
        default: a.DEFAULT === 'YES', autoselect: a.AUTOSELECT === 'YES',
        uri: a.URI ? resolve(a.URI, base) : null,
      });
    } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttributes(l.slice(19));
      if (a.METHOD && a.METHOD !== 'NONE') sessionKey = { method: a.METHOD, keyformat: a.KEYFORMAT || '' };
    }
  }
  return { type: 'master', variants, media, encrypted: sessionKey };
}

function parseMedia(lines, base) {
  const segments = [];
  let duration = 0, map = null, encrypted = null, endList = false, targetDuration = 0;
  let segDur = 0, byterange = null, discontinuity = false;
  const lastEnd = new Map(); // uri -> slutposition för BYTERANGE utan start
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) {
      segDur = parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      byterange = l.slice(17);
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(l.slice(11));
      const uri = resolve(a.URI, base);
      map = { uri, byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(l.slice(11));
      if (a.METHOD && a.METHOD !== 'NONE') encrypted = encrypted || { method: a.METHOD, keyformat: a.KEYFORMAT || '' };
    } else if (l.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(l.slice(22)) || 0;
    } else if (l.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (l.startsWith('#EXT-X-DISCONTINUITY') && !l.startsWith('#EXT-X-DISCONTINUITY-')) {
      discontinuity = true;
    } else if (!l.startsWith('#')) {
      const uri = resolve(l, base);
      let br = null;
      if (byterange) {
        br = parseByteRange(byterange, lastEnd.get(uri) || 0);
        lastEnd.set(uri, br.offset + br.length);
      }
      segments.push({ uri, duration: segDur, byterange: br, map, discontinuity });
      duration += segDur;
      segDur = 0; byterange = null; discontinuity = false;
    }
  }
  const first = segments[0];
  const looksFmp4 = !!map || (first && /\.(m4s|mp4|m4a|m4v|cmf[va])(\?|$)/i.test(first.uri));
  return { type: 'media', segments, duration, encrypted, endList, targetDuration, format: looksFmp4 ? 'fmp4' : 'ts' };
}

// Är varianten bara ljud (t.ex. CODECS="mp4a.40.2" utan video)?
export function isAudioOnlyCodecs(codecs) {
  if (!codecs) return false;
  const list = codecs.split(',').map(s => s.trim().toLowerCase());
  return list.length > 0 && list.every(c => /^(mp4a|ac-3|ec-3|opus|flac|mp3|fla)/.test(c));
}

// Väljer det minsta alternativet som räcker för transkribering.
// Returnerar { uri, kind: 'audio-rendition' | 'audio-variant' | 'lowest-variant', label }
export function pickAudioOnly(master) {
  const audioRenditions = master.media.filter(m => m.type === 'AUDIO' && m.uri);
  const byBw = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth);
  if (audioRenditions.length) {
    // Föredra gruppen som den minsta varianten använder, och där DEFAULT=YES.
    const group = byBw.find(v => v.audio)?.audio;
    const inGroup = audioRenditions.filter(m => !group || m.groupId === group);
    const pick = (inGroup.find(m => m.default) || inGroup[0] || audioRenditions[0]);
    return { uri: pick.uri, kind: 'audio-rendition', label: pick.name || pick.language || 'ljud' };
  }
  const audioVariant = byBw.find(v => isAudioOnlyCodecs(v.codecs));
  if (audioVariant) return { uri: audioVariant.uri, kind: 'audio-variant', label: 'ljud' };
  if (byBw.length) return { uri: byBw[0].uri, kind: 'lowest-variant', label: variantLabel(byBw[0]) };
  return null;
}

export function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
  if (v.bandwidth) parts.push(formatBitrate(v.bandwidth));
  if (!parts.length) parts.push('okänd kvalitet');
  return parts.join(' · ');
}

export function formatBitrate(bps) {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1).replace('.', ',')} Mbit/s`;
  return `${Math.round(bps / 1e3)} kbit/s`;
}

export function formatBytes(n) {
  if (n == null || !isFinite(n)) return 'okänd storlek';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

export function formatDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s ? s + ' s' : ''}`.trim();
  return `${s} s`;
}

export function sanitizeFilename(name, fallback = 'forelasning') {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|%~#{}^`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s || fallback;
}

export function describeEncryption(enc) {
  if (!enc) return '';
  const fmt = (enc.keyformat || '').toLowerCase();
  if (enc.method.startsWith('SAMPLE-AES') || (fmt && fmt !== 'identity')) {
    return 'Den här strömmen är skyddad med DRM (kopieringsskydd) och kan inte sparas.';
  }
  return 'Den här strömmen är skyddad/krypterad och kan inte sparas med tillägget.';
}
