// Transkriberingsmotorn. Körs på huvudtråden men rör aldrig DOM – app.js visar det motorn rapporterar.
//
//   const engine = createEngine({ source, model, startAt, prefs: { useCpu }, on: { … } });
//   await engine.start();      // klar när körningen slutat: engine.state = 'done' | 'paused' | 'error'
//   await engine.pause();      // klar inom ca 2 s; allt som sparats ligger kvar, resten görs om
//
// Händelser (on):
//   status({ phase:'loading'|'running', text })    vad som händer, på svenska
//   backend({ id, device, label, threads })         vilken motor som används
//   notice(text)                                    något användaren bör få veta (t.ex. byte till processorn)
//   progress({ fraction, position, speed, etaSec })
//   commit({ segments:[{start,end,text}], cursor }) färdig text (absoluta tider) och ny position – spara dessa
//   done({ cursor }) / paused({ cursor }) / error({ code, message, cause })
//
// Uppbyggnad:
//   AudioReader   läser ljudet i större bitar i förväg, så att avkodningen aldrig bromsar modellen
//   WorkerHost    en worker med en laddad modell; vakthund, krascher och avbrott hanteras här
//   Engine        fönster för fönster: tystnad -> modell -> rimlighetskontroll -> spara -> nästa
import {
  SAMPLE_RATE, WINDOW_S, MIN_ADVANCE_S, MODELS,
  analyseWindow, planWindowAudio, planCommit, activeSeconds,
  checkWindow, textSimilarity, dropRepeatedPieces,
  backendChain, pickThreads, BackendMemory, ProgressMeter,
} from './engine-logic.js';

export { isGarbageText } from './engine-logic.js';

const DEFAULTS = {
  firstReadS: 40,          // första läsningen är kort så att text syns snabbt
  chunkS: 150,             // sedan läses ljudet 2,5 min åt gången …
  aheadS: 180,             // … så att minst så här mycket alltid ligger färdigt framför modellen
  pauseGraceMs: 1500,      // så länge får pågående fönster på sig vid paus innan workern stängs
  loadIdleMs: { webgpu: 120_000, wasm: 240_000 },                 // inget livstecken under laddning
  runIdleMs: { webgpu: 45_000, wasm: 120_000, wasmSmall: 300_000 }, // inget livstecken under ett fönster
  maxRestartsPerWindow: 2, // omstarter av en kraschad motor för samma fönster
  maxRestartsPerRun: 8,
  maxNewTokens: 224,       // Whispers egen gräns per fönster (halva kontexten)
  strikesToDemote: 2,      // så många bekräftat felaktiga fönster innan grafikkortet väljs bort
  agreeToTrust: 3,         // så många falsklarm innan grafikkortet slutar dubbelkollas
  verify: true,            // dubbelkolla misstänkta fönster från grafikkortet på processorn
  allowSoftwareGpu: false, // använd WebGPU även utan riktigt grafikkort (bara för tester)
};

class EngineError extends Error {
  constructor(code, message, cause) { super(message); this.code = code; this.cause = cause; }
}
class StopSignal extends Error { constructor() { super('STOP'); this.code = 'STOP'; } }

const memory = new BackendMemory(typeof localStorage === 'undefined' ? null : localStorage);
/** Glöm vilka motorer som fungerat (grafikkortet provas på nytt nästa gång). */
export function forgetBackendMemory() { memory.forget(); }
/** Har grafikkortet valts bort för någon modell efter att ha gett fel? */
export function gpuRemembered() { return Object.keys(MODELS).some(m => !!memory.get(m).bad.webgpu); }

// Finns ett riktigt grafikkort för WebGPU? En mjukvaruadapter (t.ex. SwiftShader) räknas inte:
// den är mångdubbelt långsammare än processorn via WASM (uppmätt: 135 s för en kodarkörning).
let webgpuProbe = null;
function hasWebGPU(allowSoftware = false) {
  webgpuProbe ??= (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      return { software: !!(adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter) };
    } catch { return null; }
  })();
  return webgpuProbe.then(a => !!a && (allowSoftware || !a.software));
}
/** Kan grafikkortet användas för transkribering på den här datorn? */
export function webgpuUsable() { return hasWebGPU(globalThis.__transkriberaTuning?.allowSoftwareGpu); }

