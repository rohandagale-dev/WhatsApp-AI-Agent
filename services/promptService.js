const { supabase } = require("./supabaseClient");

async function buildDynamicPrompt(contactId, latestMessageText) {
    try {
        // 1. Fetch Contact, Persona, and RelationPerson
        const { data: contact, error: contactError } = await supabase
            .from('contacts')
            .select('*, persona:personas(*), relationPerson:relation_persons(*)')
            .eq('id', contactId)
            .maybeSingle();

        if (contactError) {
            throw contactError;
        }

        if (!contact) {
            throw new Error(`Contact not found: ${contactId}`);
        }

        const relation = contact.relationPerson || {};
        const persona = contact.persona || {};

        // 2. Fetch Last 20 messages (with timestamp)
        const { data: messages, error: messagesError } = await supabase
            .from('chats')
            .select('*')
            .eq('contact_id', contactId)
            .order('created_at', { ascending: false })
            .limit(20);

        if (messagesError) {
            throw messagesError;
        }

        // 3. Fetch Latest Insight (Summary)
        const { data: insights, error: insightsError } = await supabase
            .from('insights')
            .select('*')
            .eq('contact_id', contactId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (insightsError) {
            throw insightsError;
        }

        const latestInsight = insights && insights.length > 0 ? insights[0] : null;

        // 4. Format Components

        // My Persona
        const myPersona = relation.my_persona || "You are Rohan, chill, sarcastic and supportive. Reply briefly.";

        // My Dictionary (max 100 words)
        let dictionaryText = "";
        if (relation.my_dictionary) {
            const words = relation.my_dictionary.split(",").map(w => w.trim());
            const cappedWords = words.slice(0, 100);
            dictionaryText = cappedWords.join(", ");
        }

        // Users' Persona
        const userPersona = relation.user_persona || contact.notes || "A WhatsApp user.";

        // Style
        const style = relation.style || "Natural and brief.";

        // Rules
        const rules = relation.rules || "Stay in character, match the user's tone, and be helpful.";

        // Last 20 Messages with Timestamp
        // We display them in chronological order
        const history = (messages || []).reverse().map(m => {
            const dateObj = new Date(m.created_at);
            const timestamp = dateObj.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
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
