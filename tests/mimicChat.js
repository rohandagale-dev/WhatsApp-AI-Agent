/**
 * Scripted mimicry demos: replays a few short conversations into a contact's
 * thread and asks the live provider for the next reply.
 *
 * Every line below is INVENTED. The rows are tagged source:'mock' so they can
 * never become style exemplars -- but the rolling prompt history is
 * provenance-blind by design (see CONTRACT 4 in services/promptService.js), so
 * the ~46 scripted lines these demos APPEND become roughly the newest half of
 * whatever the live agent reads back as context for that contact. On a real
 * thread that means replying to a real person out of a fabricated conversation.
 *
 * So --phone never defaults to a real contact. Without it everything is written
 * to DEMO_PHONE, a number that is nobody's, created on first run if missing.
 * Aiming the demos at any other number is a deliberate act and needs
 * --allow-real; deleting anything additionally needs --reset.
 *
 *   node tests/mimicChat.js                     # demo contact, append (safe)
 *   node tests/mimicChat.js --reset             # wipe the DEMO thread, then seed
 *   node tests/mimicChat.js --phone=<n> --allow-real
 *                                               # DANGEROUS: write to a real thread
 */
require('../loadEnv');
const { supabase } = require('../services/supabaseClient');
const { loadSystemPrompt } = require('../services/systemPrompt');
const { generateResponse: generateGeminiResponse } = require('../services/geminiService');
const { generateResponse: generateGroqResponse } = require('../services/groqService');
const { saveMessage } = require('../services/chatStore');

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// Deliberately not a real contact: a bare `node tests/mimicChat.js` must not be
// able to pour scripted lines into a live thread. Kept distinct from
// scripts/seedMockChats.js's 910000000099 so the two demo corpora do not
// interleave inside one history window.
const DEMO_PHONE = '910000000098';
// Numbers known to belong to nobody: these skip the --allow-real gate AND are
// created on demand by resolveContact(). Anything else is assumed to be a real
// contact -- it needs --allow-real and is never auto-created.
// ('910000000099' is scripts/seedMockChats.js's demo number.)
const DEMO_PHONES = new Set([DEMO_PHONE, '910000000099']);

const PHONE = arg('phone', DEMO_PHONE);
const RESET = flag('reset');
const ALLOW_REAL = flag('allow-real');
const TARGET_IS_DEMO = DEMO_PHONES.has(PHONE);

/**
 * Gate on writing to anything that is not a known demo number.
 *
 * Tagging these rows source:'mock' protects the exemplar pool only. The history
 * window is provenance-blind, so appending here still changes what the live
 * model conditions on for this contact -- which is exactly why the default
 * target must never be a real person.
 */
function targetAllowed() {
    if (TARGET_IS_DEMO || ALLOW_REAL) return true;
    console.error(`Refusing to write scripted demo messages to ${PHONE}: not a known demo number.`);
    console.error('        These demos APPEND ~46 invented lines, and the prompt history window is');
    console.error('        provenance-blind -- on a real thread they become most of the context the');
    console.error('        live agent replies from.');
    console.error(`        Run without --phone to use the demo contact ${DEMO_PHONE} (created if missing),`);
    console.error('        or add --allow-real if you really do mean to write to this contact.');
    return false;
}

// Every line in these demos is scripted for the test, not lifted from a real
// thread, so it is stored as 'mock' and stays out of the style exemplar pool.
async function addChatMessage(contactId, message, direction) {
    return saveMessage({
        contactId,
        message,
        direction,
        source: 'mock',
        extra: { seed: 'mimicChat' }
    });
}

async function loadContact(phone) {
    const { data: contact, error } = await supabase
        .from('contacts')
        .select('*, persona:personas(*), relationPerson:relation_persons(*)')
        .eq('phone', phone)
        .maybeSingle();
    if (error) throw error;
    return contact || null;
}

