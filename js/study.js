// Textbearbetning, pluggverktyg och export. Ren logik utan DOM – lätt att testa.

// ---------- tid ----------
export function fmtTime(sec, withHours) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return (h || withHours) ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}
export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (sec >= 60) return `${Math.max(1, Math.round(sec / 60))} min`;
  return `${sec} s`;
}

// ---------- rensning av modellens utdata ----------
const JUNK = [
  /textning\.nu/i, /undertext(er|ning)?\s+(av|från)/i, /amara\.org/i, /svensktextning/i,
  /^tack för (att ni|att du) (tittade|lyssnade)/i, /^www\.[^\s]+$/i, /^\W*$/,
  /prenumerera/i, /^musik$/i, /^\[.*\]$/, /^\(.*\)$/,
];

let segCounter = 0;
export function newId() {
  segCounter = (segCounter + 1) % 1e6;
  return Date.now().toString(36) + segCounter.toString(36) + Math.random().toString(36).slice(2, 6);
}

// raw: [{start,end,text}] relativt blockets start. Returnerar segment med absolut tid.
export function cleanSegments(raw, offset, blockEnd) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const text = (r.text || '').replace(/\s+/g, ' ').trim();
    if (!text || JUNK.some(re => re.test(text))) continue;
    let s = (r.start ?? (i ? raw[i - 1].end : 0) ?? 0) + offset;
    let e = (r.end ?? raw[i + 1]?.start ?? (blockEnd - offset)) + offset;
    if (e < s) e = s;
    // samma mening om och om igen = hallucination
    const prev = out[out.length - 1], prev2 = out[out.length - 2];
    if (prev && prev2 && norm(prev.t) === norm(text) && norm(prev2.t) === norm(text)) { prev.e = e; continue; }
    out.push({ id: newId(), s: round2(s), e: round2(e), t: dedupeRepeats(text), star: false, note: '' });
  }
  return out;
}
const round2 = x => Math.round(x * 100) / 100;
function norm(t) { return t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim(); }
// "och så och så och så och så" -> korta ner upprepningar av samma fras
function dedupeRepeats(text) {
  return text.replace(/(\b[\p{L}\p{N}][^.!?]{0,40}?)(?:[\s,]+\1){3,}/giu, '$1');
}

// ---------- viktigt-signaler ----------
const CUES = [
  /\bviktig(t|a|aste)?\b/i, /\btentan?\b/i, /\btenta(fråga|frågor)?\b/i, /\bexamination(en)?\b/i,
  /\bkom ihåg\b/i, /\bkomma ihåg\b/i, /\bmärk väl\b/i, /\bobservera\b/i, /\bnotera\b/i,
  /\bdefinition(en)?\b/i, /\bdefinieras\b/i, /\bkallas (för )?\b/i, /\bbetyder\b/i, /\binnebär\b/i,
  /\bsammanfattningsvis\b/i, /\bsammanfatta\b/i, /\bdet centrala\b/i, /\bnyckeln\b/i,
  /\bkärnan\b/i, /\bpoängen\b/i, /\bslutsats(en)?\b/i, /\bframför allt\b/i,
  /\bskriv (upp|ner)\b/i, /\bkommer (att )?(komma|dyka upp) på\b/i, /\bni (måste|behöver) (kunna|veta|förstå)\b/i,
  /\bdet här (måste|ska|bör) ni\b/i, /\bkänna till\b/i, /\bförstå (att|hur|varför)\b/i,
];
export function isCue(text) { return CUES.some(re => re.test(text)); }

// ---------- nyckelbegrepp ----------
const STOP = new Set(`alla allt alltid alltså andra annan annat antingen att av bara behöver bli blir blev bra bort bättre både böra då där därför
de dem den denna dess dessa det detta dig din dina ditt dom du där efter eftersom eller en ena enda ett exempel faktiskt finns fick fler flera
fram från får fått för första förstå före ganska genom gick gjorde gjort gå går göra gör hade han hans har hela heller hela hon honom hur här
hände i igen in inget inom inte ja jag just kan kanske komma kommer kunde kunna kör lite liksom lika man med mellan men mer mest mig min mina
mitt mot mycket många måste nej ner ni nog nu när någon något några nästa och också om oss på precis riktigt rätt sedan sen sig sin sina sitt
själv ska skulle slags snarare som stor stora står så sådan sådant säga säger sätt ta tar till tills titta tror två tycker under upp ut utan va
vad var vara varför varje vet vi vid vidare vilka vilken vill visa väl väldigt än ändå ännu är även över okej okay alltså såhär sådär liksom
kanske egentligen ungefär typ grejen grej saker sak gånger gång också första andra tredje dels hälften kolla kollar kommit vart vilket vilket
eh öh mm hm ah oj aa japp nä nää jaha jaså asså tänker tänka tänkte pratar prata pratade sagt sade sa säger börjar börja slut slutet början
någonting ingenting allting varandra därefter emellertid dessutom därmed sätta sitter ligger lägger kommer fortfarande tidigare senare
idag igår imorgon vecka veckan dag dagen år året stund nåt nån inga ingen sånt sånna dom dem hos ens eget egen egna samma olika
föreläsning föreläsningen föreläsningar föreläsningens viktigt viktiga viktigaste tentan tenta tentamen ihåg definition definitionen
betyder innebär kallas observera notera poängen kärnan nyckeln slutsats slutsatsen sammanfattningsvis exempelvis exemplet`.split(/\s+/));

