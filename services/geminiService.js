const axios = require('axios');

const API_KEY = process.env.GEMINI_API_KEY;
const model  = "gemini-2.5-flash"

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

async function generateResponse(prompt, history = []) {
    if (!API_KEY) {
        console.warn('something went wrong with API key');
    }

    // 1. Extract system prompt and filter history
    const systemMessage = history.find(m => m.role === "system");
    const systemPrompt = systemMessage ? systemMessage.content : "You are a helpful assistant.";
    
    const chatHistory = history.filter(m => m.role !== "system");

    // 2. Map and merge consecutive messages with the same role for Gemini API compatibility
    const contents = [];
    chatHistory.forEach((m) => {
        const role = m.role === "assistant" ? "model" : "user";
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
            // Append to the last message's parts
            contents[contents.length - 1].parts[0].text += `\n${m.content}`;
        } else {
            // Add a new message entry
            contents.push({
                role: role,
                parts: [{ text: m.content }]
            });
        }
    });

    // If history is empty OR the last role is model, we need to ensure the turn starts/ends correctly
    // or just ensure we have at least one user message if no history exists.
    if (contents.length === 0) {
        contents.push({
            role: "user",
            parts: [{ text: prompt }]
        });
    }

    try {
        const payload = {
            system_instruction: {
                parts: [{ text: systemPrompt }]
            },
            contents: contents
        };
        
        console.log("--- Gemini API Payload ---");
        console.log(JSON.stringify(payload, null, 2));
        console.log("--------------------------");

        const response = await axios.post(GEMINI_URL, payload);

        const aiText = response.data.candidates[0].content.parts[0].text;
        const usage = response.data.usageMetadata || {};

        console.log(`Gemini responded: "${aiText.substring(0, 50)}..."`);
        
        return {
            text: aiText,
            usage: {
                promptTokens: usage.promptTokenCount || 0,
                completionTokens: usage.candidatesTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0
            }
        };
    } catch (error) {
        console.error('Error generating response from Gemini:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        return {
            text: "Error generating response from Gemini.",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        };
    }
}

module.exports = { generateResponse };

