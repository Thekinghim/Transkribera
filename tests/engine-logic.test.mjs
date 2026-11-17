// Enhetstester för motorns rena logik. Kör:  node --test tests/engine-logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_RATE, ENGINE_VERSION, analyseWindow, planWindowAudio, activeSeconds, parseTokens, planCommit,
  checkText, checkWindow, isGarbageText, isGibberish, swedishShare, repetitionScore, textSimilarity, dropRepeatedPieces,
  backendChain, pickThreads, BackendMemory, ProgressMeter,
} from '../js/engine-logic.js';

// ---------------------------------------------------------------- hjälpare
const TS = 50364, EOS = 50257;                       // som i KB-Whisper
const ts = (sec) => TS + Math.round(sec / 0.02);
const spec = { timestampBegin: TS, eos: EOS };
const dB = (x) => Math.pow(10, x / 20);
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
/** Bygger ljud av delar: ['speech'|'noise'|'tone'|'zero', sekunder, nivå i dBFS] */
function audio(...parts) {
  const total = parts.reduce((a, p) => a + p[1], 0);
  const out = new Float32Array(Math.round(total * SAMPLE_RATE));
  let i = 0;
  for (const [kind, sec, level = -25] of parts) {
    const n = Math.round(sec * SAMPLE_RATE), a = dB(level);
    for (let k = 0; k < n; k++, i++) {
      const t = k / SAMPLE_RATE;
      if (kind === 'speech') {
        // stavelser: 4 Hz-modulerat brus med korta uppehåll, som tal
        const env = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2;
        out[i] = a * 3.4 * env * rnd() + dB(-75) * rnd();
      } else if (kind === 'noise') out[i] = a * 3.4 * rnd();
      else if (kind === 'tone') out[i] = a * 1.41 * Math.sin(2 * Math.PI * 440 * t);
    }
  }
  return out;
}
const piece = (start, end, text = 'Det här är en mening.') => ({ start, end, text });

