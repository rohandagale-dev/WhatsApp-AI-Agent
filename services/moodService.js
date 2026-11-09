/**
 * Reads the moment before Rohan replies.
 *
 * One small structured call that looks at the recent chat with ONE person and
 * works out their mood and energy, what they want from Rohan right now, the
 * topic, what kind of relationship it is, how Rohan usually handles this kind
 * of moment with them, and whether it really needs Rohan. The draft prompt
 * (v4) gets the result as "RIGHT NOW" notes, and the AUDIT block prints it.
 *
 * It runs on GROQ_MODEL_ANALYSIS (default openai/gpt-oss-20b), which on Groq
 * has its own rate-limit bucket, so it does not eat the drafts' budget.
 * The answer is a strict JSON schema AND is validated again here before use.
 *
 * Mood reading must never block a draft: any failure -- network, rate limit,
 * bad JSON, MOOD_ANALYSIS=false -- returns null and the draft goes ahead
 * without the notes.
 */
require('../loadEnv');

const ENERGY = ['low', 'normal', 'high'];
const MAX_FIELD_CHARS = 160;
// How much recent chat the reader sees. Small on purpose: a mood lives in the
// last few minutes of a chat, and this keeps the call cheap.
const MOOD_WINDOW_MESSAGES = 30;

const SCHEMA = {
    type: 'object',
    properties: {
        last_exchange: { type: 'string', description: 'First, who said what most recently, in one short sentence naming the speakers (e.g. "Rohan asked them a question; they answered it" or "they replied to Rohan\'s message"). Read the ROHAN/THEM labels carefully.' },
        mood: { type: 'string', description: 'Their mood right now, 1-4 words (e.g. "bored, playful", "low, upset", "excited").' },
        energy: { type: 'string', enum: ENERGY },
        intent: { type: 'string', description: 'What THEY are after from Rohan right now -- their goal, a few words (e.g. "attention", "reassurance", "an answer", "to vent", "to flirt", "banter", "to make plans"), or "nothing, just answering Rohan" when they are replying to Rohan. Never "to respond".' },
        topic: { type: 'string', description: 'What the conversation is about right now, a few words.' },
        relationship: { type: 'string', description: 'How the two talk: e.g. "close friend", "flirty / romantic", "family", "work", "acquaintance", "unclear".' },
        rohan_pattern: { type: 'string', description: 'How Rohan usually replies to this kind of moment with this person, from Rohan\'s own messages in the chat. "not enough history" if unclear.' },
        missing_context: { type: 'string', description: 'If their last message refers to something this chat never mentions -- a plan, object, decision, place or person that must have come up in person, on a call or elsewhere -- say in a few words what is missing. Otherwise "". If the chat mentions the thing they are talking about, it is NOT missing, even when the chat does not contain the answer.' },
        needs_rohan: { type: 'boolean', description: 'True if a bot replying for Rohan would be wrong here: a question only Rohan can answer about Rohan\'s own life (whether Rohan is coming or will do something, whether Rohan got, did, paid, sent or finished something, what Rohan decided), money, plans to confirm, questions about Rohan\'s feelings, emergencies, health, a fight, or a flirty chat that is about photos, videos, bodies or anything sexual, or asks for a call. Everyday small talk is NOT a reason: greetings, how-are-you, what-are-you-up-to and banter get Rohan\'s usual casual reply, so needs_rohan is false for them.' },
        needs_rohan_reason: { type: 'string', description: 'Why, in a few words, or "" when needs_rohan is false.' }
    },
    required: ['last_exchange', 'mood', 'energy', 'intent', 'topic', 'relationship', 'rohan_pattern', 'missing_context', 'needs_rohan', 'needs_rohan_reason'],
    additionalProperties: false
};

const INSTRUCTIONS = [
    'You read a WhatsApp chat between Rohan and one other person and describe the moment right before Rohan replies.',
    'Lines marked THEM are the other person; lines marked ROHAN were typed by Rohan. Rohan often starts the chat, asks the questions or sends the wishes: check the labels before deciding who wants what.',
    'The chat may be in Marathi, Hindi, English or any mix, in Devanagari or Roman letters, with casual spellings. Understand all of it; write your answer fields in plain English.',
    'Focus on their LAST messages. Be concrete and brief. "intent" is what THEY want, not what Rohan should do.',
    'Base rohan_pattern only on what Rohan actually wrote in this chat. Set needs_rohan whenever photos, videos, bodies or sex are being discussed or asked for.',
    'Write in plain English. Do not invent anything that is not in the chat.'
].join('\n');

