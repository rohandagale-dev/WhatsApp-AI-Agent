require('../loadEnv');
const { supabase } = require("./supabaseClient");
const readline = require("readline");

const { saveMessage } = require("./chatStore");
const { buildDynamicPrompt } = require("./promptService");
const { sanitizeReply } = require("./sanitizeReply");
// Same scheduling-JSON pipeline production runs -- one module, no second copy.
const {
    extractSchedule,
    buildScheduleExtra,
    isAcknowledgeablePlan,
    describeAckRefusal,
    containsScheduleResidue,
    deferScheduleExtra,
    saveWithCarriedSchedules
} = require("./scheduleExtract");
// Same model-id resolver production runs -- one module, no second copy.
const { resolveModelId } = require("./modelId");
const { generateResponse: generateGroqResponse } = require("./groqService");
const { generateResponse: generateGeminiResponse } = require("./geminiService");
const { generateResponse: generateOllamaResponse } = require("./ollamaService");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const path = require('path');
const { loadSystemPrompt } = require('./systemPrompt');

const TRAINING_PHONE = "0000000000";

// resolveModelId (which model actually produced a reply, for metadata.model on
// source:'ai' rows) now comes from services/modelId.js, required above. It was
// a byte-identical copy of whatsappService's, "kept in sync" by a comment, and
// both had already drifted from geminiService -- which TRIMS GEMINI_MODEL while
// they did not, so GEMINI_MODEL='   ' stamped training rows with a model id that
// never saw the request. The shared resolver trims. Do not re-inline it.

// ------------------------------ Reply post-processing ------------------------------ //
//
// The scheduling-JSON pipeline (extractSchedule / buildScheduleExtra) is
// required from services/scheduleExtract.js above -- the SAME module
// whatsappService.js uses, not a copy. It used to be copy-pasted here, and the
// copies then diverged: whatsappService gained truncated-blob handling that
// this file never got, so 'npm run train' kept writing half-emitted JSON into
// chats.message, where the deliberately provenance-blind rolling history
// (CONTRACT 4) replayed it into every later prompt for the model to imitate.
// Training is the main way this agent is exercised, so it has to post-process
// replies exactly the way production does. Do not re-inline these helpers.
//
// applySanitizer stays local: it is four lines around sanitizeReply and is not
// schedule-related, so it does not belong in scheduleExtract.js.

/**
 * CONTRACT 3. Never let a sanitizer fault drop a reply on the floor; fall back
 * to the raw trimmed text and shout about it instead.
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
 * CONTRACT 6, last gate -- the same one whatsappService applies before a send.
 * extractSchedule already guarantees its own output is residue-free, but this
 * is the point where text becomes a chats.message row, and applySanitizer's
 * fallback hands back RAW model text when sanitizeReply throws. Training writes
 * into the same chats table the provenance-blind history reads, so a blob
 * slipping through here poisons production prompts just as thoroughly.
 */
function guardStoredText(text) {
    if (!text || !containsScheduleResidue(text)) return text;
    console.error(`[SCHEDULE] Refusing to print or store this reply: it still contains scheduling-JSON residue `
        + `after extraction and sanitizing. Dropped: ${JSON.stringify(text)}`);
    return '';
}

/**
 * Hands a schedule payload to the carry-forward ledger when this turn stores no
 * chats row, so the parsed payload (or the parse error and the raw blob) is not
 * lost to a console.log. It rides in chats.metadata.carried_schedules on the
 * next row this contact stores -- in training, the next line typed. Metadata
 * only: chats.message and metadata.source are untouched and promptService's
 * history renders neither, so it cannot reach a prompt. Mechanism and proof:
 * services/scheduleExtract.js.
 */
function carrySchedule(contactId, scheduleExtra, reason) {
    if (!scheduleExtra) return false;
    const queued = deferScheduleExtra(contactId, scheduleExtra, reason);
    console.warn(`[SCHEDULE] No row stored (${reason}); `
        + `${queued ? 'carrying the payload forward to the next stored row' : 'COULD NOT carry the payload forward'}: `
        + `${JSON.stringify(scheduleExtra)}`);
    return queued;
}

/**
 * True when the persona text defines the named section itself ("## Style",
 * "TONE & STYLE:", "## Rules", ...).
 *
 * Same rule as scripts/seed.js: promptService renders relation_persons.style
 * and .rules as their own STYLE:/RULES: blocks, so writing them alongside a
 * my_persona that already contains those sections puts two competing rule sets
 * -- differently worded -- into one prompt. When the persona defines a section,
 * the column is left NULL and promptService omits the block entirely.
 */
function carriesOwnSection(personaText, section) {
    if (typeof personaText !== 'string' || !personaText) return false;
    const heading = new RegExp(
        `^[ \\t]*(?:#{1,6}[ \\t]*)?[A-Za-z&' \\t-]*\\b${section}\\b[ \\t]*:?[ \\t]*$`,
        'im'
    );
    return heading.test(personaText);
}

