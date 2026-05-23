const { supabase } = require("./supabaseClient");
const readline = require("readline");
require("dotenv").config();

const { buildDynamicPrompt } = require("./promptService");
const { generateResponse: generateGroqResponse } = require("./groqService");
const { generateResponse: generateGeminiResponse } = require("./geminiService");
const { generateResponse: generateOllamaResponse } = require("./ollamaService");

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
    let { data: rohanPersonas } = await supabase.from('personas').select('*').eq('name', 'Rohan').limit(1);
    let rohanPersona = rohanPersonas && rohanPersonas.length > 0 ? rohanPersonas[0] : null;
    
    if (!rohanPersona) {
        const { data: newPersona } = await supabase.from('personas').insert({
            name: "Rohan",
            system_prompt: rohanPrompt,
            tone: "chill",
            style: "conversational"
        }).select().single();
        rohanPersona = newPersona;
    } else if (rohanPersona.system_prompt !== rohanPrompt) {
        // Sync with file if it changed
        const { data: updatedPersona } = await supabase.from('personas').update({
            system_prompt: rohanPrompt
        }).eq('id', rohanPersona.id).select().single();
        rohanPersona = updatedPersona;
    }

    // 2. Fetch or create Training Contact
    let { data: contact } = await supabase.from('contacts').select('*, persona:personas(*)').eq('phone', TRAINING_PHONE).maybeSingle();

    if (!contact) {
        console.log("Creating training contact with Rohan persona...");
        const { data: newContact } = await supabase.from('contacts').insert({
            phone: TRAINING_PHONE, 
            name: "Training User",
            persona_id: rohanPersona.id 
        }).select('*, persona:personas(*)').single();
        contact = newContact;
    } else if (contact.persona_id !== rohanPersona.id) {
        // Ensure it uses Rohan persona
        const { data: updatedContact } = await supabase.from('contacts').update({
            persona_id: rohanPersona.id
        }).eq('id', contact.id).select('*, persona:personas(*)').single();
        contact = updatedContact;
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
                process.exit(0);
            }

            if (!input.trim()) {
                askQuestion();
                return;
            }

            try {
                // 1. Log incoming message (User)
                await supabase.from('chats').insert({
                    contact_id: contact.id,
                    message: input,
                    direction: "INCOMING"
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
                    await supabase.from('chats').insert({
                        contact_id: contact.id,
                        message: text,
                        direction: "OUTGOING"
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
