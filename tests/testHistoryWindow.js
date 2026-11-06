/**
 * Mimics the production prompt path against a full conversation history.
 *
 * services/promptService.js feeds the model only the newest HISTORY_LIMIT messages. This test
 * seeds more than 20, calls the real buildDynamicPrompt(), and asserts the window
 * slides correctly: exactly 20 messages, the newest ones, oldest-first.
 *
 * Timestamps are written explicitly because `created_at DEFAULT NOW()` uses the
 * transaction clock -- messages inserted in one batch share a timestamp and the
 * ORDER BY would then tie-break arbitrarily.
 *
 *   node tests/testHistoryWindow.js          # run and clean up
 *   node tests/testHistoryWindow.js --keep   # leave seeded rows in place
 */
require('../loadEnv');
const { supabase } = require('../services/supabaseClient');
const { saveMany } = require('../services/chatStore');
const { buildDynamicPrompt, HISTORY_LIMIT } = require('../services/promptService');

const TEST_PHONE = '919999999999';
const WINDOW = HISTORY_LIMIT;        // derived, so the test tracks the service
const SEED_COUNT = HISTORY_LIMIT + 10;   // deliberately overflow the window
const KEEP = process.argv.includes('--keep');

const LATEST_MESSAGE = 'and what did I say at the very start?';
const INSIGHT_SUMMARY = 'Rohan and the contact have been counting test messages together.';

// Pad to the width of the largest label so msg-10 cannot substring-match msg-100.
const PAD = String(SEED_COUNT).length;
const label = (i) => `msg-${String(i + 1).padStart(PAD, '0')}`;
const directionFor = (i) => (i % 2 === 0 ? 'INCOMING' : 'OUTGOING');
const speakerFor = (i) => (directionFor(i) === 'INCOMING' ? 'User' : 'Assistant');

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    let line = `${pass ? '  PASS' : '  FAIL'}  ${name}`;
    if (!pass && detail) line += `\n        ${detail}`;
    console.log(line);
}

async function setupContact() {
    let { data: personas } = await supabase.from('personas').select('*').eq('name', 'Default').limit(1);
    let persona = personas && personas.length ? personas[0] : null;
    if (!persona) {
        const { data } = await supabase.from('personas').insert({ name: 'Default' }).select().single();
        persona = data;
    }

    let { data: contact } = await supabase.from('contacts').select('*').eq('phone', TEST_PHONE).maybeSingle();
    if (!contact) {
        const { data } = await supabase.from('contacts')
            .insert({ phone: TEST_PHONE, name: 'History Window Test', persona_id: persona.id })
            .select().single();
        contact = data;
    }

    await supabase.from('relation_persons').upsert({
        contact_id: contact.id,
        my_persona: 'You are Rohan, chill and brief.',
        my_dictionary: 'bhava, nivant, sahiye',
        user_persona: 'An automated test harness.',
        style: 'Terse.',
        rules: 'Answer plainly.'
    }, { onConflict: 'contact_id' });

    return contact;
}

async function seedHistory(contactId) {
    await supabase.from('chats').delete().eq('contact_id', contactId);
    await supabase.from('insights').delete().eq('contact_id', contactId);

    // One minute apart so ordering is deterministic and readable in the prompt.
    // Written through chatStore so these rows carry metadata.source = 'mock':
    // they are numbered filler, never an example of how Rohan writes.
    const base = Date.now() - SEED_COUNT * 60000;
    const messages = Array.from({ length: SEED_COUNT }, (_, i) => ({
        contactId,
        message: `${label(i)} this is test message number ${i + 1}`,
        direction: directionFor(i),
        source: 'mock',
        extra: { seed: 'testHistoryWindow' },
        createdAt: new Date(base + i * 60000).toISOString()
    }));

    try {
        await saveMany(messages);
    } catch (err) {
        throw new Error(`seed failed: ${err.message || err}`);
    }

    await supabase.from('insights').insert({
        contact_id: contactId,
        summary: INSIGHT_SUMMARY,
        message_count: SEED_COUNT
    });
}