// ---------------------------------------------------------------- tystnad och klipp
test('helt tyst fönster hoppas över', () => {
  for (const pcm of [audio(['zero', 30]), audio(['noise', 30, -70])]) {
    const p = planWindowAudio(analyseWindow(pcm), false);
    assert.equal(p.why, 'silent'); assert.equal(p.skip, 29.7, 'slutet av fönstret lämnas åt nästa');
    assert.equal(planWindowAudio(analyseWindow(pcm), true).skip, 30, 'filens sista fönster hoppas över helt');
  }
});
test('tal som börjar precis i slutet av ett tyst eller jämnt fönster tappas inte', () => {
  const a = planWindowAudio(analyseWindow(audio(['zero', 29.92], ['speech', 0.08])), false);
  assert.ok(a.skip <= 29.7);
  const b = planWindowAudio(analyseWindow(audio(['tone', 29.2, -29], ['speech', 0.8, -20])), false);
  assert.ok(b.skip == null || b.skip <= 28.5, JSON.stringify(b));
});
test('jämn ton (inget tal) hoppas över, även med ett pip i', () => {
  assert.equal(planWindowAudio(analyseWindow(audio(['tone', 30, -29])), false).why, 'steady');
  assert.equal(planWindowAudio(analyseWindow(audio(['tone', 0.4, -14], ['tone', 29.6, -29])), false).why, 'steady');
  assert.equal(planWindowAudio(analyseWindow(audio(['noise', 30, -35])), false).why, 'steady');   // fläktbrus
});
test('svagt tal släpps aldrig', () => {
  // tal på -50 dBFS över ett brusgolv på -75: ska köras genom modellen
  const an = analyseWindow(audio(['speech', 30, -50]));
  const p = planWindowAudio(an, false);
  assert.equal(p.skip, undefined);
  assert.ok(an.activeS > 5);
  // även ett kort svagt yttrande i ett annars tyst fönster
  const p2 = planWindowAudio(analyseWindow(audio(['noise', 12, -75], ['speech', 1.5, -48], ['noise', 16.5, -75])), false);
  assert.equal(p2.why, 'lead'); assert.ok(p2.skip > 11 && p2.skip < 12, 'hoppar bara fram till strax före talet');
  // tal som hörs över rumsbrus
  assert.equal(planWindowAudio(analyseWindow(audio(['speech', 30, -38]).map((x, i) => x + dB(-55) * 3.4 * rnd())), false).skip, undefined);
});
test('svag inspelning (tal 40–50 dB under normal nivå) räknas inte som tystnad', () => {
  // mikrofon längst bak i salen: talet ligger under -60 dBFS men modellen klarar det bra
  for (const level of [-65, -75]) {
    const pcm = audio(['zero', 2], ['speech', 12, level], ['zero', 0.6], ['speech', 15.4, level]).map(x => x - dB(-75) * rnd() * (x ? 1 : 0));
    const an = analyseWindow(pcm, -100);
    const p = planWindowAudio(an, false);
    assert.ok(p.why === 'lead' && p.skip < 2 || p.skip == null, `${level} dBFS: ${JSON.stringify(p)}`);
    assert.ok(an.activeS > 10, `${level} dBFS: aktivt ${an.activeS}`);
  }
  // … men svagt brus utan tal är fortfarande tystnad
  assert.equal(planWindowAudio(analyseWindow(audio(['noise', 30, -68])), false).why, 'silent');
});
test('jämn nivå räcker inte för att hoppa över: hårt komprimerat tal körs genom modellen', () => {
  // automatisk förstärkning: nivån är konstant, men klangen växlar mellan mörka och ljusa ljud
  const n = 30 * SAMPLE_RATE, pcm = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const bright = Math.floor(i / (0.12 * SAMPLE_RATE)) % 2 === 0;       // växlar var 120 ms
    const x = rnd();
    lp += 0.05 * (x - lp);                                               // mörkt (lågpassat) brus
    pcm[i] = bright ? x : lp;
  }
  for (let f = 0; f + 480 <= n; f += 480) {                              // samma nivå i varje 30 ms-ruta
    let e = 0;
    for (let i = f; i < f + 480; i++) e += pcm[i] * pcm[i];
    const g = dB(-30) / Math.sqrt(e / 480);
    for (let i = f; i < f + 480; i++) pcm[i] *= g;
  }
  const an = analyseWindow(pcm);
  const act = Array.from(an.db).sort((a, b) => a - b);
  assert.ok(act[Math.round(0.97 * (act.length - 1))] - act[Math.round(0.03 * (act.length - 1))] < 3, 'testljudet har jämn nivå');
  assert.equal(an.steady, false);
  assert.equal(planWindowAudio(an, false).skip, undefined);
});
test('brusgolv från resten av filen gör bedömningen försiktigare, aldrig djärvare', () => {
  const pcm = audio(['noise', 30, -52]);                          // rumsbrus
  assert.ok(planWindowAudio(analyseWindow(pcm), false).skip);      // ensamt: tystnad
  assert.equal(planWindowAudio(analyseWindow(pcm, -80), false).why, 'steady', 'jämnt brus är inte tal oavsett golv');
  const quiet = audio(['speech', 30, -52]);
  assert.equal(planWindowAudio(analyseWindow(quiet, -80), false).skip, undefined, 'svagt tal i en annars tyst fil körs');
});
test('inledande tystnad hoppas över men lite sparas före talet', () => {
  const p = planWindowAudio(analyseWindow(audio(['zero', 10], ['speech', 20])), false);
  assert.equal(p.why, 'lead'); assert.ok(Math.abs(p.skip - 9.7) < 0.15, String(p.skip));
  // kort inledande tystnad: kör direkt
  assert.equal(planWindowAudio(analyseWindow(audio(['zero', 0.6], ['speech', 29.4])), false).skip, undefined);
});
test('fönstret klipps i en paus, helst en lång', () => {
  // tal 0–21, paus 0,8 s, tal, kort paus 0,25 s vid 26, tal till 30
  const pcm = audio(['speech', 21], ['zero', 0.8], ['speech', 4.2], ['zero', 0.25], ['speech', 3.75]);
  const p = planWindowAudio(analyseWindow(pcm), false);
  assert.equal(p.cutInSilence, true);
  assert.ok(p.useS > 21 && p.useS < 21.8, 'klipper i den långa pausen: ' + p.useS);
  // bara korta pauser: tar den senaste
  const q = planWindowAudio(analyseWindow(audio(['speech', 20], ['zero', 0.3], ['speech', 5.7], ['zero', 0.3], ['speech', 3.7])), false);
  assert.ok(q.useS > 26 && q.useS < 26.3, String(q.useS));
});
test('ingen paus: hela fönstret, och det märks att talet fortsätter', () => {
  const p = planWindowAudio(analyseWindow(audio(['noise', 30, -25]).map((x, i) => x * (0.3 + 0.7 * Math.abs(Math.sin(i / 3000))))), false);
  assert.equal(p.useS, 30); assert.equal(p.cutInSilence, false); assert.equal(p.tailActive, true);
});
test('sista fönstret och korta fönster klipps aldrig', () => {
  const p = planWindowAudio(analyseWindow(audio(['speech', 12.5])), true);
  assert.equal(p.useS, 12.5); assert.equal(p.cutInSilence, true);
});
test('activeSeconds räknar bara ljud i intervallet', () => {
  const an = analyseWindow(audio(['zero', 10], ['noise', 10, -20], ['zero', 10]));
  assert.ok(Math.abs(activeSeconds(an, 0, 30) - 10) < 0.1);
  assert.ok(activeSeconds(an, 21) < 0.1);
});

