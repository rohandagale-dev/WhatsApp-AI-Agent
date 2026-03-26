const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { generateResponse } = require("./geminiService");

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`//------------------------ Starting connection with WhatsApp service ------------------------//`);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "info" }),
        version,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on("connection.update", (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            console.log("Scan QR Code (Dev Environment)");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Connection closed due to ${lastDisconnect.error}, reconnecting ${shouldReconnect}`);
            
            if (shouldReconnect) {
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
            console.log("WhatsApp connected!");
        }
    });


    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];

        // If it's me who sent the message, It can be task or something else (Parked)
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption;

        if (text) {
            console.log(`Message from ${sender}: ${text}`);
            
            const aiResponse = await generateResponse(text);
            
            await sock.sendMessage(sender, { text: aiResponse });
        }
    });
}

module.exports = { startWhatsApp };