function parseHistory(prompt) {
    const startMarker = `LAST ${HISTORY_LIMIT} MESSAGES (HISTORY):`;
    const endMarker = 'LATEST MESSAGE (REPLY TO THIS):';
    const start = prompt.indexOf(startMarker);
    const end = prompt.indexOf(endMarker);
    if (start === -1 || end === -1) return null;

    return prompt
        .slice(start + startMarker.length, end)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
            const m = l.match(/^\[([^\]]+)\]\s+(User|Assistant):\s?([\s\S]*)$/);
            return m ? { timestamp: m[1], speaker: m[2], message: m[3] } : { raw: l };
        });
}

async function main() {
    console.log('--- Prompt history window test ---');
    console.log(`Seeding ${SEED_COUNT} messages, expecting the prompt to carry the last ${WINDOW}.\n`);

    const contact = await setupContact();
    await seedHistory(contact.id);

    const prompt = await buildDynamicPrompt(contact.id, LATEST_MESSAGE);
    const history = parseHistory(prompt);

    if (!history) {
        console.error('Could not locate the history section in the generated prompt.');
        console.error(prompt);
        process.exit(1);
    }

    const malformed = history.filter((h) => h.raw);
    const parsed = history.filter((h) => h.message);
    const expectedFirst = label(SEED_COUNT - WINDOW);   // msg-11
    const expectedLast = label(SEED_COUNT - 1);         // msg-30

    check(`history holds exactly ${WINDOW} messages`,
        history.length === WINDOW, `got ${history.length}`);

    check('every history line is well formed',
        malformed.length === 0,
        `${malformed.length} unparsed, first: ${JSON.stringify(malformed[0])}`);

    check(`window starts at ${expectedFirst} (oldest kept)`,
        parsed[0] && parsed[0].message.startsWith(expectedFirst),
        `got "${parsed[0] && parsed[0].message.slice(0, 30)}"`);

    check(`window ends at ${expectedLast} (newest)`,
        parsed.length > 0 && parsed[parsed.length - 1].message.startsWith(expectedLast),
        `got "${parsed.length > 0 && parsed[parsed.length - 1].message.slice(0, 30)}"`);

    const nums = parsed.map((h) => parseInt(h.message.match(/msg-(\d+)/)[1], 10));
    check('messages are chronological, oldest first, no gaps',
        nums.every((n, i) => i === 0 || n === nums[i - 1] + 1),
        `sequence: ${nums.join(',')}`);

    const dropped = Array.from({ length: SEED_COUNT - WINDOW }, (_, i) => label(i));
    // Match the trailing space too, so a label is never a prefix of a longer one.
    const leaked = dropped.filter((l) => prompt.includes(`${l} `));
    check(`the ${dropped.length} oldest messages are excluded`,
        leaked.length === 0, `leaked: ${leaked.join(', ')}`);

    check('INCOMING renders as User and OUTGOING as Assistant',
        parsed.every((h) => {
            const n = parseInt(h.message.match(/msg-(\d+)/)[1], 10) - 1;
            return h.speaker === speakerFor(n);
        }));

    check('every history line carries a timestamp',
        parsed.every((h) => h.timestamp && h.timestamp.length > 0));

    check('latest message is present',
        prompt.includes(LATEST_MESSAGE));

    check('conversation summary (insight) is injected',
        prompt.includes(INSIGHT_SUMMARY));

    console.log('\n----------------- GENERATED PROMPT -----------------');
    console.log(prompt);
    console.log('----------------------------------------------------');

    if (KEEP) {
        console.log(`\nKept seeded rows on contact ${contact.id} (${TEST_PHONE}).`);
    } else {
        await supabase.from('chats').delete().eq('contact_id', contact.id);
        await supabase.from('insights').delete().eq('contact_id', contact.id);
        console.log('\nCleaned up seeded rows (pass --keep to retain them).');
    }

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
