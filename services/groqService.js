const Groq = require('groq-sdk');

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

/**
 * Generates a response using Groq (v2).
 * Matches the requested style: temperature=0.8
 * 
 * @param {string} prompt - The user's prompt (final message)
 * @param {Array} history - The conversation history including system prompt
 * @returns {Promise<string>} - The generated response text
 */
async function generateResponse(prompt, history = []) {
    const API_KEY = process.env.GROQ_API_KEY;
    if (!API_KEY) {
        console.warn('Groq API Key (GROQ_API_KEY) is missing in .env');
    }

    try {
        // 1. Create a clean copy of the history
        let finalMessages = [];
        
        // If history is provided, use it. If it contains system messages, ensure they are at the start.
        if (Array.isArray(history) && history.length > 0) {
            finalMessages = [...history];
        }

        // 2. Ensure the last message has the 'user' role (Required by Groq API)
        // If the last message is from the assistant or system, or if finalMessages is empty, add the prompt as a user message.
        const lastMessage = finalMessages[finalMessages.length - 1];
        
        if (!lastMessage || lastMessage.role !== 'user') {
            finalMessages.push({
                role: 'user',
                content: prompt || "Continue the conversation based on the context above."
            });
        }

        if (process.env.DEBUG === 'true') {
            console.log("\n--- [DEBUG] FINAL GROQ API MESSAGES ---");
            console.log(JSON.stringify(finalMessages, null, 2));
            console.log("----------------------------------------\n");
        }

        const completion = await groq.chat.completions.create({
            messages: finalMessages,
            model: process.env.GROQ_MODEL || "groq/compound",
            temperature: 0.7,
            max_completion_tokens: 8192,
            top_p: 1,
            // reasoning_effort: "medium",
            stream: false, // Set to false for easier integration with the current bot flow
            stop: null
        });

        const aiText = completion.choices[0].message.content;
        const usage = completion.usage || {};
        
        console.log(`Groq responded: "${aiText.substring(0, 50)}..."`);
        
        return {
            text: aiText,
            usage: {
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0
            }
        };
    } catch (error) {
        console.error('Error generating response from Groq:', error.message);
        return {
            text: "Error generating response from Groq.",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        };
    }
}

module.exports = { generateResponse };
