require("../loadEnv");

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, generateMessageIDV2 } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { generateResponse: generateGeminiResponse } = require("./geminiService");
const { generateResponse: generateGroqResponse } = require("./groqService");
const { generateResponse: generateOllamaResponse } = require("./ollamaService");
const { supabase } = require("./supabaseClient");
const { buildDynamicPrompt } = require("./promptService");
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

let currentSock = null;
const pendingTimers = new Map();

// Response Delay: Maximum and minimum delay between messages
const RESPONSE_DELAY_MAX = 45 * 1000;
const RESPONSE_DELAY_MIN = 20 * 1000;

// Insight Threshold: Number of messages to generate a summary
const INSIGHT_THRESHOLD = 20;

// Message Collection Delay: Time to wait before processing a bundle of messages
const MESSAGE_COLLECTION_DELAY = 30 * 1000;

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

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    console.log(`//------------------------ Starting connection with WhatsApp service ------------------------//`);

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
        emitOwnEvents: false
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
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
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

        console.log("------------------- NEW INCOMING MESSAGE -------------------");
        console.log("WhatsApp Message Object:", JSON.stringify(msg, null, 2));

        // Ignore status messages, broadcast messages, and group messages
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.broadcast || msg.key.remoteJid.endsWith('@g.us')) return;

        const sender = msg.key.remoteJid;
        const phoneNumber = sender.split("@")[0].replace(/[^0-9]/g, "");

        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption;

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
        if (!state.timeoutId) {
            console.log(`[BUNDLE] Starting ${MESSAGE_COLLECTION_DELAY / 1000}s silence window for ${phoneNumber}...`);
            state.timeoutId = setTimeout(async () => {
                const currentProcessId = Date.now();
                state.processId = currentProcessId;
                state.timeoutId = null;

                // SNAPSHOT the current bundle and clear it for the next one
                const currentBatch = [...state.bundleMessages];
                state.bundleMessages = [];

                console.log(`[AI] Processing batch of ${currentBatch.length} messages for ${phoneNumber}...`);

                // 1. Build the Dynamic System Prompt
                const combinedBatchText = currentBatch.map(m => m.message.conversation || m.message.extendedTextMessage?.text || "(media)").join("\n");
                const dynamicSystemPrompt = await buildDynamicPrompt(contact.id, combinedBatchText);

                console.log("--- AI Dynamic Prompt ---");
                console.log(dynamicSystemPrompt);
                console.log("-----------------------------------------------");

                const messages = [{
                    role: "system",
                    content: dynamicSystemPrompt
                }];

                console.log("--- AI Messages (Dynamic System Prompt) ---");
                console.log(JSON.stringify(messages, null, 2));
                console.log("-----------------------------------------------");

                // Use the last message in currentBatch as the "text" prompt for compatibility
                const lastMessageText = currentBatch[currentBatch.length - 1]?.message?.conversation ||
                    currentBatch[currentBatch.length - 1]?.message?.extendedTextMessage?.text ||
                    "(media)";

                const { provider, model, response: aiResponse } = await callModel(lastMessageText, messages);
                console.log(`[AI] Requested response from ${provider} (${model}).`);

                // CONTRACT 2: on failure the provider hands back text:null plus an error
                // string. Nothing is sent, nothing is stored -- an error message must
                // never land in the contact's chat or become a Rohan-voice example.
                if (!isUsableAiResponse(aiResponse)) {
                    console.error(`[AI] ${provider} failed for ${phoneNumber}: ${aiFailureReason(aiResponse)}. Nothing sent, nothing stored.`);
                    pendingTimers.delete(phoneNumber);
                    return;
                }

                console.log("AI Response Raw Content:", aiResponse.text);
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

                const prose = guardOutgoingText(applySanitizer(extracted.text), phoneNumber);
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

                if (!finalReply) {
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
                            console.log(`[OUTGOING] to ${phoneNumber}: "${finalReply}"`);
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
            }, MESSAGE_COLLECTION_DELAY);
        }
    });
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