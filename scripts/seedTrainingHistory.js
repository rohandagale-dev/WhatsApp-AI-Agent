const { supabase } = require("../services/supabaseClient");
const { saveMany } = require("../services/chatStore");

const TRAINING_PHONE = "0000000000";

async function main() {
    console.log(`--- Resetting History for Training Contact (${TRAINING_PHONE}) ---`);

    const { data: contact } = await supabase.from('contacts').select('*').eq('phone', TRAINING_PHONE).maybeSingle();

    if (!contact) {
        console.error("Training contact not found. Run 'npm run train' first to create it.");
        process.exit(1);
    }

    // 1. Delete all existing chats for this contact
    const { data: deletedChats, error: deleteChatsErr } = await supabase.from('chats').delete().eq('contact_id', contact.id).select();
    if (deleteChatsErr) console.error("Error deleting chats:", deleteChatsErr);
    else console.log(`Deleted ${deletedChats ? deletedChats.length : 0} messages.`);

    // 2. Delete all existing insights for this contact
    const { data: deletedInsights, error: deleteInsightsErr } = await supabase.from('insights').delete().eq('contact_id', contact.id).select();
    if (deleteInsightsErr) console.error("Error deleting insights:", deleteInsightsErr);
    else console.log(`Deleted ${deletedInsights ? deletedInsights.length : 0} insights.`);

    // 3. (Optional) Seed with a few messages to set up a Scheduling test
    console.log("Seeding with new 'Scheduling' scenario...");
    
    // These lines are written by hand for the scheduling test, not taken from a
    // real thread, so they are 'mock': useful as conversation context but never
    // as an example of how Rohan actually writes.
    const seedMessages = [
        { message: "hi rohan", direction: "INCOMING" },
        { message: "Ha bol", direction: "OUTGOING" },
        { message: "Dinner ke liye chale saturday?", direction: "INCOMING" },
        { message: "Sahi hai, chalte hai.", direction: "OUTGOING" }
    ];

    // One batch insert shares a single transaction clock, so created_at is written
    // explicitly (a minute apart, ending now) to keep ORDER BY created_at stable.
    const startedAt = Date.now() - seedMessages.length * 60 * 1000;

    await saveMany(seedMessages.map((msg, i) => ({
        contactId: contact.id,
        message: msg.message,
        direction: msg.direction,
        source: "mock",
        extra: { seed: "seedTrainingHistory", scenario: "scheduling" },
        createdAt: new Date(startedAt + i * 60 * 1000).toISOString()
    })));

    console.log(`Seeded ${seedMessages.length} new messages.`);
    console.log("History reset complete. You can now run 'npm run train' to test the scheduling logic.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
