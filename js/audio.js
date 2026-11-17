// Ljudkällor: läser ljud ur stora filer utan att någonsin läsa in hela filen.
// Alla källor exponerar samma gränssnitt:
//   await src.open()            -> laddar metadata
//   src.duration                -> längd i sekunder
//   await src.read(start, end)  -> Float32Array, mono, 16 kHz, för [start, end)
//   src.close()

import { createFile, MP4BoxBuffer } from 'https://cdn.jsdelivr.net/npm/mp4box@2.5.0/dist/mp4box.all.mjs';

export const TARGET_RATE = 16000;
const SMALL_FILE_LIMIT = 400 * 1024 * 1024; // decodeAudioData läser in hela filen – bara för små filer
const READ_BATCH = 1024 * 1024;               // ca 1 MB per file.slice
const MAX_GAP = 64 * 1024;                    // slå ihop sampel som ligger nära varandra i filen

export class UserFacingError extends Error {}

const MP4_EXT = /\.(mp4|m4a|m4v|mov|3gp|3g2|m4b)$/i;
const MP4_BRANDS = /^(ftyp)$/;

export async function openAudioSource(file) {
  if (await looksLikeMp4(file)) {
    const src = new Mp4AudioSource(file);
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

async function looksLikeMp4(file) {
  if (file.size < 12) return false;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (MP4_BRANDS.test(type)) return true;
  // vissa MOV-filer börjar med wide/mdat/moov/free
  if (MP4_EXT.test(file.name) && /^(moov|mdat|wide|free|skip)$/.test(type)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Steg 1: hitta toppnivåboxar genom att bara läsa 16-byte-huvuden.
export async function scanTopLevelBoxes(file) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= file.size) {
    const dv = new DataView(await file.slice(off, Math.min(off + 16, file.size)).arrayBuffer());
    let size = dv.getUint32(0);
    const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
    let header = 8;
    if (size === 1) {
      if (dv.byteLength < 16) break;
      size = Number(dv.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = file.size - off; // boxen sträcker sig till filens slut
    }
    if (size < header || !/^[\x20-\x7e]{4}$/.test(type)) break; // trasig/okänd data
    boxes.push({ type, offset: off, size: Math.min(size, file.size - off), header });
    off += size;
  }
  return boxes;
}

class Mp4AudioSource {
  constructor(file) {
    this.file = file;
    this.kind = 'mp4';
  }

  async open() {
    const boxes = await scanTopLevelBoxes(this.file);
    const ftyp = boxes.find(b => b.type === 'ftyp');
    const moov = boxes.find(b => b.type === 'moov');
    if (!moov) {
      throw new UserFacingError('Hittade ingen "moov"-box i filen. Filen kan vara trasig eller ofullständigt nedladdad.');
    }
    if (moov.size > 512 * 1024 * 1024) {
      throw new UserFacingError('Filens metadata är orimligt stor – filen verkar vara trasig.');
    }
    const parts = [ftyp, moov].filter(Boolean);
    const total = parts.reduce((n, b) => n + b.size, 0);
    const joined = new Uint8Array(total);
    let pos = 0;
    for (const b of parts) {
      joined.set(new Uint8Array(await this.file.slice(b.offset, b.offset + b.size).arrayBuffer()), pos);
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

    // Steg 3: samplelista med absoluta filoffset
    const trak = mp4.getTrackById(track.id);
    const samples = trak?.samples || [];
    if (!samples.length) {
      const fragmented = info.isFragmented || boxes.some(b => b.type === 'moof');
      throw new UserFacingError(fragmented
        ? 'Filen är en fragmenterad MP4, vilket inte stöds än. Konvertera den till en vanlig MP4 (t.ex. med HandBrake) och försök igen.'
        : 'Ljudspåret innehåller inga ljuddata.');
    }

    const first = samples[0];
    const timescale = first.timescale || track.timescale;
    const entry = first.description;
    let codec = track.codec || '';
    let description;
    const dsi = entry?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    if (dsi) description = new Uint8Array(dsi);
    if (/^mp4a\.40$/.test(codec)) codec = 'mp4a.40.2';
    if (codec === 'mp4a') codec = 'mp4a.40.2';

    const sampleRate = track.audio?.sample_rate || entry?.samplerate || 48000;
    const channels = track.audio?.channel_count || entry?.channel_count || 2;

    if (typeof AudioDecoder === 'undefined') {
      throw new UserFacingError('Din webbläsare saknar WebCodecs. Använd en aktuell version av Chrome eller Edge.');
    }
    const config = { codec, sampleRate, numberOfChannels: channels };
    if (description) config.description = description;
    let support;
    try { support = await AudioDecoder.isConfigSupported(config); } catch { support = null; }
    if (!support?.supported) {
      throw new UserFacingError(`Ljudformatet (${codec || 'okänt'}) kan inte avkodas av webbläsaren. Konvertera filen till MP4 med AAC-ljud.`);
    }

    this.config = config;
    this.samples = samples;
    this.timescale = timescale;
    this.sampleRate = sampleRate;
    this.codec = codec;
    // Tid räknas från första samplets cts (ignorerar edit lists, skillnaden är några ms)
    this.t0 = samples[0].cts;
    const last = samples[samples.length - 1];
    this.duration = (last.cts + (last.duration || 1024) - this.t0) / timescale;
    // cts i sekunder för binärsökning
    this.times = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) this.times[i] = (samples[i].cts - this.t0) / timescale;
    this.mp4 = mp4;
  }

  indexAt(sec) {
    // första sample med tid >= sec
    let lo = 0, hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] < sec) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Steg 4: läs ljudsamplen med file.slice, avkoda med WebCodecs, mixa till mono, resampla.
  async read(start, end) {
    end = Math.min(end, this.duration);
    if (end <= start) return new Float32Array(0);
    // Starta två sampel tidigare så att AAC-avkodarens överlapp blir rätt, och kasta sedan överskottet
    const i0 = Math.max(0, this.indexAt(start) - 2);
    let i1 = this.indexAt(end);
    if (i1 < this.samples.length) i1 += 1;
    i1 = Math.min(i1, this.samples.length);

    const rate = this.sampleRate;
    const firstTime = this.times[i0];
    // Mono-PCM i källans samplingsfrekvens, med plats för lite marginal
    const cap = Math.ceil((this.times[i1 - 1] - firstTime + 1) * rate) + 8192;
    let mono = new Float32Array(cap);
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
            const bigger = new Float32Array(Math.max(mono.length * 1.5, pos + n + rate) | 0);
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
    decoder.configure(this.config);

    try {
      let i = i0;
      while (i < i1) {
        // gruppera sampel som ligger nära varandra i filen, upp till ~1 MB per läsning
        const bStart = this.samples[i].offset;
        let bEnd = bStart + this.samples[i].size;
        let j = i + 1;
        while (j < i1) {
          const s = this.samples[j];
          if (s.offset < bEnd || s.offset - bEnd > MAX_GAP) break;
          if (s.offset + s.size - bStart > READ_BATCH) break;
          bEnd = s.offset + s.size;
          j++;
        }
        const buf = new Uint8Array(await this.file.slice(bStart, bEnd).arrayBuffer());
        if (buf.byteLength < bEnd - bStart) {
          throw new UserFacingError('Filen tog slut tidigare än väntat – den kan vara ofullständigt nedladdad.');
        }
        for (let k = i; k < j; k++) {
          const s = this.samples[k];
          decoder.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round(((s.cts - this.t0) / this.timescale) * 1e6),
            duration: Math.round(((s.duration || 1024) / this.timescale) * 1e6),
            data: buf.subarray(s.offset - bStart, s.offset - bStart + s.size),
          }));
        }
        i = j;
        if (decodeError) throw decodeError;
        if (decoder.decodeQueueSize > 256) await waitForDequeue(decoder, 64);
      }
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

  close() { this.samples = null; this.times = null; this.mp4 = null; }
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

// ---------------------------------------------------------------------------
// Små filer i andra format (mp3, wav, webm, ogg ...): decodeAudioData.
class DecodedAudioSource {
  constructor(file) { this.file = file; this.kind = 'decoded'; }
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
