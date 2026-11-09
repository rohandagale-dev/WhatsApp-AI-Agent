require('../loadEnv');
const Groq = require('groq-sdk');

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

// ---------------------------------------------------------------------------
// Sampling knobs (identical contract in geminiService.js / ollamaService.js)
//
// AI_TEMPERATURE - float, 0..2, default 0.4.
//   We are imitating one specific person's terse WhatsApp voice, not writing
//   prose. Lower temperature tracks that voice more faithfully; the old 0.7
//   (while this comment claimed 0.8) let the model invent its own register.
// AI_MAX_TOKENS  - positive int, default 256.
//   Replies should be 2-8 words. The old max_completion_tokens: 8192 gave the
//   model room to ramble into assistant-speak.
// Anything unparseable / out of range falls back to the default.
// ---------------------------------------------------------------------------
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_TOKENS = 256;

// GROQ_REASONING_EFFORT: 'low' (default) | 'medium' | 'high' | 'none' | 'default'.
// 'default' omits the field entirely, for models that reject it. Anything
// unrecognised falls back to 'low'. See the request builder for why this matters.
const REASONING_EFFORT = (() => {
    const raw = (process.env.GROQ_REASONING_EFFORT || 'low').trim().toLowerCase();
    return ['low', 'medium', 'high', 'none', 'default'].includes(raw) ? raw : 'low';
})();

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

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** CONTRACT 2 failure shape. text is ALWAYS null -- never a human-readable
 *  error string, because callers used to send that straight to a real contact
 *  and store it as a Rohan-voice training example. */
function failure(message) {
    return { ok: false, text: null, error: message, usage: { ...ZERO_USAGE } };
}

/**
 * Generates a response using Groq (v2).
 *
 * Sampling: temperature = AI_TEMPERATURE (default 0.4),
 *           max_completion_tokens = AI_MAX_TOKENS (default 256), top_p = 1.
 *
 * @param {string} prompt - The user's prompt (final message)
 * @param {Array} history - The conversation history including system prompt
 * @returns {Promise<{ok: boolean, text: (string|null), error?: string, usage: object}>}
 *   success: { ok: true,  text: "<reply>", usage: {promptTokens, completionTokens, totalTokens} }
 *   failure: { ok: false, text: null, error: "<message>", usage: {0,0,0} }
 */
async function generateResponse(prompt, history = []) {
    const API_KEY = process.env.GROQ_API_KEY;
    if (!API_KEY) {
        console.warn('Groq API Key (GROQ_API_KEY) is missing in .env');
    }

    try {
        // 1. Create a clean copy of the history
        let finalMessages = [];
        
        // If history is provided, use it. If it contains system messages, ensure they are at the start.
        if (Array.isArray(history) && history.length > 0) {
            finalMessages = [...history];
        }

        // 2. Ensure the last message has the 'user' role (Required by Groq API)
        // If the last message is from the assistant or system, or if finalMessages is empty, add the prompt as a user message.
        const lastMessage = finalMessages[finalMessages.length - 1];
        
        if (!lastMessage || lastMessage.role !== 'user') {
            finalMessages.push({
                role: 'user',
                content: prompt || "Continue the conversation based on the context above."
            });
        }

        const temperature = resolveTemperature();
        const maxTokens = resolveMaxTokens();

        if (process.env.DEBUG === 'true') {
            console.log("\n--- [DEBUG] FINAL GROQ API MESSAGES ---");
            console.log(JSON.stringify(finalMessages, null, 2));
            console.log(`[DEBUG] temperature=${temperature} max_completion_tokens=${maxTokens}`);
            console.log("----------------------------------------\n");
        }

        // Default was groq/compound until Groq shut it down on 2026-09-21.
        const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

        const request = {
            messages: finalMessages,
            model: model,
            temperature: temperature,
            max_completion_tokens: maxTokens,
            top_p: 1,
            stream: false, // Set to false for easier integration with the current bot flow
            stop: null
        };

        // gpt-oss and other reasoning models bill their internal reasoning against
        // max_completion_tokens, the SAME budget as the visible reply. With a cap
        // sized for a 2-8 word WhatsApp message the reasoning can swallow all of
        // it, and the call returns finish_reason:'length' with content:'' -- the
        // bot then says nothing at all, silently, on perfectly ordinary messages.
        // Keeping reasoning minimal is also just correct here: imitating someone's
        // texting voice is not a chain-of-thought problem.
        if (REASONING_EFFORT !== 'default') request.reasoning_effort = REASONING_EFFORT;

        const completion = await groq.chat.completions.create(request);

        const choice = completion && completion.choices ? completion.choices[0] : null;
        const aiText = choice && choice.message ? choice.message.content : null;
        const usage = (completion && completion.usage) || {};

        if (typeof aiText !== 'string' || !aiText.trim()) {
            const why = choice && choice.finish_reason === 'length'
                ? `the ${maxTokens}-token budget was exhausted before any visible text was produced `
                  + `(finish_reason: length). ${model} is a reasoning model and charges its reasoning to the `
                  + `same budget -- raise AI_MAX_TOKENS or lower GROQ_REASONING_EFFORT (currently `
                  + `"${REASONING_EFFORT}").`
                : `finish_reason: ${choice ? choice.finish_reason : 'unknown'}`;
            console.error(`Groq returned no usable text: ${why}`);
            return failure(`Groq returned no usable text: ${why}`);
        }

        console.log(`Groq responded: "${aiText.substring(0, 50)}..."`);
        
        return {
            ok: true,
            text: aiText,
            usage: {
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0
            }
        };
    } catch (error) {
        console.error('Error generating response from Groq:', error.message);
        return failure(`Groq request failed: ${error.message}`);
    }
}

module.exports = { generateResponse };