async function getOrCreateTrainingContact() {
    const loaded = loadSystemPrompt();
    const rohanPrompt = loaded.text;
    console.log(`System prompt: ${loaded.version}${loaded.source ? ` (${path.basename(loaded.source)})` : ''}`);

    // 1. Ensure Rohan Persona exists
    let { data: rohanPersonas } = await supabase.from('personas').select('*').eq('name', 'Rohan').limit(1);
    let rohanPersona = rohanPersonas && rohanPersonas.length > 0 ? rohanPersonas[0] : null;
    
    if (!rohanPersona) {
        const { data: newPersona } = await supabase.from('personas').insert({
            name: "Rohan"
        }).select().single();
        rohanPersona = newPersona;
    }

    // 2. Fetch or create Training Contact
    let { data: contact } = await supabase.from('contacts').select('*, persona:personas(*), relationPerson:relation_persons(*)').eq('phone', TRAINING_PHONE).maybeSingle();

    if (!contact) {
        console.log("Creating training contact with Rohan persona...");
        const { data: newContact } = await supabase.from('contacts').insert({
            phone: TRAINING_PHONE, 
            name: "Training User",
            persona_id: rohanPersona.id 
        }).select('*, persona:personas(*), relationPerson:relation_persons(*)').single();
        contact = newContact;
    } else if (contact.persona_id !== rohanPersona.id) {
        // Ensure it uses Rohan persona
        const { data: updatedContact } = await supabase.from('contacts').update({
            persona_id: rohanPersona.id
        }).eq('id', contact.id).select('*, persona:personas(*), relationPerson:relation_persons(*)').single();
        contact = updatedContact;
    }

    // 3. Sync system prompt and style into relation_persons for the training contact.
    //    The prompt file carries its own "## Style" section, so a separate
    //    style column would render a SECOND, differently worded STYLE: block in
    //    the same prompt. Detect that in the persona text (never by contact) and
    //    write NULL instead; only a persona without its own section gets one.
    const style = carriesOwnSection(rohanPrompt, 'style') ? null : "conversational";
    let relation = contact.relationPerson;
    if (!relation) {
        const { data: newRelation } = await supabase.from('relation_persons').insert({
            contact_id: contact.id,
            my_persona: rohanPrompt,
            style: style
        }).select().single();
        contact.relationPerson = newRelation;
    } else if (relation.my_persona !== rohanPrompt || (relation.style || null) !== style) {
        // Explicit NULL, so an earlier run's "conversational" is cleared.
        const { data: updatedRelation } = await supabase.from('relation_persons').update({
            my_persona: rohanPrompt,
            style: style
        }).eq('id', relation.id).select().single();
        contact.relationPerson = updatedRelation;
    }
    
    return contact;
}

