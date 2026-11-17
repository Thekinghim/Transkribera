// Plockar ut ljudspåret ur MPEG-TS (HLS-segment) som en ren AAC- (ADTS) eller MP3-ström.
// Används för "Bara ljud" när strömmen bara har TS-segment med video+ljud.
// Inget avkodas eller dekrypteras – bytes från ljud-PES-paketen kopieras rakt av.

const STREAM_TYPES = { 0x0f: 'aac', 0x03: 'mp3', 0x04: 'mp3' };

export function probeTsAudio(bytes) {
  const x = new TsAudioExtractor();
  x.push(bytes);
  return x.codec; // 'aac' | 'mp3' | null
}

export class TsAudioExtractor {
  constructor() {
    this.pmtPid = -1;
    this.audioPid = -1;
    this.codec = null;
    this.rest = null;
    this.inPes = false;
  }

  // Tar emot TS-bytes, returnerar ljud-bytes (kan vara tom).
  push(chunk) {
    let data = chunk;
    if (this.rest) {
      data = new Uint8Array(this.rest.length + chunk.length);
      data.set(this.rest); data.set(chunk, this.rest.length);
      this.rest = null;
    }
    const out = [];
    let total = 0;
    let i = 0;
    // Synka på första 0x47.
    while (i < data.length && data[i] !== 0x47) i++;
    for (; i + 188 <= data.length; i += 188) {
      if (data[i] !== 0x47) { // tappad synk – leta upp nästa
        while (i < data.length && data[i] !== 0x47) i++;
        i -= 188;
        continue;
      }
      const p = data.subarray(i, i + 188);
      const pusi = (p[1] & 0x40) !== 0;
      const pid = ((p[1] & 0x1f) << 8) | p[2];
      const afc = (p[3] >> 4) & 3;
      let off = 4;
      if (afc === 2 || afc === 0) continue;
      if (afc === 3) off += 1 + p[4];
      if (off >= 188) continue;
      if (pid === 0 && pusi) this.parsePat(p, off);
      else if (pid === this.pmtPid && pusi) this.parsePmt(p, off);
      else if (pid === this.audioPid && this.audioPid >= 0) {
        let payload = p.subarray(off);
        if (pusi) {
          if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) { this.inPes = false; continue; }
          const hdrLen = payload[8];
          payload = payload.subarray(9 + hdrLen);
          this.inPes = true;
        } else if (!this.inPes) continue;
        if (payload.length) { out.push(payload.slice()); total += payload.length; }
      }
    }
    if (i < data.length) this.rest = data.slice(i);
    if (out.length === 1) return out[0];
    const res = new Uint8Array(total);
    let o = 0;
    for (const b of out) { res.set(b, o); o += b.length; }
    return res;
  }

  parsePat(p, off) {
    off += 1 + p[off]; // pointer field
    const sectionLen = ((p[off + 1] & 0x0f) << 8) | p[off + 2];
    const end = Math.min(off + 3 + sectionLen - 4, 188);
    for (let j = off + 8; j + 4 <= end; j += 4) {
      const prog = (p[j] << 8) | p[j + 1];
      const pid = ((p[j + 2] & 0x1f) << 8) | p[j + 3];
      if (prog !== 0) { this.pmtPid = pid; break; }
    }
  }

  parsePmt(p, off) {
    off += 1 + p[off];
    const sectionLen = ((p[off + 1] & 0x0f) << 8) | p[off + 2];
    const end = Math.min(off + 3 + sectionLen - 4, 188);
    const progInfoLen = ((p[off + 10] & 0x0f) << 8) | p[off + 11];
    for (let j = off + 12 + progInfoLen; j + 5 <= end;) {
      const type = p[j];
      const pid = ((p[j + 1] & 0x1f) << 8) | p[j + 2];
      const esLen = ((p[j + 3] & 0x0f) << 8) | p[j + 4];
      if (this.audioPid < 0 && STREAM_TYPES[type]) {
        this.audioPid = pid;
        this.codec = STREAM_TYPES[type];
      }
      j += 5 + esLen;
    }
  }
}
