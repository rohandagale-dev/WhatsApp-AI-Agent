const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { generateResponse: generateGeminiResponse } = require("./geminiService");
const { generateResponse: generateGroqResponse } = require("./groqService");
const { generateResponse: generateOllamaResponse } = require("./ollamaService");
const { PrismaClient } = require("@prisma/client");
const { buildDynamicPrompt } = require("./promptService");

const prisma = new PrismaClient();
let currentSock = null;
const pendingTimers = new Map();

// Configuration: Timing parameters in milliseconds
const RESPONSE_DELAY_MAX = 45 * 1000;          // 45 seconds
const RESPONSE_DELAY_MIN = 20 * 1000;          // 20 seconds
const MESSAGE_CONTEXT_WINDOW = 15;
const INSIGHT_THRESHOLD = 20;                  // Generate summary every 20 messages
const MESSAGE_COLLECTION_DELAY = 30 * 1000;    // 30 seconds bundle window

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

    sock.ev.on("creds.update", saveCreds);

    /**
     * Generates and stores a conversation summary (insight) for a contact.
     */
    async function generateAndStoreInsight(contactId, phoneNumber) {
        console.log(`--- Generating AI Insight for ${phoneNumber} ---`);
        try {
            const lastMessages = await prisma.chat.findMany({
                where: { contactId },
                orderBy: { createdAt: "desc" },
                take: INSIGHT_THRESHOLD
            });

            if (lastMessages.length < 5) return;

            const historyText = lastMessages.reverse().map(m => `${m.direction}: ${m.message}`).join("\n");
            const summarizationPrompt = `Summarize the following WhatsApp conversation between Rohan and a contact into a single, concise paragraph (max 2-3 sentences). Focus on core topics and the current status.\n\nCONVERSATION:\n${historyText}`;
            const systemPromptMessage = [{ role: "system", content: "You are a helpful assistant that summarizes conversations concisely." }];

            const aiVersion = process.env.AI_VERSION || 'v1';
            let summary;
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

                await prisma.insight.create({
                    data: {
                        contactId,
                        summary: summary,
                        messageCount: await prisma.chat.count({ where: { contactId } })
                    }
                });
                console.log(`Stored insight for ${phoneNumber}`);
            }
        } catch (err) {
            console.error(`Insight failed for ${phoneNumber}:`, err.message);
        }
    }

    //------------------------------ Incoming Message Controller ------------------------------//
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        console.log("------------------- NEW INCOMING MESSAGE -------------------");
        console.log("WhatsApp Message Object:", JSON.stringify(msg, null, 2));

        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.broadcast || msg.key.remoteJid.endsWith('@g.us')) return;

        const sender = msg.key.remoteJid;
        const phoneNumber = sender.split("@")[0].replace(/[^0-9]/g, "");

        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption;

        if (!text) return;

        // 1. Fetch or create Contact and Persona
        let contact = await prisma.contact.findUnique({
            where: { phone: phoneNumber },
            include: { 
                persona: true,
                relationPerson: true 
            }
        });

        if (!contact) {
            console.log(`Creating new contact for ${phoneNumber}...`);
            // Attempt to find the "Rohan" persona first, then fallback to "Default"
            let targetPersona = await prisma.persona.findFirst({ where: { name: "Rohan" } });
            
            if (!targetPersona) {
                targetPersona = await prisma.persona.findFirst({ where: { name: "Default" } });
            }

            if (!targetPersona) {
                console.log("Creating default persona...");
                targetPersona = await prisma.persona.create({
                    data: {
                        name: "Default",
                        tone: "chill",
                        style: "conversational",
                        systemPrompt: "You are Rohan, chill and slightly sarcastic. Reply briefly."
                    }
                });
            }
            
            contact = await prisma.contact.create({
                data: { phone: phoneNumber, personaId: targetPersona.id },
                include: { 
                    persona: true,
                    relationPerson: true 
                }
            });
        }
        console.log(`[CONTACT] Loaded contact for ${phoneNumber} (ID: ${contact.id})`);

        // 2. Store outgoing message
        if (msg.key.fromMe) {
            await prisma.chat.create({
                data: { contactId: contact.id, message: text, direction: "OUTGOING" }
            });
            return;
        }

        // 3. Log incoming message
        console.log(`[INCOMING] from ${phoneNumber}: "${text}"`);
        await prisma.$transaction([
            prisma.chat.create({
                data: { contactId: contact.id, message: text, direction: "INCOMING" }
            }),
            prisma.contact.update({
                where: { id: contact.id },
                data: { lastMessageAt: new Date() }
            })
        ]);
        console.log(`[STORAGE] Incoming message stored under Contact ID: ${contact.id}`);

        // 4. Bundling logic
        if (pendingTimers.has(phoneNumber)) {
            const state = pendingTimers.get(phoneNumber);
            if (state.timeoutId) {
                clearTimeout(state.timeoutId);
                state.timeoutId = null; // Fix: Ensure the next if block understands no timer is active
                state.bundleMessages.push(msg);
                console.log(`[BUNDLING] Added message to existing bundle for ${phoneNumber}. Total: ${state.bundleMessages.length}`);
            } else {
                // Currently processing or in AI delay - push to NEXT bundle
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
            console.log(`[BUNDLE] Starting ${MESSAGE_COLLECTION_DELAY/1000}s silence window for ${phoneNumber}...`);
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
                    console.log(`[DELAY] Waiting ${Math.round(randomDelay/1000)}s before sending reply to ${phoneNumber}...`);
                    await new Promise(resolve => setTimeout(resolve, randomDelay));

                    const sendSock = currentSock || sock;
                    if (sendSock) {
                        try {
                            console.log(`[OUTGOING] to ${phoneNumber}: "${finalReply}"`);
                            await sendSock.sendMessage(sender, { text: finalReply });
                            
                            await prisma.chat.create({
                                data: { contactId: contact.id, message: finalReply, direction: "OUTGOING" }
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
                const finalCount = await prisma.chat.count({ where: { contactId: contact.id } });
                console.log(`[INSIGHT] Message count for ${phoneNumber}: ${finalCount}`);
                if (finalCount % INSIGHT_THRESHOLD === 0) {
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