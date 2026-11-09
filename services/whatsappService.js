require("../loadEnv");

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, generateMessageIDV2 } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { generateResponse: generateGeminiResponse } = require("./geminiService");
const { generateResponse: generateGroqResponse } = require("./groqService");
const { generateResponse: generateOllamaResponse } = require("./ollamaService");
const { supabase } = require("./supabaseClient");
const { buildDraftMessages } = require("./promptService");
const { saveMessage } = require("./chatStore");
const { sanitizeReply } = require("./sanitizeReply");
// The scheduling-JSON pipeline lives in one place and is shared with
// trainingService.js. It used to be copy-pasted into both, and the copies
// diverged -- see the header of services/scheduleExtract.js. Do not re-inline it.
const {
    extractSchedule,
    buildScheduleExtra,
    isAcknowledgeablePlan,
    describeAckRefusal,
    containsScheduleResidue,
    deferScheduleExtra,
    saveWithCarriedSchedules
} = require("./scheduleExtract");
// One resolver for "which model id answered this", shared with trainingService.
// It used to be a byte-identical copy in each file -- see services/modelId.js.
const { resolveModelId, providerLabel } = require("./modelId");

// -------------------------------- TESTING MODE vs LIVE MODE -------------------------------- //
//
// TESTING_MODE in .env decides whether the agent may text anyone.
//
//   TESTING_MODE=true (the default) -- observation only. Every 1:1 message is
//       received, stored and answered by the model, but the answer is only a
//       DRAFT: printed to the terminal as an AUDIT block and sent nowhere.
//       Drafts are NOT written to `chats` either: the contact never saw them,
//       so a stored draft would put words in Rohan's mouth in every future
//       prompt. When Rohan replies from the phone, the real message is printed
//       next to the draft as a COMPARE block.
//
//   TESTING_MODE=false -- LIVE. The original auto-reply path runs: after a
//       random REPLY_DELAY_MIN..MAX_SECONDS wait, the reply is SENT to the real
//       contact and stored as source:'ai'.
//
// Fail-safe: only an explicit off value (false / off / 0 / no) goes live. A
// missing, empty or misspelled value ("flase") stays in testing mode, so a
// typo can never start texting people. tests/testObservationMode.js covers
// both modes.

/** True unless `raw` is an explicit off value. Unset, empty or unknown => testing. */
function resolveTestingMode(raw) {
    const value = String(raw == null ? '' : raw).trim().toLowerCase();
    return !['false', 'off', '0', 'no'].includes(value);
}

let currentSock = null;
const pendingTimers = new Map();

// Response Delay: in live mode a reply waits a random time between these two
// before it is sent, so it does not land with machine timing. Set with
// REPLY_DELAY_MIN_SECONDS / REPLY_DELAY_MAX_SECONDS in .env; default 30-90s.
// It comes ON TOP of MESSAGE_COLLECTION_DELAY below (the 30s quiet window that
// bundles a burst of messages), so a live reply lands roughly 60-120s after the
// contact's last message. Testing mode never waits: drafts print when ready.
const DEFAULT_REPLY_DELAY_MIN_SECONDS = 30;
const DEFAULT_REPLY_DELAY_MAX_SECONDS = 90;