// ---------------------------------------------------------------- ljudläsare
/** Läser framåt i källan i större bitar och håller en begränsad buffert framför läspositionen. */
class AudioReader {
  constructor(source, duration, startAt, { firstReadS, chunkS, aheadS }) {
    this.source = source; this.duration = duration;
    this.firstReadS = firstReadS; this.chunkS = chunkS; this.aheadS = aheadS;
    this.parts = [];            // { start, end, data } i stigande ordning, sammanhängande
    this.readTo = startAt;      // hit är läsningar beställda
    this.pos = startAt;         // hit har motorn hunnit
    this.pending = null; this.error = null; this.closed = false; this.first = true;
    this._pump();
  }
  get loadedTo() { return this.parts.length ? this.parts[this.parts.length - 1].end : this.pos; }
  has(end) { return this.loadedTo >= Math.min(end, this.duration) - 1e-3; }
  _pump() {
    if (this.closed || this.pending || this.error || this.readTo >= this.duration - 1e-3) return;
    if (this.readTo - this.pos >= this.aheadS) return;
    const a = this.readTo, b = Math.min(this.duration, a + (this.first ? this.firstReadS : this.chunkS));
    this.first = false; this.readTo = b;
    this.pending = Promise.resolve().then(() => this.source.read(a, b)).then(
      (data) => { this.pending = null; if (this.closed) return; this.parts.push({ start: a, end: b, data }); this._pump(); },
      (e) => { this.pending = null; this.error = e; },
    );
  }
  /** Ljudet för [start, end) som en egen Float32Array. */
  async get(start, end) {
    end = Math.min(end, this.duration);
    this.pos = start;
    while (this.parts.length && this.parts[0].end <= start) this.parts.shift();
    this._pump();
    while (!this.has(end)) {
      if (this.error) throw this.error;
      if (this.closed) throw new StopSignal();
      if (!this.pending) this._pump();
      if (!this.pending && !this.has(end)) break;   // källan gav mindre än utlovat
      await this.pending;
    }
    if (this.error && !this.has(end)) throw this.error;
    const out = new Float32Array(Math.max(0, Math.round((end - start) * SAMPLE_RATE)));
    for (const p of this.parts) {
      if (p.end <= start || p.start >= end) continue;
      const from = Math.max(start, p.start);
      const src = Math.round((from - p.start) * SAMPLE_RATE), dst = Math.round((from - start) * SAMPLE_RATE);
      const n = Math.min(p.data.length - src, out.length - dst, Math.round((Math.min(end, p.end) - from) * SAMPLE_RATE));
      if (n > 0) out.set(p.data.subarray(src, src + n), dst);
    }
    return out;
  }
  close() { this.closed = true; this.parts = []; }
}

