// Claude-integration via Anthropics officiella SDK, direkt från webbläsaren.
// API-nyckeln sparas bara i användarens webbläsare (localStorage) och skickas bara till api.anthropic.com.
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
const MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
const PURIFY_URL = 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs';

export const MODEL = 'claude-opus-5-5';
const KEY_STORAGE = 'transkribera.anthropicKey';
// Ungefärliga priser för Claude Opus 5.5 (USD per miljon tokens) och växelkurs – bara för en grov kostnadsvisning.
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const SEK_PER_USD = 10.5;

let sdkPromise = null, mdPromise = null;
function loadSdk() { return sdkPromise ||= import(SDK_URL); }
function loadMarkdown() {
  return mdPromise ||= Promise.all([import(MARKED_URL), import(PURIFY_URL)]).then(([m, p]) => ({ marked: m.marked, purify: p.default }));
}

export function getKey() { try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; } }
export function setKey(k) { try { k ? localStorage.setItem(KEY_STORAGE, k.trim()) : localStorage.removeItem(KEY_STORAGE); } catch {} }
export function hasKey() { return !!getKey(); }

async function client() {
  const mod = await loadSdk();
  const Anthropic = mod.default || mod.Anthropic;
  return { mod, c: new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true, maxRetries: 3 }) };
}

export class AIError extends Error {}

// Översätter SDK-fel till begripliga svenska meddelanden.
function friendly(err, mod) {
  if (err instanceof AIError) return err;
  const E = mod || {};
  if (E.APIUserAbortError && err instanceof E.APIUserAbortError) return new AIError('Avbrutet.');
  if (E.AuthenticationError && err instanceof E.AuthenticationError) return new AIError('API-nyckeln fungerar inte. Kontrollera att du klistrat in hela nyckeln (börjar med sk-ant-) under Inställningar.');
  if (E.PermissionDeniedError && err instanceof E.PermissionDeniedError) return new AIError('Nyckeln saknar behörighet till modellen. Kontrollera kontot på console.anthropic.com.');
  if (E.RateLimitError && err instanceof E.RateLimitError) return new AIError('För många förfrågningar just nu. Vänta en minut och försök igen.');
  if (E.BadRequestError && err instanceof E.BadRequestError) {
    if (/credit balance/i.test(err.message)) return new AIError('Kontot har slut på krediter. Fyll på under Billing på console.anthropic.com.');
    return new AIError('Förfrågan nekades: ' + err.message);
  }
  if (E.APIConnectionError && err instanceof E.APIConnectionError) return new AIError('Kunde inte nå Claude. Kontrollera internetanslutningen.');
  if (E.InternalServerError && err instanceof E.InternalServerError) return new AIError('Claude är tillfälligt överbelastat. Försök igen om en stund.');
  if (E.APIError && err instanceof E.APIError) return new AIError(`Fel från Claude (${err.status ?? '?'}): ${err.message}`);
  return new AIError(String(err?.message || err));
}

export async function testKey() {
  const { mod, c } = await client();
  try { await c.models.retrieve(MODEL); return true; } catch (e) { throw friendly(e, mod); }
}

const SYSTEM = `Du är en kunnig och pedagogisk studiecoach för en universitetsstudent i Sverige. Du hjälper henne att plugga från en föreläsning.
Underlaget är ett automatiskt transkript (KB-Whisper) av föreläsningen. Det kan innehålla hörfel, särskilt i facktermer och namn – tolka dem utifrån sammanhanget och skriv den korrekta termen. Om något är oklart i transkriptet, säg det i stället för att gissa.
Regler:
- Svara alltid på svenska, tydligt och välstrukturerat med Markdown (rubriker, punktlistor, **fetstil** för begrepp).
- Hänvisa till var i föreläsningen saker sägs med tidsstämplar inom hakparentes, exakt i formatet [mm:ss] eller [h:mm:ss], tagna från transkriptet. De blir klickbara för studenten.
- Håll dig till det föreläsningen tar upp. Om du lägger till förklaringar eller exempel som inte finns i föreläsningen, markera det kort ("Utöver föreläsningen: …").
- Var konkret och pedagogisk. Hellre en bra förklaring än många ytliga.`;

function systemBlocks(transcript) {
  return [
    { type: 'text', text: SYSTEM },
    // transkriptet cachas så att följdfrågor och flera knapptryck blir billigare och snabbare
    { type: 'text', text: transcript, cache_control: { type: 'ephemeral' } },
  ];
}

