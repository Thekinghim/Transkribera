// Ren logik för transkriberingsmotorn – ingen DOM, ingen Worker, inga nätanrop.
// Allt här går att köra i Node (se tests/engine-logic.test.mjs).
//
//   ljudanalys   frameDb, analyseWindow, planWindowAudio   (tystnad, klipp i pauser)
//   avkodning    parseTokens                               (Whisper-tokens -> textbitar med tider)
//   planering    planCommit                                (vad sparas, var börjar nästa fönster)
//   rimlighet    checkText, checkWindow, isGarbageText     (skräp, upprepning, fel språk, tomt)
//   motorval     backendChain, pickThreads, BackendMemory  (grafikkort -> processor)
//   förlopp      ProgressMeter                             (jämn hastighet och tid kvar)

export const ENGINE_VERSION = 1;      // höj när motorn ändras så att grafikkortet provas på nytt
export const SAMPLE_RATE = 16000;
export const WINDOW_S = 30;           // Whisper ser högst 30 s åt gången
export const FRAME_S = 0.03;          // analysruta 30 ms
const FRAME = Math.round(FRAME_S * SAMPLE_RATE);

// ---------------------------------------------------------------- ljudanalys
const DB_FLOOR = -100;
const ABS_SILENCE_DB = -60;           // under detta är det alltid tyst
const ALWAYS_ACTIVE_DB = -45;         // över detta räknas det aldrig som tyst (hellre för mycket än för lite)
const NOISE_MARGIN_DB = 8;            // ljud måste ligga så här mycket över brusgolvet

