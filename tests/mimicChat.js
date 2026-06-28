require('dotenv').config();
const { supabase } = require('../services/supabaseClient');
const { generateResponse: generateGeminiResponse } = require('../services/geminiService');
const { generateResponse: generateGroqResponse } = require('../services/groqService');

async function addChatMessage(contactId, message, direction) {
    const { data } = await supabase.from('chats').insert({
        contact_id: contactId,
        message,
        direction
    }).select().single();
    return data;
}

async function getAIResponse(contact, userMessage) {
    const contextLimit = 5;
    const { data: pastChats } = await supabase.from('chats')
        .select('*')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false })
        .limit(contextLimit);

    const history = (pastChats || []).reverse().map(chat => ({
        role: chat.direction === "INCOMING" ? "user" : "assistant",
        content: chat.message
    }));

    const relation = contact.relationPerson || {};
    const systemPromptTemplate = relation.my_persona || `You are an AI WhatsApp assistant representing Rohan.

Your behavior is defined by the following persona:
- Style: ${relation.style || 'conversational'}

Core Instructions:
- Respond naturally like a human, not like an AI. No "As an AI..." crap.
- **Ultra-Concise**: Keep responses as short as possible. Use 1-3 words for simple reactions (e.g., "oh demn", "pata hain", "thnx thnx", "cool").
- **Bro-Mode**: If the user uses street slang (Hinglish/Marathi), reply in the same style. Use slang like "bhava", "lavdya", "bhai" naturally.`;

    if (history.length > 0 && history[0].role === "system") {
        history[0].content = systemPromptTemplate;
    } else {
        history.unshift({ role: "system", content: systemPromptTemplate });
    }

    const aiVersion = process.env.AI_VERSION || 'v1';
    let aiResponse;

    if (aiVersion === 'v2') {
        console.log("\n--- Sending to Groq (v2) ---");
        aiResponse = await generateGroqResponse(userMessage, history);
    } else {
        console.log("\n--- Sending to Gemini ---");
        aiResponse = await generateGeminiResponse(userMessage, history);
    }
    
    console.log(`AI Response: ${aiResponse.text || aiResponse}`);
    return aiResponse;
}

