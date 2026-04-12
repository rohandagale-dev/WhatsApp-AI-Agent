const { PrismaClient } = require("@prisma/client");
const readline = require("readline");
require("dotenv").config();

const { buildDynamicPrompt } = require("./promptService");
const { generateResponse: generateGroqResponse } = require("./groqService");
const { generateResponse: generateGeminiResponse } = require("./geminiService");
const { generateResponse: generateOllamaResponse } = require("./ollamaService");

const prisma = new PrismaClient();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const fs = require('fs');
const path = require('path');

const TRAINING_PHONE = "0000000000";

async function getOrCreateTrainingContact() {
    let rohanPrompt = "You are a helpful AI assistant.";
    try {
        const promptPath = path.join(__dirname, '..', 'system_prompts', 'system_prompt_v2.txt');
        rohanPrompt = fs.readFileSync(promptPath, 'utf8');
    } catch (err) {
        console.warn("Could not read system_prompt_v2.txt, falling back to basic Rohan prompt.");
        rohanPrompt = "You are Rohan, chill, sarcastic and supportive. Reply briefly.";
    }

    // 1. Ensure Rohan Persona exists
    let rohanPersona = await prisma.persona.findFirst({ where: { name: "Rohan" } });
    
    if (!rohanPersona) {
        rohanPersona = await prisma.persona.create({
            data: {
                name: "Rohan",
                systemPrompt: rohanPrompt,
                tone: "chill",
                style: "conversational"
            }
        });
    } else if (rohanPersona.systemPrompt !== rohanPrompt) {
        // Sync with file if it changed
        rohanPersona = await prisma.persona.update({
            where: { id: rohanPersona.id },
            data: { systemPrompt: rohanPrompt }
        });
    }

    // 2. Fetch or create Training Contact
    let contact = await prisma.contact.findUnique({
        where: { phone: TRAINING_PHONE },
        include: { persona: true }
    });

    if (!contact) {
        console.log("Creating training contact with Rohan persona...");
        contact = await prisma.contact.create({
            data: { 
                phone: TRAINING_PHONE, 
                name: "Training User",
                personaId: rohanPersona.id 
            },
            include: { persona: true }
        });
    } else if (contact.personaId !== rohanPersona.id) {
        // Ensure it uses Rohan persona
        contact = await prisma.contact.update({
            where: { id: contact.id },
            data: { personaId: rohanPersona.id },
            include: { persona: true }
        });
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

    const askQuestion = () => {
        rl.question("You: ", async (input) => {
            if (input.toLowerCase() === "exit") {
                console.log("Ending training session.");
                await prisma.$disconnect();
                process.exit(0);
            }

            if (!input.trim()) {
                askQuestion();
                return;
            }

            try {
                // 1. Log incoming message (User)
                await prisma.chat.create({
                    data: {
                        contactId: contact.id,
                        message: input,
                        direction: "INCOMING"
                    }
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

                if (aiResponse && aiResponse.text) {
                    const { text, usage } = aiResponse;
                    console.log(`\nRohan: ${text}\n`);
                    console.log(`[TOKEN CONSUMPTION] 📥 Input: ${usage.promptTokens} | 📤 Output: ${usage.completionTokens} | 📊 Total: ${usage.totalTokens}\n`);

                    // 4. Log outgoing message (AI/Rohan)
                    await prisma.chat.create({
                        data: {
                            contactId: contact.id,
                            message: text,
                            direction: "OUTGOING"
                        }
                    });
                } else {
                    console.error("AI failed to respond.");
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
    process.exit(1);
});
