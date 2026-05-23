const { supabase } = require("../services/supabaseClient");

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
    
    const seedMessages = [
        { message: "hi rohan", direction: "INCOMING" },
        { message: "Ha bol", direction: "OUTGOING" },
        { message: "Dinner ke liye chale saturday?", direction: "INCOMING" },
        { message: "Sahi hai, chalte hai.", direction: "OUTGOING" }
    ];

    for (const msg of seedMessages) {
        await supabase.from('chats').insert({
            contact_id: contact.id,
            message: msg.message,
            direction: msg.direction
        });
    }

    console.log("Seeded 4 new messages.");
    console.log("History reset complete. You can now run 'npm run train' to test the scheduling logic.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
