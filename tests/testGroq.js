require('../loadEnv');
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

        // Contract: success is { ok:true, text }, failure is { ok:false, text:null, error }.
        if (response && response.ok && response.text) {
            console.log("\n--- Groq Response ---");
            console.log(response.text);
            console.log("---------------------");
            console.log("Usage:", response.usage);
            console.log("Test PASSED!");
        } else {
            console.error(`Test FAILED: ${(response && response.error) || 'no response from provider'}`);
            process.exitCode = 1;
        }
    } catch (error) {
        console.error("Test failed:", error);
        process.exitCode = 1;
    }
}

testGroq();