/** { minMs, maxMs } from .env. Unset, negative or unparseable values fall back to the defaults. */
function resolveReplyDelays(env = process.env) {
    const seconds = (raw, fallback) => {
        if (raw == null || String(raw).trim() === '') return fallback;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const min = seconds(env.REPLY_DELAY_MIN_SECONDS, DEFAULT_REPLY_DELAY_MIN_SECONDS);
    const max = seconds(env.REPLY_DELAY_MAX_SECONDS, DEFAULT_REPLY_DELAY_MAX_SECONDS);
    if (max < min) {
        console.warn(`[DELAY] REPLY_DELAY_MAX_SECONDS (${max}) is below REPLY_DELAY_MIN_SECONDS (${min}); `
            + `using the defaults ${DEFAULT_REPLY_DELAY_MIN_SECONDS}-${DEFAULT_REPLY_DELAY_MAX_SECONDS}s.`);
        return { minMs: DEFAULT_REPLY_DELAY_MIN_SECONDS * 1000, maxMs: DEFAULT_REPLY_DELAY_MAX_SECONDS * 1000 };
    }
    return { minMs: Math.round(min * 1000), maxMs: Math.round(max * 1000) };
}

const { minMs: RESPONSE_DELAY_MIN, maxMs: RESPONSE_DELAY_MAX } = resolveReplyDelays();

// Insight Threshold: Number of messages to generate a summary
const INSIGHT_THRESHOLD = 20;

// Message Collection Delay: Time to wait before processing a bundle of messages
// (live mode). Each new message from the contact restarts the wait, so a burst
// is answered once.
const MESSAGE_COLLECTION_DELAY = 30 * 1000;

// Testing mode drafts right away: nothing is sent, so there is nothing to wait
// for. TESTING_BUNDLE_SECONDS in .env brings a wait back (default 0). Messages
// that arrive together in one WhatsApp batch are still drafted together.
function resolveTestingBundleDelay(env = process.env) {
    const raw = env.TESTING_BUNDLE_SECONDS;
    const n = raw == null || String(raw).trim() === '' ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 0;
}

// -------------------------------- Self-echo suppression -------------------------------- //
//
// !! DO NOT RE-ENABLE THE ECHO. READ THIS FIRST. !!
//
// Baileys ships `emitOwnEvents: true` (Defaults/index.js). With it on, every
// message THIS socket sends is fed straight back into 'messages.upsert' by
// Socket/messages-send.js, carrying `key.fromMe === true`.
//
// The upsert handler below treats fromMe as "Rohan typed this on his phone" and
// stores it with source:'human' -- the one provenance class that chatStore lets
// promptService use as a Rohan-voice style exemplar. So with the echo on, every
// reply the agent generates is stored TWICE: once honestly as source:'ai', and
// once again as source:'human'. The agent's own output then becomes its own
// highest-quality "this is how Rohan really writes" example, and the voice
// drifts a little further from his with every single turn. That is precisely
// the failure the provenance system exists to prevent, so it is guarded twice:
//
//   Belt 1 -- `emitOwnEvents: false` on makeWASocket, killing the local echo at
//             the source. Messages Rohan genuinely types on his own phone are
//             unaffected: those reach us as fromMe over multi-device sync from
//             the server, through the receive path, which this flag does not
//             touch (it is read only by messages-send.js and by the app-state
//             chunk handler in chats.js, neither of which is the inbound path).
//
//   Belt 2 -- the id ledger below. Every id this process puts on the wire is
//             remembered, and any upsert bearing one of those ids is dropped.
//             This still holds if someone flips belt 1 back on, if a Baileys
//             upgrade changes the default, or if a reconnect builds a socket
//             from somewhere other than startWhatsApp().

// Bounded so a long-lived session cannot leak memory. A few hundred ids covers
// far more than the echo window (the echo fires on the next tick), and a Set
// iterates in insertion order, so the oldest entry is always the first one out.
const SELF_SENT_ID_LIMIT = 500;
const selfSentMessageIds = new Set();

/** Records a message id this process sent. Ignores anything that is not a usable id. */
function rememberSelfSentId(id) {
    if (typeof id !== 'string' || !id) return false;
    // Delete-then-add so a repeated id moves back to the newest position instead
    // of keeping its original one and ageing out early.
    selfSentMessageIds.delete(id);
    selfSentMessageIds.add(id);
    while (selfSentMessageIds.size > SELF_SENT_ID_LIMIT) {
        selfSentMessageIds.delete(selfSentMessageIds.values().next().value);
    }
    return true;
}

/** True when this process is the one that sent the message with this id. */
function isSelfSentId(id) {
    return typeof id === 'string' && id.length > 0 && selfSentMessageIds.has(id);
}

/**
 * Mints the id for an outgoing message up front.
 *
 * Baileys queues the echo with process.nextTick BEFORE sendMessage's promise
 * resolves, and nextTick callbacks run ahead of promise continuations -- so
 * registering the id only after `await sendMessage(...)` returns can lose the
 * race. Reserving the id first and handing it to Baileys via options.messageId
 * removes the race entirely. Same generator and same format Baileys would have
 * used itself; on any failure we return null and fall back to registering the
 * id from the send result.
 */
function newOutgoingMessageId(sock) {
    try {
        const id = generateMessageIDV2(sock && sock.user && sock.user.id);
        return typeof id === 'string' && id ? id : null;
    } catch (err) {
        console.warn(`[ECHO] Could not pre-generate a message id (${err.message}); relying on the id Baileys assigns.`);
        return null;
    }
}

// -------------------------------- AI provider plumbing -------------------------------- //

// resolveModelId / providerLabel now come from services/modelId.js (required at
// the top). They were duplicated byte for byte here and in trainingService.js,
// and both copies had already drifted from geminiService, which TRIMS
// GEMINI_MODEL -- so GEMINI_MODEL='   ' recorded a model id that never saw the
// request. The shared resolver trims. Do not re-inline it.

/**
 * Single dispatch point for every model call in this file.
 * @returns {Promise<{aiVersion: string, model: string, provider: string, response: object}>}
 */
async function callModel(prompt, messages) {
    const aiVersion = process.env.AI_VERSION || 'v1';
    const model = resolveModelId(aiVersion);
    const provider = providerLabel(aiVersion);

    let response;
    if (aiVersion === 'v3') {
        response = await generateOllamaResponse(prompt, messages);
    } else if (aiVersion === 'v2') {
        response = await generateGroqResponse(prompt, messages);
    } else {
        response = await generateGeminiResponse(prompt, messages);
    }

    return { aiVersion, model, provider, response };
}

/**
 * CONTRACT 2 gate. A provider result is only usable when it explicitly succeeded
 * AND carries text. On failure `text` is null and `error` holds a human-readable
 * message -- that message must never reach a contact or the chats table.
 */
function isUsableAiResponse(r) {
    return !!(r && r.ok === true && typeof r.text === 'string' && r.text.trim());
}

function aiFailureReason(r) {
    if (!r) return 'no response object returned by provider';
    if (r.ok !== true) return r.error || 'provider reported failure';
    return 'provider returned ok with empty text';
}

// -------------------------------- Reply post-processing -------------------------------- //

/**
 * CONTRACT 3. Never let a sanitizer fault drop a reply on the floor; fall back to
 * the raw trimmed text and shout about it instead.
 */
function applySanitizer(text) {
    try {
        const cleaned = sanitizeReply(text, {});
        return typeof cleaned === 'string' ? cleaned.trim() : '';
    } catch (err) {
        console.error(`[SANITIZE] sanitizeReply threw (${err.message}); falling back to raw text.`);
        return typeof text === 'string' ? text.trim() : '';
    }
}

/**
 * CONTRACT 6, last gate. extractSchedule already guarantees its own output is
 * free of scheduling-JSON debris, but this is the single point where text
 * becomes something a contact reads and a chats.message row -- including the
 * applySanitizer fallback path, which hands back RAW model text when
 * sanitizeReply throws. So the check is repeated on the finished string: if it
 * still smells like JSON, nothing goes out and nothing is stored. Losing a
 * reply is recoverable (the contact repeats themselves); texting someone a JSON
 * fragment, and then replaying it into every future prompt, is not.
 */
function guardOutgoingText(text, phoneNumber) {
    if (!text || !containsScheduleResidue(text)) return text;
    console.error(`[SCHEDULE] Refusing to emit a reply to ${phoneNumber}: it still contains scheduling-JSON `
        + `residue after extraction and sanitizing. Dropped: ${JSON.stringify(text)}`);
    return '';
}

/**
 * Hands a schedule payload to the carry-forward ledger because this turn stored
 * no chats row to put it on.
 *
 * Every branch that declines to store a row goes through here, so the parsed
 * schedule (or the parse error and the raw blob) can no longer evaporate into a
 * console.log the way it used to. The ledger merges it into
 * chats.metadata.carried_schedules of the next row this contact does store --
 * usually their next incoming message, seconds later. Metadata only: neither
 * chats.message nor metadata.source is touched, and promptService's history
 * renders only direction + message, so nothing here can reach a prompt. The
 * mechanism and its proof are documented in services/scheduleExtract.js.
 *
 * Also logged, unconditionally: the ledger is process memory, so a crash before
 * the next row would lose it and the log line is the backstop.
 */
function carrySchedule(contactId, phoneNumber, scheduleExtra, reason) {
    if (!scheduleExtra) return false;
    const queued = deferScheduleExtra(contactId, scheduleExtra, reason);
    console.warn(`[SCHEDULE] No row stored for ${phoneNumber} (${reason}); `
        + `${queued ? 'carrying the payload forward to the next stored row' : 'COULD NOT carry the payload forward'}: `
        + `${JSON.stringify(scheduleExtra)}`);
    return queued;
}

/**
 * What we say when the model's entire reply was a CONFIRMED scheduling payload.
 *
 * system_prompt_v3 Step 3 tells the model to "return JSON" once a plan is
 * settled, so a reply that is nothing but the blob is a designed, everyday path
 * -- not an error. The JSON itself can never be sent (see extractSchedule), but
 * staying silent there is worse: the contact just agreed a plan and hears
 * nothing back. So that one case gets a single short line instead.
 *
 * WHY "done" AND NOT SOMETHING WARMER. This is the only reply in the whole
 * service that bypasses the model, so it cannot follow the persona's "Match
 * user's language (Hinglish, Marathi, English)" rule -- whatever it says is
 * said to an English speaker, a Marathi speaker and a Hinglish speaker alike.
 * The previous string ('ha, set kar diya') was unmistakably Hinglish and, at
 * four words, long for a persona whose style rule is "1-5 words, yes/no
 * preferred". "done" is register-neutral, reads naturally in all three, and is
 * already how this project's own corpus closes a settled plan --
 * scripts/seedMockChats.js has ['out', 'done'] immediately after "kitne baje" /
 * "1 baje". Deliberately a single fixed string, not a random pick from a list.
 *
 * It must also survive the `negative` hand-off check below (a reply containing
 * "negative" is suppressed and escalated to the real Rohan): 'done' does not
 * contain that substring, so an acknowledgement can never be mistaken for a
 * hand-off.
 */
const SCHEDULE_ACK = 'done';

// -------------------------------- Roman letters only -------------------------------- //
//
// Rohan writes Hindi and Marathi in Roman letters ("kasa ahe", "chalega") --
// Hinglish or Marathi-English -- and never in Devanagari, so a draft in
// Devanagari never sounds like Rohan. The persona file says so; the check in
// the reply pipeline makes it a guarantee: one retry with an explicit
// correction, and if the model still answers in Devanagari the draft is
// dropped, so nothing is ever sent in that script.

// Shared with promptService's style-example filter -- see services/scriptCheck.js.
const { containsDevanagari } = require("./scriptCheck");

const ROMAN_ONLY_CORRECTION = 'Your last reply used Devanagari script. Rewrite the same reply in Roman (English) '
    + 'letters only: Hinglish or Marathi-English, never Devanagari. Reply with the rewritten message only.';

// -------------------------------- Emoji habit -------------------------------- //
//
// The model puts an emoji in nearly every draft even when the style notes say
// Rohan uses one in 2 of 26 messages to this person -- that was the most
// visible repetition (the same 😞 on every reply). Instructions did not fix it,
// so this does: a draft keeps its emoji only about as often as Rohan really
// uses one with this person (a little more, x1.2, since the model already skips
// some). An emoji-only reply is left alone. EMOJI_MATCHING=false turns it off.

const EMOJI_RUN = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu;

// Used when Rohan's habit with this person is not measured yet (fewer than 5 of
// Rohan's messages to them): a new contact no longer gets emojis freely.
const DEFAULT_EMOJI_RATE = 0.15;

function matchEmojiHabit(text, emojiRate, random = Math.random) {
    if (!text || String(process.env.EMOJI_MATCHING || '').trim().toLowerCase() === 'false') return text;
    if (!/\p{Extended_Pictographic}/u.test(text)) return text;
    const rate = typeof emojiRate === 'number' ? emojiRate : DEFAULT_EMOJI_RATE;
    const tidy = t => t.replace(/[ \t]+$/gm, '').replace(/[ \t]{2,}/g, ' ').trim();
    // At most ONE emoji survives: a stack of different emojis reads as a bot.
    const firstOnly = t => { let kept = false; return t.replace(EMOJI_RUN, e => (kept ? '' : ((kept = true), e))); };
    const stripped = tidy(text.replace(EMOJI_RUN, ''));
    if (!stripped) return tidy(firstOnly(text));   // an emoji-only reply keeps one emoji
    return random() < Math.min(1, rate) ? tidy(firstOnly(text)) : stripped;
}

// -------------------------------- Length habit -------------------------------- //
//
// "Short when needed": a draft longer than Rohan usually writes to this person
// is cut back -- at a sentence boundary, never mid-sentence -- and extra lines
// are dropped unless Rohan often sends a few messages in a row to them. The
// limits come from Rohan's real messages to this person (promptService's
// lengthHabit: maxWords = how long 90% of them are at most, maxLines from the
// burst habit), so someone Rohan writes long messages to still gets long ones.
// A hand-off ("negative") is never touched, so it cannot be cut off.
// LENGTH_MATCHING=false turns it off.

// Used when the habit is not measured yet (fewer than 5 of Rohan's messages).
const DEFAULT_LENGTH_HABIT = { maxWords: 10, maxLines: 1 };

const wordCount = t => String(t).trim().split(/\s+/).filter(Boolean).length;

/** Whole sentences from the start of `line`, as many as fit `maxWords` (always at least the first). */
function shortenLine(line, maxWords) {
    if (wordCount(line) <= maxWords) return line;
    const sentences = line.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) || [line];
    let out = '';
    for (const sentence of sentences) {
        if (out && wordCount(out + sentence) > maxWords) break;
        out += sentence;
    }
    return out.trim() || line;
}

