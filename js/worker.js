// Web Worker: kör KB-Whisper med transformers.js. Tar emot 16 kHz mono-PCM i block.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let loadedKey = null;
let device = null;

const MODELS = {
  base: 'KBLab/kb-whisper-base',
  small: 'KBLab/kb-whisper-small',
};

async function webgpuInfo() {
  try {
    if (!self.navigator?.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return { f16: adapter.features.has('shader-f16') };
  } catch { return null; }
}

function post(type, data = {}) { self.postMessage({ type, ...data }); }

async function load(modelKey, forceWasm = false) {
  const model = MODELS[modelKey] || MODELS.base;
  const key = model + (forceWasm ? ':wasm' : '');
  if (asr && loadedKey === key) return;
  if (asr) { try { await asr.dispose(); } catch {} asr = null; }

  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      post('download', { file: p.file, loaded: p.loaded, total: p.total });
    } else if (p.status === 'done') {
      post('download-done', { file: p.file });
    }
  };

  const gpu = forceWasm ? null : await webgpuInfo();
  if (gpu) {
    try {
      post('status', { text: 'Laddar modellen (WebGPU)…' });
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        // fp16-kodaren ger skräptext (�) på en del grafikkort – kör den alltid i fp32
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      // provkör så att WebGPU-fel upptäcks direkt i stället för mitt i föreläsningen
      await asr(new Float32Array(16000), { language: 'swedish', task: 'transcribe' });
      device = 'webgpu';
      loadedKey = key;
      post('ready', { device });
      return;
    } catch (e) {
      console.warn('WebGPU misslyckades, provar WASM', e);
      post('status', { text: 'WebGPU fungerade inte – byter till WASM (långsammare)…' });
      try { await asr?.dispose(); } catch {}
      asr = null;
    }
  }
  post('status', { text: 'Laddar modellen (WASM)…' });
  asr = await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback,
  });
  device = 'wasm';
  loadedKey = model + ':wasm';
  post('ready', { device });
}

// Räknar färdiga 30-sekundersdelar så att sidan kan visa förlopp inom ett block.
function instrument(pipe) {
  const model = pipe?.model;
  if (!model || model.__counted) return;
  const gen = model.generate.bind(model);
  model.generate = async (...args) => {
    const r = await gen(...args);
    chunksDone++;
    post('chunk', { done: chunksDone, total: chunksTotal });
    return r;
  };
  model.__counted = true;
}
let chunksDone = 0, chunksTotal = 0;

async function transcribe(audio) {
  instrument(asr);
  // samma uppdelning som pipelinen: fönster 30 s, överlapp 5 s på varje sida => steg 20 s
  const sec = audio.length / 16000;
  chunksDone = 0;
  chunksTotal = sec <= 30 ? 1 : Math.ceil((sec - 10) / 20);
  const out = await asr(audio, {
    language: 'swedish',
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  return (out.chunks || []).map(c => ({
    start: c.timestamp?.[0] ?? null,
    end: c.timestamp?.[1] ?? null,
    text: (c.text || '').trim(),
  }));
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      await load(msg.model, msg.forceWasm);
    } else if (msg.type === 'transcribe') {
      let segments;
      try {
        segments = await transcribe(msg.audio);
      } catch (e) {
        if (device === 'webgpu') {
          // WebGPU kraschade mitt i – ladda om med WASM och försök samma block igen
          post('status', { text: 'WebGPU kraschade – byter till WASM och fortsätter…' });
          const modelKey = Object.keys(MODELS).find(k => loadedKey?.startsWith(MODELS[k])) || 'base';
          loadedKey = null;
          await load(modelKey, true);
          segments = await transcribe(msg.audio);
        } else throw e;
      }
      post('result', { id: msg.id, segments });
    }
  } catch (e) {
    post('error', { id: msg.id, message: String(e?.message || e) });
  }
};