// ---------------------------------------------------------------- tokens
test('parseTokens: vanliga bitar med tidsstämplar', () => {
  const r = parseTokens([ts(0), 10, 11, ts(4.2), ts(4.2), 12, ts(9), EOS], spec);
  assert.deepEqual(r.pieces, [{ start: 0, end: 4.2, tokens: [10, 11] }, { start: 4.2, end: 9, tokens: [12] }]);
  assert.equal(r.endsWithTimestamp, true);
});
test('parseTokens: sista biten utan sluttid', () => {
  const r = parseTokens([ts(0), 10, ts(5), ts(5), 11, 12, EOS], spec);
  assert.deepEqual(r.pieces[1], { start: 5, end: null, tokens: [11, 12] });
  assert.equal(r.endsWithTimestamp, false);
});
test('parseTokens: en enda bit utan sluttid, tomt, bara tidsstämplar, BigInt och specialtokens', () => {
  assert.deepEqual(parseTokens([ts(0), 10, 11], spec).pieces, [{ start: 0, end: null, tokens: [10, 11] }]);
  assert.deepEqual(parseTokens([], spec).pieces, []);
  assert.deepEqual(parseTokens([ts(0), EOS], spec).pieces, []);
  assert.deepEqual(parseTokens([ts(0), ts(30)], spec).pieces, []);
  assert.deepEqual(parseTokens([BigInt(ts(1)), 10n, BigInt(ts(2))], spec).pieces, [{ start: 1, end: 2, tokens: [10] }]);
  assert.deepEqual(parseTokens([ts(0), 10, 50362, 50359, ts(2), EOS], spec).pieces, [{ start: 0, end: 2, tokens: [10] }]);
  // text utan inledande tidsstämpel och en ensam tidsstämpel mellan två bitar
  assert.deepEqual(parseTokens([10, ts(3), 11, ts(6)], spec).pieces, [{ start: 0, end: 3, tokens: [10] }, { start: 3, end: 6, tokens: [11] }]);
});