function analysisEnabled() {
    return String(process.env.MOOD_ANALYSIS || 'true').trim().toLowerCase() !== 'false';
}

function analysisModel() {
    return String(process.env.GROQ_MODEL_ANALYSIS || '').trim() || 'openai/gpt-oss-20b';
}

const tidy = value => String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_CHARS);

/**
 * Validates a parsed answer. Returns a clean object, or null if anything is
 * missing or the wrong type -- the model's output is never trusted blindly.
 */
function validateMoment(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    for (const key of ['last_exchange', 'mood', 'intent', 'topic', 'relationship', 'rohan_pattern', 'missing_context', 'needs_rohan_reason']) {
        if (typeof raw[key] !== 'string') return null;
    }
    if (!ENERGY.includes(raw.energy) || typeof raw.needs_rohan !== 'boolean') return null;
    if (!tidy(raw.mood) || !tidy(raw.intent)) return null;
    return {
        lastExchange: tidy(raw.last_exchange),
        mood: tidy(raw.mood),
        energy: raw.energy,
        intent: tidy(raw.intent),
        topic: tidy(raw.topic),
        relationship: tidy(raw.relationship),
        rohanPattern: tidy(raw.rohan_pattern),
        missingContext: tidy(raw.missing_context),
        needsRohan: raw.needs_rohan,
        needsRohanReason: raw.needs_rohan ? tidy(raw.needs_rohan_reason) : ''
    };
}

/** The chat as a short labelled transcript for the reader, oldest first. */
function transcriptOf(rows, latestMessageText) {
    const lines = [];
    for (const row of (rows || []).slice(-MOOD_WINDOW_MESSAGES)) {
        const source = row.metadata && row.metadata.source;
        if (source === 'mock' || (row.direction === 'OUTGOING' && source !== 'human')) continue;
        const text = String(row.message || '').trim();
        if (text) lines.push(`${row.direction === 'INCOMING' ? 'THEM' : 'ROHAN'}: ${text.replace(/\s*\n\s*/g, ' / ')}`);
    }
    const latest = String(latestMessageText || '').trim();
    if (latest && !lines.slice(-5).some(l => l.includes(latest.split('\n').pop()))) {
        latest.split('\n').forEach(l => lines.push(`THEM: ${l}`));
    }
    return lines.join('\n');
}

let defaultClient = null;
function groqClient() {
    if (!defaultClient) {
        const Groq = require('groq-sdk');
        defaultClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }
    return defaultClient;
}

/**
 * @param {Array} rows chat rows with this person, oldest first
 * @param {string} latestMessageText their message(s) being answered
 * @param {object} [opts] { client } -- an injected Groq-like client, for tests
 * @returns {Promise<object|null>}
 */
async function analyzeMoment(rows, latestMessageText, opts = {}) {
    if (!analysisEnabled()) return null;
    const transcript = transcriptOf(rows, latestMessageText);
    if (!transcript) return null;
    try {
        const client = opts.client || groqClient();
        const completion = await client.chat.completions.create({
            model: analysisModel(),
            messages: [
                { role: 'system', content: INSTRUCTIONS },
                { role: 'user', content: `The chat, oldest first:\n\n${transcript}` }
            ],
            response_format: { type: 'json_schema', json_schema: { name: 'moment', strict: true, schema: SCHEMA } },
            temperature: 0.2,
            // Medium: at low effort the reader mixed up who asked what. It runs
            // on its own rate-limit bucket, so the extra thinking is cheap.
            max_completion_tokens: 1500,
            reasoning_effort: 'medium'
        });
        const content = completion && completion.choices && completion.choices[0] && completion.choices[0].message
            ? completion.choices[0].message.content : null;
        const moment = validateMoment(JSON.parse(content));
        if (!moment) console.warn('[MOOD] The mood reader returned something unusable; drafting without it.');
        return moment;
    } catch (err) {
        console.warn(`[MOOD] Could not read the mood (${(err && err.message ? err.message : String(err)).slice(0, 120)}); drafting without it.`);
        return null;
    }
}

module.exports = { analyzeMoment, validateMoment, transcriptOf, analysisEnabled, analysisModel, SCHEMA, MOOD_WINDOW_MESSAGES };
