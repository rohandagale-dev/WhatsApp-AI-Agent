const axios = require('axios');

const API_KEY = process.env.GEMINI_API_KEY;
const model  = process.env.GEMINI_MODEL;

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

async function generateResponse(prompt) {
    if (!API_KEY) {
        console.warn('something went wrong with API key');
    }

    try {
        const response = await axios.post(GEMINI_URL, {
            contents: [{
                parts: [{
                    text: prompt
                }]
            }]
        });

        const aiText = response.data.candidates[0].content.parts[0].text;
        console.log(`Gemini responded: "${aiText.substring(0, 50)}..."`);
        return aiText;
    } catch (error) {
        console.error('Error generating response from Gemini:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        return;
    }
}

module.exports = { generateResponse };

