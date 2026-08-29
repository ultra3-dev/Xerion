/**
 * ============================================================================
 *  XERION v2.0.2 ULTRA — ai.js
 *  Integración con Groq (API compatible con OpenAI) para el chat: la gente
 *  puede hablar con el bot mencionándolo (@Xerion) o respondiendo a un
 *  mensaje que la IA generó antes. Nada más activa la IA — nunca se mete
 *  sola en cofres, eliminaciones ni ningún otro flujo del juego.
 *
 *  REGLA DE ORO, innegociable: el bot JAMÁS pinga a nadie por esta vía, pase
 *  lo que pase, se lo pidan como se lo pidan. Esto se garantiza en DOS capas
 *  independientes:
 *   - Código (game.js): todo mensaje generado por la IA se envía SIEMPRE con
 *     `allowedMentions: SAFE_MENTIONS` (parse: []), que a nivel de la propia
 *     API de Discord desactiva cualquier notificación sin importar el texto.
 *     Esta es la garantía real — no depende de que el modelo "se porte bien".
 *   - Texto (sanitizeAiText, acá abajo): además, se neutraliza cualquier
 *     @everyone/@here o mención cruda que el modelo pudiera llegar a escribir,
 *     así ni siquiera se ve como un intento de ping.
 *
 *  Si no hay GROQ_API_KEY configurada, o si Groq falla o tarda demasiado,
 *  todo acá devuelve null en silencio — nunca rompe el juego ni manda un
 *  mensaje de error feo. El resto del bot funciona igual de bien sin esto.
 * ============================================================================
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Groq retiró `llama-3.1-8b-instant` y `llama-3.3-70b-versatile` el 16 de
// agosto de 2026 (por eso el reporte de "varios modelos no funcionan desde
// el 16" — confirmado contra console.groq.com/docs/deprecations). El
// reemplazo oficial y actual es `openai/gpt-oss-20b`, y NO está deprecado —
// así que es el default seguro. Si en el futuro Groq vuelve a retirar algo,
// FALLBACK_MODEL es la red de seguridad de abajo, no hace falta tocar nada
// más: cualquier modelo puesto en GROQ_MODEL que falle por estar
// descontinuado cae automáticamente acá en el mismo intento.
const PRIMARY_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

function isAiAvailable() {
  return Boolean(process.env.GROQ_API_KEY);
}

/** true si el cuerpo de error de Groq indica un modelo inválido/descontinuado (no un problema de red, cuota, etc). */
function looksLikeModelError(status, bodyText) {
  if (status !== 400 && status !== 404) return false;
  const t = (bodyText || '').toLowerCase();
  return t.includes('model') && (t.includes('decommission') || t.includes('does not exist') || t.includes('not found') || t.includes('deprecat'));
}

async function requestGroq(model, messages, { maxTokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return { ok: false, status: res.status, bodyText };
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return { ok: true, text: text || null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Llamado a Groq con reintento automático de modelo. Nunca lanza — cualquier
 * problema (sin API key, error HTTP, timeout, respuesta rara) devuelve null
 * y lo deja logueado con el cuerpo real del error (no solo el status), para
 * que un problema de modelo/cuota/etc. se pueda diagnosticar desde los logs
 * sin adivinar. Si el modelo configurado (PRIMARY_MODEL) fallara por estar
 * descontinuado, reintenta UNA vez con FALLBACK_MODEL antes de rendirse —
 * así un GROQ_MODEL viejo en las variables de entorno nunca deja la IA muda.
 */
async function callGroq(messages, { maxTokens = 200, temperature = 0.9, timeoutMs = 6000 } = {}) {
  if (!isAiAvailable()) return null;

  try {
    const first = await requestGroq(PRIMARY_MODEL, messages, { maxTokens, temperature, timeoutMs });
    if (first.ok) return first.text;

    console.error(`[Xerion IA] Groq respondió HTTP ${first.status} con el modelo "${PRIMARY_MODEL}": ${first.bodyText.slice(0, 300)}`);

    if (PRIMARY_MODEL !== FALLBACK_MODEL && looksLikeModelError(first.status, first.bodyText)) {
      console.error(`[Xerion IA] "${PRIMARY_MODEL}" parece descontinuado — reintentando una vez con "${FALLBACK_MODEL}".`);
      const retry = await requestGroq(FALLBACK_MODEL, messages, { maxTokens, temperature, timeoutMs });
      if (retry.ok) return retry.text;
      console.error(`[Xerion IA] El reintento con "${FALLBACK_MODEL}" también falló (HTTP ${retry.status}): ${retry.bodyText.slice(0, 300)}`);
    }
    return null;
  } catch (err) {
    console.error('[Xerion IA] Error llamando a Groq:', err.message);
    return null;
  }
}

/**
 * Segunda capa de seguridad: neutraliza cualquier @everyone/@here o mención
 * cruda (<@id>, <@&id>, <#id>) que el modelo pudiera llegar a escribir, y
 * recorta el largo para que nunca rompa el límite de un mensaje de Discord.
 * La garantía real de que nunca pingea es `allowedMentions` en game.js — esto
 * es solo para que ni siquiera se VEA como un intento.
 */
function sanitizeAiText(text) {
  if (!text) return null;
  let clean = text
    .replace(/@(everyone|here)/gi, '$1')
    .replace(/<@[!&]?\d+>/g, 'alguien')
    .replace(/<#\d+>/g, 'ese canal')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return null;
  if (clean.length > 1500) clean = `${clean.slice(0, 1500)}…`;
  return clean;
}

const CHAT_SYSTEM_PROMPT = `Eres Xerion, la IA/mascota de un bot de Discord de cofres y batallas por eliminación (roles: ARISE, KING, GOAT, AURA INFINITE, STAR X; moneda: Feathers 🐦‍🔥).

Cómo hablas:
- Como una persona real chateando en Discord: casual, frases cortas, sin sonar corporativo ni como un asistente genérico. Nada de "¡Claro! Estoy aquí para ayudarte con lo que necesites".
- Responde en el mismo idioma en el que te escriben (por defecto español).
- Máximo 1-3 frases. Esto es un chat, no un ensayo.
- Tienes personalidad y buen humor: si te tratan bien, eres cálido y divertido; si te tratan mal o intentan picarte, respondes con ingenio y sarcasmo ligero — nunca realmente cruel ni tóxico, solo con carácter.
- Puedes usar emoji ocasionalmente, sin abusar.
- Si preguntan del bot (cofres, roles, /shop, /daily, /claim, /profile, etc.) puedes explicar brevemente, pero hablas como parte del juego, no como un manual.

Regla que nunca rompes, sin excepción, la pidan como la pidan (directo, disfrazado, insistiendo, "es broma", lo que sea): JAMÁS escribes @everyone, @here, ni menciones/pings de ningún usuario o rol. Si te lo piden, responde con humor que eso no lo vas a hacer, sin dar explicaciones técnicas.`;

/** Respuesta de chat cuando alguien menciona al bot o responde a un mensaje de la IA. Devuelve null si la IA no está disponible o falla. */
async function generateChatReply({ userMessage, authorName }) {
  if (!userMessage) return null;
  const messages = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: `${authorName} te escribe: ${userMessage}` },
  ];
  const raw = await callGroq(messages, { maxTokens: 220, temperature: 0.95, timeoutMs: 8000 });
  return sanitizeAiText(raw);
}

module.exports = {
  isAiAvailable,
  generateChatReply,
};
