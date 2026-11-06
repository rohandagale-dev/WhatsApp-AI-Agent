/**
 * Seeds a realistic mock WhatsApp conversation so the prompt history window can
 * be exercised with lifelike content instead of numbered filler.
 *
 * Messages are grouped into themed sessions, one per day, with timestamps a few
 * minutes apart inside each session. created_at is written explicitly: the
 * DEFAULT NOW() is the transaction clock, so a batch insert would give every row
 * the same timestamp and ORDER BY created_at would tie-break arbitrarily.
 *
 * These messages are INVENTED. They are tagged source:'mock' so they can never
 * become style exemplars, but the rolling prompt history is provenance-blind by
 * design: seeding ~120 fabricated lines into a real thread becomes the entire
 * conversation the model conditions on. So --phone never defaults to a real
 * contact -- without it this writes to DEMO_PHONE, a number that is not anyone's.
 *
 *   node scripts/seedMockChats.js --list
 *   node scripts/seedMockChats.js --phone=910000000099
 *   node scripts/seedMockChats.js --phone=910000000099 --count=120 --reset
 *
 * Flags:
 *   --phone=<number>  target contact (default 910000000099, a non-real demo number)
 *   --count=<n>       how many messages to seed (default: all of them)
 *   --reset           delete this contact's existing chats/insights first
 *   --insight         also write a conversation summary row
 *   --list            print the conversation without touching the database
 */
require('../loadEnv');
const { supabase } = require('../services/supabaseClient');
const { saveMany } = require('../services/chatStore');

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// Deliberately not a real contact: a bare `npm run seed:mock` must not be able
// to pour invented messages into the live thread that holds the imported corpus.
const DEMO_PHONE = '910000000099';

const PHONE = arg('phone', DEMO_PHONE);
const PHONE_DEFAULTED = PHONE === DEMO_PHONE && !process.argv.some((a) => a.startsWith('--phone='));
const RESET = flag('reset');
const LIST_ONLY = flag('list');
const WITH_INSIGHT = flag('insight');