/**
 * Returns the contact to run against, creating it on first use when -- and only
 * when -- the number is on the DEMO_PHONES whitelist.
 *
 * Auto-creation is keyed off the same whitelist that waives --allow-real, not
 * off DEMO_PHONE alone: a number this script is willing to write to unprompted
 * is exactly a number it should be willing to create. Keying the two off
 * different sets is what stranded 910000000099 -- whitelisted, so it skipped the
 * --allow-real gate, but not auto-created, so it died pointing at
 * scripts/seed.js, which only ever creates the four real contacts.
 *
 * Any number NOT on the whitelist is assumed to be a real person: it is never
 * created here, because inventing a contacts row for a real number is worse
 * than refusing.
 */
async function resolveContact() {
    const existing = await loadContact(PHONE);
    if (existing) return existing;

    if (!TARGET_IS_DEMO) {
        console.error(`Contact ${PHONE} not found, and this script only ever creates demo numbers.`);
        console.error('        Insert the contacts row yourself if that number is real -- note that');
        console.error("        'node scripts/seed.js' seeds its own four fixed contacts and will NOT");
        console.error(`        create ${PHONE}.`);
        console.error(`        Drop --phone to run the demos against ${DEMO_PHONE}, which this script creates for you.`);
        return null;
    }

    const { error } = await supabase.from('contacts').insert({
        phone: PHONE,
        name: `Mimic Demo ${PHONE} (not a real contact)`,
        notes: 'Scratch contact for tests/mimicChat.js. Scripted mock messages only.'
    });
    if (error) throw error;
    console.log(`Created demo contact ${PHONE} -- nothing real lives on this thread.`);

    const created = await loadContact(PHONE);
    if (created) await seedDemoPersona(created);
    return created;
}

/**
 * Gives a freshly created demo contact the same persona the live agent uses.
 *
 * Without a relation_persons row getAIResponse falls back to its inline prompt,
 * so the demo would exercise a persona that exists nowhere else and the replies
 * would not reflect what production actually sends. Loading the configured
 * system_prompts file keeps the mock faithful to the real thing.
 */
async function seedDemoPersona(contact) {
    const { text, version } = loadSystemPrompt();
    const { error } = await supabase.from('relation_persons').upsert({
        contact_id: contact.id,
        my_persona: text,
        my_dictionary: 'bhava, lavdya, bhai, nivant, sahiye, pata hain, kay scene',
        user_persona: 'A close friend texting in Hinglish and Marathi.',
        // style / rules stay NULL: the prompt file above carries its own
        // "## Style" and "## Rules", and duplicating them puts two competing
        // rule sets in one prompt.
        style: null,
        rules: null
    }, { onConflict: 'contact_id' });
    if (error) throw error;
    console.log(`Demo persona set from system_prompt_${version}.txt.`);
}

async function countMessages(contactId) {
    const { count, error } = await supabase.from('chats')
        .select('*', { count: 'exact', head: true }).eq('contact_id', contactId);
    if (error) throw error;
    return count || 0;
}

/**
 * Clears the thread ONLY when --reset was explicitly passed, and says how many
 * rows are going before it touches anything. Without the flag this is a no-op,
 * so a stray demo run can never wipe an imported corpus.
 */
async function resetThread(contact) {
    if (!RESET) return;
    const existing = await countMessages(contact.id);
    const kind = TARGET_IS_DEMO ? 'demo contact' : 'REAL contact';
    console.log(`--reset: about to delete ${existing} message(s) for ${kind} ${contact.phone} (contact id ${contact.id})...`);
    const { data: gone, error } = await supabase.from('chats')
        .delete().eq('contact_id', contact.id).select('id');
    if (error) throw error;
    console.log(`--reset: deleted ${gone ? gone.length : 0} message(s).`);
}