export function estimateCostSEK(usage) {
  if (!usage) return 0;
  const usd = ((usage.input_tokens || 0) * PRICE.input + (usage.output_tokens || 0) * PRICE.output +
    (usage.cache_read_input_tokens || 0) * PRICE.cacheRead + (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite) / 1e6;
  return usd * SEK_PER_USD;
}

/**
 * Strömmar ett svar. messages: [{role:'user'|'assistant', content:string}].
 * onText(fullTextSoFar) anropas löpande.
 */
export async function streamAnswer({ transcript, messages, effort = 'high', maxTokens = 32000, onText, signal }) {
  const { mod, c } = await client();
  try {
    const stream = c.beta.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemBlocks(transcript),
      messages,
      output_config: { effort },
    }, { signal });
    let text = '';
    stream.on('text', (delta) => { text += delta; onText?.(text); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new AIError('Claude kunde inte svara på den här förfrågan. Försök formulera om den.');
    const full = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { text: full || text, usage: msg.usage, truncated: msg.stop_reason === 'max_tokens' };
  } catch (e) { throw friendly(e, mod); }
}

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Frågan, på svenska' },
          a: { type: 'string', description: 'Kort, korrekt svar (1–3 meningar)' },
          t: { type: 'string', description: 'Tidsstämpel där det tas upp, format mm:ss eller h:mm:ss' },
        },
        required: ['q', 'a', 't'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

/** Skapar förhörskort (fråga/svar) som strukturerad JSON. */
export async function generateCards({ transcript, focus, count = 30, signal, onProgress }) {
  const { mod, c } = await client();
  try {
    const stream = c.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemBlocks(transcript),
      messages: [{
        role: 'user',
        content: `Skapa ${count} förhörskort (fråga + svar) som täcker det viktigaste i föreläsningen${focus ? ` – fokusera på ${focus}` : ''}.
Blanda definitioner, förklaringar (varför/hur), samband mellan begrepp och tillämpningar. Prioritera det föreläsaren betonar som viktigt. Undvik triviala frågor och frågor om ren ordalydelse. Varje kort ska ha en tidsstämpel från transkriptet där svaret finns.`,
      }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: CARD_SCHEMA } },
    }, { signal });
    let n = 0;
    stream.on('text', (d) => { n += d.length; onProgress?.(n); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new AIError('Claude kunde inte skapa kort av den här texten.');
    const raw = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let data;
    try { data = JSON.parse(raw); } catch { throw new AIError('Svaret blev ofullständigt. Försök igen, gärna med ett mindre avsnitt.'); }
    return { cards: Array.isArray(data.cards) ? data.cards : [], usage: msg.usage };
  } catch (e) { throw friendly(e, mod); }
}

// ---------- Markdown → säker HTML, med klickbara tidsstämplar ----------
export function parseTimestamp(ts) {
  const p = ts.split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
export async function renderMarkdown(text) {
  const { marked, purify } = await loadMarkdown();
  const linked = text.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g, (m, ts) => {
    const sec = parseTimestamp(ts);
    return sec == null ? m : `[${ts}](#t=${sec})`;
  });
  const html = marked.parse(linked, { gfm: true, breaks: false });
  return purify.sanitize(html, { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input'], FORBID_ATTR: ['style'] });
}
export function plainToHtml(text) {
  return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
}

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['rätt', 'delvis', 'fel'] },
    feedback: { type: 'string', description: 'Kort återkoppling på svenska, 1–3 meningar: vad som var rätt, vad som saknas eller är fel.' },
  },
  required: ['verdict', 'feedback'],
  additionalProperties: false,
};

/** Rättar studentens fritextsvar mot facit. Liten och billig förfrågan (inget transkript skickas). */
export async function gradeAnswer({ question, answer, studentAnswer, signal }) {
  const { mod, c } = await client();
  try {
    const msg = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'Du rättar en universitetsstudents svar på en förhörsfråga. Var rättvis och uppmuntrande men ärlig. Bedöm innehållet, inte stavning eller formuleringar – egna ord är bra. "rätt" = kärnan är korrekt, "delvis" = på rätt spår men något viktigt saknas eller är oprecist, "fel" = felaktigt eller saknar kärnan. Svara på svenska.',
      messages: [{ role: 'user', content: `Fråga: ${question}\n\nFacit: ${answer}\n\nStudentens svar: ${studentAnswer}` }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: GRADE_SCHEMA } },
    }, { signal });
    if (msg.stop_reason === 'refusal') throw new AIError('Claude kunde inte rätta svaret.');
    const raw = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { ...JSON.parse(raw), usage: msg.usage };
  } catch (e) { throw friendly(e, mod); }
}