// ---------------------------------------------------------------- worker
let hostSeq = 0;
/** En worker med (högst) en laddad modell. Ett anrop åt gången. Varje fel gör workern obrukbar. */
class WorkerHost {
  constructor(key) {
    this.key = key; this.n = ++hostSeq;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.dead = false; this.loaded = null; this.pending = null; this.reqId = 0;
    this.lastBeat = performance.now(); this.onEvent = null;
    this.abort = null;
    try { if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') this.abort = new Int32Array(new SharedArrayBuffer(4)); } catch {}
    this.worker.onmessage = (ev) => this._message(ev.data || {});
    this.worker.onerror = (e) => { e.preventDefault?.(); this.kill('CRASH', e.message || 'Workern kraschade'); };
    this.worker.onmessageerror = () => this.kill('CRASH', 'Oläsbart svar från workern');
  }
  _message(m) {
    this.lastBeat = performance.now();
    if (m.ev === 'tick' || m.ev === 'download' || m.ev === 'stage') { this.onEvent?.(m); return; }
    // varje fel gör workern obrukbar: den stängs och pågående anrop avvisas med felkoden
    if (m.ev === 'error') { this.kill(m.code || 'CRASH', m.message); return; }
    const p = this.pending;
    if (!p || m.id !== p.id) return;
    this.pending = null;
    p.resolve(m);
  }
  /** Skickar ett anrop. Avvisas med EngineError(kod) vid fel, krasch, tidsgräns eller kill(). */
  request(msg, transfer = []) {
    if (this.dead) return Promise.reject(new EngineError('CRASH', 'Workern är stängd'));
    if (this.pending) return Promise.reject(new EngineError('BAD_REQUEST', 'Upptagen'));
    const id = ++this.reqId;
    this.lastBeat = performance.now();
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      try { this.worker.postMessage({ ...msg, id }, transfer); } catch (e) { this.kill('CRASH', e.message); }
    });
  }
  /**
   * Anrop med vakthund: kommer inget livstecken på idleMs stängs workern och anropet avvisas med
   * TIMEOUT. Har sidan själv stått still (datorn sov, fliken strypt i bakgrunden) börjar väntan om –
   * annars skulle ett friskt grafikkort dömas ut efter att locket fällts ner.
   */
  async guarded(msg, transfer, idleMs) {
    const every = Math.min(1000, Math.max(50, idleMs / 4));
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - lastTick > every * 3 + 2000) this.lastBeat = now;
      lastTick = now;
      if (now - this.lastBeat > idleMs) this.kill('TIMEOUT', 'Inget svar från modellen');
    }, every);
    try { return await this.request(msg, transfer); } finally { clearInterval(timer); }
  }
  requestAbort() { if (this.abort) Atomics.store(this.abort, 0, 1); return !!this.abort; }
  clearAbort() { if (this.abort) Atomics.store(this.abort, 0, 0); }
  get idle() { return !this.dead && !this.pending && !!this.loaded; }
  kill(code = 'KILLED', message = '') {
    if (this.dead) return;
    this.dead = true;
    try { this.worker.terminate(); } catch {}
    const p = this.pending; this.pending = null;
    p?.reject(new EngineError(code, message || code));
  }
}

// En vilande, laddad worker sparas mellan körningar så att "Fortsätt" efter paus går direkt.
let parked = null;
/** Stänger sparade workers (t.ex. när inställningen för processor/grafikkort ändras). */
export function releaseWorkers() { parked?.kill('RELEASED'); parked = null; }

// ---------------------------------------------------------------- motorn
const fmt = (sec, withHours) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, '0');
  return (h || withHours) ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
