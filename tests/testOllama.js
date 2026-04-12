require('dotenv').config();
const { generateResponse } = require('../services/ollamaService');

async function testOllama() {
    console.log("Testing Ollama Service...");
    const prompt = "Hello, who are you? Please keep it very short.";
    const history = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt }
    ];

    try {
        const response = await generateResponse(prompt, history);
        if (response) {
            console.log("\n--- Ollama Response ---");
            console.log(response);
            console.log("-----------------------\n");
            console.log("Test PASSED!");
        } else {
            console.error("Test FAILED: No response received.");
        }
    } catch (error) {
        console.error("Test error:", error);
    }
}

testOllama();