async function getAIResponse(contact, userMessage) {
    const contextLimit = 5;
    const { data: pastChats } = await supabase.from('chats')
        .select('*')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false })
        .limit(contextLimit);

    const history = (pastChats || []).reverse().map(chat => ({
        role: chat.direction === "INCOMING" ? "user" : "assistant",
        content: chat.message
    }));

    const relation = contact.relationPerson || {};
    const systemPromptTemplate = relation.my_persona || `You are an AI WhatsApp assistant representing Rohan.

Your behavior is defined by the following persona:
- Style: ${relation.style || 'conversational'}

Core Instructions:
- Respond naturally like a human, not like an AI. No "As an AI..." crap.
- **Ultra-Concise**: Keep responses as short as possible. Use 1-3 words for simple reactions (e.g., "oh demn", "pata hain", "thnx thnx", "cool").
- **Bro-Mode**: If the user uses street slang (Hinglish/Marathi), reply in the same style. Use slang like "bhava", "lavdya", "bhai" naturally.`;

    if (history.length > 0 && history[0].role === "system") {
        history[0].content = systemPromptTemplate;
    } else {
        history.unshift({ role: "system", content: systemPromptTemplate });
    }

    const aiVersion = process.env.AI_VERSION || 'v1';
    let aiResponse;

    if (aiVersion === 'v2') {
        console.log("\n--- Sending to Groq (v2) ---");
        aiResponse = await generateGroqResponse(userMessage, history);
    } else {
        console.log("\n--- Sending to Gemini ---");
        aiResponse = await generateGeminiResponse(userMessage, history);
    }

    // On failure the provider returns { ok:false, text:null, error } - print the
    // error instead of pretending it was a reply.
    if (aiResponse && aiResponse.ok && aiResponse.text) {
        console.log(`AI Response: ${aiResponse.text}`);
    } else {
        console.error(`AI failed: ${(aiResponse && aiResponse.error) || 'no response from provider'}`);
    }

    return aiResponse;
}