function matchLengthHabit(text, habit) {
    if (!text || String(process.env.LENGTH_MATCHING || '').trim().toLowerCase() === 'false') return text;
    if (/\bnegative\b/i.test(text)) return text;
    const { maxWords, maxLines } = habit || DEFAULT_LENGTH_HABIT;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, Math.max(1, maxLines));
    const shortened = lines.map(line => shortenLine(line, Math.max(1, maxWords))).join('\n').trim();
    return shortened || text;
}

// -------------------------------- Audit output (testing mode) -------------------------------- //

/** A message's text as a person reads it, or '' for media without a caption. */
function messageText(msg) {
    const m = (msg && msg.message) || {};
    return m.conversation
        || (m.extendedTextMessage && m.extendedTextMessage.text)
        || (m.imageMessage && m.imageMessage.caption)
        || (m.videoMessage && m.videoMessage.caption)
        || '';
}

// The latest draft per contact, waiting to be compared with Rohan's real reply.
const pendingDrafts = new Map();
// Rohan's replies typed while no draft was waiting -- usually because the agent
// was still inside its collection window. Timestamped, so a draft is only ever
// compared with replies typed during its own batch.
const recentOwnReplies = new Map();
// A draft older than this is not compared with a new reply: by then Rohan is
// answering something else.
const DRAFT_COMPARE_WINDOW_MS = 30 * 60 * 1000;
// Bounded like the self-sent id ledger, so a long session cannot leak memory.
const AUDIT_MAP_LIMIT = 500;

// The last few drafts per contact, newest last. Testing mode never stores
// drafts in `chats`, so without this every new draft for a person starts from
// scratch and lands on the same reply; the prompt lists these as "don't repeat
// yourself". (Live mode's sent replies are read back from `chats` instead.)
const recentDraftTexts = new Map();
const RECENT_DRAFTS_KEPT = 6;

function rememberRecentDraft(phoneNumber, text) {
    if (!text) return;
    boundedSet(recentDraftTexts, phoneNumber, (recentDraftTexts.get(phoneNumber) || []).concat(text).slice(-RECENT_DRAFTS_KEPT));
}

function boundedSet(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > AUDIT_MAP_LIMIT) map.delete(map.keys().next().value);
}

function auditClock() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// The AI's reply is highlighted so it stands out in a busy log. Colour is used
// only on a real terminal, so log files and pipes stay plain text: NO_COLOR
// (any value) turns it off, FORCE_COLOR=1 turns it on even when piped.
function useColor() {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== '0';
    return !!(process.stdout && process.stdout.isTTY);
}

/** Bold black on bright green, like a highlighter pen. Plain text when colour is off. */
function highlightAI(text) {
    return useColor() ? `\x1b[1;30;102m ${text} \x1b[0m` : text;
}

/** One labelled entry; continuation lines of a multi-line message line up under the first. */
function auditLines(label, text, style = line => line) {
    const pad = ' '.repeat(label.length);
    return String(text).split('\n').map((line, i) => `│ ${i === 0 ? label : pad}${style(line)}`);
}

// -------------------------------- Hand-off from the mood reader -------------------------------- //
//
// Some messages must never get an AI reply, however good it would be:
//   - a question only Rohan can answer about Rohan's own life (coming or not,
//     got it or not, decided what) -- it needs Rohan's attention;
//   - a message that depends on something the chat never explains (talked
//     about in person or on a call), where any answer would be a guess.
// The prompt says so, but the model does not always listen, so when the mood
// reader flags either case the draft is not even requested: it is handed to
// Rohan. HANDOFF_FROM_MOOD=false makes the flags advisory again (prompt only).

