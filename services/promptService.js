const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function buildDynamicPrompt(contactId, latestMessageText) {
    try {
        // 1. Fetch Contact, Persona, and RelationPerson
        const contact = await prisma.contact.findUnique({
            where: { id: contactId },
            include: {
                relationPerson: true,
                persona: true
            }
        });

        if (!contact) {
            throw new Error(`Contact not found: ${contactId}`);
        }

        const relation = contact.relationPerson || {};
        const persona = contact.persona || {};

        // 2. Fetch Last 20 messages (with timestamp)
        const messages = await prisma.chat.findMany({
            where: { contactId },
            orderBy: { createdAt: "desc" },
            take: 20
        });

        // 3. Fetch Latest Insight (Summary)
        const latestInsight = await prisma.insight.findFirst({
            where: { contactId },
            orderBy: { createdAt: "desc" }
        });

        // 4. Format Components
        
        // My Persona
        const myPersona = relation.myPersona || persona.systemPrompt || "You are a helpful AI assistant.";
        
        // My Dictionary (max 100 words)
        let dictionaryText = "";
        if (relation.myDictionary) {
            const words = relation.myDictionary.split(",").map(w => w.trim());
            const cappedWords = words.slice(0, 100);
            dictionaryText = cappedWords.join(", ");
        }

        // Users' Persona
        const userPersona = relation.userPersona || contact.notes || "A WhatsApp user.";

        // Style
        const style = relation.style || persona.style || "Natural and brief.";

        // Rules
        const rules = relation.rules || "Stay in character, match the user's tone, and be helpful.";

        // Last 20 Messages with Timestamp
        // We display them in chronological order
        const history = messages.reverse().map(m => {
            const timestamp = m.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            return `[${timestamp}] ${m.direction === "INCOMING" ? "User" : "Assistant"}: ${m.message}`;
        }).join("\n");

        // 5. Assemble the prompt string in the exact order requested
        const dynamicPrompt = `
SYSTEM PROMPT

MY PERSONA:
${myPersona}

MY DICTIONARY:
${dictionaryText}

USER'S PERSONA:
${userPersona}

PREVIOUS CONVERSATION SUMMARY:
${latestInsight ? latestInsight.summary : "No long-term summary available yet."}

STYLE:
${style}

RULES:
${rules}

LAST 20 MESSAGES (HISTORY):
${history || "No previous history."}

LATEST MESSAGE (REPLY TO THIS):
${latestMessageText}
        `.trim();

        return dynamicPrompt;
    } catch (error) {
        console.error("Error building dynamic prompt:", error);
        return "You are a helpful AI assistant.";
    }
}

module.exports = { buildDynamicPrompt };