// ---------------------------------------------------------------- planering
test('planCommit: inget tal -> hela fönstret', () => {
  assert.deepEqual(planCommit({ pieces: [], winStart: 100, useS: 30 }), { segments: [], next: 130, rule: 'empty' });
  assert.equal(planCommit({ pieces: [piece(0, 5, '   ')], winStart: 0, useS: 30 }).rule, 'empty');
});
test('planCommit: tider är relativa fönstrets start', () => {
  const r = planCommit({ pieces: [piece(1, 4.5), piece(4.5, 12)], winStart: 600, useS: 24, cutInSilence: true });
  assert.deepEqual(r.segments.map(s => [s.start, s.end]), [[601, 604.5], [604.5, 612]]);
  assert.equal(r.next, 624); assert.equal(r.rule, 'full');
});
test('planCommit: oavslutad sista bit sparas inte – nästa fönster börjar vid sista färdiga', () => {
  const r = planCommit({ pieces: [piece(0, 8), piece(8, 21.4), piece(21.4, null, 'och sedan så')], winStart: 30, useS: 30 });
  assert.equal(r.rule, 'seek-last-complete'); assert.equal(r.segments.length, 2); assert.equal(r.next, 51.4);
});
test('planCommit: en enda bit utan sluttid tas hel', () => {
  const r = planCommit({ pieces: [piece(0, null, 'en lång mening utan slut')], winStart: 60, useS: 30 });
  assert.equal(r.rule, 'open-full'); assert.deepEqual([r.segments[0].start, r.segments[0].end, r.next], [60, 90, 90]);
});
test('planCommit: fönster utan paus (brusig inspelning) fortsätter från sista tidsstämpeln om det låter efter den', () => {
  const pieces = [piece(0, 9), piece(9, 28.6, 'och inte kyrkobok.')];
  const noisy = { pieces, winStart: 30, useS: 30, cutInSilence: false, tailActive: true, activeAfter: (t) => 30 - t };
  const r = planCommit(noisy);
  assert.equal(r.rule, 'uncut-tail'); assert.equal(r.next, 58.6); assert.equal(r.segments.length, 2);
  // klippt i en paus, sista fönstret eller tyst efter tidsstämpeln: hela fönstret som förut
  assert.equal(planCommit({ ...noisy, cutInSilence: true, tailActive: false }).rule, 'full');
  assert.equal(planCommit({ ...noisy, isLast: true }).rule, 'full');
  assert.equal(planCommit({ ...noisy, activeAfter: () => 0 }).rule, 'full');
});
test('planCommit: skydd mot stillastående', () => {
  // första biten slutar vid 0,4 s, resten oavslutad: skulle annars bara flytta 0,4 s
  const r = planCommit({ pieces: [piece(0, 0.4, 'Ja.'), piece(0.4, null, 'resten av texten')], winStart: 10, useS: 30 });
  assert.equal(r.rule, 'open-full'); assert.equal(r.next, 40); assert.equal(r.segments.length, 2);
  // tidsstämpel 0 på allt
  const z = planCommit({ pieces: [piece(0, 0, 'a'), piece(0, null, 'b')], winStart: 0, useS: 30 });
  assert.equal(z.next, 30);
  // nödbromsen
  const f = planCommit({ pieces: [piece(0, 8), piece(8, null, 'x')], winStart: 0, useS: 30, forceFull: true });
  assert.equal(f.rule, 'forced'); assert.equal(f.next, 30); assert.equal(f.segments[1].end, 30);
});
test('planCommit: bit som slutar exakt vid 30,00 mitt i tal görs om i nästa fönster', () => {
  const pieces = [piece(0, 9), piece(9, 22), piece(22, 30, 'en mening som klipptes av')];
  const r = planCommit({ pieces, winStart: 0, useS: 30, cutInSilence: false, tailActive: true });
  assert.equal(r.rule, 'redo-cut-sentence'); assert.equal(r.next, 22); assert.equal(r.segments.length, 2);
  // … men inte om fönstret slutar i en paus, är filens sista, eller om det skulle ge för lite framsteg
  assert.equal(planCommit({ pieces, winStart: 0, useS: 30, cutInSilence: true }).next, 30);
  assert.equal(planCommit({ pieces, winStart: 0, useS: 30, tailActive: true, isLast: true }).next, 30);
  assert.equal(planCommit({ pieces: [piece(0, 3), piece(3, 30)], winStart: 0, useS: 30, tailActive: true }).next, 30);
  assert.equal(planCommit({ pieces: [piece(0, 30)], winStart: 0, useS: 30, tailActive: true }).next, 30);
});
test('planCommit: modellen slutar tidigt fast det låter -> fortsätt därifrån', () => {
  const r = planCommit({ pieces: [piece(0, 12)], winStart: 0, useS: 30, cutInSilence: true, activeAfter: () => 10 });
  assert.equal(r.rule, 'early-stop'); assert.equal(r.next, 12); assert.equal(r.segments.length, 1);
  // tyst efteråt: lita på modellen
  assert.equal(planCommit({ pieces: [piece(0, 12)], winStart: 0, useS: 30, activeAfter: () => 0.2 }).next, 30);
});
test('planCommit: sista fönstret', () => {
  const r = planCommit({ pieces: [piece(0, 4), piece(4, 7.5)], winStart: 760, useS: 7.5, isLast: true, cutInSilence: true });
  assert.equal(r.next, 767.5); assert.equal(r.segments.at(-1).end, 767.5);
  // oavslutad bit i sista fönstret: det färdiga sparas, resten görs om i ett kortare fönster
  const o = planCommit({ pieces: [piece(0, 4), piece(4, null, 'slut')], winStart: 760, useS: 7.5, isLast: true });
  assert.equal(o.next, 764);
});
test('planCommit: tider städas – inom fönstret, aldrig bakåt', () => {
  const r = planCommit({ pieces: [piece(-2, 5), piece(3, 4, 'bakåt'), piece(4, 99, 'för långt')], winStart: 10, useS: 20, cutInSilence: true });
  assert.deepEqual(r.segments.map(s => [s.start, s.end]), [[10, 15], [15, 15], [15, 30]]);
  for (let i = 1; i < r.segments.length; i++) assert.ok(r.segments[i].start >= r.segments[i - 1].end);
  // saknad sluttid mitt i antar nästa bits start
  const m = planCommit({ pieces: [piece(0, null, 'a'), piece(6, 9, 'b')], winStart: 0, useS: 30 });
  assert.deepEqual(m.segments.map(s => [s.start, s.end]), [[0, 6], [6, 9]]);
});