/** RMS-nivå i dBFS per 30 ms-ruta. */
export function frameDb(pcm) {
  const n = Math.floor(pcm.length / FRAME);
  const out = new Float32Array(n);
  for (let f = 0, i = 0; f < n; f++) {
    let sum = 0;
    for (const end = i + FRAME; i < end; i++) { const x = pcm[i]; sum += x * x; }
    const rms = Math.sqrt(sum / FRAME);
    out[f] = rms > 1e-5 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR;
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return DB_FLOOR;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

/**
 * Analys av ett ljudfönster. Försiktig: en ruta räknas som "aktiv" (möjligt tal) så fort den ligger
 * över brusgolvet + marginal, och alltid om den är starkare än -45 dBFS.
 * @param {Float32Array} pcm mono 16 kHz
 * @param {number} [noiseFloorDb] brusgolv uppmätt över hela körningen (annars fönstrets eget)
 */
export function analyseWindow(pcm, noiseFloorDb = null) {
  const db = frameDb(pcm);
  const sorted = Float32Array.from(db).sort();
  const p10 = percentile(sorted, 0.10), p50 = percentile(sorted, 0.5), p90 = percentile(sorted, 0.9);
  const floor = noiseFloorDb == null ? p10 : Math.min(noiseFloorDb, p10);
  const threshold = Math.max(ABS_SILENCE_DB, Math.min(ALWAYS_ACTIVE_DB, floor + NOISE_MARGIN_DB));
  const active = new Uint8Array(db.length);
  let activeFrames = 0;
  for (let i = 0; i < db.length; i++) if (db[i] > threshold) { active[i] = 1; activeFrames++; }
  // Jämnt ljud (ton, brum, fläkt): nästan alla rutor aktiva men nivån varierar knappt. Tal varierar
  // alltid mycket (pauser mellan ord och stavelser), så det här kan inte vara tal.
  let steady = false;
  if (db.length >= 30 && activeFrames >= 0.9 * db.length) {
    const act = [];
    for (let i = 0; i < db.length; i++) if (active[i]) act.push(db[i]);
    act.sort((a, b) => a - b);
    steady = percentile(act, 0.97) - percentile(act, 0.03) < 3;
  }
  return { db, active, activeS: activeFrames * FRAME_S, durS: pcm.length / SAMPLE_RATE, p10, p50, p90, threshold, steady };
}

/** Sekunder aktivt ljud i [fromS, toS) av fönstret. */
export function activeSeconds(an, fromS = 0, toS = Infinity) {
  const a = Math.max(0, Math.floor(fromS / FRAME_S)), b = Math.min(an.active.length, Math.ceil(toS / FRAME_S));
  let n = 0;
  for (let i = a; i < b; i++) n += an.active[i];
  return n * FRAME_S;
}

const MIN_SPEECH_S = 0.12;            // kortare ljud än så i ett helt fönster är klick/brus
const LEAD_KEEP_S = 0.3;              // spara lite tystnad före talet
const CUT_SEARCH_S = 12;              // leta klippställe i fönstrets sista 12 s
const CUT_MIN_RUN = 7;                // minst 7 rutor (~0,2 s) paus för att klippa där
const CUT_LONG_RUN = 15;              // en paus på 0,45 s eller mer räknas som meningsgräns

/**
 * Bestämmer hur ett fönster ska användas innan modellen körs.
 *  { skip: sek }                      – inget tal i början: hoppa fram så här långt, kör inte modellen
 *  { useS, cutInSilence, tailActive } – kör modellen på de första useS sekunderna
 * @param {object} an resultat från analyseWindow
 * @param {boolean} isLast fönstret når filens slut
 */
export function planWindowAudio(an, isLast) {
  const { db, active, durS } = an;
  const n = active.length;
  // Hoppa aldrig ända fram till fönstrets slut (utom i filens sista fönster): slutet får nästa
  // fönster titta på igen, så att tal som börjar precis där aldrig tappas.
  const skipAll = (why, keep) => ({ skip: isLast || durS <= keep * 2 ? durS : durS - keep, why });
  if (an.steady) return skipAll('steady', 1.5);
  if (an.activeS < MIN_SPEECH_S) return skipAll('silent', LEAD_KEEP_S);
  // inledande tystnad: börja strax före första ljudet (kräv tre aktiva rutor i rad mot klick)
  let first = 0;
  while (first < n && !(active[first] && (active[first + 1] ?? 1) && (active[first + 2] ?? 1))) first++;
  if (first >= n) return skipAll('silent', LEAD_KEEP_S);
  const lead = first * FRAME_S;
  if (lead >= 1) return { skip: lead - LEAD_KEEP_S, why: 'lead' };
  if (isLast || durS < WINDOW_S - 0.05) return { useS: durS, cutInSilence: true, tailActive: false };

  // Klipp helst i en paus så att ingen mening delas mitt i ett ord. "Paus" = klart svagare än talet.
  // Bland pauserna i fönstrets sista del väljs den senaste av de långa (meningsgränser är längre
  // än pauser mellan ord).
  const quiet = Math.max(an.threshold, an.p90 - 18);
  const from = Math.max(0, n - Math.round(CUT_SEARCH_S / FRAME_S));
  const runs = [];                       // [start, längd] i rutor
  for (let i = from, run = 0; i <= n; i++) {
    if (i < n && db[i] <= quiet) { run++; continue; }
    if (run >= CUT_MIN_RUN) runs.push([i - run, run]);
    run = 0;
  }
  if (!runs.length) return { useS: durS, cutInSilence: false, tailActive: activeSeconds(an, durS - 0.6) > 0.3 };
  const longest = Math.max(...runs.map(r => r[1]));
  const need = Math.min(CUT_LONG_RUN, Math.ceil(longest * 0.7));   // ungefär lika långa pauser: ta den senaste
  const [start, len] = runs.filter(r => r[1] >= need).pop();
  // når pausen fönstrets slut används hela fönstret, annars klipps mitt i pausen
  if (start + len >= n) return { useS: durS, cutInSilence: true, tailActive: false };
  return { useS: Math.round((start + len / 2) * FRAME_S * 100) / 100, cutInSilence: true, tailActive: false };
}

// ---------------------------------------------------------------- avkodning
/**
 * Delar Whispers tokens i textbitar med tider (relativt fönstrets start).
 * Följden ser ut som  <|0.00|> text <|4.20|><|4.20|> text <|9.00|> … [<|eot|>]
 * @param {number[]} tokens genererade tokens (utan startprefixet)
 * @param {{timestampBegin:number, eos:number, precision?:number}} spec
 * @returns {{pieces:{start:number, end:number|null, tokens:number[]}[], endsWithTimestamp:boolean}}
 */
export function parseTokens(tokens, { timestampBegin, eos, precision = 0.02 }) {
  const pieces = [];
  let start = null, lastTs = 0, cur = [], endsWithTimestamp = false;
  for (const raw of tokens) {
    const tok = Number(raw);
    if (tok >= timestampBegin) {
      const t = Math.round((tok - timestampBegin) * precision * 100) / 100;
      if (cur.length) {
        pieces.push({ start: start ?? lastTs, end: t, tokens: cur });
        cur = [];
      }
      start = t; lastTs = t; endsWithTimestamp = true;
    } else if (tok < eos) {
      cur.push(tok); endsWithTimestamp = false;
    } // övriga specialtokens (eot, språk, uppgift …) hoppas över
  }
  if (cur.length) pieces.push({ start: start ?? lastTs, end: null, tokens: cur });
  return { pieces, endsWithTimestamp };
}

// ---------------------------------------------------------------- planering
export const MIN_ADVANCE_S = 1;       // varje fönster flyttar fram minst så här långt
const REDO_TAIL_MIN_START_S = 5;      // gör bara om sista meningen om minst 5 s ändå blir klart
const TAIL_SPEECH_S = 1.5;            // så mycket ljud efter sista tidsstämpeln betyder att modellen slutade för tidigt

/**
 * Whispers sekventiella långformsalgoritm: spara bara färdiga bitar och börja nästa fönster där den
 * sista färdiga biten slutar.
 * @param {object} p
 * @param {{start:number,end:number|null,text:string}[]} p.pieces bitar relativt fönstrets start
 * @param {number} p.winStart fönstrets start i filen (s)
 * @param {number} p.useS fönstrets längd (s)
 * @param {boolean} p.isLast fönstret når filens slut
 * @param {boolean} p.cutInSilence fönstret slutar i en paus (eller vid filens slut)
 * @param {boolean} p.tailActive det låter ända fram till fönstrets slut
 * @param {(fromS:number)=>number} [p.activeAfter] sekunder aktivt ljud efter en tidpunkt i fönstret
 * @param {boolean} [p.forceFull] nödbroms: spara allt och flytta fram hela fönstret
 * @returns {{segments:{start:number,end:number,text:string}[], next:number, rule:string}}
 */
export function planCommit({ pieces, winStart, useS, isLast = false, cutInSilence = false, tailActive = false, activeAfter = null, forceFull = false }) {
  const winEnd = winStart + useS;
  // städa: tider inom fönstret, aldrig bakåt, inga tomma bitar
  const clean = [];
  let prevEnd = 0;
  for (const p of pieces || []) {
    const text = (p.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let s = Number.isFinite(p.start) ? p.start : prevEnd;
    s = Math.min(useS, Math.max(prevEnd, s));
    let e = p.end == null || !Number.isFinite(p.end) ? null : Math.min(useS, Math.max(s, p.end));
    clean.push({ start: s, end: e, text });
    prevEnd = e ?? s;
  }
  // bara den sista biten får sakna sluttid; saknas den mitt i antas nästa bits start
  for (let i = 0; i < clean.length - 1; i++) if (clean[i].end == null) clean[i].end = clean[i + 1].start;

  const abs = (list, fallbackEnd) => list.map(p => ({ start: r2(winStart + p.start), end: r2(winStart + (p.end ?? fallbackEnd)), text: p.text }));
  if (!clean.length) return { segments: [], next: winEnd, rule: 'empty' };
  const last = clean[clean.length - 1];
  if (forceFull) return { segments: abs(clean, useS), next: winEnd, rule: 'forced' };

  if (last.end == null) {
    // sista biten är inte avslutad
    const done = clean.slice(0, -1);
    const doneEnd = done.length ? done[done.length - 1].end : 0;
    if (done.length && doneEnd >= MIN_ADVANCE_S) return { segments: abs(done), next: r2(winStart + doneEnd), rule: 'seek-last-complete' };
    // en enda bit utan sluttid (eller inget framsteg annars): ta allt, hela fönstret
    return { segments: abs(clean, useS), next: winEnd, rule: 'open-full' };
  }

  // alla bitar är avslutade
  if (!isLast && !cutInSilence && tailActive && clean.length >= 2 && last.end >= useS - 0.3 && last.start >= REDO_TAIL_MIN_START_S) {
    // fönstret tog slut mitt i tal och modellen stängde sista meningen vid kanten: gör om den i nästa fönster
    return { segments: abs(clean.slice(0, -1)), next: r2(winStart + last.start), rule: 'redo-cut-sentence' };
  }
  if (last.end < useS - 2 && last.end >= MIN_ADVANCE_S && activeAfter && activeAfter(last.end + 0.2) >= TAIL_SPEECH_S) {
    // modellen slutade tidigt fast det fortfarande låter: fortsätt därifrån i stället för att lita på den
    return { segments: abs(clean), next: r2(winStart + last.end), rule: 'early-stop' };
  }
  return { segments: abs(clean), next: winEnd, rule: 'full' };
}
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- rimlighet
// De vanligaste svenska småorden. I löpande svenska är 35–55 % av orden något av dessa.
const SV_COMMON = new Set(('och att det i en är som på för av med den till inte har de ett om var jag man så men vi kan ni du han hon ' +
  'från eller när där här vad hur ska kommer också sig sin sitt sina nu då bara mycket alla efter vid under över blir finns få får hade ' +
  'skulle måste vara bli göra gör ju väl alltså lite den det dem dessa detta denna vilket vilka mer än upp ut in mot mellan genom utan ' +
  'sedan sen hans hennes deras vår er min mitt mina oss mig dig honom henne två tre många några något någon inget ingen andra annan ' +
  'första stor stora hela samma även redan kunde blev varit kunna vill ha tar ta går gå ser se säger sa ja nej okej').split(' '));

const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/** Andel vanliga svenska småord (0–1). */
export function swedishShare(text) {
  const w = words(text);
  if (!w.length) return 0;
  let n = 0;
  for (const x of w) if (SV_COMMON.has(x)) n++;
  return n / w.length;
}

/**
 * Mått på upprepning (0 = ingen, 1 = bara upprepning): andelen ord som ingår i en ordföljd som
 * redan förekommit, plus kontroll av samma korta enhet många gånger i rad.
 */
export function repetitionScore(text) {
  const w = words(text);
  if (w.length < 8) return 0;
  // andel treordsföljder som är dubbletter
  const seen = new Set();
  let dup = 0;
  for (let i = 0; i + 2 < w.length; i++) {
    const g = w[i] + ' ' + w[i + 1] + ' ' + w[i + 2];
    if (seen.has(g)) dup++; else seen.add(g);
  }
  const tri = dup / Math.max(1, w.length - 2);
  // ordförråd: unika ord / ord
  const uniq = 1 - new Set(w).size / w.length;
  return Math.max(tri, w.length >= 16 ? Math.max(0, (uniq - 0.5) * 2) : 0);
}

/** Samma enhet (1–6 ord) minst fem gånger i rad, t.ex. "och så och så och så och så och så". */
function hasLoop(text) {
  return /(?<![\p{L}\p{N}])([\p{L}\p{N}][^.!?]{0,40}?)(?:[\s,.!?]+\1(?![\p{L}\p{N}])){4,}/iu.test(text);
}

/**
 * Skräptext från en trasig beräkning (t.ex. grafikkort med fel i flyttalen): fullt av
 * ersättningstecken (�). Kan aldrig vara riktig text och får aldrig sparas.
 */
export function isGarbageText(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const bad = (t.match(/\uFFFD/g) || []).length;
  return (bad >= 2 && bad / t.length > 0.01) || bad >= 5;
}

// korta ord som är riktiga svenska ord/utfyllnadsljud (för kontrollen av "lösa bokstäver")
const SV_SHORT = new Set('ja nej jo nä näe mm hm eh öh äh ah oj å ok okej va ju då så nu vi ni du de en ett är och att det i på av om se ta ha få gå ge be le tro två tre tio'.split(' '));

/**
 * Text som ser trasig ut utan att innehålla �: lösa bokstäver och stavelser ("a a ar a ar"),
 * teckensoppa eller mest främmande skrift. Misstänkt, men kan i sällsynta fall vara riktigt
 * (någon som bokstaverar) – därför jämförs den med en omräkning i stället för att kastas direkt.
 */
export function isGibberish(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const chars = t.replace(/\s/g, '');
  if (chars.length >= 12) {
    const weird = (chars.match(/[^\p{L}\p{N}.,!?;:'"()\-–—%+=/*·×<>°€$&@#…]/gu) || []).length;
    if (weird / chars.length > 0.2) return true;
  }
  const w = words(t);
  if (w.length >= 5) {
    const mean = w.reduce((a, x) => a + x.length, 0) / w.length;
    const known = w.filter(x => SV_SHORT.has(x) || SV_COMMON.has(x) || /^\d+$/.test(x)).length;
    if (mean < 2.3 && known / w.length < 0.34) return true;
    const nonLatin = w.filter(x => /[^\p{Script=Latin}\p{N}]/u.test(x)).length;
    if (nonLatin / w.length > 0.5) return true;
  }
  return false;
}

export const CHECK = {
  minWordsForLanguage: 25,   // språkkontroll bara på längre text
  minSwedishShare: 0.10,     // löpande svenska ligger på 0,35–0,55; engelska på ~0,05
  maxRepetition: 0.45,
  emptyActiveS: 8,           // så mycket aktivt ljud utan en enda bokstav är misstänkt
  minAvgLogprob: -1.2,       // modellens egen osäkerhet (Whisper använder -1,0 som gräns)
};

/**
 * Bedömer texten från ett fönster.
 *   ok       – inget konstigt
 *   hard     – kan inte vara riktig text (skräp): får aldrig sparas
 *   soft     – misstänkt (upprepning, fel språk, tomt, osäkert): gör om på annat sätt och jämför
 * @returns {{ok:boolean, kind:null|'garbage'|'gibberish'|'repetition'|'language'|'empty'|'runaway'|'lowconf', hard:boolean}}
 */
export function checkText(text) {
  const t = (text || '').trim();
  if (!t) return verdict(null);
  if (isGarbageText(t)) return verdict('garbage', true);
  if (isGibberish(t)) return verdict('gibberish');
  if (hasLoop(t) || repetitionScore(t) > CHECK.maxRepetition) return verdict('repetition');
  const w = words(t);
  if (w.length >= CHECK.minWordsForLanguage && swedishShare(t) < CHECK.minSwedishShare) return verdict('language');
  return verdict(null);
}

/**
 * @param {object} p
 * @param {string} p.text all text från fönstret
 * @param {number} p.activeS sekunder aktivt ljud i fönstret
 * @param {boolean} [p.hitMax] modellen slutade inte själv (nådde maxlängden)
 * @param {number|null} [p.avgLogprob] medelvärdet av modellens log-sannolikheter
 */
export function checkWindow({ text, activeS, hitMax = false, avgLogprob = null }) {
  const v = checkText(text);
  if (!v.ok) return v;
  const t = (text || '').trim();
  if (!t) return activeS >= CHECK.emptyActiveS ? verdict('empty') : verdict(null);
  if (hitMax) return verdict('runaway');
  if (avgLogprob != null && avgLogprob < CHECK.minAvgLogprob) return verdict('lowconf');
  return verdict(null);
}
function verdict(kind, hard = false) { return { ok: !kind, kind, hard }; }

/** Likhet mellan två texter (0–1), andel gemensamma ord. Används för att jämföra två beräkningar av samma ljud. */
export function textSimilarity(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.length && !wb.length) return 1;
  if (!wa.length || !wb.length) return 0;
  const count = new Map();
  for (const x of wa) count.set(x, (count.get(x) || 0) + 1);
  let common = 0;
  for (const x of wb) { const c = count.get(x) || 0; if (c > 0) { common++; count.set(x, c - 1); } }
  return (2 * common) / (wa.length + wb.length);
}

/** Tar bort bitar som är upprepningar av föregående bit (hallucinationsslinga) ur en lista. */
export function dropRepeatedPieces(pieces) {
  const out = [];
  const norm = (t) => words(t || '').join(' ');
  for (const p of pieces) {
    const n = norm(p.text);
    if (!n) continue;
    const prev = out[out.length - 1];
    if (prev && norm(prev.text) === n) { prev.end = p.end; continue; }
    const k = checkText(p.text).kind;
    if (k === 'repetition' || k === 'garbage') continue;
    out.push({ ...p });
  }
  return out;
}

// ---------------------------------------------------------------- motorval
// Vilka modellfiler som används. Uppmätt på 12,8 min svenskt tal (FLEURS) med Snabb på processorn,
// 3 trådar: kodare/avkodare q8/q8 4,8× realtid och 14,2 % ordfel; q8/fp32 6,5× och 13,6 %;
// fp32/fp32 5,8× och 12,4 %. Den okvantiserade avkodaren är alltså både snabbare och bättre i WASM.
export const MODELS = {
  base: {
    repo: 'KBLab/kb-whisper-base', label: 'Snabb', cpuSpeedGuess: 5,
    wasm: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
  },
  small: {
    repo: 'KBLab/kb-whisper-small', label: 'Noggrann', cpuSpeedGuess: 1,
    wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  },
};

/**
 * Motorerna i den ordning de provas: grafikkortet först (om det finns och inte valts bort), sedan
 * processorn. Kodaren körs aldrig i fp16 på grafikkortet – det gav skräptext (�) på vissa kort.
 */
export function backendChain({ webgpu, useCpu, model = 'base' }) {
  const chain = [];
  if (webgpu && !useCpu) {
    chain.push({ id: 'webgpu', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, label: 'grafikkortet' });
  }
  chain.push({ id: 'wasm', device: 'wasm', dtype: (MODELS[model] || MODELS.base).wasm, label: 'processorn' });
  return chain;
}

/**
 * Antal trådar för processorn. hardwareConcurrency räknar logiska kärnor; med hyperthreading ger
 * fler trådar än fysiska kärnor ingenting, och en kärna lämnas åt webbläsaren.
 */
export function pickThreads(hardwareConcurrency, crossOriginIsolated) {
  if (!crossOriginIsolated) return 1;
  const hc = Math.max(1, hardwareConcurrency | 0 || 4);
  if (hc <= 4) return Math.max(1, hc - (hc > 2 ? 1 : 0));   // 2 -> 2, 3 -> 2, 4 -> 3
  return Math.max(4, Math.min(8, Math.floor(hc / 2)));        // 8 -> 4, 12 -> 6, 16+ -> 8
}

/**
 * Minne av vilka motorer som fungerat på den här datorn, sparat i localStorage per modell.
 * Ändras ENGINE_VERSION glöms allt och grafikkortet provas på nytt.
 */
export class BackendMemory {
  constructor(storage, key = 'transkribera.engine') { this.storage = storage; this.key = key; }
  _read() {
    try {
      const v = JSON.parse(this.storage?.getItem(this.key) || 'null');
      if (v && v.v === ENGINE_VERSION && v.models) return v;
    } catch {}
    return { v: ENGINE_VERSION, models: {} };
  }
  _write(v) { try { this.storage?.setItem(this.key, JSON.stringify(v)); } catch {} }
  /** @returns {{bad:Record<string,string>, good:string|null}} */
  get(model) { const m = this._read().models[model]; return { bad: m?.bad || {}, good: m?.good || null }; }
  markBad(model, backendId, why) {
    const v = this._read();
    const m = v.models[model] ||= { bad: {}, good: null };
    m.bad[backendId] = why;
    if (m.good === backendId) m.good = null;
    this._write(v);
  }
  markGood(model, backendId) {
    const v = this._read();
    const m = v.models[model] ||= { bad: {}, good: null };
    if (m.good === backendId) return;
    m.good = backendId;
    this._write(v);
  }
  forget() { try { this.storage?.removeItem(this.key); } catch {} }
}

// ---------------------------------------------------------------- förlopp
/**
 * Jämnar ut hastighet och tid kvar. Förloppet går aldrig bakåt. Mellan två sparade fönster
 * uppskattas läget utifrån uppmätt hastighet så att stapeln rör sig hela tiden.
 */
export class ProgressMeter {
  /**
   * @param {number} duration filens längd (s)
   * @param {number} startAt var körningen började (s)
   * @param {number} speedGuess gissad hastighet (× realtid) innan något är uppmätt
   */
  constructor(duration, startAt, speedGuess = 3) {
    this.duration = Math.max(0.001, duration);
    this.cursor = startAt;
    this.shown = startAt;
    this.guess = speedGuess;
    this.samples = [];           // { audio, wall } per fönster som modellen kört
    this.speed = null;           // × realtid, utjämnad
    this.skipped = 0;            // sekunder överhoppad tystnad
    this.worked = 0;             // sekunder ljud som modellen kört
    this.startAt = startAt;
    this.windowStart = null;     // { at (ms), from, len }
  }
  /** Modellen börjar på ett fönster. */
  beginWindow(nowMs, from, len) { this.windowStart = { at: nowMs, from, len }; }
  /** Ett fönster är klart: cursor flyttad till `to`; wallMs = modellens tid (0 om tystnad hoppades över). */
  commit(to, wallMs) {
    const adv = Math.max(0, to - this.cursor);
    this.cursor = Math.max(this.cursor, to);
    this.windowStart = null;
    if (wallMs > 0) {
      this.worked += adv;
      this.samples.push({ audio: adv, wall: wallMs / 1000 });
      if (this.samples.length > 40) this.samples.shift();
      // viktat medel över de senaste fönstren (ca 2 min arbete), mjukt mot föregående värde
      let a = 0, w = 0;
      for (let i = this.samples.length - 1; i >= 0 && w < 120; i--) { a += this.samples[i].audio; w += this.samples[i].wall; }
      const recent = a / Math.max(0.001, w);
      this.speed = this.speed == null ? recent : this.speed * 0.6 + recent * 0.4;
    } else {
      this.skipped += adv;
    }
  }
  /** Det som ska visas just nu. */
  snapshot(nowMs) {
    let pos = this.cursor;
    const sp = this.speed ?? this.guess;
    if (this.windowStart) {
      const { at, from, len } = this.windowStart;
      // uppskatta läget i pågående fönster, men gå aldrig förbi 90 % av det
      pos = Math.max(pos, from + Math.min(len * 0.9, sp * Math.max(0, nowMs - at) / 1000));
    }
    this.shown = Math.max(this.shown, Math.min(this.duration, pos));
    const remaining = Math.max(0, this.duration - this.shown);
    // andelen tystnad hittills antas gälla även resten av filen
    const done = this.worked + this.skipped;
    const workShare = done > 60 ? Math.max(0.05, this.worked / done) : 1;
    return {
      fraction: this.shown / this.duration,
      position: this.shown,
      speed: this.speed,
      etaSec: this.speed ? (remaining * workShare) / this.speed : null,
    };
  }
}
