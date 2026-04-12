const axios = require('axios');

/**
 * Generates a response using a local Ollama instance.
 * 
 * @param {string} prompt - The user's prompt (final message)
 * @param {Array} history - The conversation history including system prompt
 * @returns {Promise<string>} - The generated response text
 */
async function generateResponse(prompt, history = []) {
    const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

    try {
        console.log(`[Ollama] Requesting response from model: ${OLLAMA_MODEL}`);
        
        // Ollama /api/chat expects messages in { role, content } format
        // history already contains messages in this format
        const messages = [...history];

        // Ensure the last message is a user prompt if provided
        if (prompt && (!messages.length || messages[messages.length - 1].role !== 'user')) {
            messages.push({ role: 'user', content: prompt });
        }

        const payload = {
            model: OLLAMA_MODEL,
            messages: messages,
            stream: false,
            options: {
                temperature: 0.7,
            }
        };

        const response = await axios.post(`${OLLAMA_HOST}/api/chat`, payload);

        if (response.data && response.data.message) {
            const aiText = response.data.message.content;
            const promptTokens = response.data.prompt_eval_count || 0;
            const completionTokens = response.data.eval_count || 0;
            const totalTokens = promptTokens + completionTokens;

            console.log(`Ollama responded: "${aiText.substring(0, 50)}..."`);
            
            return {
                text: aiText,
                usage: {
                    promptTokens,
                    completionTokens,
                    totalTokens
                }
            };
        } else {
            console.error('Unexpected response format from Ollama:', response.data);
            return {
                text: "Unexpected response format from Ollama.",
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
            };
        }
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error(`Error: Could not connect to Ollama at ${OLLAMA_HOST}. Is it running?`);
        } else {
            console.error('Error generating response from Ollama:', error.response ? error.response.data : error.message);
        }
        return {
            text: "Error generating response from Ollama.",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        };
    }
}

module.exports = { generateResponse };
