const { buildDynamicPrompt } = require("../services/promptService");
const { supabase } = require("../services/supabaseClient");
const { saveMany } = require("../services/chatStore");

async function test() {
    console.log("--- Testing Dynamic Prompt Builder ---");

    // 1. Get or create a test contact
    let { data: contact } = await supabase.from('contacts').select('*, relationPerson:relation_persons(*)').eq('phone', "911234567890").maybeSingle();

    if (!contact) {
        // Create a persona first if not exists
        let { data: personas } = await supabase.from('personas').select('*').eq('name', 'Default').limit(1);
        let persona = personas && personas.length > 0 ? personas[0] : null;

        if (!persona) {
            const { data: newPersona } = await supabase.from('personas').insert({
                name: "Default", system_prompt: "Basic Assistant"
            }).select().single();
            persona = newPersona;
        }

        const { data: newContact } = await supabase.from('contacts').insert({
            phone: "911234567890", 
            name: "Test User",
            persona_id: persona.id 
        }).select().single();
        contact = newContact;
    }

    // 2. Upsert RelationPerson
    await supabase.from('relation_persons').upsert({
        contact_id: contact.id,
        my_persona: "I am a space pirate bot named Sparky.",
        my_dictionary: "Ahoy, Matey, Anchor, Rum, Parrot, Space, Star, Galaxy",
        user_persona: "A curious traveler from Earth.",
        style: "Talk like a pirate in space.",
        rules: "1. Always use pirate slang. 2. Be slightly rude but helpful."
    }, { onConflict: 'contact_id' });

    // 3. Add some dummy chat history
    const { count: existingChats } = await supabase.from('chats').select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);

    if (existingChats < 2) {
        // Invented pirate filler for the prompt builder: 'mock', never a style exemplar.
        // created_at is explicit because one batch insert would otherwise give both
        // rows the same transaction clock and leave their order undefined.
        const startedAt = Date.now() - 2 * 60 * 1000;
        await saveMany([
            { message: "Hello Sparky!", direction: "INCOMING" },
            { message: "Ahoy! What brings ye to this sector?", direction: "OUTGOING" }
        ].map((msg, i) => ({
            contactId: contact.id,
            message: msg.message,
            direction: msg.direction,
            source: 'mock',
            extra: { seed: 'testDynamicPrompt' },
            createdAt: new Date(startedAt + i * 60 * 1000).toISOString()
        })));
    }

    // 4. Build Dynamic Prompt
    const latestMessage = "Tell me about the galaxy.";
    const result = await buildDynamicPrompt(contact.id, latestMessage);

    console.log("GENERATED PROMPT BEGIN:");
    console.log("-----------------------------------------");
    console.log(result);
    console.log("-----------------------------------------");
    console.log("GENERATED PROMPT END");

    process.exit(0);
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
