/**
 * ============================================================================
 *  XERION v1.9.2 — ai.js
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
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b'; // rápido y barato — reemplazo oficial de Groq para el modelo descontinuado

function isAiAvailable() {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * Llamado crudo a Groq. Nunca lanza — cualquier problema (sin API key, error
 * HTTP, timeout, respuesta rara) devuelve null y lo deja logueado.
 */
async function callGroq(messages, { maxTokens = 200, temperature = 0.9, timeoutMs = 6000 } = {}) {
  if (!isAiAvailable()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[Xerion IA] Groq respondió HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.error('[Xerion IA] Error llamando a Groq:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
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