// ---------------------------------------------------------------- rimlighet
const SVENSKA = 'Idag ska vi prata om fotosyntesen och hur den omvandlar ljusenergi till kemisk energi. Det är viktigt att ni förstår att klorofyllet absorberar ljus i kloroplasten, och att det sker i två steg som vi går igenom nu.';
test('skräptexten från fältrapporten upptäcks', () => {
  for (const t of ['�ie �ie �ier …', '�ie �ie �ier', 'Det ��� �� är']) {
    assert.equal(isGarbageText(t), true, t);
    assert.deepEqual(checkText(t), { ok: false, kind: 'garbage', hard: true });
  }
  const v = checkText('a a ar a ar');
  assert.equal(v.ok, false); assert.equal(v.kind, 'gibberish');
  assert.equal(isGibberish('a a ar a ar'), true);
  assert.equal(checkText('a a ar a ar a a ar a ar a a ar').ok, false);
});
test('riktig text godkänns', () => {
  assert.equal(checkText(SVENSKA).ok, true);
  assert.equal(checkText('').ok, true);
  assert.equal(checkText('Ja, ja, ja, nä, jo.').ok, true);
  assert.equal(checkText('Okej.').ok, true);
  assert.equal(checkText('1 + 1 = 2, 2 + 2 = 4').ok, true);
  assert.equal(checkText('Det kostar 50 %, alltså 1 200 kr – inte 2 400 kr (se s. 12).').ok, true);
  assert.equal(isGarbageText('Ett enstaka � i en lång och i övrigt helt vanlig svensk mening om fotosyntesen och annat som hör till.'), false);
  assert.equal(isGarbageText('Fotosyntesen omvandlar ljusenergi.'), false);
});
test('upprepning upptäcks', () => {
  assert.equal(checkText('och så och så och så och så och så och så').kind, 'repetition');
  assert.equal(checkText('Tack för att ni tittade. Tack för att ni tittade. Tack för att ni tittade. Tack för att ni tittade. Tack för att ni tittade.').kind, 'repetition');
  assert.equal(checkText('det är det som är det viktiga här det är det som är det viktiga här det är det som är det viktiga här det är det som är det viktiga här').kind, 'repetition');
  assert.ok(repetitionScore(SVENSKA) < 0.1);
  // vanlig talspråklig upprepning är inte en slinga
  assert.equal(checkText('Det är, det är alltså så att man måste, man måste tänka på det här när man räknar.').ok, true);
});
test('fel språk upptäcks bara på längre text', () => {
  const en = 'The quick brown fox jumps over the lazy dog and then it runs away from the big farmer who is angry at the fox for stealing his chickens every night this week';
  assert.equal(checkText(en).kind, 'language');
  assert.equal(checkText('The quick brown fox jumps.').ok, true);
  assert.ok(swedishShare(SVENSKA) > 0.3);
  assert.ok(swedishShare(en) < 0.05);
});
test('checkWindow: tomt på tydligt ljud, maxlängd och osäker modell är misstänkt', () => {
  assert.equal(checkWindow({ text: '', activeS: 20 }).kind, 'empty');
  assert.equal(checkWindow({ text: '', activeS: 2 }).ok, true);
  assert.equal(checkWindow({ text: SVENSKA, activeS: 20, hitMax: true }).kind, 'runaway');
  assert.equal(checkWindow({ text: SVENSKA, activeS: 20, avgLogprob: -1.6 }).kind, 'lowconf');
  assert.equal(checkWindow({ text: SVENSKA, activeS: 20, avgLogprob: -0.3 }).ok, true);
  assert.equal(checkWindow({ text: '�ie �ie �ier …', activeS: 20 }).hard, true);
  for (const v of [checkWindow({ text: '', activeS: 20 }), checkWindow({ text: SVENSKA, activeS: 1, hitMax: true })]) assert.equal(v.hard, false);
});
test('textSimilarity och dropRepeatedPieces', () => {
  assert.equal(textSimilarity('Det här är en mening.', 'det här är en mening'), 1);
  assert.ok(textSimilarity(SVENSKA, 'a a ar a ar') < 0.1);
  assert.ok(textSimilarity(SVENSKA, SVENSKA.replace('fotosyntesen', 'fotosyntes')) > 0.9);
  assert.equal(textSimilarity('', ''), 1); assert.equal(textSimilarity('hej', ''), 0);
  const kept = dropRepeatedPieces([piece(0, 2, 'Nu börjar vi.'), piece(2, 4, 'Tack.'), piece(4, 6, 'Tack.'), piece(6, 8, 'tack'), piece(8, 9, 'och så och så och så och så och så och så'), piece(9, 10, '���')]);
  assert.deepEqual(kept.map(p => [p.text, p.end]), [['Nu börjar vi.', 2], ['Tack.', 8]]);
});

