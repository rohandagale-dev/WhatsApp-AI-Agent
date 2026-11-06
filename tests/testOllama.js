require('../loadEnv');
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

        // Contract: success is { ok:true, text }, failure is { ok:false, text:null, error }.
        // A truthy object alone proves nothing - it may be a failure envelope.
        if (response && response.ok && response.text) {
            console.log("\n--- Ollama Response ---");
            console.log(response.text);
            console.log("-----------------------\n");
            console.log("Usage:", response.usage);
            console.log("Test PASSED!");
        } else {
            console.error(`Test FAILED: ${(response && response.error) || 'no response received'}`);
            process.exitCode = 1;
        }
    } catch (error) {
        console.error("Test error:", error);
        process.exitCode = 1;
    }
}

testOllama();