const fmtMB = (n) => n >= 1e9 ? (n / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.round(n / 1e6) + ' MB';
const joinText = (pieces) => pieces.map(p => p.text || '').join(' ').replace(/\s+/g, ' ').trim();

class Engine {
  constructor({ source, model = 'base', startAt = 0, prefs = {}, on = {}, tuning = {} }) {
    if (!source || !(source.duration > 0)) throw new Error('Ljudkälla saknas');
    this.source = source;
    this.model = MODELS[model] ? model : 'base';
    this.duration = source.duration;
    this.cursor = Math.max(0, Math.min(startAt || 0, this.duration));
    this.prefs = prefs;
    this.on = on;
    this.t = { ...DEFAULTS, ...tuning };
    this.state = 'idle';
    this.backend = null;        // aktiv motor ur kedjan
    this.primary = null;        // WorkerHost för aktiv motor
    this.reference = null;      // WorkerHost för nästa motor i kedjan (dubbelkoll)
    this.stats = { windows: 0, skippedS: 0, verified: 0, restarts: 0, fallbacks: [] };
    this._stop = false; this._finished = false; this._donePromise = null; this._pauseWaiters = [];
    this._perBackend = new Map(); // id -> { windows, strikes, agree, trusted, crashes }
    this._hosts = new Set();      // alla workers den här körningen startat och inte stängt
  }

  // ---- utåt
  start() {
    if (this._donePromise) return this._donePromise;
    this._donePromise = new Promise((resolve) => { this._resolveDone = resolve; });
    this._main();
    return this._donePromise;
  }
  /** Pausar. Löftet uppfylls när motorn står still – inom pauseGraceMs + en liten marginal. */
  pause() {
    if (this._finished || this.state === 'idle') return Promise.resolve(this.state);
    const waiter = new Promise((resolve) => this._pauseWaiters.push(resolve));
    if (!this._stop) {
      this._stop = true;
      this.state = 'pausing';
      // Pågående fönster avbryts vid nästa token om minnet är delat (workern lever då kvar till
      // nästa körning). Laddning och workers utan delat minne går bara att avbryta genom att stänga dem.
      for (const host of this._hosts) {
        if (host.pending && !(host.loaded && host.requestAbort())) host.kill('PAUSED');
      }
      // sista utväg: står motorn inte still inom tidsgränsen stängs allt
      this._graceTimer = setTimeout(() => {
        for (const host of this._hosts) if (host.pending) host.kill('PAUSED');
        this._finish('paused');
      }, this.t.pauseGraceMs);
    }
    return waiter;
  }

  // ---- intern livscykel
  _emit(name, payload) {
    if (this._finished && name !== 'done' && name !== 'paused' && name !== 'error') return;
    try { this.on[name]?.(payload); } catch (e) { console.error(e); }
  }
  _status(text, phase = this._phase) { this._phase = phase; this._emit('status', { phase, text }); }
  _checkStop() { if (this._stop || this._finished) throw new StopSignal(); }

  async _main() {
    this.state = 'loading';
    try {
      await this._run();
      this._finish('done');
    } catch (e) {
      if (this._stop || e instanceof StopSignal) this._finish('paused');
      else this._finish('error', e);
    }
  }

  _finish(state, error = null) {
    if (this._finished) return;
    this._finished = true;
    clearTimeout(this._graceTimer);
    clearInterval(this._ticker);
    this.state = state;
    this.reader?.close();
    // behåll en frisk, vilande worker till nästa körning; stäng allt annat
    const keep = this.primary?.idle && state !== 'error' ? this.primary : null;
    for (const host of this._hosts) if (host !== keep) host.kill('DONE');
    this._hosts.clear(); this.primary = null; this.reference = null;
    if (keep) { keep.clearAbort(); keep.onEvent = null; releaseWorkers(); parked = keep; }
    if (state === 'done') { this.cursor = this.duration; this._emit('done', { cursor: this.cursor, stats: this.stats }); }
    else if (state === 'paused') this._emit('paused', { cursor: this.cursor });
    else {
      console.error('[motor]', error);
      const known = error instanceof EngineError;
      this._emit('error', {
        code: known ? error.code : 'INTERNAL',
        message: known ? error.message : `Fel: ${error?.message || error}`,
        cause: known ? error.cause : error,
      });
    }
    for (const w of this._pauseWaiters.splice(0)) w(state);
    this._resolveDone?.(state);
  }

  // ---- motorval och laddning
  _stat(id) {
    let s = this._perBackend.get(id);
    if (!s) this._perBackend.set(id, s = { windows: 0, strikes: 0, agree: 0, trusted: false, crashes: 0 });
    return s;
  }

  async _buildChain() {
    const all = backendChain({ webgpu: await hasWebGPU(this.t.allowSoftwareGpu), useCpu: !!this.prefs.useCpu, model: this.model });
    this._checkStop();
    const bad = memory.get(this.model).bad;
    // motorer som tidigare gett fel hoppas över – men den sista (processorn) finns alltid kvar
    this.chain = all.filter((b, i) => i === all.length - 1 || !bad[b.id]);
    this.skippedBad = all.filter(b => !this.chain.includes(b)).map(b => ({ id: b.id, why: bad[b.id] }));
    this.bi = 0;
    this.threads = pickThreads(navigator.hardwareConcurrency, globalThis.crossOriginIsolated === true);
  }

  _hostKey(b) { return `${this.model}|${b.id}|${b.device === 'wasm' ? this.threads : 0}|${JSON.stringify(b.dtype)}`; }

  /** Laddar en motor i en ny (eller sparad) worker. Kastar EngineError vid fel. */
  async _load(b, { quiet = false } = {}) {
    this._checkStop();
    const key = this._hostKey(b);
    if (parked && parked.key === key && parked.idle) { const h = parked; parked = null; h.clearAbort(); this._hosts.add(h); return h; }
    if (parked) releaseWorkers();   // en annan modell ligger laddad: frigör minnet först
    const host = new WorkerHost(key);
    this._hosts.add(host);
    const files = new Map();
    let downloading = false;
    host.onEvent = (m) => {
      if (quiet) return;
      if (m.ev === 'download' && m.total && /\.onnx/.test(m.file || '')) {   // bara själva modellfilerna, inte småfilerna
        files.set(m.file, { loaded: m.loaded, total: m.total });
        let l = 0, t = 0;
        for (const f of files.values()) { l += f.loaded; t += f.total; }
        // filer som redan ligger i webbläsarens cache "laddas" på ett ögonblick – visa bara riktig nedladdning
        if (l < t) downloading = true;
        if (downloading) this._status(`Laddar ner modellen: ${Math.floor(100 * l / t)} % av ${fmtMB(t)} (bara första gången – sedan är den sparad i webbläsaren).`, 'loading');
      } else if (m.ev === 'stage' && !note) {
        this._status(`Startar modellen på ${b.label}…`, 'loading');
      }
    };
    // efter en krasch står det varför modellen laddas igen
    const note = this._loadNote; this._loadNote = null;
    if (!quiet) this._status(note ? `${note} – startar om den på ${b.label}…` : `Laddar modellen för ${b.label}…`, 'loading');
    try {
      const r = await host.guarded({
        op: 'load', repo: MODELS[this.model].repo, device: b.device, dtype: b.dtype, threads: this.threads, abort: host.abort?.buffer,
      }, [], this.t.loadIdleMs[b.device]);
      host.loaded = r;
      host.onEvent = null;
      return host;
    } catch (e) {
      host.kill('LOAD'); this._hosts.delete(host);
      throw e;
    }
  }

  /** Ser till att aktiv motor är laddad; går vidare i kedjan om en motor inte går att ladda. */
  async _ensurePrimary() {
    for (;;) {
      this._checkStop();
      if (this.primary && !this.primary.dead) return;
      const b = this.chain[this.bi];
      const isLast = this.bi === this.chain.length - 1;
      // en redan laddad kontrollmotor kan tas i bruk direkt
      if (this.reference && !this.reference.dead && this.reference.key === this._hostKey(b)) {
        this.primary = this.reference; this.reference = null;
      } else {
        try {
          this.primary = await this._load(b);
        } catch (e) {
          if (this._stop) throw new StopSignal();
          if (isLast) throw this._loadError(e, b);
          // Hängde sig grafikkortet redan vid provkörningen minns vi det; andra laddfel (t.ex. nätet) glöms.
          this._fallback(b, e.code === 'TIMEOUT' ? 'hang' : 'load', e.code === 'TIMEOUT');
          continue;
        }
      }
      this.backend = b;
      this._emit('backend', { id: b.id, device: b.device, label: b.label, threads: b.device === 'wasm' ? this.primary.loaded?.threads ?? this.threads : 0, model: this.model, remembered: this.skippedBad });
      return;
    }
  }

  _loadError(e, b) {
    if (e.code === 'TIMEOUT') return new EngineError('LOAD_TIMEOUT', `Modellen gick inte att starta på ${b.label} (inget svar). Kontrollera nätanslutningen och försök igen.`, e);
    return new EngineError('LOAD_FAILED', `Modellen kunde inte laddas (${e.message}). Kontrollera nätanslutningen och försök igen.`, e);
  }

  /** Lämnar aktiv motor och går till nästa i kedjan. persist = kom ihåg till nästa gång. */
  _fallback(b, why, persist) {
    this._drop('primary');
    if (persist) memory.markBad(this.model, b.id, why);
    this.stats.fallbacks.push({ from: b.id, why, persist });
    this.bi = Math.min(this.bi + 1, this.chain.length - 1);
    const next = this.chain[this.bi];
    const text = {
      garbage: `${cap(b.label)} gav felaktig text – byter till ${next.label} och gör om delen.`,
      strikes: `${cap(b.label)} gav felaktig text – byter till ${next.label}.`,
      hang: `${cap(b.label)} svarade inte – byter till ${next.label} och fortsätter.`,
      crash: `${cap(b.label)} kraschade – byter till ${next.label} och fortsätter.`,
      load: `Modellen gick inte att starta på ${b.label} – byter till ${next.label}.`,
    }[why] || `Byter till ${next.label}.`;
    this._emit('notice', text);
    this._status(text);
  }

  _drop(which) {
    const host = this[which];
    if (host) { host.kill('DROPPED'); this._hosts.delete(host); }
    this[which] = null;
  }

  // ---- ett fönster
  _idleLimit(b) {
    if (b.device === 'webgpu') return this.t.runIdleMs.webgpu;
    return this.model === 'small' ? this.t.runIdleMs.wasmSmall : this.t.runIdleMs.wasm;
  }

  async _runOn(host, b, win, gen = {}) {
    const audio = win.slice();   // kopia: originalet behövs om fönstret måste göras om
    const r = await host.guarded({ op: 'transcribe', audio, maxNewTokens: this.t.maxNewTokens, ...gen }, [audio.buffer], this._idleLimit(b));
    if (r.stats?.aborted) throw new StopSignal();
    return r;
  }

  /**
   * Kör modellen på ett fönster och returnerar godkända textbitar. Sköter omstart efter krasch,
   * byte av motor, dubbelkoll av misstänkt text och sista utvägar. Sparar aldrig skräp.
   */
  async _transcribeWindow(win, activeS, describe) {
    let restarts = 0, hardFails = 0, retriedSoft = false, gen = {};
    const began = performance.now();   // all tid som går åt till fönstret räknas, även omstarter och omräkningar
    for (;;) {
      this._checkStop();
      await this._ensurePrimary();
      this._status(describe(this.backend), 'running');
      const b = this.backend, st = this._stat(b.id), isLast = this.bi === this.chain.length - 1;
      let r;
      try {
        r = await this._runOn(this.primary, b, win, gen);
      } catch (e) {
        if (this._stop || e instanceof StopSignal) throw new StopSignal();
        // krasch, fel i beräkningen eller ingen reaktion
        this._drop('primary');
        st.crashes++; restarts++; this.stats.restarts++;
        const hang = e.code === 'TIMEOUT';
        if (!isLast && (hang || st.crashes >= 2)) { this._fallback(b, hang ? 'hang' : 'crash', true); restarts = 0; continue; }
        if (restarts > this.t.maxRestartsPerWindow || this.stats.restarts > this.t.maxRestartsPerRun) {
          throw new EngineError(hang ? 'HANG' : 'CRASH', hang
            ? 'Modellen slutade svara flera gånger. Försök fortsätta, eller ladda om sidan.'
            : `Modellen kraschade flera gånger (${e.message}). Försök fortsätta, eller ladda om sidan.`, e);
        }
        this._loadNote = hang ? 'Modellen svarade inte' : 'Modellen kraschade';
        continue;
      }
      const wallMs = performance.now() - began;
      st.windows++;
      const text = joinText(r.pieces);
      const v = checkWindow({ text, activeS, hitMax: r.stats.hitMax, avgLogprob: r.stats.avgLogprob });
      if (v.ok) {
        if (st.windows === 3 && !st.strikes) memory.markGood(this.model, b.id);
        return { pieces: r.pieces, wallMs, stats: r.stats };
      }

      if (!isLast) {
        if (v.hard) { this._fallback(b, 'garbage', true); continue; }
        if (!st.trusted && this.t.verify) {
          const out = await this._verify(win, activeS, r, v, b, st);
          return { ...out, wallMs: performance.now() - began };
        }
      } else if (v.hard) {
        // skräp även från sista motorn: starta om en gång, ge sedan upp utan att spara något
        this._drop('primary');
        if (++hardFails >= 2) throw new EngineError('GARBAGE', 'Modellen ger felaktig text även på processorn. Ladda om sidan och försök igen – inget felaktigt har sparats.');
        continue;
      }
      // misstänkt men inte skräp, och ingen annan motor att fråga
      if (!retriedSoft && (v.kind === 'repetition' || v.kind === 'runaway')) {
        retriedSoft = true; gen = { noRepeatNgram: 3 };   // gör om med spärr mot upprepningar
        continue;
      }
      return { pieces: salvage(r.pieces, v), wallMs: performance.now() - began, stats: r.stats, verdict: v };
    }
  }

  /**
   * Misstänkt text från grafikkortet: räkna om fönstret på nästa motor och jämför.
   * Returnerar bitarna som ska sparas. Ger kontrollen upprepat rätt och grafikkortet fel väljs
   * grafikkortet bort; är de överens beror det på ljudet och grafikkortet behålls.
   */
  async _verify(win, activeS, r, v, b, st) {
    const nb = this.chain[this.bi + 1];
    this._status(`Kontrollerar en osäker del med ${nb.label}…`);
    this.stats.verified++;
    let ref;
    try {
      if (!this.reference || this.reference.dead) this.reference = await this._load(nb, { quiet: true });
      ref = await this._runOn(this.reference, nb, win);
    } catch (e) {
      if (this._stop || e instanceof StopSignal) throw new StopSignal();
      this._drop('reference');
      // kontrollmotorn gick inte att använda: behåll det som går att rädda från första försöket
      return { pieces: salvage(r.pieces, v), stats: r.stats, verdict: v };
    }
    const refText = joinText(ref.pieces);
    const rv = checkWindow({ text: refText, activeS, hitMax: ref.stats.hitMax, avgLogprob: ref.stats.avgLogprob });
    const similar = textSimilarity(joinText(r.pieces), refText) >= 0.5;
    if (rv.ok && !similar) {
      // kontrollen gav riktig text som skiljer sig: aktiv motor räknade fel
      st.strikes++;
      if (st.strikes >= this.t.strikesToDemote && st.strikes >= 0.2 * st.windows) this._fallback(b, 'strikes', true);
      return { pieces: ref.pieces, stats: ref.stats };
    }
    // båda säger samma sak (eller är lika osäkra): det är ljudet, inte motorn
    if (++st.agree >= this.t.agreeToTrust) st.trusted = true;
    return rv.ok ? { pieces: ref.pieces, stats: ref.stats } : { pieces: salvage(ref.pieces, rv), stats: ref.stats, verdict: rv };
  }

  // ---- huvudslingan
  async _run() {
    await this._buildChain();
    this.reader = new AudioReader(this.source, this.duration, this.cursor, this.t);
    this._phase = 'loading';
    await this._ensurePrimary();

    const guess = this.backend.device === 'webgpu' ? (this.model === 'small' ? 8 : 15) : MODELS[this.model].cpuSpeedGuess;
    const meter = this.meter = new ProgressMeter(this.duration, this.cursor, guess);
    const report = () => this._emit('progress', meter.snapshot(performance.now()));
    this._ticker = setInterval(report, 500);
    this.state = 'running';
    const wh = this.duration >= 3600;
    let noiseFloor = null, smallAdvances = 0;

    while (this.cursor < this.duration - 0.3) {
      this._checkStop();
      const start = this.cursor, end = Math.min(start + WINDOW_S, this.duration);
      const isLast = end >= this.duration - 1e-3;
      if (!this.reader.has(end)) this._status(`Läser ljudet från ${fmt(start, wh)}…`, 'running');
      const win = await this.reader.get(start, end);
      this._checkStop();
      if (win.length < 0.1 * SAMPLE_RATE) break;

      const an = analyseWindow(win, noiseFloor);
      noiseFloor = noiseFloor == null ? an.p10 : Math.min(noiseFloor, an.p10);
      const plan = planWindowAudio(an, isLast);
      if (plan.skip != null) {
        // tystnad (eller jämn ton): hoppa fram utan att köra modellen
        const to = Math.min(end, start + Math.max(plan.skip, 0.1));
        this.stats.skippedS += to - start;
        this._status(`Hoppar över ${plan.why === 'steady' ? 'ljud utan tal' : 'tystnad'} vid ${fmt(start, wh)}.`, 'running');
        this._advance(to >= this.duration - 0.3 ? this.duration : to, [], 0);
        report();
        continue;
      }

      const useS = Math.min(plan.useS, win.length / SAMPLE_RATE);
      const audio = win.subarray(0, Math.round(useS * SAMPLE_RATE));
      meter.beginWindow(performance.now(), start, useS);
      const res = await this._transcribeWindow(audio, activeSeconds(an, 0, useS),
        (b) => `Transkriberar ${fmt(start, wh)}–${fmt(start + useS, wh)} av ${fmt(this.duration, wh)} med ${b.label}…`);
      this._checkStop();
      this.stats.windows++;

      const commit = (forceFull) => planCommit({
        pieces: res.pieces, winStart: start, useS, isLast, cutInSilence: plan.cutInSilence, tailActive: plan.tailActive,
        activeAfter: (t) => activeSeconds(an, t, useS), forceFull,
      });
      let c = commit(false);
      // nödbroms: flera fönster i rad som knappt kommer framåt -> ta hela fönstret
      smallAdvances = c.next - start < 2 ? smallAdvances + 1 : 0;
      if (smallAdvances >= 3) { c = commit(true); smallAdvances = 0; }
      let next = Math.min(start + useS, Math.max(c.next, start + MIN_ADVANCE_S));
      if (next >= this.duration - 0.3) next = this.duration;
      this._advance(next, c.segments, res.wallMs);
      report();
    }
    this._advance(this.duration, [], 0);
  }

  _advance(cursor, segments, wallMs) {
    if (this._finished) return;
    cursor = Math.max(this.cursor, Math.min(this.duration, cursor));
    this.meter.commit(cursor, wallMs);
    const changed = cursor !== this.cursor || segments.length;
    this.cursor = cursor;
    if (changed) this._emit('commit', { segments, cursor });
  }
}

/**
 * Det som sparas av ett resultat som fortfarande ser misstänkt ut efter omräkning. Skräp sparas
 * aldrig. Vid upprepning tas bara själva slingorna bort (samma bit om och om igen) – resten kan
 * vara riktigt tal och behålls.
 */
function salvage(pieces, verdict) {
  if (verdict.kind === 'garbage') return [];
  if (verdict.kind === 'repetition' || verdict.kind === 'runaway') return dropRepeatedPieces(pieces);
  return pieces;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {object} options
 * @param {{duration:number, read:(start:number,end:number)=>Promise<Float32Array>}} options.source ljudkälla (audio.js)
 * @param {'base'|'small'} options.model
 * @param {number} options.startAt var i filen körningen ska börja (s)
 * @param {{useCpu?:boolean}} [options.prefs]
 * @param {object} options.on händelser, se överst i filen
 * @param {object} [options.tuning] ändrade gränsvärden (för tester)
 */
export function createEngine(options) { return new Engine(options); }