// ---------------------------------------------------------------- motorval
test('motorkedja: aldrig fp16 på grafikkortet, processorn alltid sist', () => {
  for (const model of ['base', 'small']) {
    const c = backendChain({ webgpu: true, useCpu: false, model });
    assert.deepEqual(c.map(b => b.id), ['webgpu', 'wasm']);
    assert.ok(!JSON.stringify(c.filter(b => b.device === 'webgpu')).includes('fp16'));
    assert.equal(c[0].dtype.encoder_model, 'fp32');
    assert.deepEqual(backendChain({ webgpu: true, useCpu: true, model }).map(b => b.id), ['wasm']);
    assert.deepEqual(backendChain({ webgpu: false, useCpu: false, model }).map(b => b.id), ['wasm']);
  }
});
test('pickThreads', () => {
  assert.equal(pickThreads(8, false), 1);
  assert.deepEqual([1, 2, 4, 8, 12, 16, 32].map(n => pickThreads(n, true)), [1, 2, 3, 4, 6, 8, 8]);
  assert.equal(pickThreads(undefined, true), 3);
});
test('BackendMemory: minns per modell, glömmer vid ny version', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const m = new BackendMemory(storage);
  assert.deepEqual(m.get('base'), { bad: {}, good: null });
  m.markGood('base', 'webgpu'); m.markBad('small', 'webgpu', 'garbage');
  assert.equal(m.get('base').good, 'webgpu'); assert.deepEqual(m.get('small').bad, { webgpu: 'garbage' });
  m.markBad('base', 'webgpu', 'hang');
  assert.equal(m.get('base').good, null);
  // ny motorversion: allt provas på nytt
  const saved = JSON.parse(store.get('transkribera.engine'));
  assert.equal(saved.v, ENGINE_VERSION);
  store.set('transkribera.engine', JSON.stringify({ ...saved, v: ENGINE_VERSION - 1 }));
  assert.deepEqual(m.get('small').bad, {});
  // trasig lagring kraschar inte
  store.set('transkribera.engine', '{trasig');
  assert.deepEqual(m.get('base'), { bad: {}, good: null });
  m.markBad('base', 'webgpu', 'x'); m.forget();
  assert.deepEqual(m.get('base').bad, {});
  const none = new BackendMemory(null); none.markBad('base', 'webgpu', 'x'); assert.deepEqual(none.get('base').bad, {});
});

