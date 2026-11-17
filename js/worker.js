// Web Worker: kör KB-Whisper med transformers.js. En worker = en modell på en motor (grafikkort
// eller processor). Byte av motor görs av engine.js genom att starta en ny worker.
//
// Protokoll (ett anrop åt gången, varje anrop har ett id):
//   -> { op:'load', id, repo, device:'webgpu'|'wasm', dtype, threads, abort?:SharedArrayBuffer }
//   <- { ev:'files', id, missing:[fil…] }               modellfiler som inte finns sparade i webbläsaren
//   <- { ev:'download', file, loaded, total }*          inläsning av modellfiler (från nätet eller webbläsarens cache)
//   <- { ev:'download', file, done:true }               en fil är färdigläst
//   <- { ev:'stage', id, stage:'warmup' }               modellen är byggd (på grafikkortet provkörs den nu)
//   <- { ev:'loaded', id, device, threads, ms }
//   -> { op:'transcribe', id, audio:Float32Array (≤30 s, 16 kHz mono), maxNewTokens?, noRepeatNgram?, temperature? }
//   <- { ev:'tick', id, tokens }*                       livstecken: kodaren klar (tokens=0), sedan var 16:e token
//   <- { ev:'result', id, pieces:[{start,end|null,text}], endsWithTimestamp, stats:{tokens,avgLogprob,hitMax,aborted,ms,encodeMs} }
//   -> { op:'dispose', id }      <- { ev:'disposed', id }
//   <- { ev:'error', id, code:'NO_WEBGPU'|'LOAD'|'RUN'|'BAD_REQUEST'|'CRASH', message }
// Avbrott mitt i ett fönster: sätt abort[0] = 1 (delat minne) så slutar avkodningen vid nästa token
// (under kodarens körning, de första sekunderna av ett fönster, går det inte att avbryta).
import {
  pipeline, env, LogitsProcessor, LogitsProcessorList, log_softmax,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
import { parseTokens, SAMPLE_RATE } from './engine-logic.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;          // { processor, model, tokenizer }
let spec = null;         // { timestampBegin, eos }
let loaded = null;       // { device, threads }
let abortFlag = null;    // Int32Array på delat minne, eller null
let busy = false;

const post = (m) => self.postMessage(m);
class CodedError extends Error { constructor(code, message) { super(message); this.code = code; } }
const aborted = () => !!abortFlag && Atomics.load(abortFlag, 0) !== 0;

/**
 * Körs före varje token. Ger livstecken, mäter modellens säkerhet (medel-logsannolikhet för
 * texttokens), ser till att tidsstämplar aldrig går bakåt och avbryter avkodningen när sidan ber om
 * det. (Avbrottet görs här genom att tvinga fram sluttoken: transformers.js 3.8.1 skickar inte
 * vidare stopping_criteria för Whisper.)
 */
class Monitor extends LogitsProcessor {
  constructor(id, { timestampBegin, eos }) {
    super();
    this.id = id; this.tsBegin = timestampBegin; this.eos = eos; this.aborted = false;
    this.promptLen = null; this.steps = 0; this.prev = null; this.sum = 0; this.count = 0; this.encodeMs = null; this.t0 = performance.now();
  }
  _call(input_ids, logits) {
    const ids = input_ids[0];
    if (this.promptLen == null) { this.promptLen = ids.length; this.encodeMs = performance.now() - this.t0; }
    if (this.steps % 16 === 0) post({ ev: 'tick', id: this.id, tokens: this.steps });
    this.steps++;
    const data = logits[0].data;
    if (aborted()) { this.aborted = true; data.fill(-Infinity); data[this.eos] = 0; return logits; }
    // sannolikheten för den token som valdes i förra steget
    if (this.prev) {
      const chosen = Number(ids[ids.length - 1]);
      if (chosen < this.tsBegin && Number.isFinite(this.prev[chosen])) { this.sum += this.prev[chosen]; this.count++; }
    }
    this.prev = log_softmax(data);
    // tidsstämplar får inte gå bakåt, och varje bit måste ha en längd (annars kan modellen fastna)
    let lastTs = -1, n = ids.length;
    for (let i = n - 1; i >= this.promptLen; i--) if (Number(ids[i]) >= this.tsBegin) { lastTs = Number(ids[i]); break; }
    if (lastTs >= 0) {
      const lastWas = Number(ids[n - 1]) >= this.tsBegin;
      const penultWas = n - 2 < this.promptLen || Number(ids[n - 2]) >= this.tsBegin;
      const until = lastWas && !penultWas ? lastTs : lastTs + 1;
      data.subarray(this.tsBegin, until).fill(-Infinity);
    }
    return logits;
  }
  get avgLogprob() { return this.count ? this.sum / this.count : null; }
}

async function run(id, audio, { maxNewTokens = 224, noRepeatNgram = 0, temperature = 0 } = {}) {
  const t0 = performance.now();
  const { input_features } = await asr.processor(audio);
  const monitor = new Monitor(id, spec);
  const processors = new LogitsProcessorList(); processors.push(monitor);
  const options = {
    inputs: input_features,
    language: 'swedish', task: 'transcribe', return_timestamps: true,
    max_new_tokens: maxNewTokens,
    logits_processor: processors,
  };
  if (noRepeatNgram > 0) options.no_repeat_ngram_size = noRepeatNgram;
  if (temperature > 0) { options.do_sample = true; options.temperature = temperature; }
  const out = await asr.model.generate(options);
  const seq = (out.tolist ? out.tolist()[0] : out[0]).map(Number);
  const gen = seq.slice(monitor.promptLen ?? 0);
  const wasAborted = monitor.aborted || aborted();
  const hitMax = !wasAborted && gen.length >= maxNewTokens && gen[gen.length - 1] !== spec.eos;
  const parsed = parseTokens(gen, spec);
  const pieces = parsed.pieces.map(p => ({
    start: p.start, end: p.end,
    text: asr.tokenizer.decode(p.tokens, { skip_special_tokens: true }),
  }));
  return {
    pieces, endsWithTimestamp: parsed.endsWithTimestamp,
    stats: {
      tokens: gen.length, avgLogprob: monitor.avgLogprob, hitMax, aborted: wasAborted,
      ms: Math.round(performance.now() - t0), encodeMs: Math.round(monitor.encodeMs ?? 0),
    },
  };
}

// Filnamnstillägg per precision, som i transformers.js.
const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', int8: '_int8', uint8: '_uint8', q8: '_quantized', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };

/** Vilka av modellfilerna saknas i webbläsarens cache (och måste laddas ner)? null om det inte går att ta reda på. */
async function missingFiles(repo, dtype) {
  try {
    const names = Object.entries(dtype).map(([name, d]) => `onnx/${name}${DTYPE_SUFFIX[d] ?? ''}.onnx`);
    const cache = await caches.open('transformers-cache');
    const urls = (await cache.keys()).map(r => r.url);
    return names.filter(n => !urls.some(u => u.includes(`/${repo}/`) && u.endsWith('/' + n)));
  } catch { return null; }
}

async function load(msg) {
  const t0 = performance.now();
  if (msg.abort) abortFlag = new Int32Array(msg.abort);
  const missing = await missingFiles(msg.repo, msg.dtype || {});
  if (missing) post({ ev: 'files', id: msg.id, missing });
  if (msg.device === 'webgpu') {
    let adapter = null;
    try { adapter = await self.navigator?.gpu?.requestAdapter(); } catch {}
    if (!adapter) throw new CodedError('NO_WEBGPU', 'WebGPU saknas');
  } else if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = Math.max(1, msg.threads | 0 || 1);
  }
  const pipe = await pipeline('automatic-speech-recognition', msg.repo, {
    device: msg.device,
    dtype: msg.dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) post({ ev: 'download', file: p.file, loaded: p.loaded, total: p.total });
      else if (p.status === 'done') post({ ev: 'download', file: p.file, done: true });
    },
  });
  asr = { processor: pipe.processor, model: pipe.model, tokenizer: pipe.tokenizer, dispose: () => pipe.dispose() };
  const eos = asr.model.generation_config?.eos_token_id ?? asr.model.config?.eos_token_id;
  spec = { timestampBegin: asr.tokenizer.timestamp_begin, eos: Array.isArray(eos) ? eos[0] : eos, precision: 0.02 };
  // Grafikkortet provkörs på en sekund tystnad: det kompilerar dess program och avslöjar fel direkt
  // i stället för mitt i föreläsningen. På processorn finns inget att kompilera – där vore det bara
  // en kodarkörning (2–6 s) i onödan före första texten.
  post({ ev: 'stage', id: msg.id, stage: 'warmup' });
  if (msg.device === 'webgpu') await run(msg.id, new Float32Array(SAMPLE_RATE), { maxNewTokens: 8 });
  loaded = { device: msg.device, threads: msg.device === 'wasm' ? (env.backends?.onnx?.wasm?.numThreads ?? 1) : 0 };
  post({ ev: 'loaded', id: msg.id, ...loaded, ms: Math.round(performance.now() - t0) });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (busy && msg.op !== 'dispose') { post({ ev: 'error', id: msg.id, code: 'BAD_REQUEST', message: 'Upptagen' }); return; }
  busy = true;
  try {
    if (msg.op === 'load') {
      try { await load(msg); } catch (e) { throw e.code ? e : new CodedError('LOAD', String(e?.message || e)); }
    } else if (msg.op === 'transcribe') {
      if (!asr) throw new CodedError('BAD_REQUEST', 'Modellen är inte laddad');
      if (!(msg.audio instanceof Float32Array) || msg.audio.length > 30.5 * SAMPLE_RATE) throw new CodedError('BAD_REQUEST', 'Ogiltigt ljudfönster');
      let r;
      try { r = await run(msg.id, msg.audio, msg); } catch (e) { throw new CodedError('RUN', String(e?.message || e)); }
      post({ ev: 'result', id: msg.id, ...r });
    } else if (msg.op === 'dispose') {
      try { await asr?.dispose(); } catch {}
      asr = null;
      post({ ev: 'disposed', id: msg.id });
    } else {
      throw new CodedError('BAD_REQUEST', 'Okänt anrop: ' + msg.op);
    }
  } catch (e) {
    post({ ev: 'error', id: msg.id, code: e.code || 'CRASH', message: String(e?.message || e) });
  } finally {
    busy = false;
  }
};
self.addEventListener('unhandledrejection', (e) => {
  post({ ev: 'error', id: null, code: 'CRASH', message: String(e.reason?.message || e.reason) });
});