async function runScreenshotDemo(contact) {
    await resetThread(contact);

    console.log(`\n=== Starting Screenshot Mimicry for ${contact.phone} ===`);

    const sequence = [
        { dir: "INCOMING", msg: "which tool do you use to draw schema" },
        { dir: "OUTGOING", msg: "excalidraw" },
        { dir: "INCOMING", msg: "voh drawing tool he na" },
        { dir: "OUTGOING", msg: "oh wait" },
        { dir: "OUTGOING", msg: "i use miro" },
        { dir: "INCOMING", msg: "It's free right..." },
        { dir: "OUTGOING", msg: "i believe" },
        { dir: "OUTGOING", msg: "my startup added me to the team" },
        { dir: "INCOMING", msg: "Acha okay...I'll check" },
        { dir: "INCOMING", msg: "Thanks" },
        { dir: "INCOMING", msg: "are you familiar with prisma?" },
        { dir: "OUTGOING", msg: "i know about it but never used it" },
        { dir: "INCOMING", msg: "cool" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "wait actually miro is better na?";
    console.log(`\nUser: ${lastUserMessage}`);
    await addChatMessage(contact.id, lastUserMessage, "INCOMING");
    
    await getAIResponse(contact, lastUserMessage);
}

async function runShortReactionDemo(contact) {
    await resetThread(contact);

    console.log(`\n=== Starting Short Reaction Mimicry for ${contact.phone} ===`);

    const sequence = [
        { dir: "OUTGOING", msg: "oh demn" },
        { dir: "INCOMING", msg: "Photo" },
        { dir: "OUTGOING", msg: "pata hain" },
        { dir: "INCOMING", msg: "Sahiye" },
        { dir: "INCOMING", msg: "There????" },
        { dir: "OUTGOING", msg: "yes gimme a sec" },
        { dir: "INCOMING", msg: "Arre what's app call kr" },
        { dir: "INCOMING", msg: "Ikde range nahi ahe mala" },
        { dir: "INCOMING", msg: "B-10 Sai Saiyaji Nagar, Near Service Road, Warje, Pune 411058" },
        { dir: "OUTGOING", msg: "thnx thnx" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "bro reached yet?";
    console.log(`\nUser: ${lastUserMessage}`);
    await getAIResponse(contact, lastUserMessage);
}

async function runEmotionalDemo(contact) {
    await resetThread(contact);

    console.log(`\n=== Starting Emotional/Friendship Mimicry for ${contact.phone} ===`);

    const sequence = [
        { dir: "OUTGOING", msg: "🥺🥺" },
        { dir: "OUTGOING", msg: "Yrrr mla ek ghosht sangychiyee" },
        { dir: "OUTGOING", msg: "Tulaa" },
        { dir: "OUTGOING", msg: "Kdhi free ye tu" },
        { dir: "INCOMING", msg: "Kay scene?" },
        { dir: "OUTGOING", msg: "Call krshil" },
        { dir: "OUTGOING", msg: "Jevha ekdam free ashil" },
        { dir: "OUTGOING", msg: "Sngel m" },
        { dir: "OUTGOING", msg: "Konla ky bolu nko atach sngteyyy" },
        { dir: "INCOMING", msg: "Ha bro...me konala message pn nahi karat..." },
        { dir: "INCOMING", msg: "Krto evening la" },
        { dir: "OUTGOING", msg: "Haan chlaty" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "Kay challay mag?";
    console.log(`\nUser: ${lastUserMessage}`);
    await getAIResponse(contact, lastUserMessage);
}

async function runSlangBanterDemo(contact) {
    await resetThread(contact);

    console.log(`\n=== Starting Slang Banter Mimicry for ${contact.phone} ===`);

    const sequence = [
        { dir: "INCOMING", msg: "No worries at all! I'm here if you ever need anything." },
        { dir: "OUTGOING", msg: "Bc kay seen yevdh ghapa ghap reply taktoy" },
        { dir: "INCOMING", msg: "Copy paste bhava" },
        { dir: "INCOMING", msg: "Gpt...." },
        { dir: "OUTGOING", msg: "Vatalch mala" },
        { dir: "INCOMING", msg: "baki kasa challay" },
        { dir: "OUTGOING", msg: "Nivant" },
        { dir: "INCOMING", msg: "sahiye bhai" },
        { dir: "INCOMING", msg: "kay plan ahe ka" },
        { dir: "OUTGOING", msg: "Tu sang" }
    ];

    for (const step of sequence) {
        console.log(`${step.dir === "INCOMING" ? "User" : "AI"}: ${step.msg}`);
        await addChatMessage(contact.id, step.msg, step.dir);
    }

    const lastUserMessage = "chalu mag kuthlo tri ek scene";
    console.log(`\nUser: ${lastUserMessage}`);
    await getAIResponse(contact, lastUserMessage);
}

// Returns the intended exit code (0 ok, 1 refusal) instead of calling
// process.exit(), so the caller below can let the event loop drain first.
async function runAllTests() {
    if (!targetAllowed()) return 1;

    const contact = await resolveContact();
    if (!contact) return 1;

    const existing = await countMessages(contact.id);
    const kind = TARGET_IS_DEMO ? 'demo contact' : 'REAL contact';

    if (!TARGET_IS_DEMO) {
        console.log(`--allow-real: writing scripted demo messages into REAL contact ${contact.phone}.`);
        console.log('        These rows stay out of the exemplar pool, but they DO enter the prompt');
        console.log("        history window this contact's live replies are generated from.");
    }

    if (RESET) {
        console.log(`--reset passed: every demo below DELETES all ${existing} chat row(s) of `
            + `${kind} ${contact.phone} (contact id ${contact.id}) before seeding its script.`);
        if (!TARGET_IS_DEMO) {
            console.log('        This permanently destroys any imported real messages on this thread.');
        }
    } else {
        console.log(`Appending scripted demo messages to ${kind} ${contact.phone} (contact id ${contact.id}).`);
        console.log(`        ${existing} existing message(s) are left untouched. Pass --reset to wipe the`);
        console.log('        thread first -- that permanently deletes everything already stored on it.');
    }

    await runScreenshotDemo(contact);
    await runShortReactionDemo(contact);
    await runEmotionalDemo(contact);
    await runSlangBanterDemo(contact);
    return 0;
}

// Set exitCode and let the loop drain rather than calling process.exit().
// Forcing an exit while a supabase-js / provider (undici) socket is still
// tearing down trips a libuv assertion on Windows --
// "!(handle->flags & UV_HANDLE_CLOSING)" -- which replaces the intended exit
// code with a 127 crash, so both the refusals above and a clean success run
// look like the script itself blew up.
//
// Nothing here holds the loop open indefinitely: the only lingering handles are
// pooled keep-alive sockets, which expire on their own a few seconds after the
// last request, so the process still exits on its own after the final demo.
runAllTests()
    .then((code) => { process.exitCode = code || 0; })
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    });
