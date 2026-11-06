require('../loadEnv');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Sampling knobs (identical contract in groqService.js / geminiService.js)
//
// AI_TEMPERATURE - float, 0..2, default 0.4. Low temperature tracks one
//   person's terse WhatsApp voice more faithfully than a chatty default
//   (this service used to be pinned at 0.7).
// AI_MAX_TOKENS  - positive int, default 256, sent as options.num_predict.
//   Replies should be 2-8 words; a large cap just lets the model ramble.
// Anything unparseable / out of range falls back to the default.
//
// CONTEXT WINDOW (why num_ctx is set explicitly):
//   Ollama does NOT size the context window to the prompt. When num_ctx is
//   omitted it applies the server default (2048, 4096 on newer builds) and
//   silently truncates the FRONT of the prompt -- which is exactly where
//   promptService puts the persona, dictionary, style, rules and the few-shot
//   exemplar block. Nothing errors; the style instructions just vanish and the
//   model answers as a generic assistant off the tail of the history.
//
// OLLAMA_NUM_CTX - positive int, default 8192, sent as options.num_ctx.
//   Budget for the default prompt shape:
//     ~2.4 KB  system persona (system_prompts/system_prompt_v3.txt)
//     ~2 KB    MY PERSONA + dictionary + user persona + summary + style + rules
//     ~1 KB    few-shot EXEMPLAR block
//     ~10 KB   HISTORY_MESSAGE_LIMIT (100) lines, each a ~35 char timestamped
//              "[ts] User: " prefix plus a ~60 char WhatsApp message
//   ~15-16 KB of characters, i.e. roughly 4k tokens at ~4 chars/token, plus
//   num_predict (256) for the reply. 8192 leaves ~2x headroom for chattier
//   contacts or a raised HISTORY_MESSAGE_LIMIT while staying cheap on KV-cache
//   memory. Raise it if HISTORY_MESSAGE_LIMIT goes much past 100; the prompt
//   AND the reply share this window.
// ---------------------------------------------------------------------------
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_NUM_CTX = 8192;

function resolveTemperature() {
    const parsed = parseFloat(process.env.AI_TEMPERATURE);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
        return parsed;
    }
    return DEFAULT_TEMPERATURE;
}

function resolveMaxTokens() {
    const parsed = parseInt(process.env.AI_MAX_TOKENS, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
    }
    return DEFAULT_MAX_TOKENS;
}

function resolveNumCtx() {
    const parsed = parseInt(process.env.OLLAMA_NUM_CTX, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
    }
    return DEFAULT_NUM_CTX;
}

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** CONTRACT 2 failure shape. text is ALWAYS null -- never a human-readable
 *  error string, because callers used to send that straight to a real contact
 *  and store it as a Rohan-voice training example. */
function failure(message) {
    return { ok: false, text: null, error: message, usage: { ...ZERO_USAGE } };
}

/**
 * Generates a response using a local Ollama instance (v3).
 *
 * Sampling: options.temperature = AI_TEMPERATURE (default 0.4),
 *           options.num_predict = AI_MAX_TOKENS (default 256),
 *           options.num_ctx     = OLLAMA_NUM_CTX (default 8192) -- without it
 *           Ollama truncates the front of the prompt (persona, style, rules,
 *           exemplars) to fit its 2048/4096 server default.
 *
 * @param {string} prompt - The user's prompt (final message)
 * @param {Array} history - The conversation history including system prompt
 * @returns {Promise<{ok: boolean, text: (string|null), error?: string, usage: object}>}
 *   success: { ok: true,  text: "<reply>", usage: {promptTokens, completionTokens, totalTokens} }
 *   failure: { ok: false, text: null, error: "<message>", usage: {0,0,0} }
 */
async function generateResponse(prompt, history = []) {
    const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

    try {
        console.log(`[Ollama] Requesting response from model: ${OLLAMA_MODEL}`);
        
        // Ollama /api/chat expects messages in { role, content } format
        // history already contains messages in this format
        const messages = [...history];

        // Ensure the last message is a user prompt if provided
        if (prompt && (!messages.length || messages[messages.length - 1].role !== 'user')) {
            messages.push({ role: 'user', content: prompt });
        }

        const payload = {
            model: OLLAMA_MODEL,
            messages: messages,
            stream: false,
            options: {
                temperature: resolveTemperature(),
                num_predict: resolveMaxTokens(),
                // Must be explicit: the server default silently drops the front
                // of the prompt, i.e. every style instruction we send.
                num_ctx: resolveNumCtx(),
            }
        };

        if (process.env.DEBUG === 'true') {
            console.log("\n--- [DEBUG] FINAL OLLAMA PAYLOAD ---");
            console.log(JSON.stringify(payload, null, 2));
            console.log("------------------------------------\n");
        }

        const response = await axios.post(`${OLLAMA_HOST}/api/chat`, payload);

        if (response.data && response.data.message) {
            const aiText = response.data.message.content;
            const promptTokens = response.data.prompt_eval_count || 0;
            const completionTokens = response.data.eval_count || 0;
            const totalTokens = promptTokens + completionTokens;

            if (typeof aiText !== 'string' || !aiText.trim()) {
                console.error('Ollama returned an empty message.');
                return failure('Ollama returned an empty message.');
            }

            console.log(`Ollama responded: "${aiText.substring(0, 50)}..."`);
            
            return {
                ok: true,
                text: aiText,
                usage: {
                    promptTokens,
                    completionTokens,
                    totalTokens
                }
            };
        } else {
            console.error('Unexpected response format from Ollama:', response.data);
            return failure('Unexpected response format from Ollama.');
        }
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error(`Error: Could not connect to Ollama at ${OLLAMA_HOST}. Is it running?`);
            return failure(`Could not connect to Ollama at ${OLLAMA_HOST}.`);
        }
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('Error generating response from Ollama:', error.response ? error.response.data : error.message);
        return failure(`Ollama request failed: ${detail}`);
    }
}

module.exports = { generateResponse };
