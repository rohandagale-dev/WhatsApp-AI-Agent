require('./loadEnv');
const { generateResponse } = require('./services/groqService');

// The fallback services/groqService.js actually uses when GROQ_MODEL is unset.
// Keep this in sync with that file: the whole point of this script is to report
// which model answered, so a banner naming a model that was never called is
// worse than no banner at all.
const SERVICE_DEFAULT_MODEL = 'groq/compound';

function resolveModel() {
    const configured = process.env.GROQ_MODEL;
    return configured
        ? { name: configured, note: ' (from GROQ_MODEL)' }
        : { name: SERVICE_DEFAULT_MODEL, note: ' (GROQ_MODEL unset -- groqService default)' };
}

async function testGroqModel() {
    console.log("--- Testing Groq Model Integration ---");
    
    // Simple test prompt and dummy history
    const testPrompt = "Hi, how are you?";
    const testHistory = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: testPrompt }
    ];

    const model = resolveModel();

    console.log(`Sending prompt: "${testPrompt}"`);
    console.log(`Using model: ${model.name}${model.note}`);

    try {
        const response = await generateResponse(testPrompt, testHistory);

        // Contract: success is { ok:true, text }, failure is { ok:false, text:null, error }.
        if (response && response.ok && response.text) {
            console.log("--- Model Response Received ---");
            console.log(response.text);
            console.log("Usage:", response.usage);
            console.log("--- Test Successful ---");
        } else {
            console.error("--- Test Failed ---");
            console.error((response && response.error) || 'no response received');
            process.exitCode = 1;
        }
    } catch (error) {
        console.error("--- Test Failed with Error ---");
        console.error(error.message);
        process.exitCode = 1;
    }
}

testGroqModel();