async function runScreenshotDemo() {
    const phoneNumber = "918485078050"; 
    
    let { data: contact } = await supabase.from('contacts').select('*, persona:personas(*), relationPerson:relation_persons(*)').eq('phone', phoneNumber).maybeSingle();

    if (!contact) {
        console.error("Contact not found! Run seed.js first.");
        return;
    }

    await supabase.from('chats').delete().eq('contact_id', contact.id);

    console.log(`\n=== Starting Screenshot Mimicry for ${phoneNumber} ===`);

    const sequence = [
        { dir: "INCOMING", msg: "which tool do you use to draw schema" },
        { dir: "OUTGOING", msg: "excalidraw" },
        { dir: "INCOMING", msg: "voh drawing tool he na" },
        { dir: "OUTGOING", msg: "oh wait" },
        { dir: "OUTGOING", msg: "i use miro" },
        { dir: "INCOMING", msg: "It's free right..." },
        { dir: "OUTGOING", msg: "i believe" },
        { dir: "OUTGOING", msg: "my startup added me to the team" },
        { dir: "INCOMING", msg: "Acha okay...I'll check" },
        { dir: "INCOMING", msg: "Thanks" },
        { dir: "INCOMING", msg: "are you familiar with prisma?" },
        { dir: "OUTGOING", msg: "i know about it but never used it" },
        { dir: "INCOMING", msg: "cool" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "wait actually miro is better na?";
    console.log(`\nUser: ${lastUserMessage}`);
    await addChatMessage(contact.id, lastUserMessage, "INCOMING");
    
    await getAIResponse(contact, lastUserMessage);
}

async function runShortReactionDemo() {
    const phoneNumber = "918485078050"; 
    let { data: contact } = await supabase.from('contacts').select('*, persona:personas(*), relationPerson:relation_persons(*)').eq('phone', phoneNumber).maybeSingle();

    await supabase.from('chats').delete().eq('contact_id', contact.id);

    console.log(`\n=== Starting Short Reaction Mimicry for ${phoneNumber} ===`);

    const sequence = [
        { dir: "OUTGOING", msg: "oh demn" },
        { dir: "INCOMING", msg: "Photo" },
        { dir: "OUTGOING", msg: "pata hain" },
        { dir: "INCOMING", msg: "Sahiye" },
        { dir: "INCOMING", msg: "There????" },
        { dir: "OUTGOING", msg: "yes gimme a sec" },
        { dir: "INCOMING", msg: "Arre what's app call kr" },
        { dir: "INCOMING", msg: "Ikde range nahi ahe mala" },
        { dir: "INCOMING", msg: "B-10 Sai Saiyaji Nagar, Near Service Road, Warje, Pune 411058" },
        { dir: "OUTGOING", msg: "thnx thnx" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "bro reached yet?";
    console.log(`\nUser: ${lastUserMessage}`);
    await getAIResponse(contact, lastUserMessage);
}

async function runEmotionalDemo() {
    const phoneNumber = "918485078050"; 
    let { data: contact } = await supabase.from('contacts').select('*, persona:personas(*), relationPerson:relation_persons(*)').eq('phone', phoneNumber).maybeSingle();

    await supabase.from('chats').delete().eq('contact_id', contact.id);

    console.log(`\n=== Starting Emotional/Friendship Mimicry for ${phoneNumber} ===`);

    const sequence = [
        { dir: "OUTGOING", msg: "🥺🥺" },
        { dir: "OUTGOING", msg: "Yrrr mla ek ghosht sangychiyee" },
        { dir: "OUTGOING", msg: "Tulaa" },
        { dir: "OUTGOING", msg: "Kdhi free ye tu" },
        { dir: "INCOMING", msg: "Kay scene?" },
        { dir: "OUTGOING", msg: "Call krshil" },
        { dir: "OUTGOING", msg: "Jevha ekdam free ashil" },
        { dir: "OUTGOING", msg: "Sngel m" },
        { dir: "OUTGOING", msg: "Konla ky bolu nko atach sngteyyy" },
        { dir: "INCOMING", msg: "Ha bro...me konala message pn nahi karat..." },
        { dir: "INCOMING", msg: "Krto evening la" },
        { dir: "OUTGOING", msg: "Haan chlaty" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "Kay challay mag?";
    console.log(`\nUser: ${lastUserMessage}`);
    await getAIResponse(contact, lastUserMessage);
}

async function runSlangBanterDemo() {
    const phoneNumber = "918485078050"; 
    let { data: contact } = await supabase.from('contacts').select('*, persona:personas(*), relationPerson:relation_persons(*)').eq('phone', phoneNumber).maybeSingle();

    await supabase.from('chats').delete().eq('contact_id', contact.id);

    console.log(`\n=== Starting Slang Banter Mimicry for ${phoneNumber} ===`);

    const sequence = [
        { dir: "INCOMING", msg: "No worries at all! I'm here if you ever need anything." },
        { dir: "OUTGOING", msg: "Bc kay seen yevdh ghapa ghap reply taktoy" },
        { dir: "INCOMING", msg: "Copy paste bhava" },
        { dir: "INCOMING", msg: "Gpt...." },
        { dir: "OUTGOING", msg: "Vatalch mala" },
        { dir: "INCOMING", msg: "baki kasa challay" },
        { dir: "OUTGOING", msg: "Nivant" },
        { dir: "INCOMING", msg: "sahiye bhai" },
        { dir: "INCOMING", msg: "kay plan ahe ka" },
        { dir: "OUTGOING", msg: "Tu sang" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "chalu mag kuthlo tri ek scene";
    console.log(`\nUser: ${lastUserMessage}`);
    await getAIResponse(contact, lastUserMessage);
}

async function runAllTests() {
    await runScreenshotDemo();
    await runShortReactionDemo();
    await runEmotionalDemo();
    await runSlangBanterDemo();
    process.exit(0);
}

runAllTests().catch(console.error);
