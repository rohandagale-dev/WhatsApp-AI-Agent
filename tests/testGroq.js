require('dotenv').config();
const { generateResponse } = require('../services/groqService');

async function testGroq() {
    console.log("Testing Groq Service...");
    const prompt = "Hello, who are you?";
    const history = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt }
    ];

    try {
        const response = await generateResponse(prompt, history);
        console.log("Response:", response);
    } catch (error) {
        console.error("Test failed:", error);
    }
}

testGroq();