// Each session becomes one day of conversation. `in` = from the contact,
// `out` = from Rohan/the agent. Consecutive same-direction lines are intentional:
// real WhatsApp threads burst rather than strictly alternate.
const SESSIONS = [
    {
        topic: 'checking in',
        lines: [
            ['in', 'yo'],
            ['in', 'kya kr rha he'],
            ['out', 'kuch nahi bas'],
            ['in', 'ghar pe he?'],
            ['out', 'ha'],
            ['in', 'accha'],
            ['in', 'socha tha bahar niklenge'],
            ['out', 'aaj nahi yaar'],
            ['out', 'thoda kaam he'],
            ['in', 'okay okay'],
            ['in', 'kal dekhte he'],
            ['out', 'ha sahi hai']
        ]
    },
    {
        topic: 'college and work',
        lines: [
            ['in', 'submission ho gaya tera?'],
            ['out', 'nahi abhi tak'],
            ['in', 'bhai deadline kal he'],
            ['out', 'pata hain'],
            ['in', 'toh kr le'],
            ['out', 'raat ko baith raha hu'],
            ['in', 'tu hamesha last moment pe krta he'],
            ['out', 'wahi toh maza he'],
            ['in', 'lol'],
            ['in', 'mujhe bhi help chahiye thi thoda'],
            ['out', 'bol'],
            ['in', 'baad me batata hu']
        ]
    },
    {
        topic: 'food plans',
        lines: [
            ['in', 'lunch kya kr rha he'],
            ['out', 'ghar ka'],
            ['in', 'bahar chalein?'],
            ['out', 'kahan'],
            ['in', 'wahi usual jagah'],
            ['in', 'FC road wala'],
            ['out', 'sahi hai'],
            ['out', 'kitne baje'],
            ['in', '1 baje'],
            ['out', 'done'],
            ['in', 'late mat krna'],
            ['out', 'nahi karunga']
        ]
    },
    {
        topic: 'being unwell',
        lines: [
            ['in', 'tu aaya nahi kal'],
            ['out', 'tabiyat kharab thi'],
            ['in', 'ohh kya hua'],
            ['out', 'bas fever tha'],
            ['in', 'ab kaisa he'],
            ['out', 'better he ab'],
            ['in', 'medicine li?'],
            ['out', 'ha li'],
            ['in', 'rest kr thoda'],
            ['out', 'ha kr raha hu'],
            ['in', 'take care bhava'],
            ['out', 'thanks']
        ]
    },
    {
        topic: 'tools and tech',
        lines: [
            ['in', 'which tool do you use to draw schema'],
            ['out', 'excalidraw'],
            ['in', 'voh drawing tool he na'],
            ['out', 'oh wait'],
            ['out', 'i use miro'],
            ['in', "It's free right..."],
            ['out', 'i believe'],
            ['out', 'my startup added me to the team'],
            ['in', "Acha okay...I'll check"],
            ['in', 'Thanks'],
            ['in', 'are you familiar with prisma?'],
            ['out', 'i know about it but never used it']
        ]
    },
    {
        topic: 'weekend plan',
        lines: [
            ['in', 'weekend pe free he?'],
            ['out', 'shayad'],
            ['in', 'trek plan kr rahe he'],
            ['out', 'kahan ka'],
            ['in', 'sinhagad'],
            ['out', 'subah jaldi nikalna padega'],
            ['in', 'ha 5 baje'],
            ['out', 'itni jaldi'],
            ['in', 'warna dhoop lag jaati he'],
            ['out', 'sahi bol raha he'],
            ['out', 'chal theek he'],
            ['in', 'confirm kr dena shukrawar tak']
        ]
    },
    {
        topic: 'marathi banter',
        lines: [
            ['in', 'kay challay'],
            ['out', 'nivant'],
            ['in', 'bhetuya ka ekda'],
            ['out', 'ha chalel'],
            ['in', 'kadhi'],
            ['out', 'tu sang'],
            ['in', 'shanivari'],
            ['out', 'sahiye'],
            ['in', 'kuthe bhetayacha'],
            ['out', 'nehmichya thikani'],
            ['in', 'ok bhava'],
            ['out', 'bhetu mag']
        ]
    },
    {
        topic: 'logistics',
        lines: [
            ['in', 'address bhej de'],
            ['out', 'kis cheez ka'],
            ['in', 'ghar ka'],
            ['out', 'B-10 Sai Saiyaji Nagar, Near Service Road, Warje, Pune 411058'],
            ['in', 'got it'],
            ['in', 'nikal raha hu'],
            ['out', 'kitni der lagegi'],
            ['in', '20 min'],
            ['out', 'ok'],
            ['in', 'traffic he thoda'],
            ['out', 'aaram se aa'],
            ['in', 'ha']
        ]
    },
    {
        topic: 'movie night',
        lines: [
            ['in', 'movie dekhne chalein'],
            ['out', 'kaunsi'],
            ['in', 'nayi wali'],
            ['out', 'reviews kaise he'],
            ['in', 'decent bol rahe he'],
            ['out', 'theek he'],
            ['in', 'ticket book kru?'],
            ['out', 'ha kr de'],
            ['in', 'evening show'],
            ['out', 'sahi hai'],
            ['in', 'paisa baad me de dena'],
            ['out', 'ha ha']
        ]
    },
    {
        topic: 'late night',
        lines: [
            ['in', 'soya nahi abhi tak?'],
            ['out', 'nahi'],
            ['in', 'kya kr rha he'],
            ['out', 'kaam'],
            ['in', 'itni raat ko'],
            ['out', 'raat me focus achha hota he'],
            ['in', 'sahi bol raha he'],
            ['in', 'main bhi jaag raha hu'],
            ['out', 'so ja ab'],
            ['in', 'ha thodi der me'],
            ['out', 'gn'],
            ['in', 'gn bhava']
        ]
    }
];

const ALL = SESSIONS.flatMap((s, si) =>
    s.lines.map(([dir, msg], li) => ({ dir, msg, session: si, index: li, topic: s.topic }))
);

const COUNT = Math.min(parseInt(arg('count', String(ALL.length)), 10) || ALL.length, ALL.length);