function moodHandOffReason(mood) {
    if (!mood || String(process.env.HANDOFF_FROM_MOOD || 'true').trim().toLowerCase() === 'false') return null;
    if (mood.needsRohan) return `needs you (${mood.needsRohanReason || 'see the hand-off rules'})`;
    if (mood.missingContext) return `refers to something not in the chat (${mood.missingContext})`;
    return null;
}

/** Stands in for a model call that was never made: a plain hand-off, no tokens used. */
function skippedDraft() {
    const aiVersion = process.env.AI_VERSION || 'v1';
    return {
        aiVersion,
        model: resolveModelId(aiVersion),
        provider: providerLabel(aiVersion),
        response: { ok: true, text: 'negative', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
    };
}

/** Which prompt produced a draft, e.g. "prompt v4, per-person (learned from 33 of your messages)". */
function promptLabel(meta) {
    if (!meta) return 'prompt unknown';
    let label;
    if (meta.requested) label = `prompt ${meta.version}, classic (fallback from ${meta.requested}: ${meta.reason})`;
    else if (meta.layout === 'per-person') label = `prompt ${meta.version}, per-person (learned from ${meta.ownMessages} of your messages)`;
    else label = `prompt ${meta.version}, classic`;
    // How much chat history went in, and whether the token guard had to trim it.
    if (Number.isInteger(meta.historyMessages)) {
        label += ` · context: ${meta.historyMessages} messages`;
        if (meta.trimmed > 0) label += ` (${meta.trimmed} oldest trimmed to fit ${meta.budget} tokens)`;
    }
    return label;
}

function printAudit(a) {
    const who = [a.name, a.phoneNumber].filter(Boolean).join(' · ');
    const usage = a.usage || {};
    const lines = [`┌── AUDIT · ${who} · ${auditClock()} ${'─'.repeat(16)}`];
    a.incoming.forEach(t => lines.push(...auditLines('THEM  ', t)));
    // What the mood reader understood about the moment (v4), before the draft.
    const mood = a.prompt && a.prompt.mood;
    if (mood) {
        lines.push(`│ MOOD  ${mood.mood} (${mood.energy}) · wants ${mood.intent}`
            + `${mood.topic ? ` · ${mood.topic}` : ''}${mood.relationship ? ` · ${mood.relationship}` : ''}`);
        if (mood.missingContext) lines.push(`│       ⚠ refers to something not in the chat: ${mood.missingContext}`);
        if (mood.needsRohan) lines.push(`│       ⚠ looks like it needs you: ${mood.needsRohanReason || 'see the hand-off rules'}`);
    }
    lines.push(...auditLines('AI    ', a.draft || '(no reply)', highlightAI));
    // What the model wrote before the emoji/length habits trimmed it, so their
    // effect can be watched while tuning the prompt.
    if (a.original && a.original !== a.draft) lines.push(`│       model wrote: ${String(a.original).replace(/\s*\n\s*/g, ' / ')}`);
    if (a.handOffReason) lines.push(`│       handed to you without drafting: ${a.handOffReason}`);
    if (a.schedule) lines.push(...auditLines('PLAN  ', JSON.stringify(a.schedule)));
    lines.push(`│       ${a.provider} ${a.model} · ${(a.latencyMs / 1000).toFixed(1)}s · `
        + `${usage.promptTokens || 0} in / ${usage.completionTokens || 0} out tokens`);
    if (a.prompt) lines.push(`│       ${promptLabel(a.prompt)}`);
    a.alreadySent.forEach(t => lines.push(...auditLines('YOU   ', t)));
    lines.push(`└── ${a.verdict} · not sent (testing mode)`);
    console.log(lines.join('\n'));
}

function printComparison(phoneNumber, draft, ownText) {
    const tag = draft.verdict === 'WOULD SEND' ? '' : `  [${draft.verdict}]`;
    const aiLines = auditLines('AI    ', draft.text || '(no reply)', highlightAI);
    aiLines[aiLines.length - 1] += tag;
    console.log([
        `┌── COMPARE · ${phoneNumber} · ${auditClock()} ${'─'.repeat(16)}`,
        ...aiLines,
        ...auditLines('YOU   ', ownText),
        '└──'
    ].join('\n'));
}

/**
 * Called for every message Rohan sends from the phone. A waiting draft for
 * this contact is printed next to it; otherwise the reply is remembered so a
 * draft that is still being generated can be compared with it when it lands.
 */
function noteOwnReply(phoneNumber, text) {
    const draft = pendingDrafts.get(phoneNumber);
    pendingDrafts.delete(phoneNumber);
    if (draft && Date.now() - draft.at <= DRAFT_COMPARE_WINDOW_MS) {
        printComparison(phoneNumber, draft, text);
        return;
    }
    const replies = recentOwnReplies.get(phoneNumber) || [];
    replies.push({ text, at: Date.now() });
    boundedSet(recentOwnReplies, phoneNumber, replies.slice(-20));
}

/** Rohan's replies to this contact since `since` (epoch ms). Consumes them. */
function takeOwnRepliesSince(phoneNumber, since) {
    const replies = recentOwnReplies.get(phoneNumber) || [];
    recentOwnReplies.delete(phoneNumber);
    return replies.filter(r => r.at >= since).map(r => r.text);
}

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    console.log(`//------------------------ Starting connection with WhatsApp service ------------------------//`);

    // Read on every (re)start -- see "TESTING MODE vs LIVE MODE" at the top.
    const AUTO_REPLY_ENABLED = !resolveTestingMode(process.env.TESTING_MODE);
    if (AUTO_REPLY_ENABLED) {
        console.log(`⚠️  LIVE MODE (TESTING_MODE=false): AI replies WILL be sent to real contacts, `
            + `${MESSAGE_COLLECTION_DELAY / 1000}s after their last message plus a random `
            + `${RESPONSE_DELAY_MIN / 1000}-${RESPONSE_DELAY_MAX / 1000}s wait.`);
    } else {
        console.log("TESTING MODE: replies are drafted and printed here, never sent. Set TESTING_MODE=false in .env to send them.");
    }
    // Live mode waits for a quiet window before replying; testing mode drafts right away.
    const collectionDelay = AUTO_REPLY_ENABLED ? MESSAGE_COLLECTION_DELAY : resolveTestingBundleDelay();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "error" }),
        version,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        // Belt 1 of the self-echo guard -- see "Self-echo suppression" at the top
        // of this file before changing this. Baileys defaults this to true, which
        // replays our own replies into 'messages.upsert' as fromMe, and the
        // handler below then stores them a second time as source:'human',
        // teaching the model to imitate itself. Rohan's real phone-typed messages
        // still arrive: they come in over multi-device sync, which this does not
        // affect. Leave it false.
        emitOwnEvents: false,
        // In testing mode the agent only listens, so it stays invisible:
        // Baileys' default (true) shows Rohan as "online" to every contact the
        // moment the agent connects, and WhatsApp then holds back notifications
        // on the phone. Live mode keeps that default, as the original did.
        markOnlineOnConnect: AUTO_REPLY_ENABLED
    });

    // -------------------------------- Handle connection updates with WhatsApp -------------------------------- //
    sock.ev.on("connection.update", async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            console.log("Scan QR Code (Dev Environment)");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            const isConflict = statusCode === DisconnectReason.connectionReplaced;

            console.log(`Connection closed due to ${lastDisconnect.error}, reconnecting ${shouldReconnect}`);

            if (shouldReconnect) {
                if (isConflict) {
                    console.log("⚠️ Conflict detected (logged in elsewhere). Waiting 10s before retrying...");
                    await new Promise(resolve => setTimeout(resolve, 10000));
                } else {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                startWhatsApp();
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log("Logged out. Clearing auth folder and restarting to show new QR...");
                const fs = require('fs');
                if (fs.existsSync('auth')) {
                    fs.rmSync('auth', { recursive: true, force: true });
                }
                startWhatsApp();
            }
        } else if (connection === "open") {
            console.log("WhatsApp connected! Ready to receive messages.");
            console.log(AUTO_REPLY_ENABLED
                ? "⚠️  LIVE MODE: AI replies are being SENT. (TESTING_MODE=true in .env stops this.)"
                : "TESTING MODE: replies are drafted and printed here, never sent.");
            currentSock = sock;
        }
    });

    // -------------------------------- Handle credential updates -------------------------------- //
    sock.ev.on("creds.update", saveCreds);

    /**
     * Generates and stores a conversation summary (insight) for a contact.
     */
    async function generateAndStoreInsight(contactId, phoneNumber) {
        console.log(`--- Generating AI Insight for ${phoneNumber} ---`);
        try {
            const { data: lastMessages, error } = await supabase
                .from('chats')
                .select('*')
                .eq('contact_id', contactId)
                .order('created_at', { ascending: false })
                .limit(INSIGHT_THRESHOLD);

            if (error) throw error;
            if (!lastMessages || lastMessages.length < 5) return;

            const historyText = lastMessages.reverse().map(m => `${m.direction}: ${m.message}`).join("\n");
            const summarizationPrompt = `Summarize the following WhatsApp conversation between Rohan and a contact into a single, concise paragraph (max 2-3 sentences). Focus on core topics and the current status.\n\nCONVERSATION:\n${historyText}`;
            const systemPromptMessage = [{ role: "system", content: "You are a helpful assistant that summarizes conversations concisely." }];

            const { provider, response: summaryResponse } = await callModel(summarizationPrompt, systemPromptMessage);

            // CONTRACT 2: a failed summarisation writes nothing at all.
            if (!isUsableAiResponse(summaryResponse)) {
                console.error(`[INSIGHT] ${provider} failed for ${phoneNumber}: ${aiFailureReason(summaryResponse)}. No insight stored.`);
                return;
            }

            const summary = summaryResponse.text.trim();
            const usage = summaryResponse.usage || {};
            console.log(`[INSIGHT TOKENS] In: ${usage.promptTokens} Out: ${usage.completionTokens} Total: ${usage.totalTokens}`);

            const { count, error: countErr } = await supabase
                .from('chats')
                .select('*', { count: 'exact', head: true })
                .eq('contact_id', contactId);

            if (countErr) throw countErr;

            await supabase.from('insights').insert({
                contact_id: contactId,
                summary: summary,
                message_count: count
            });
            console.log(`Stored insight for ${phoneNumber}`);
        } catch (err) {
            console.error(`Insight failed for ${phoneNumber}:`, err.message);
        }
    }

    // -------------------------------- Incoming Message Controller -------------------------------- //
    // Every message in the upsert, not just the first. Baileys batches them --
    // messages queued while the socket was offline arrive together on
    // reconnect -- and the old `m.messages[0]` silently dropped the rest.
    // Handled one at a time, so a bad message cannot sink the rest of its batch
    // and two messages in one batch from a new contact cannot both create it.
    sock.ev.on("messages.upsert", async (m) => {
        const batch = (m && Array.isArray(m.messages)) ? m.messages : [];
        for (const msg of batch) {
            try {
                await handleUpsertMessage(msg);
            } catch (err) {
                console.error(`[UPSERT] Failed to process message ${msg && msg.key ? msg.key.id : '(no key)'}:`, err.message);
            }
        }
    });

    async function handleUpsertMessage(msg) {
        if (!msg || !msg.key) return;

        // Belt 2 of the self-echo guard -- see "Self-echo suppression" at the top
        // of this file. An upsert carrying an id this process just sent is our own
        // reply coming back, never Rohan typing. Dropping it here is what stops an
        // agent reply from being re-stored as source:'human' and then served back
        // to the model as a Rohan-voice exemplar.
        if (isSelfSentId(msg.key.id)) {
            console.log(`[ECHO] Dropped our own message ${msg.key.id} echoed back to messages.upsert.`);
            return;
        }

        // The raw Baileys object is huge and full of private content, and one
        // arrives for every status update and group message too. Parked behind
        // DEBUG=true so the audit output stays readable.
        if (process.env.DEBUG === 'true') {
            console.log("------------------- NEW INCOMING MESSAGE -------------------");
            console.log("WhatsApp Message Object:", JSON.stringify(msg, null, 2));
        }

        // Ignore status messages, broadcast messages, and group messages
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.broadcast || msg.key.remoteJid.endsWith('@g.us')) return;

        const sender = msg.key.remoteJid;
        const phoneNumber = sender.split("@")[0].replace(/[^0-9]/g, "");

        const text = messageText(msg);

        if (!text) return;

        // 1. Fetch or create Contact and Persona
        let { data: contact, error: contactError } = await supabase
            .from('contacts')
            .select('*, persona:personas(*), relationPerson:relation_persons(*)')
            .eq('phone', phoneNumber)
            .maybeSingle();

        if (contactError) {
            console.error("❌ Error fetching contact from Supabase:", contactError.message);
            if (contactError.message.includes("Could not find the table")) {
                console.error("👉 Please make sure that you have successfully executed the SQL schema (supabase_schema.sql) in your Supabase Dashboard SQL Editor.");
            }
            return;
        }

        if (!contact) {
            console.log(`Creating new contact for ${phoneNumber}...`);
            let { data: targetPersonas, error: personaErr } = await supabase.from('personas').select('*').eq('name', 'Rohan').limit(1);
            if (personaErr) {
                console.error("❌ Error querying personas from Supabase:", personaErr.message);
                return;
            }
            let targetPersona = targetPersonas && targetPersonas.length > 0 ? targetPersonas[0] : null;

            if (!targetPersona) {
                let { data: defPersonas, error: defPersonaErr } = await supabase.from('personas').select('*').eq('name', 'Default').limit(1);
                if (defPersonaErr) {
                    console.error("❌ Error querying default personas from Supabase:", defPersonaErr.message);
                    return;
                }
                targetPersona = defPersonas && defPersonas.length > 0 ? defPersonas[0] : null;
            }

            if (!targetPersona) {
                console.log("Creating default persona...");
                const { data: newPersona, error: insertPersonaErr } = await supabase.from('personas').insert({
                    name: "Default"
                }).select().single();

                if (insertPersonaErr) {
                    console.error("❌ Error creating default persona in Supabase:", insertPersonaErr.message);
                    return;
                }
                targetPersona = newPersona;
            }

            if (!targetPersona) {
                console.error("❌ Could not resolve or create a valid target persona.");
                return;
            }

            const { data: newContact, error: insertContactErr } = await supabase.from('contacts').insert({
                phone: phoneNumber,
                persona_id: targetPersona.id
            }).select('*, persona:personas(*), relationPerson:relation_persons(*)').single();

            if (insertContactErr) {
                console.error("❌ Error creating new contact in Supabase:", insertContactErr.message);
                return;
            }
            contact = newContact;
        }
        console.log(`[CONTACT] Loaded contact for ${phoneNumber} (ID: ${contact.id})`);

        // 2. Store outgoing message
        // fromMe == Rohan typing on his own phone. This is the real thing: the only
        // outgoing text that may ever be shown to the model as a style exemplar.
        // Only genuine phone-typed messages reach this point -- the agent's own
        // replies are stopped by both belts of the self-echo guard above.
        //
        // saveWithCarriedSchedules, not saveMessage: any schedule payload a
        // previous turn could not attach to a row rides along in this row's
        // metadata.carried_schedules. It changes metadata only -- not `message`,
        // not `source` -- so this row stays exactly as exemplar-eligible as it
        // was, and promptService's history never reads metadata at all. See the
        // carry-forward ledger in services/scheduleExtract.js.
        if (msg.key.fromMe) {
            console.log(`[YOU] to ${phoneNumber}: "${text}"`);
            try {
                await saveWithCarriedSchedules(saveMessage, contact.id, {
                    contactId: contact.id,
                    message: text,
                    direction: "OUTGOING",
                    source: "human"
                });
            } catch (err) {
                console.error(`[STORAGE] Failed to store Rohan's own message for ${phoneNumber}:`, err.message);
            }
            // Observation mode: line the real reply up against the agent's draft.
            noteOwnReply(phoneNumber, text);
            return;
        }

        // 3. Log incoming message
        // Typed by the contact -- a real person, so 'human'. It is not agent output,
        // and direction=INCOMING keeps it out of the Rohan-voice exemplar pool anyway.
        console.log(`[INCOMING] from ${phoneNumber}: "${text}"`);
        try {
            await Promise.all([
                // The soonest "next stored row" there is, and therefore where a
                // schedule deferred by the previous turn normally lands.
                saveWithCarriedSchedules(saveMessage, contact.id, {
                    contactId: contact.id,
                    message: text,
                    direction: "INCOMING",
                    source: "human"
                }),
                supabase.from('contacts').update({ last_message_at: new Date() }).eq('id', contact.id)
            ]);
            console.log(`[STORAGE] Incoming message stored under Contact ID: ${contact.id}`);
        } catch (err) {
            // Storage hiccup must not swallow the message: still bundle and reply.
            console.error(`[STORAGE] Failed to store incoming message for ${phoneNumber}:`, err.message);
        }

        // 4. Bundling logic
        if (pendingTimers.has(phoneNumber)) {
            const state = pendingTimers.get(phoneNumber);
            if (state.timeoutId) {
                clearTimeout(state.timeoutId);
                state.timeoutId = null;
                state.bundleMessages.push(msg);
                console.log(`[BUNDLING] Added message to existing bundle for ${phoneNumber}. Total: ${state.bundleMessages.length}`);
            } else {
                state.bundleMessages.push(msg);
                console.log(`[BUNDLING] New message arrived during AI phase. Waiting to start/reset next timer...`);
            }
        } else {
            pendingTimers.set(phoneNumber, {
                timeoutId: null,
                bundleMessages: [msg],
                shouldQuote: false,
                processId: null
            });
        }

        const state = pendingTimers.get(phoneNumber);
        // When this batch began, so the audit can tell which of Rohan's own
        // replies were typed while it was collecting.
        if (!state.firstReceivedAt) state.firstReceivedAt = Date.now();
        if (!state.timeoutId) {
            console.log(collectionDelay
                ? `[BUNDLE] Starting ${collectionDelay / 1000}s silence window for ${phoneNumber}...`
                : `[BUNDLE] Drafting right away for ${phoneNumber} (testing mode, no wait)...`);
            state.timeoutId = setTimeout(async () => {
                const currentProcessId = Date.now();
                state.processId = currentProcessId;
                state.timeoutId = null;

                // SNAPSHOT the current bundle and clear it for the next one
                const currentBatch = [...state.bundleMessages];
                state.bundleMessages = [];
                const batchStartedAt = state.firstReceivedAt || Date.now();
                state.firstReceivedAt = null;

                console.log(`[AI] Processing batch of ${currentBatch.length} messages for ${phoneNumber}...`);

                // 1. Build the prompt. Its layout follows SYSTEM_PROMPT_VERSION:
                //    classic (v1-v3) or per-person (v4) -- see "Prompt versions and
                //    layouts" in promptService.js.
                const incomingTexts = currentBatch.map(m => messageText(m) || "(media)");
                const combinedBatchText = incomingTexts.join("\n");
                const draft = await buildDraftMessages(contact.id, combinedBatchText, {
                    contactName: contact.name || (currentBatch.find(m => m.pushName) || {}).pushName || '',
                    recentDrafts: recentDraftTexts.get(phoneNumber) || []
                });
                const dynamicSystemPrompt = draft.messages[0] ? draft.messages[0].content : "";

                // The full prompt carries the persona and up to HISTORY_MESSAGE_LIMIT
                // private messages -- far too much to print on every draft. Both
                // dumps are parked behind DEBUG=true.
                if (process.env.DEBUG === 'true') {
                    console.log("--- AI Dynamic Prompt ---");
                    console.log(dynamicSystemPrompt);
                    console.log("-----------------------------------------------");
                }

                const messages = draft.messages;

                if (process.env.DEBUG === 'true') {
                    console.log("--- AI Messages (Dynamic System Prompt) ---");
                    console.log(JSON.stringify(messages, null, 2));
                    console.log("-----------------------------------------------");
                }

                // Use the last message in currentBatch as the "text" prompt for compatibility
                const lastMessageText = incomingTexts[incomingTexts.length - 1] || "(media)";

                // HAND-OFF FROM THE MOOD READER -- see "Hand-off from the mood
                // reader" above. A question only Rohan can answer, or a message that
                // depends on context the chat doesn't have: no draft is requested at
                // all (which also saves the tokens); it flows on as "negative", the
                // same hand-off every path below already handles.
                const handOffReason = moodHandOffReason(draft.meta && draft.meta.mood);
                const aiStartedAt = Date.now();
                let { provider, model, response: aiResponse } = handOffReason
                    ? skippedDraft()
                    : await callModel(lastMessageText, messages);
                let latencyMs = Date.now() - aiStartedAt;
                console.log(handOffReason
                    ? `[AI] Not drafting for ${phoneNumber}: ${handOffReason}. Handed to you.`
                    : `[AI] Requested response from ${provider} (${model}), ${promptLabel(draft.meta)}.`);

                // CONTRACT 2: on failure the provider hands back text:null plus an error
                // string. Nothing is sent, nothing is stored -- an error message must
                // never land in the contact's chat or become a Rohan-voice example.
                if (!isUsableAiResponse(aiResponse)) {
                    console.error(`[AI] ${provider} failed for ${phoneNumber}: ${aiFailureReason(aiResponse)}. Nothing sent, nothing stored.`);
                    pendingTimers.delete(phoneNumber);
                    return;
                }

                // ROMAN LETTERS ONLY -- see "Roman letters only" above. One retry with
                // an explicit correction; if it is still Devanagari (or the retry
                // fails) the draft is emptied, which every path below treats as
                // "no reply": testing mode shows SILENT, live mode sends nothing.
                if (containsDevanagari(aiResponse.text)) {
                    console.warn(`[SCRIPT] Draft for ${phoneNumber} came back in Devanagari; asking once for Roman letters.`);
                    // Per-person (v4) messages already end on their message as a
                    // user turn; classic ones are a single system message.
                    const asked = messages[messages.length - 1].role === "user"
                        ? messages
                        : [...messages, { role: "user", content: lastMessageText }];
                    const retry = await callModel(lastMessageText, [
                        ...asked,
                        { role: "assistant", content: aiResponse.text },
                        { role: "user", content: ROMAN_ONLY_CORRECTION }
                    ]);
                    latencyMs = Date.now() - aiStartedAt;
                    if (isUsableAiResponse(retry.response) && !containsDevanagari(retry.response.text)) {
                        aiResponse = retry.response;
                    } else {
                        console.warn(`[SCRIPT] Still not in Roman letters after the retry; dropping the draft for ${phoneNumber}.`);
                        aiResponse = { ...aiResponse, text: '' };
                    }
                }

                if (process.env.DEBUG === 'true') {
                    console.log("AI Response Raw Content:", aiResponse.text);
                }
                const usage = aiResponse.usage || {};
                console.log(`[TOKEN USAGE] In: ${usage.promptTokens} | Out: ${usage.completionTokens} | Total: ${usage.totalTokens}`);

                // Lift any scheduling JSON out first, then sanitize whatever prose is
                // left. Both the sent text and the stored text are the sanitized prose.
                const extracted = extractSchedule(aiResponse.text);
                if (extracted.schedule) {
                    console.log(`[SCHEDULE] Parsed scheduling payload for ${phoneNumber}:`, JSON.stringify(extracted.schedule));
                } else if (extracted.scheduleError) {
                    console.warn(`[SCHEDULE] Malformed scheduling JSON from ${provider} for ${phoneNumber} (${extracted.scheduleError}). Stripped from the reply.`);
                }
                if (extracted.residueStripped) {
                    console.warn(`[SCHEDULE] Scheduling-JSON residue survived brace scanning for ${phoneNumber} and was scrubbed `
                        + `from the prose: ${JSON.stringify(extracted.residueStripped)}`);
                }

                const cleanedProse = guardOutgoingText(applySanitizer(extracted.text), phoneNumber);
                // Emoji and length habits -- see "Emoji habit" and "Length habit" above.
                const emojiRate = draft.meta && typeof draft.meta.emojiRate === 'number' ? draft.meta.emojiRate : null;
                const lengthHabit = (draft.meta && draft.meta.lengthHabit) || null;
                const fewerEmojis = matchEmojiHabit(cleanedProse, emojiRate);
                const prose = matchLengthHabit(fewerEmojis, lengthHabit);
                if (fewerEmojis !== cleanedProse) {
                    console.log(`[EMOJI] Fewer emojis in the draft for ${phoneNumber}: Rohan uses one in `
                        + (emojiRate === null ? `about ${Math.round(DEFAULT_EMOJI_RATE * 100)}% of messages (default, not measured yet).`
                            : `${Math.round(emojiRate * 100)}% of messages to them.`));
                }
                if (prose !== fewerEmojis) {
                    const habit = lengthHabit || DEFAULT_LENGTH_HABIT;
                    console.log(`[LENGTH] Shortened the draft for ${phoneNumber} to how Rohan writes to them `
                        + `(up to ${habit.maxWords} words, ${habit.maxLines} line${habit.maxLines === 1 ? '' : 's'}).`);
                }
                const hasSchedule = !!(extracted.schedule || extracted.scheduleError);

                // Everything the extractor learned, in the shape chats.metadata
                // wants it. Built once so every path can attach it -- the paths
                // that store no row hand it to the carry-forward ledger instead
                // (see the refusal branches below), so it is never lost.
                const scheduleExtra = buildScheduleExtra(extracted);

                // ---- When a JSON-only reply may be answered with SCHEDULE_ACK ----
                //
                // POLICY: acknowledge a payload that PARSED and says
                // confirmed:true. That is the whole test. A missing date or time
                // does NOT block the acknowledgement: the template itself offers
                // `"date": "<DD/MM/YYYY or null>"`, and a same-day plan ("aaj 7
                // baje call") needs date arithmetic off history timestamps that
                // the model routinely skips, emitting date:null -- "kal bhetu"
                // does the same to time. Requiring both slots meant a contact who
                // had just said "haan 7 baje chalta hai" got total silence, which
                // reads as being ignored. isAcknowledgeablePlan owns the rule;
                // the reasoning in full is in services/scheduleExtract.js.
                //
                // Still refused, and still answered with silence plus a log line:
                //
                //   * a blob that failed to PARSE (truncated mid-emit, or
                //     malformed). buildScheduleExtra records it as
                //     {schedule:null, schedule_parse_error, schedule_raw} -- i.e.
                //     nothing was captured. Replying "done" there told the contact
                //     their booking was in the diary when in fact it had been
                //     dropped, and they stopped chasing it.
                //
                //   * an UNCONFIRMED plan (confirmed !== true, which includes the
                //     template's own unfilled `true/false`). system_prompt_v3
                //     Step 2 says to ask casually when the plan is not settled,
                //     and `"confirmed": true/false` exists so the model can say
                //     "not yet". Confirming that both lies and swallows the
                //     question the model was supposed to ask.
                //
                // Silence is the right failure for those two, not a substitute
                // question of our own: the contact repeats themselves, the next
                // turn goes back through the model, and the question gets asked in
                // Rohan's voice instead of ours. The raw JSON never leaves this
                // function on any branch: neither sent nor written to chats.message.
                let finalReply = prose;
                if (!finalReply && isAcknowledgeablePlan(extracted.schedule)) {
                    finalReply = SCHEDULE_ACK;
                    console.log(`[SCHEDULE] Reply for ${phoneNumber} was a confirmed plan only; acknowledging with "${SCHEDULE_ACK}". Payload: ${JSON.stringify(extracted.schedule)}`);
                } else if (!finalReply && hasSchedule) {
                    console.warn(`[SCHEDULE] Not acknowledging for ${phoneNumber}: ${describeAckRefusal(extracted)}. Staying silent rather than confirming something the model did not mark as agreed. Payload: ${JSON.stringify(extracted.schedule || extracted.scheduleRaw)}`);
                }

                // TESTING_MODE (see the top of this file) picks the branch. Testing
                // mode runs only the first one. Live mode (TESTING_MODE=false) runs
                // the three after it: the original auto-reply path, unchanged.
                if (!AUTO_REPLY_ENABLED) {
                    // ---- TESTING MODE: report what the agent WOULD do; send nothing ----
                    let verdict;
                    let carryReason;
                    if (!finalReply) {
                        // No prose, and no confirmed plan worth acknowledging: the agent
                        // would stay silent. (If a schedule was involved, the branch above
                        // has already logged why it is not being confirmed.)
                        verdict = 'SILENT';
                        carryReason = describeAckRefusal(extracted);
                    } else if (finalReply.toLowerCase().includes("negative")) {
                        // "negative" is the persona's hand-off signal: this one needs the
                        // real Rohan. SCHEDULE_ACK never trips this, so the check still
                        // only ever fires on the model's prose.
                        verdict = 'HAND-OFF';
                        carryReason = 'reply was the "negative" hand-off signal, so no row was stored';
                    } else {
                        verdict = 'WOULD SEND';
                        carryReason = 'testing mode: the draft was not sent, so no row was stored';
                    }

                    // Replies Rohan typed during this batch (before the draft was ready)
                    // go straight into the audit block. Otherwise the draft waits for
                    // Rohan's next message to this contact and is compared then.
                    const alreadySent = takeOwnRepliesSince(phoneNumber, batchStartedAt);
                    printAudit({
                        phoneNumber,
                        name: contact.name || (currentBatch.find(m => m.pushName) || {}).pushName || '',
                        incoming: incomingTexts,
                        draft: finalReply,
                        original: cleanedProse,
                        schedule: extracted.schedule,
                        provider,
                        model,
                        latencyMs,
                        usage,
                        prompt: draft.meta,
                        handOffReason,
                        alreadySent,
                        verdict
                    });
                    if (alreadySent.length === 0) {
                        boundedSet(pendingDrafts, phoneNumber, { text: finalReply, verdict, at: Date.now() });
                    }
                    if (verdict === 'WOULD SEND') rememberRecentDraft(phoneNumber, finalReply);

                    // No chats row is stored for a draft. A schedule payload is not
                    // dropped with it, though: it is deferred and merged into the
                    // metadata of the next row this contact stores (metadata only --
                    // never the message text). See the carry-forward ledger in
                    // services/scheduleExtract.js.
                    carrySchedule(contact.id, phoneNumber, scheduleExtra, carryReason);
                } else if (!finalReply) {
                    // No prose, and no confirmed plan worth acknowledging. Say nothing
                    // and store no row: an empty chats row would only pollute future
                    // prompts. (If a schedule was involved, the branch above has
                    // already logged why it is not being confirmed.)
                    //
                    // The PAYLOAD is not dropped with the reply, though -- it is
                    // deferred and merged into the metadata of the next row this
                    // contact stores, normally their very next message. See the
                    // carry-forward ledger in services/scheduleExtract.js.
                    console.log(`[AI] Response was empty after sanitizing. Skipping response for ${phoneNumber}.`);
                    carrySchedule(contact.id, phoneNumber, scheduleExtra, describeAckRefusal(extracted));
                } else if (finalReply.toLowerCase().includes("negative")) {
                    // "negative" is the persona's hand-off signal: this one needs the real
                    // Rohan, so nothing goes out and nothing is stored. SCHEDULE_ACK never
                    // trips this, so the check still only ever fires on the model's prose.
                    console.log(`[AI] Response was "negative". Skipping response for ${phoneNumber}.`);
                    carrySchedule(contact.id, phoneNumber, scheduleExtra, 'reply was the "negative" hand-off signal, so no row was stored');
                } else {
                    const randomDelay = Math.floor(Math.random() * (RESPONSE_DELAY_MAX - RESPONSE_DELAY_MIN + 1)) + RESPONSE_DELAY_MIN;
                    console.log(`[DELAY] Waiting ${Math.round(randomDelay / 1000)}s before sending reply to ${phoneNumber}...`);
                    await new Promise(resolve => setTimeout(resolve, randomDelay));

                    const sendSock = currentSock || sock;
                    if (sendSock) {
                        let sent = false;

                        // Reserve the id before the send -- see newOutgoingMessageId for
                        // why registering it afterwards can lose the race with the echo.
                        const messageId = newOutgoingMessageId(sendSock);
                        if (messageId) rememberSelfSentId(messageId);

                        try {
                            console.log(`[OUTGOING] to ${phoneNumber}: "${highlightAI(finalReply)}"`);
                            const receipt = await sendSock.sendMessage(sender, { text: finalReply }, messageId ? { messageId } : {});
                            // Belt and braces: if Baileys ignored our id, remember its own.
                            rememberSelfSentId(receipt && receipt.key && receipt.key.id);
                            sent = true;
                        } catch (err) {
                            console.error(`Send error:`, err.message);
                        }

                        // Only store what actually reached the contact.
                        if (sent) {
                            try {
                                await saveWithCarriedSchedules(saveMessage, contact.id, {
                                    contactId: contact.id,
                                    message: finalReply,
                                    direction: "OUTGOING",
                                    source: "ai",
                                    model: model,
                                    extra: scheduleExtra
                                });
                                console.log(`[STORAGE] AI response stored for ${phoneNumber}: "${finalReply}"${scheduleExtra ? ` (+schedule metadata)` : ''}`);
                            } catch (err) {
                                console.error(`[STORAGE] Failed to store AI response for ${phoneNumber}:`, err.message);
                                // The row never landed, so this turn's own payload
                                // has nowhere to live yet either. (Anything drained
                                // for the attempt was already put back by
                                // saveWithCarriedSchedules.)
                                carrySchedule(contact.id, phoneNumber, scheduleExtra, `storing the AI row failed (${err.message})`);
                            }
                        } else {
                            carrySchedule(contact.id, phoneNumber, scheduleExtra, 'the send failed, so no delivered row was stored');
                        }
                    } else {
                        carrySchedule(contact.id, phoneNumber, scheduleExtra, 'no WhatsApp socket was available to send on');
                    }
                }

                // Insight check
                const { count: finalCount } = await supabase.from('chats').select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);
                console.log(`[INSIGHT] Message count for ${phoneNumber}: ${finalCount}`);
                if (finalCount && finalCount % INSIGHT_THRESHOLD === 0) {
                    console.log(`[INSIGHT] Threshold reached (${INSIGHT_THRESHOLD}). Generating summary...`);
                    generateAndStoreInsight(contact.id, phoneNumber);
                }

                pendingTimers.delete(phoneNumber);
            }, collectionDelay);
        }
    }
}

