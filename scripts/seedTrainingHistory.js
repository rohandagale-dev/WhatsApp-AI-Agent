const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TRAINING_PHONE = "0000000000";

async function main() {
    console.log(`--- Resetting History for Training Contact (${TRAINING_PHONE}) ---`);

    const contact = await prisma.contact.findUnique({
        where: { phone: TRAINING_PHONE }
    });

    if (!contact) {
        console.error("Training contact not found. Run 'npm run train' first to create it.");
        process.exit(1);
    }

    // 1. Delete all existing chats for this contact
    const deletedChats = await prisma.chat.deleteMany({
        where: { contactId: contact.id }
    });
    console.log(`Deleted ${deletedChats.count} messages.`);

    // 2. Delete all existing insights for this contact
    const deletedInsights = await prisma.insight.deleteMany({
        where: { contactId: contact.id }
    });
    console.log(`Deleted ${deletedInsights.count} insights.`);

    // 3. (Optional) Seed with a few messages to set up a Scheduling test
    console.log("Seeding with new 'Scheduling' scenario...");
    
    const seedMessages = [
        { message: "hi rohan", direction: "INCOMING" },
        { message: "Ha bol", direction: "OUTGOING" },
        { message: "Dinner ke liye chale saturday?", direction: "INCOMING" },
        { message: "Sahi hai, chalte hai.", direction: "OUTGOING" }
    ];

    for (const msg of seedMessages) {
        await prisma.chat.create({
            data: {
                contactId: contact.id,
                message: msg.message,
                direction: msg.direction,
                createdAt: new Date()
            }
        });
    }

    console.log("Seeded 4 new messages.");
    console.log("History reset complete. You can now run 'npm run train' to test the scheduling logic.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
