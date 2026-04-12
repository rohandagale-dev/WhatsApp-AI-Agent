const { buildDynamicPrompt } = require("../services/promptService");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function test() {
    console.log("--- Testing Dynamic Prompt Builder ---");

    // 1. Get or create a test contact
    let contact = await prisma.contact.findFirst({
        where: { phone: "911234567890" },
        include: { relationPerson: true }
    });

    if (!contact) {
        // Create a persona first if not exists
        let persona = await prisma.persona.findFirst({ where: { name: "Default" } });
        if (!persona) {
            persona = await prisma.persona.create({
                data: { name: "Default", systemPrompt: "Basic Assistant" }
            });
        }

        contact = await prisma.contact.create({
            data: { 
                phone: "911234567890", 
                name: "Test User",
                personaId: persona.id 
            }
        });
    }

    // 2. Upsert RelationPerson
    await prisma.relationPerson.upsert({
        where: { contactId: contact.id },
        update: {
            myPersona: "I am a space pirate bot named Sparky.",
            myDictionary: "Ahoy, Matey, Anchor, Rum, Parrot, Space, Star, Galaxy",
            userPersona: "A curious traveler from Earth.",
            style: "Talk like a pirate in space.",
            rules: "1. Always use pirate slang. 2. Be slightly rude but helpful."
        },
        create: {
            contactId: contact.id,
            myPersona: "I am a space pirate bot named Sparky.",
            myDictionary: "Ahoy, Matey, Anchor, Rum, Parrot, Space, Star, Galaxy",
            userPersona: "A curious traveler from Earth.",
            style: "Talk like a pirate in space.",
            rules: "1. Always use pirate slang. 2. Be slightly rude but helpful."
        }
    });

    // 3. Add some dummy chat history
    const existingChats = await prisma.chat.count({ where: { contactId: contact.id } });
    if (existingChats < 2) {
        await prisma.chat.create({
            data: { contactId: contact.id, message: "Hello Sparky!", direction: "INCOMING" }
        });
        await prisma.chat.create({
            data: { contactId: contact.id, message: "Ahoy! What brings ye to this sector?", direction: "OUTGOING" }
        });
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