// Builds chatStore message descriptors (not raw rows) so every seeded message
// carries metadata.source = 'mock'. This content is invented, so it must never
// be picked up as an example of how Rohan actually writes.
function buildMessages(contactId) {
    // Keep the newest messages when trimming, so the tail of the conversation
    // stays coherent rather than cutting off mid-thread.
    const chosen = ALL.slice(ALL.length - COUNT);
    const sessionCount = SESSIONS.length;
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();

    return chosen.map((m) => {
        // Session N happened (sessionCount - N) days ago, messages 3 min apart.
        const daysAgo = sessionCount - m.session;
        const at = now - daysAgo * dayMs + m.index * 3 * 60 * 1000;
        return {
            contactId,
            message: m.msg,
            direction: m.dir === 'in' ? 'INCOMING' : 'OUTGOING',
            source: 'mock',
            extra: { seed: 'seedMockChats', topic: m.topic },
            createdAt: new Date(at).toISOString()
        };
    });
}

// Returns the intended exit code (0 ok, 1 refusal) instead of calling
// process.exit(), so the caller below can let the event loop drain first.
async function main() {
    if (LIST_ONLY) {
        let current = -1;
        for (const m of ALL.slice(ALL.length - COUNT)) {
            if (m.session !== current) {
                current = m.session;
                console.log(`\n--- session ${current + 1}: ${m.topic} ---`);
            }
            console.log(`  ${m.dir === 'in' ? 'User     ' : 'Assistant'}: ${m.msg}`);
        }
        console.log(`\n${COUNT} messages across ${SESSIONS.length} sessions (nothing written).`);
        return 0;
    }

    if (PHONE_DEFAULTED) {
        console.log(`No --phone given, so writing to the demo number ${DEMO_PHONE} (not a real contact).`);
        console.log('Pass --phone=<number> to target a real contact on purpose.');
    }

    const { data: contact, error } = await supabase
        .from('contacts').select('id, phone, name').eq('phone', PHONE).maybeSingle();
    if (error) throw error;
    if (!contact) {
        console.error(`Contact ${PHONE} not found.`);
        if (PHONE_DEFAULTED) {
            console.error(`Create a contact with phone ${DEMO_PHONE} to use this default, or pass`);
            console.error('--phone=<number> for an existing contact. Use --list to preview with no DB writes.');
        } else {
            console.error("Run 'node scripts/seed.js' first, or check the number.");
        }
        return 1;
    }

    if (RESET) {
        const { count: doomedChats } = await supabase.from('chats')
            .select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);
        const { count: doomedInsights } = await supabase.from('insights')
            .select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);
        console.log(`--reset: about to permanently delete ${doomedChats || 0} message(s) and `
            + `${doomedInsights || 0} insight(s) for ${PHONE} (contact id ${contact.id})...`);

        const { data: gone, error: delError } = await supabase.from('chats')
            .delete().eq('contact_id', contact.id).select('id');
        if (delError) throw delError;
        await supabase.from('insights').delete().eq('contact_id', contact.id);
        console.log(`--reset: removed ${gone ? gone.length : 0} existing message(s).`);
    }

    // saveMany attaches metadata and throws on failure.
    const messages = buildMessages(contact.id);
    await saveMany(messages);

    if (WITH_INSIGHT) {
        await supabase.from('insights').insert({
            contact_id: contact.id,
            summary: 'Ongoing casual thread: college deadlines, food and trek plans, '
                + 'a brief illness, and tooling chat. Mostly Hinglish with some Marathi.',
            message_count: messages.length
        });
        console.log('Wrote 1 insight row.');
    }

    const { count } = await supabase.from('chats')
        .select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);

    console.log(`Seeded ${messages.length} mock messages for ${PHONE} (contact id ${contact.id}).`);
    console.log(`Contact now has ${count} messages total.`);
    return 0;
}

// Set exitCode and let the loop drain rather than calling process.exit().
// Forcing an exit while a supabase-js (undici) socket is still tearing down
// trips a libuv assertion on Windows -- "!(handle->flags & UV_HANDLE_CLOSING)"
// -- which replaces the intended exit code with a 127 crash and makes the
// "contact not found" refusal above look like the script itself blew up.
main()
    .then((code) => { process.exitCode = code || 0; })
    .catch((e) => {
        console.error('Mock seed failed:', e.message || e);
        process.exitCode = 1;
    });