export function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}-]*/gu) || []);
}

export function keywords(segments, limit = 30) {
  const tf = new Map(), df = new Map(), first = new Map();
  const total = segments.length || 1;
  for (const seg of segments) {
    const seen = new Set();
    for (const w of tokenize(seg.t)) {
      if (w.length < 5 || STOP.has(w) || /^\d/.test(w)) continue;
      tf.set(w, (tf.get(w) || 0) + 1);
      if (!seen.has(w)) { seen.add(w); df.set(w, (df.get(w) || 0) + 1); }
      if (!first.has(w)) first.set(w, seg.s);
    }
  }
  // slå ihop böjningsformer (begrepp, begreppet, begreppen) under kortaste formen
  const groups = new Map();
  const words = [...tf.keys()].sort((a, b) => a.length - b.length);
  for (const w of words) {
    let root = null;
    for (const suf of ['erna', 'arna', 'orna', 'ernas', 'arnas', 'ens', 'ets', 'en', 'et', 'er', 'ar', 'or', 'na', 'n', 's', 'a', 'e']) {
      if (w.endsWith(suf) && w.length - suf.length >= 4) {
        const base = w.slice(0, -suf.length);
        if (groups.has(base)) { root = base; break; }
      }
    }
    if (root) groups.get(root).push(w); else groups.set(w, [w]);
  }
  const scored = [];
  for (const [root, forms] of groups) {
    const count = forms.reduce((n, f) => n + tf.get(f), 0);
    const docs = forms.reduce((n, f) => Math.max(n, df.get(f)), 0);
    if (count < 3) continue;
    // långa ord (sammansättningar, fackord) väger tyngre; ord som finns överallt väger lättare
    const spread = docs / total;
    const score = count * Math.log2(root.length) * (spread > 0.25 ? 0.4 : 1);
    const display = forms.reduce((best, f) => tf.get(f) > tf.get(best) ? f : best, forms[0]);
    scored.push({ word: display, forms, count, score, first: Math.min(...forms.map(f => first.get(f))) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- avsnitt (kapitel) ----------
// Delar vid den längsta pausen nära varje ~10-minutersgräns.
export function chapters(segments, target = 600) {
  if (!segments.length) return [];
  const cuts = [0];
  let lastCut = segments[0].s;
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].s - lastCut < target) continue;
    // titta på kandidater inom ±2 min
    let best = i, bestGap = -1;
    for (let j = i; j < segments.length && segments[j].s - segments[i].s < 240; j++) {
      const gap = segments[j].s - segments[j - 1].e;
      const sentenceEnd = /[.!?]$/.test(segments[j - 1].t) ? 0.5 : 0;
      if (gap + sentenceEnd > bestGap) { bestGap = gap + sentenceEnd; best = j; }
    }
    cuts.push(best);
    lastCut = segments[best].s;
    i = best;
  }
  const out = [];
  for (let c = 0; c < cuts.length; c++) {
    const from = cuts[c], to = c + 1 < cuts.length ? cuts[c + 1] : segments.length;
    const segs = segments.slice(from, to);
    const kws = keywords(segs, 3).map(k => k.word);
    out.push({
      index: c, from, to, start: segs[0].s, end: segs[segs.length - 1].e,
      title: kws.length ? capitalize(kws.join(', ')) : `Del ${c + 1}`,
    });
  }
  return out;
}
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- stycken för läsläge ----------
export function paragraphs(segments) {
  const out = [];
  let cur = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prev = segments[i - 1];
    const gap = prev ? seg.s - prev.e : 0;
    const len = cur.reduce((n, s) => n + s.t.length, 0);
    if (cur.length && (gap > 2.5 || len > 700 || (len > 350 && /[.!?]$/.test(prev.t)))) { out.push(cur); cur = []; }
    cur.push(seg);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- förhör (lucktest) ----------
export function makeCards(segments, kw) {
  const kwSet = new Map();
  kw.forEach((k, rank) => k.forms.forEach(f => kwSet.set(f, rank)));
  const cards = [];
  for (const seg of segments) {
    if (!(seg.star || isCue(seg.t))) continue;
    if (seg.t.length < 30) continue;
    // välj det viktigaste begreppet i meningen, annars det längsta ordet
    const tokens = seg.t.match(/[\p{L}][\p{L}\p{N}-]*/gu) || [];
    let pick = null, pickRank = Infinity;
    for (const tok of tokens) {
      const r = kwSet.get(tok.toLowerCase());
      if (r !== undefined && r < pickRank) { pick = tok; pickRank = r; }
    }
    if (!pick) {
      const cand = tokens.filter(t => t.length >= 7 && !STOP.has(t.toLowerCase()));
      if (!cand.length) continue;
      pick = cand.sort((a, b) => b.length - a.length)[0];
    }
    const re = new RegExp(`(^|[^\\p{L}])(${escapeRe(pick)})(?![\\p{L}])`, 'u');
    const question = seg.t.replace(re, (m, pre) => pre + '_____');
    if (question === seg.t) continue;
    cards.push({ id: seg.id, question, answer: pick, context: seg.t, s: seg.s, starred: !!seg.star });
  }
  return cards;
}
export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- AI-prompter ----------
export const PROMPTS = {
  summary: {
    label: 'Sammanfattning',
    text: `Du är en pedagogisk studiecoach. Nedan finns ett automatiskt transkript av en universitetsföreläsning på svenska (det kan innehålla hörfel – tolka dem utifrån sammanhanget).

Gör en strukturerad sammanfattning på svenska att plugga från:
1. Föreläsningens syfte i 2–3 meningar.
2. Huvudpunkter under tydliga rubriker, i den ordning de tas upp, med tidsstämplar [mm:ss] så att jag kan hitta tillbaka.
3. Alla viktiga begrepp med en kort, korrekt definition.
4. Saker föreläsaren betonar som viktiga eller som kan komma på tentan.
5. De 5 viktigaste sakerna att kunna.`,
  },
  flashcards: {
    label: 'Flashcards',
    text: `Du är en pedagogisk studiecoach. Nedan finns ett automatiskt transkript av en föreläsning på svenska (det kan innehålla hörfel).

Skapa 25–40 flashcards på svenska som täcker det viktigaste i föreläsningen. Blanda definitioner, förklaringar ("varför/hur"), samband och exempel. En fråga per kort, kort och tydligt svar.

Ge dem först som en tabell (Fråga | Svar | Tid [mm:ss]) och sedan samma kort i ett kodblock i formatet
fråga;svar
(ett kort per rad) så att jag kan importera dem i Anki eller Quizlet.`,
  },
  quiz: {
    label: 'Övningsfrågor',
    text: `Du är en examinator på universitetet. Nedan finns ett automatiskt transkript av en föreläsning på svenska (det kan innehålla hörfel).

Skriv ett övningsprov på svenska baserat på föreläsningen:
- 8 flervalsfrågor (A–D)
- 5 kortsvarsfrågor
- 2 resonerande essäfrågor av tentatyp
Ge facit med förklaringar och tidsstämpel [mm:ss] där svaret finns, sist – efter en tydlig avgränsning så att jag kan försöka själv först.`,
  },
  concepts: {
    label: 'Förklara begrepp',
    text: `Du är en tålmodig lärare. Nedan finns ett automatiskt transkript av en föreläsning på svenska (det kan innehålla hörfel).

Gå igenom de svåraste begreppen och resonemangen i föreläsningen. För varje begrepp:
- Förklara det enkelt, som för en klasskompis.
- Ge ett konkret exempel eller en liknelse.
- Visa hur det hänger ihop med de andra begreppen.
- Nämn vanliga missförstånd.
Avsluta med en begreppskarta i textform.`,
  },
  plan: {
    label: 'Pluggplan',
    text: `Du är en studiecoach. Nedan finns ett automatiskt transkript av en föreläsning på svenska.

Gör en konkret pluggplan för den här föreläsningen: vad jag ska läsa/repetera i vilken ordning, uppdelat på 3 pass à 45 min med aktiva övningar (självförhör, förklara högt, rita samband). Lägg in repetition efter 1 dag, 3 dagar och 1 vecka. Avsluta med 5 kontrollfrågor jag ska kunna besvara utan anteckningar.`,
  },
  explain: {
    label: 'Förklara avsnittet',
    text: `Du är en pedagogisk lärare. Nedan finns ett utdrag ur ett automatiskt transkript av en föreläsning på svenska (det kan innehålla hörfel).

Förklara vad föreläsaren går igenom i det här utdraget så att jag verkligen förstår det: först kort och enkelt, sedan mer utförligt med exempel. Peka ut begrepp jag måste kunna och ge 3 frågor jag kan testa mig själv med.`,
  },
};

export function transcriptForAI(segments, title) {
  const withHours = segments.some(s => s.s >= 3600);
  const lines = paragraphs(segments).map(p =>
    `[${fmtTime(p[0].s, withHours)}] ` + p.map(s => s.t + (s.star ? ' ⭐' : '')).join(' ')
  );
  return `Föreläsning: ${title}\n(⭐ = markerat som viktigt av mig)\n\n` + lines.join('\n\n');
}

// ---------- export ----------
export function toTXT(segments, title, { timestamps = true } = {}) {
  const withHours = segments.some(s => s.s >= 3600);
  const body = paragraphs(segments).map(p =>
    (timestamps ? `[${fmtTime(p[0].s, withHours)}] ` : '') + p.map(s => s.t).join(' ')
  ).join('\n\n');
  return `${title}\n\n${body}\n`;
}

export function toSRT(segments) {
  return segments.map((s, i) => `${i + 1}\n${srtTime(s.s)} --> ${srtTime(Math.max(s.e, s.s + 0.5))}\n${s.t}\n`).join('\n');
}

export function toMarkdown(segments, title, chaps, notesInline = true) {
  const withHours = segments.some(s => s.s >= 3600);
  let md = `# ${title}\n\n`;
  const starred = segments.filter(s => s.star);
  if (starred.length) {
    md += `## ⭐ Viktiga delar\n\n` + starred.map(s => `- **[${fmtTime(s.s, withHours)}]** ${s.t}${s.note ? `\n  - *Anteckning:* ${s.note}` : ''}`).join('\n') + '\n\n';
  }
  const chs = chaps?.length ? chaps : [{ from: 0, to: segments.length, title: 'Transkript', start: 0 }];
  md += `## Innehåll\n\n` + chs.map((c, i) => `${i + 1}. ${c.title} (${fmtTime(c.start, withHours)})`).join('\n') + '\n\n';
  for (const c of chs) {
    md += `## ${c.title} — ${fmtTime(c.start, withHours)}\n\n`;
    for (const p of paragraphs(segments.slice(c.from, c.to))) {
      md += `**[${fmtTime(p[0].s, withHours)}]** ` + p.map(s => (s.star ? `**${s.t}**` : s.t)).join(' ') + '\n\n';
      if (notesInline) for (const s of p) if (s.note) md += `> 📝 ${s.note}\n\n`;
    }
  }
  return md;
}

export function toWordHTML(segments, title, chaps) {
  const withHours = segments.some(s => s.s >= 3600);
  const esc = escapeHtml;
  const chs = chaps?.length ? chaps : [{ from: 0, to: segments.length, title: 'Transkript', start: 0 }];
  let body = `<h1>${esc(title)}</h1>`;
  const starred = segments.filter(s => s.star);
  if (starred.length) {
    body += `<h2>Viktiga delar</h2><ul>` + starred.map(s =>
      `<li><b>[${fmtTime(s.s, withHours)}]</b> ${esc(s.t)}${s.note ? `<br><i>Anteckning: ${esc(s.note)}</i>` : ''}</li>`).join('') + '</ul>';
  }
  for (const c of chs) {
    body += `<h2>${esc(c.title)} <span style="color:#888;font-weight:normal">${fmtTime(c.start, withHours)}</span></h2>`;
    for (const p of paragraphs(segments.slice(c.from, c.to))) {
      body += `<p><span style="color:#888">[${fmtTime(p[0].s, withHours)}]</span> ` +
        p.map(s => s.star ? `<b style="background:#fff3b0">${esc(s.t)}</b>` : esc(s.t)).join(' ') + '</p>';
      for (const s of p) if (s.note) body += `<p style="margin-left:2em;color:#555"><i>Anteckning: ${esc(s.note)}</i></p>`;
    }
  }
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5}h1{font-size:20pt}h2{font-size:14pt;margin-top:18pt}</style></head>
<body>${body}</body></html>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
