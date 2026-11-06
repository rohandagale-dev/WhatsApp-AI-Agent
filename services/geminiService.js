require('../loadEnv');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Model selection
//
// GEMINI_MODEL - model id, default 'gemini-2.5-flash'.
//   whatsappService records `process.env.GEMINI_MODEL || 'gemini-2.5-flash'`
//   in chats.metadata.model. This service MUST read the same env var, or a
//   deployment that sets GEMINI_MODEL would store a model id that never
//   answered the request.
//   Resolved per call (not at module load) so callers and tests that mutate
//   process.env after require() still hit the model they asked for.
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = 'gemini-2.5-flash';

function resolveModel() {
    const configured = (process.env.GEMINI_MODEL || '').trim();
    return configured || DEFAULT_MODEL;
}

function geminiUrl(model) {
    const key = process.env.GEMINI_API_KEY || '';
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        `:generateContent?key=${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// Sampling knobs (identical contract in groqService.js / ollamaService.js)
//
// AI_TEMPERATURE - float, 0..2, default 0.4. Low temperature tracks one
//   person's terse WhatsApp voice more faithfully than a chatty default.
// AI_MAX_TOKENS  - positive int, default 256. This is the budget for VISIBLE
//   output only; replies should be 2-8 words, so a large cap just gives the
//   model room to ramble.
// Anything unparseable / out of range falls back to the default.
//
// THINKING (the reason this file used to answer nobody):
//   gemini-2.5-* bills internal "thinking" tokens against the SAME
//   maxOutputTokens budget as visible text. With maxOutputTokens: 256 and no
//   thinkingConfig, the model spent the whole budget thinking and came back
//   with finishReason MAX_TOKENS and no content.parts at all -- so every reply
//   failed CONTRACT 2's (r && r.ok && r.text) gate and the agent sent nothing.
//   Since AI_VERSION defaults to 'v1' (Gemini), that was every reply on a
//   fresh clone. Two fixes, both applied:
//     1. thinkingConfig.thinkingBudget defaults to 0, i.e. thinking OFF. A
//        2-8 word WhatsApp reply needs no reasoning trace.
//     2. Whenever thinking IS enabled, its budget is added ON TOP of
//        AI_MAX_TOKENS, so the visible allowance survives either way.
//
// GEMINI_THINKING_BUDGET - default 0 (thinking disabled).
//     0      : thinking off (supported by gemini-2.5-flash / flash-lite).
//     N > 0  : cap thinking at N tokens (gemini-2.5-pro cannot disable
//              thinking and requires N >= 128).
//     -1     : dynamic -- the model decides how much to think.
//     'none' : omit thinkingConfig entirely, for models that reject the field.
//   Anything else falls back to 0.
// ---------------------------------------------------------------------------
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_THINKING_BUDGET = 0;

// When the thinking spend is not a number we control ('none' / -1), reserve a
// fixed slice of maxOutputTokens for it so visible output still has room.
const DYNAMIC_THINKING_RESERVE = 1024;

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

/** @returns {number|null} thinking token budget, or null to omit thinkingConfig. */
function resolveThinkingBudget() {
    const raw = (process.env.GEMINI_THINKING_BUDGET || '').trim();
    if (!raw) {
        return DEFAULT_THINKING_BUDGET;
    }
    if (raw.toLowerCase() === 'none') {
        return null;
    }
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= -1) {
        return parsed;
    }
    return DEFAULT_THINKING_BUDGET;
}

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** CONTRACT 2 failure shape. text is ALWAYS null -- never a human-readable
 *  error string, because callers used to send that straight to a real contact
 *  and store it as a Rohan-voice training example. */
function failure(message) {
    return { ok: false, text: null, error: message, usage: { ...ZERO_USAGE } };
}

/**
 * Pulls the visible reply out of a candidate.
 * Thought parts (parts[i].thought === true) summarise the model's internal
 * reasoning and must never be sent to a contact, so they are dropped; the
 * remaining text parts are concatenated.
 *
 * @returns {string} the reply, or '' when the candidate carries no visible text.
 */
function extractText(candidate) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];
    return parts
        .filter(p => p && p.thought !== true && typeof p.text === 'string')
        .map(p => p.text)
        .join('')
        .trim();
}

/**
 * Generates a response using Gemini (v1).
 *
 * Model: GEMINI_MODEL (default 'gemini-2.5-flash').
 * Sampling: temperature = AI_TEMPERATURE (default 0.4),
 *           maxOutputTokens = AI_MAX_TOKENS (default 256) + thinking reserve,
 *           thinkingConfig.thinkingBudget = GEMINI_THINKING_BUDGET (default 0).
 *
 * @param {string} prompt - The user's prompt (final message)
 * @param {Array} history - The conversation history including system prompt
 * @returns {Promise<{ok: boolean, text: (string|null), error?: string, usage: object}>}
 *   success: { ok: true,  text: "<reply>", usage: {promptTokens, completionTokens, totalTokens} }
 *   failure: { ok: false, text: null, error: "<message>", usage: {0,0,0} }
 */
async function generateResponse(prompt, history = []) {
    if (!process.env.GEMINI_API_KEY) {
        console.warn('something went wrong with API key');
    }

    const model = resolveModel();

    // 1. Extract system prompt and filter history
    const systemMessage = history.find(m => m.role === "system");
    const systemPrompt = systemMessage ? systemMessage.content : "You are a helpful assistant.";

    const chatHistory = history.filter(m => m.role !== "system");

    // 2. Map and merge consecutive messages with the same role for Gemini API compatibility
    const contents = [];
    chatHistory.forEach((m) => {
        const role = m.role === "assistant" ? "model" : "user";
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
            // Append to the last message's parts
            contents[contents.length - 1].parts[0].text += `\n${m.content}`;
        } else {
            // Add a new message entry
            contents.push({
                role: role,
                parts: [{ text: m.content }]
            });
        }
    });

    // If history is empty OR the last role is model, we need to ensure the turn starts/ends correctly
    // or just ensure we have at least one user message if no history exists.
    if (contents.length === 0) {
        contents.push({
            role: "user",
            parts: [{ text: prompt }]
        });
    }

    try {
        // maxOutputTokens covers thinking + visible text on 2.5 models, so the
        // thinking budget is added on top of the visible allowance instead of
        // being allowed to eat it.
        const visibleTokens = resolveMaxTokens();
        const thinkingBudget = resolveThinkingBudget();
        const thinkingReserve = (thinkingBudget === null || thinkingBudget === -1)
            ? DYNAMIC_THINKING_RESERVE
            : thinkingBudget;
        const maxOutputTokens = visibleTokens + thinkingReserve;

        const generationConfig = {
            temperature: resolveTemperature(),
            maxOutputTokens: maxOutputTokens
        };
        if (thinkingBudget !== null) {
            generationConfig.thinkingConfig = { thinkingBudget: thinkingBudget };
        }

        const payload = {
            system_instruction: {
                parts: [{ text: systemPrompt }]
            },
            contents: contents,
            generationConfig: generationConfig
        };

        if (process.env.DEBUG === 'true') {
            console.log("--- Gemini API Payload ---");
            console.log(`model: ${model}`);
            console.log(JSON.stringify(payload, null, 2));
            console.log("--------------------------");
        }

        const response = await axios.post(geminiUrl(model), payload);

        const data = response.data || {};
        const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
        const aiText = extractText(candidate);
        const finishReason = (candidate && candidate.finishReason) || null;
        const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
        const usage = data.usageMetadata || {};

        if (!aiText) {
            let message;
            if (finishReason === 'MAX_TOKENS') {
                // Thinking tokens are billed against maxOutputTokens, so when
                // thinking is on this is nearly always "the budget was spent
                // before any visible text".
                const head = `Gemini (${model}) hit maxOutputTokens (${maxOutputTokens}) before ` +
                    `emitting any visible text`;
                message = thinkingBudget === 0
                    ? `${head}. Thinking is already disabled, so raise AI_MAX_TOKENS ` +
                      `(currently ${visibleTokens}).`
                    : `${head} -- the budget went to internal thinking (thinkingBudget: ` +
                      `${thinkingBudget === null ? 'unset' : thinkingBudget}). Set ` +
                      `GEMINI_THINKING_BUDGET=0 to disable thinking, or raise AI_MAX_TOKENS.`;
            } else if (blockReason) {
                message = `Gemini (${model}) blocked the prompt (blockReason: ${blockReason}).`;
            } else {
                message = `Gemini (${model}) returned no usable text ` +
                    `(finishReason: ${finishReason || 'UNKNOWN'}).`;
            }
            console.error(message);
            return failure(message);
        }

        if (finishReason === 'MAX_TOKENS') {
            console.warn(`Gemini reply was truncated at maxOutputTokens (${maxOutputTokens}); ` +
                `raise AI_MAX_TOKENS if replies are being cut off.`);
        }

        console.log(`Gemini responded: "${aiText.substring(0, 50)}..."`);

        return {
            ok: true,
            text: aiText,
            usage: {
                promptTokens: usage.promptTokenCount || 0,
                completionTokens: usage.candidatesTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0
            }
        };
    } catch (error) {
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('Error generating response from Gemini:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        return failure(`Gemini request failed: ${detail}`);
    }
}

module.exports = { generateResponse };