// ---------------------------------------------------------------- förlopp
test('ProgressMeter: går aldrig bakåt, rör sig under första fönstret, jämn hastighet', () => {
  const m = new ProgressMeter(3600, 600, 4);
  let last = m.snapshot(0).fraction, now = 0;
  assert.ok(Math.abs(last - 600 / 3600) < 1e-9);
  m.beginWindow(0, 600, 30);
  const during = m.snapshot(2000);
  assert.ok(during.fraction > last, 'rör sig innan första fönstret är klart');
  assert.equal(during.speed, null);
  assert.ok(m.snapshot(600000).position <= 600 + 27.01, 'går aldrig förbi 90 % av pågående fönster');
  // fönster som tar 5–7 s vardera, ibland en omsökning bakåt i planeringen (commit < uppskattat läge)
  let cur = 600;
  for (let i = 0; i < 60; i++) {
    m.beginWindow(now, cur, 30);
    const wall = 5000 + (i % 3) * 1000;
    for (let t = 0; t < wall; t += 500) { const s = m.snapshot(now + t); assert.ok(s.fraction >= last - 1e-12); last = s.fraction; }
    now += wall; cur += i % 4 === 0 ? 14 : 28;
    m.commit(cur, wall);
    const s = m.snapshot(now); assert.ok(s.fraction >= last - 1e-12); last = s.fraction;
    if (i > 5) { assert.ok(s.speed > 3 && s.speed < 6, 'hastighet ' + s.speed); assert.ok(s.etaSec > 0); }
  }
  // tystnad som hoppas över räknas inte som modellens hastighet
  const before = m.snapshot(now).speed;
  m.commit(cur + 600, 0);
  assert.equal(m.snapshot(now).speed, before);
  m.commit(3600, 1); assert.equal(m.snapshot(now).fraction, 1);
});
