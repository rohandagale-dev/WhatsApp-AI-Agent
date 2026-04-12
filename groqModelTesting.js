require('dotenv').config();
const { generateResponse } = require('./services/groqService');

async function testGroqModel() {
    console.log("--- Testing Groq Model Integration ---");
    
    // Simple test prompt and dummy history
    const testPrompt = "Hi, how are you?";
    const testHistory = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: testPrompt }
    ];

    console.log(`Sending prompt: "${testPrompt}"`);
    console.log(`Using model: qwen/qwen3-32b`);

    try {
        const response = await generateResponse(testPrompt, testHistory);
        
        if (response) {
            console.log("--- Model Response Received ---");
            console.log(response);
            console.log("--- Test Successful ---");
        } else {
            console.error("--- Test Failed: No response received ---");
        }
    } catch (error) {
        console.error("--- Test Failed with Error ---");
        console.error(error.message);
    }
}

testGroqModel();
