const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { generateResponse: generateGeminiResponse } = require("./geminiService");
const { generateResponse: generateGroqResponse } = require("./groqService");
const { generateResponse: generateOllamaResponse } = require("./ollamaService");
const { supabase } = require("./supabaseClient");
const { buildDynamicPrompt } = require("./promptService");

let currentSock = null;
const pendingTimers = new Map();

// Response Delay: Maximum and minimum delay between messages
const RESPONSE_DELAY_MAX = 45 * 1000;
const RESPONSE_DELAY_MIN = 20 * 1000;

// Message Context Window: Number of messages to consider for the dynamic prompt
const MESSAGE_CONTEXT_WINDOW = 15;

// Insight Threshold: Number of messages to generate a summary
const INSIGHT_THRESHOLD = 20;

// Message Collection Delay: Time to wait before processing a bundle of messages
const MESSAGE_COLLECTION_DELAY = 30 * 1000;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    console.log(`//------------------------ Starting connection with WhatsApp service ------------------------//`);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "error" }),
        version,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
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

            const aiVersion = process.env.AI_VERSION || 'v1';
            let summaryResponse;
            if (aiVersion === 'v3') {
                summaryResponse = await generateOllamaResponse(summarizationPrompt, systemPromptMessage);
            } else if (aiVersion === 'v2') {
                summaryResponse = await generateGroqResponse(summarizationPrompt, systemPromptMessage);
            } else {
                summaryResponse = await generateGeminiResponse(summarizationPrompt, systemPromptMessage);
            }

            if (summaryResponse && summaryResponse.text) {
                const summary = summaryResponse.text.trim();
                const { usage } = summaryResponse;
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
            }
        } catch (err) {
            console.error(`Insight failed for ${phoneNumber}:`, err.message);
        }
    }

    // -------------------------------- Incoming Message Controller -------------------------------- //
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
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
        if (msg.key.fromMe) {
            await supabase.from('chats').insert({
                contact_id: contact.id, message: text, direction: "OUTGOING"
            });
            return;
        }

        // 3. Log incoming message
        console.log(`[INCOMING] from ${phoneNumber}: "${text}"`);
        await Promise.all([
            supabase.from('chats').insert({
                contact_id: contact.id, message: text, direction: "INCOMING"
            }),
            supabase.from('contacts').update({ last_message_at: new Date() }).eq('id', contact.id)
        ]);
        console.log(`[STORAGE] Incoming message stored under Contact ID: ${contact.id}`);

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

                const aiVersion = process.env.AI_VERSION || 'v1';
                console.log(`[AI] Requesting response using version: ${aiVersion === 'v2' ? 'Groq (Llama 3)' : 'Gemini'}`);
                let aiResponse;

                // Use the last message in currentBatch as the "text" prompt for compatibility
                const lastMessageText = currentBatch[currentBatch.length - 1]?.message?.conversation ||
                    currentBatch[currentBatch.length - 1]?.message?.extendedTextMessage?.text ||
                    "(media)";

                if (aiVersion === 'v3') {
                    aiResponse = await generateOllamaResponse(lastMessageText, messages);
                } else if (aiVersion === 'v2') {
                    aiResponse = await generateGroqResponse(lastMessageText, messages);
                } else {
                    aiResponse = await generateGeminiResponse(lastMessageText, messages);
                }

                if (aiResponse && aiResponse.text) {
                    console.log("AI Response Raw Content:", aiResponse.text);
                    const { text, usage } = aiResponse;
                    console.log(`[TOKEN USAGE] In: ${usage.promptTokens} | Out: ${usage.completionTokens} | Total: ${usage.totalTokens}`);

                    const finalReply = text.trim();

                    if (finalReply && !finalReply.toLowerCase().includes("negative")) {
                        const randomDelay = Math.floor(Math.random() * (RESPONSE_DELAY_MAX - RESPONSE_DELAY_MIN + 1)) + RESPONSE_DELAY_MIN;
                        console.log(`[DELAY] Waiting ${Math.round(randomDelay / 1000)}s before sending reply to ${phoneNumber}...`);
                        await new Promise(resolve => setTimeout(resolve, randomDelay));

                        const sendSock = currentSock || sock;
                        if (sendSock) {
                            try {
                                console.log(`[OUTGOING] to ${phoneNumber}: "${finalReply}"`);
                                await sendSock.sendMessage(sender, { text: finalReply });

                                await supabase.from('chats').insert({
                                    contact_id: contact.id, message: finalReply, direction: "OUTGOING"
                                });
                                console.log(`[STORAGE] AI response stored for ${phoneNumber}: "${finalReply}"`);
                            } catch (err) {
                                console.error(`Send error:`, err.message);
                            }
                        }
                    } else {
                        console.log(`[AI] Response was "negative" or empty. Skipping response for ${phoneNumber}.`);
                    }

                    // Insight check
                    const { count: finalCount } = await supabase.from('chats').select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);
                    console.log(`[INSIGHT] Message count for ${phoneNumber}: ${finalCount}`);
                    if (finalCount && finalCount % INSIGHT_THRESHOLD === 0) {
                        console.log(`[INSIGHT] Threshold reached (${INSIGHT_THRESHOLD}). Generating summary...`);
                        generateAndStoreInsight(contact.id, phoneNumber);
                    }

                    pendingTimers.delete(phoneNumber);
                } else {
                    console.error("AI response invalid.");
                    pendingTimers.delete(phoneNumber);
                }
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