// Handle internal errors to prevent process crash
process.on('uncaughtException', (err) => {
    console.error('Captured Uncaught Exception:', err);
    if (err.message?.includes('Connection Closed') || err.message?.includes('Stream Errored')) {
        console.log('Safe to ignore, reconnection logic will trigger...');
    } else {
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = { startWhatsApp };

// Pure helpers, exported so they can be exercised offline without a socket or a
// DB. Not part of the runtime surface -- nothing else in the app imports these.
// extractSchedule / buildScheduleExtra / isAcknowledgeablePlan are re-exports of
// services/scheduleExtract.js, and resolveModelId of services/modelId.js, kept
// here so existing callers of these names keep working; new code should require
// those modules directly.
module.exports.extractSchedule = extractSchedule;
module.exports.buildScheduleExtra = buildScheduleExtra;
module.exports.isAcknowledgeablePlan = isAcknowledgeablePlan;
module.exports.resolveModelId = resolveModelId;
module.exports.guardOutgoingText = guardOutgoingText;
module.exports.rememberSelfSentId = rememberSelfSentId;
module.exports.isSelfSentId = isSelfSentId;
module.exports.SCHEDULE_ACK = SCHEDULE_ACK;
module.exports.SELF_SENT_ID_LIMIT = SELF_SENT_ID_LIMIT;
module.exports.resolveTestingMode = resolveTestingMode;
module.exports.resolveReplyDelays = resolveReplyDelays;
module.exports.containsDevanagari = containsDevanagari;
module.exports.resolveTestingBundleDelay = resolveTestingBundleDelay;
module.exports.matchEmojiHabit = matchEmojiHabit;
module.exports.matchLengthHabit = matchLengthHabit;
module.exports.moodHandOffReason = moodHandOffReason;