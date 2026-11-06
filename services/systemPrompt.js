/**
 * Loads the agent's base system prompt from system_prompts/.
 *
 * Which file is used is controlled by SYSTEM_PROMPT_VERSION (v1 | v2 | v3).
 * NOTE: this is unrelated to AI_VERSION, which selects the *provider*
 * (v1 = Gemini, v2 = Groq, v3 = Ollama). The two happen to share v1/v2/v3 names.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_VERSION = 'v3';
const INLINE_FALLBACK = 'You are Rohan, chill, sarcastic and supportive. Reply briefly.';

function loadSystemPrompt(version) {
    const v = version || process.env.SYSTEM_PROMPT_VERSION || DEFAULT_VERSION;
    const file = path.join(__dirname, '..', 'system_prompts', `system_prompt_${v}.txt`);
    try {
        return { version: v, text: fs.readFileSync(file, 'utf8').trim(), source: file };
    } catch (err) {
        console.warn(`Could not read system_prompt_${v}.txt - using the inline fallback prompt.`);
        return { version: 'fallback', text: INLINE_FALLBACK, source: null };
    }
}

module.exports = { loadSystemPrompt, DEFAULT_VERSION };