async function startTraining() {
    console.log("\n--- WhatsApp AI Agent Training Service ---");
    console.log("Type 'exit' to quit.");
    console.log("Acting as: Rohan (AI)");
    console.log("AI Version:", process.env.AI_VERSION || "v1 (Gemini)");
    console.log("-------------------------------------------\n");

    const contact = await getOrCreateTrainingContact();

    // Set once stdin is gone (Ctrl+D, or a piped/heredoc run reaching EOF), so
    // the recursive loop stops instead of calling rl.question() on a closed
    // interface -- which throws ERR_USE_AFTER_CLOSE and, on Windows, takes the
    // libuv assertion with it. Piping input is the natural way to smoke-test
    // this script, so it has to survive EOF.
    // rl.closed covers the case where stdin hit EOF BEFORE this listener was
    // attached -- with piped input the async DB setup above easily outlasts the
    // stream, so the 'close' event has already fired and is never seen.
    let closed = rl.closed === true;
    rl.on("close", () => { closed = true; });

    const askQuestion = () => {
        if (closed || rl.closed) {
            console.log("\nInput stream ended -- training session over.");
            return;
        }
        rl.question("You: ", async (input) => {
            if (input.toLowerCase() === "exit") {
                console.log("Ending training session.");
                rl.close();
                return;
            }

            if (!input.trim()) {
                askQuestion();
                return;
            }

            try {
                // 1. Log incoming message (User)
                // Rohan types this line himself, but he is role-playing the CONTACT
                // side of the conversation, so it is a real human utterance
                // (source:'human') that happens to sit on the INCOMING side. The
                // direction keeps it out of the Rohan-voice exemplar pool; the
                // source records that no model wrote it.
                // saveWithCarriedSchedules, not saveMessage: this is the next
                // stored row after a turn that refused to reply, so it is where
                // that turn's deferred schedule payload lands (metadata only --
                // see carrySchedule above).
                await saveWithCarriedSchedules(saveMessage, contact.id, {
                    contactId: contact.id,
                    message: input,
                    direction: "INCOMING",
                    source: "human",
                    extra: { channel: "training", roleplay: "contact" }
                });

                // 2. Build dynamic prompt
                const dynamicPrompt = await buildDynamicPrompt(contact.id, input);
                const messages = [{ role: "system", content: dynamicPrompt }];

                if (process.env.DEBUG === 'true') {
                    console.log("\n--- [DEBUG] SYSTEM PROMPT ---");
                    console.log(dynamicPrompt);
                    console.log("-----------------------------\n");
                }

                // 3. Generate response
                const aiVersion = process.env.AI_VERSION || 'v1';
                let aiResponse;

                if (aiVersion === 'v3') {
                    aiResponse = await generateOllamaResponse(input, messages);
                } else if (aiVersion === 'v2') {
                    aiResponse = await generateGroqResponse(input, messages);
                } else {
                    aiResponse = await generateGeminiResponse(input, messages);
                }

                // A provider failure returns { ok:false, text:null, error }. Never
                // display or store that error - it used to be persisted as if Rohan
                // had typed it, poisoning the style examples.
                if (aiResponse && aiResponse.ok && aiResponse.text) {
                    const usage = aiResponse.usage || {};

                    if (process.env.DEBUG === 'true') {
                        console.log(`\n[DEBUG] RAW MODEL OUTPUT: ${aiResponse.text}`);
                    }

                    // 4. Post-process exactly as whatsappService does: lift the
                    //    scheduling JSON out first, then sanitize the prose that
                    //    is left. What is printed and what is stored are both the
                    //    sanitized prose - raw JSON and model punctuation never
                    //    reach chats.message, where the provenance-blind history
                    //    would replay them into every later prompt.
                    const extracted = extractSchedule(aiResponse.text);
                    if (extracted.schedule) {
                        console.log(`[SCHEDULE] Parsed scheduling payload: ${JSON.stringify(extracted.schedule)}`);
                    } else if (extracted.scheduleError) {
                        console.warn(`[SCHEDULE] Malformed scheduling JSON (${extracted.scheduleError}). Stripped from the reply.`);
                    }
                    if (extracted.residueStripped) {
                        console.warn(`[SCHEDULE] Scheduling-JSON residue survived brace scanning and was scrubbed from `
                            + `the prose: ${JSON.stringify(extracted.residueStripped)}`);
                    }

                    const finalReply = guardStoredText(applySanitizer(extracted.text));
                    const scheduleExtra = buildScheduleExtra(extracted);

                    if (!finalReply) {
                        // The whole reply was the JSON blob (or the sanitizer
                        // emptied it). Nothing a human would have typed, so store
                        // no row - an empty row only pollutes future prompts.
                        //
                        // whatsappService answers this same case with a canned
                        // one-word acknowledgement whenever the payload parsed and
                        // says confirmed:true (a null date or time does not block
                        // it -- see the policy comment in scheduleExtract.js).
                        // Training has no contact to reassure, so it still sends
                        // nothing -- it just REPORTS which branch production would
                        // have taken, so a rehearsal surfaces the real decision
                        // instead of hiding it behind "nothing stored".
                        //
                        // The payload itself is NOT dropped: it is carried forward
                        // into the metadata of the next row this session stores.
                        if (extracted.schedule || extracted.scheduleError) {
                            const verdict = isAcknowledgeablePlan(extracted.schedule)
                                ? 'production would acknowledge this plan'
                                : `production would stay silent: ${describeAckRefusal(extracted)}`;
                            console.log(`(schedule-only reply: no text alongside the JSON, no row stored - ${verdict})\n`);
                            carrySchedule(contact.id, scheduleExtra, `schedule-only reply, no row stored (${describeAckRefusal(extracted)})`);
                        } else {
                            console.log(`(empty reply after sanitizing, nothing stored)\n`);
                        }
                    } else {
                        console.log(`\nRohan: ${finalReply}\n`);

                        // 5. Log outgoing message (generated by the agent, not by Rohan).
                        //    The scheduling payload rides along in metadata, together
                        //    with anything an earlier refused turn deferred.
                        try {
                            await saveWithCarriedSchedules(saveMessage, contact.id, {
                                contactId: contact.id,
                                message: finalReply,
                                direction: "OUTGOING",
                                source: "ai",
                                model: resolveModelId(aiVersion),
                                extra: { channel: "training", ...(scheduleExtra || {}) }
                            });
                        } catch (err) {
                            console.error(`[STORAGE] Failed to store the AI reply: ${err.message}`);
                            carrySchedule(contact.id, scheduleExtra, `storing the AI row failed (${err.message})`);
                        }
                    }

                    console.log(`[TOKEN CONSUMPTION] Input: ${usage.promptTokens || 0} | Output: ${usage.completionTokens || 0} | Total: ${usage.totalTokens || 0}\n`);
                } else {
                    const reason = (aiResponse && aiResponse.error) || "no response from provider";
                    console.error(`AI failed to respond: ${reason}`);
                    console.error("(nothing stored - the error is not a Rohan-voice message)\n");
                }

            } catch (error) {
                console.error("Error during training loop:", error.message);
            }

            askQuestion();
        });
    };

    askQuestion();
}

startTraining().catch(err => {
    console.error("Critical error in training service:", err);
    process.exitCode = 1;
});
