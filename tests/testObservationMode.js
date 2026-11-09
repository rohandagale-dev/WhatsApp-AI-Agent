/**
 * Testing mode vs live mode, end to end.
 *
 * Drives services/whatsappService.js through a fake WhatsApp socket, with
 * Supabase and the AI providers replaced by in-memory fakes, and proves:
 *
 *   TESTING MODE (TESTING_MODE=true, the default): an incoming message is
 *   stored, the model drafts a reply and the draft is printed for auditing --
 *   but NOTHING reaches WhatsApp (not one socket method is called), and the
 *   draft is never written to `chats` as if it had been said.
 *
 *   LIVE MODE (TESTING_MODE=false): the reply IS sent to the contact, after a
 *   random wait inside REPLY_DELAY_MIN/MAX_SECONDS (default 30-90s), and stored
 *   as source:'ai'.
 *
 * Plus the fail-safe parsing: a missing or misspelled TESTING_MODE never goes live.
 *
 * Offline: no network, no database, and auth/ is never opened.
 *
 *   node tests/testObservationMode.js        (npm run test:observe)
 *
 * Exits non-zero if any case fails.
 */
'use strict';

const Module = require('module');
const path = require('path');
const util = require('util');
const { EventEmitter } = require('events');

// dotenv never overrides a variable that is already set, so pinning these
// before the service loads .env keeps the real .env out of the result.
process.env.AI_VERSION = 'v2';
process.env.DEBUG = 'false';
process.env.TESTING_MODE = 'true';
process.env.REPLY_DELAY_MIN_SECONDS = '30';
process.env.REPLY_DELAY_MAX_SECONDS = '90';
process.env.TESTING_BUNDLE_SECONDS = '0';
process.env.EMOJI_MATCHING = 'true';
process.env.HANDOFF_FROM_MOOD = 'true';
// Plain text by default, whether or not this runs on a terminal; the colour
// scenario below turns highlighting on explicitly.
process.env.NO_COLOR = '1';
delete process.env.FORCE_COLOR;

const ROOT = path.join(__dirname, '..');
const SERVICE_FILE = path.join(ROOT, 'services', 'whatsappService.js');

// ------------------------------- reporting ------------------------------- //

const print = console.log.bind(console);

// The service logs freely. Capture all of it, so the report stays readable and
// the audit output itself can be asserted on.
const captured = [];
for (const level of ['log', 'info', 'warn', 'error']) {
    console[level] = (...args) => { captured.push(util.format(...args)); };
}
const allOutput = () => captured.join('\n');
const blocks = (kind) => captured.filter(text => text.startsWith(`┌── ${kind}`));

process.on('uncaughtException', (err) => print('  CRASH ', err && err.stack ? err.stack : err));

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass: !!pass });
    let line = `${pass ? '  PASS' : '  FAIL'}  ${name}`;
    if (!pass && detail !== undefined) line += `\n        ${String(detail).split('\n').join('\n        ')}`;
    print(line);
}

// ------------------------------- fakes ------------------------------- //

// Supabase: just enough of the query builder for whatsappService + chatStore.
const db = { personas: [{ id: 1, name: 'Rohan' }], contacts: [], chats: [], insights: [] };
let nextId = 100;

function runQuery(q) {
    const table = db[q.table] || (db[q.table] = []);
    const matches = row => Object.entries(q.filters).every(([col, val]) => row[col] === val);
    if (q.op === 'insert') {
        const list = (Array.isArray(q.payload) ? q.payload : [q.payload])
            .map(row => ({ id: nextId++, created_at: new Date().toISOString(), ...row }));
        table.push(...list);
        return { data: q.mode ? list[0] : list, error: null };
    }
    if (q.op === 'update') {
        table.filter(matches).forEach(row => Object.assign(row, q.payload));
        return { data: null, error: null };
    }
    const found = table.filter(matches);
    if (q.head) return { data: null, count: found.length, error: null };
    if (q.mode === 'maybe') return { data: found[0] || null, error: null };
    if (q.mode === 'single') {
        return found.length ? { data: found[0], error: null } : { data: null, error: { message: 'no rows' } };
    }
    return { data: found, error: null };
}

const supabase = {
    from(table) {
        const q = { table, op: 'select', filters: {}, head: false, payload: null, mode: null };
        const builder = {
            select(_columns, opts) { if (q.op === 'select') q.head = !!(opts && opts.head); return builder; },
            insert(payload) { q.op = 'insert'; q.payload = payload; return builder; },
            update(payload) { q.op = 'update'; q.payload = payload; return builder; },
            eq(column, value) { q.filters[column] = value; return builder; },
            order() { return builder; },
            limit() { return builder; },
            maybeSingle() { q.mode = 'maybe'; return builder; },
            single() { q.mode = 'single'; return builder; },
            then(resolve, reject) { return Promise.resolve().then(() => runQuery(q)).then(resolve, reject); }
        };
        return builder;
    }
};

// Every prompt the service asked for, with the options it passed.
const draftCalls = [];

// What the stubbed mood reader "understood", per test message.
const BASE_MOOD = { mood: 'bored, playful', energy: 'high', intent: 'attention', topic: 'plans', relationship: 'close friend', needsRohan: false };
const moodFor = latest => latest === 'handoff test' ? { ...BASE_MOOD, needsRohan: true, needsRohanReason: 'asks whether Rohan is coming' }
    : latest === 'context test' ? { ...BASE_MOOD, missingContext: 'which colour they mean' }
        : BASE_MOOD;

// AI providers: record every call, answer with whatever the scenario wants.
const aiCalls = [];
let aiAnswer = () => ({ ok: true, text: 'haan 7 chalega', usage: { promptTokens: 1200, completionTokens: 9, totalTokens: 1209 } });
const fakeProvider = name => ({
    generateResponse: async (prompt, history) => {
        aiCalls.push({ provider: name, prompt, history });
        return aiAnswer();
    }
});

// WhatsApp socket: `ev` and `user` are real; touching ANY other property --
// sendMessage, relayMessage, readMessages, sendPresenceUpdate, anything --
// is recorded as a socket call. Testing mode must make none.
let sock = null;
let socketOptions = null;
const socketCalls = [];
function makeFakeSocket(options) {
    socketOptions = options;
    const real = { ev: new EventEmitter(), user: { id: '919999999999:7@s.whatsapp.net' } };
    sock = new Proxy(real, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
            return (...args) => {
                socketCalls.push({ method: String(prop), args });
                return Promise.resolve({ key: { id: 'FAKE-SENT-ID' } });
            };
        }
    });
    return sock;
}

// ------------------------------- wiring ------------------------------- //

function stubModule(request, exportsValue) {
    const filename = require.resolve(request);
    const stub = new Module(filename, module);
    stub.filename = filename;
    stub.loaded = true;
    stub.exports = exportsValue;
    require.cache[filename] = stub;
}

stubModule('@whiskeysockets/baileys', {
    default: makeFakeSocket,
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),   // never opens auth/
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),               // no network
    DisconnectReason: { loggedOut: 401, connectionReplaced: 440 },
    generateMessageIDV2: () => 'FAKE-ID'
});
stubModule('qrcode-terminal', { generate() {} });
stubModule(path.join(ROOT, 'services', 'supabaseClient.js'), { supabase });
stubModule(path.join(ROOT, 'services', 'groqService.js'), fakeProvider('groq'));
stubModule(path.join(ROOT, 'services', 'geminiService.js'), fakeProvider('gemini'));
stubModule(path.join(ROOT, 'services', 'ollamaService.js'), fakeProvider('ollama'));
stubModule(path.join(ROOT, 'services', 'promptService.js'), {
    buildDynamicPrompt: async () => 'SYSTEM PROMPT (test fake)',
    // Shaped like a v4 per-person prompt: a system message, then their message as the last user turn.
    buildDraftMessages: async (contactId, latest, options) => {
        draftCalls.push({ contactId, latest, options });
        return {
            messages: [{ role: 'system', content: 'SYSTEM PROMPT (test fake)' }, { role: 'user', content: latest }],
            meta: { version: 'v4', layout: 'per-person', ownMessages: 12,
                mood: moodFor(latest),
                // A person Rohan never sends emojis to (emoji scenario), and one Rohan
                // writes 4-word single messages to (length scenario).
                emojiRate: latest === 'emoji test' ? 0 : latest === 'length test' ? 1 : undefined,
                lengthHabit: latest === 'length test' ? { maxWords: 4, maxLines: 1 } : undefined }
        };
    }
});

// The service waits 30s to bundle messages and, in live mode, a random 30-90s
// before sending. Record every delay it asks for, then squash it to a few ms;
// the test's own waiting uses the real setTimeout.
const realSetTimeout = global.setTimeout;
const requestedDelays = [];
global.setTimeout = (fn, ms, ...args) => {
    requestedDelays.push(Number(ms) || 0);
    return realSetTimeout(fn, Math.min(Number(ms) || 0, 20), ...args);
};
const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(10);
    }
    return predicate();
}

let seq = 0;
function waMessage(phone, text, { fromMe = false, pushName, jid } = {}) {
    return {
        key: { remoteJid: jid || `${phone}@s.whatsapp.net`, fromMe, id: `TEST-${++seq}` },
        message: { conversation: text },
        pushName,
        messageTimestamp: Math.floor(Date.now() / 1000)
    };
}
const upsert = (messages, type = 'notify') => sock.ev.emit('messages.upsert', { type, messages });
const rowsFor = phone => {
    const ids = db.contacts.filter(c => c.phone === phone).map(c => c.id);
    return db.chats.filter(row => ids.includes(row.contact_id));
};
const aiRows = () => db.chats.filter(row => row.metadata && row.metadata.source === 'ai');

// ------------------------------- scenarios ------------------------------- //

async function main() {
    const service = require(SERVICE_FILE);
    const { startWhatsApp, resolveTestingMode, resolveReplyDelays, containsDevanagari, resolveTestingBundleDelay } = service;

    print('\n-- TESTING_MODE parsing is fail-safe --');
    check('unset or empty => testing', resolveTestingMode(undefined) === true && resolveTestingMode('') === true && resolveTestingMode('  ') === true);
    check('true => testing', resolveTestingMode('true') === true && resolveTestingMode('TRUE') === true);
    check('a typo stays in testing mode ("flase", "fasle", "nope")',
        ['flase', 'fasle', 'nope'].every(v => resolveTestingMode(v) === true));
    check('only an explicit off value goes live: false / off / 0 / no',
        ['false', 'FALSE', ' off ', '0', 'no'].every(v => resolveTestingMode(v) === false));

    print('\n-- reply delay settings --');
    const defaults = resolveReplyDelays({});
    check('the random reply delay defaults to 30-90 seconds', defaults.minMs === 30000 && defaults.maxMs === 90000, JSON.stringify(defaults));
    const custom = resolveReplyDelays({ REPLY_DELAY_MIN_SECONDS: '10', REPLY_DELAY_MAX_SECONDS: '20' });
    check('it can be changed in .env', custom.minMs === 10000 && custom.maxMs === 20000, JSON.stringify(custom));
    const inverted = resolveReplyDelays({ REPLY_DELAY_MIN_SECONDS: '60', REPLY_DELAY_MAX_SECONDS: '10' });
    check('a max below the min falls back to 30-90s', inverted.minMs === 30000 && inverted.maxMs === 90000, JSON.stringify(inverted));
    const garbage = resolveReplyDelays({ REPLY_DELAY_MIN_SECONDS: 'abc', REPLY_DELAY_MAX_SECONDS: '-5' });
    check('garbage values fall back to 30-90s', garbage.minMs === 30000 && garbage.maxMs === 90000, JSON.stringify(garbage));

    print('\n-- testing-mode wait --');
    check('testing mode waits 0s by default', resolveTestingBundleDelay({}) === 0 && resolveTestingBundleDelay({ TESTING_BUNDLE_SECONDS: '' }) === 0);
    check('TESTING_BUNDLE_SECONDS brings a wait back', resolveTestingBundleDelay({ TESTING_BUNDLE_SECONDS: '30' }) === 30000);
    check('garbage values mean no wait', resolveTestingBundleDelay({ TESTING_BUNDLE_SECONDS: 'abc' }) === 0 && resolveTestingBundleDelay({ TESTING_BUNDLE_SECONDS: '-5' }) === 0);

    print('\n-- emoji habit --');
    const { matchEmojiHabit } = service;
    check('an emoji is kept when it fits your habit with them', matchEmojiHabit('ha 😂', 0.33, () => 0.1) === 'ha 😂');
    check('...and taken out when it does not', matchEmojiHabit('ha 😂', 0.08, () => 0.5) === 'ha');
    check('skin tones and joined emojis go too', matchEmojiHabit('yes 🫶🏻 ok 👨‍👩‍👧', 0, () => 0.99) === 'yes ok');
    check('a kept draft keeps only its first emoji', matchEmojiHabit('maza kar 😎🎉', 1, () => 0) === 'maza kar 😎');
    check('an emoji-only reply keeps one emoji', matchEmojiHabit('😂😂', 0, () => 0.99) === '😂');
    check('a new contact (no measured habit) gets the 15% default, not free emojis',
        matchEmojiHabit('ha 😂', null, () => 0.5) === 'ha' && matchEmojiHabit('ha 😂', null, () => 0.1) === 'ha 😂');

    print('\n-- length habit --');
    const { matchLengthHabit } = service;
    const four = { maxWords: 4, maxLines: 1 };
    check('a short draft is left alone', matchLengthHabit('Cool, thik hai.', four) === 'Cool, thik hai.');
    check('a long draft is cut back at a sentence boundary',
        matchLengthHabit('Bro, Red Bus hi? koi specific time ya route yaad aa raha?', four) === 'Bro, Red Bus hi?');
    check('extra lines go when you rarely send several in a row', matchLengthHabit('Maza kar aaj\nKoi plan?', four) === 'Maza kar aaj');
    check('...and stay when you often do', matchLengthHabit('Maza kar aaj\nKoi plan?', { maxWords: 4, maxLines: 2 }) === 'Maza kar aaj\nKoi plan?');
    check('a single long sentence is never cut mid-sentence',
        matchLengthHabit('abhi confirm nahi hua thoda wait kar yaar', four) === 'abhi confirm nahi hua thoda wait kar yaar');
    check('a hand-off is never cut, so "negative" cannot be lost', matchLengthHabit('Acha sahiye\nnegative', four) === 'Acha sahiye\nnegative');
    check('a new contact (no measured habit) gets the default: up to 10 words, 1 line',
        matchLengthHabit('ek do teen\nchaar paanch', null) === 'ek do teen');

    print('\n-- hand-off from the mood reader --');
    const { moodHandOffReason } = service;
    check('a question that needs you is handed off',
        moodHandOffReason({ needsRohan: true, needsRohanReason: 'asks whether Rohan is coming' }) === 'needs you (asks whether Rohan is coming)');
    check('so is a message that depends on context the chat lacks',
        moodHandOffReason({ needsRohan: false, missingContext: 'which colour they mean' }) === 'refers to something not in the chat (which colour they mean)');
    check('an ordinary message is not', moodHandOffReason({ needsRohan: false, missingContext: '' }) === null && moodHandOffReason(null) === null);
    process.env.HANDOFF_FROM_MOOD = 'false';
    check('HANDOFF_FROM_MOOD=false makes the flags advisory only', moodHandOffReason({ needsRohan: true }) === null);
    process.env.HANDOFF_FROM_MOOD = 'true';

    print('\n-- Roman letters only --');
    check('Devanagari is detected (Marathi and Hindi script)',
        containsDevanagari('हो, उद्या भेटू') && containsDevanagari('ok ठीक है'));
    check('Roman Hinglish, Marathi-English and emoji are fine',
        !containsDevanagari('kasa ahe') && !containsDevanagari('chal kal milte') && !containsDevanagari('Sahiye 😂🫶🏻'));

    await startWhatsApp();
    sock.ev.emit('connection.update', { connection: 'open' });

    print('\n-- testing mode: socket configuration --');
    check('emitOwnEvents is off (no self-echo)', socketOptions && socketOptions.emitOwnEvents === false);
    check('markOnlineOnConnect is off (contacts do not see you online; phone keeps notifications)',
        socketOptions && socketOptions.markOnlineOnConnect === false);
    check('the startup banner announces TESTING MODE', /TESTING MODE/.test(allOutput()) && !/LIVE MODE/.test(allOutput()));

    print('\n-- testing mode: an incoming message is drafted and printed, but NOT sent --');
    const RAHUL = '919800000001';
    upsert([waMessage(RAHUL, 'kal milte kya? 7 baje?', { pushName: 'Rahul' })]);
    await waitFor(() => blocks('AUDIT').length >= 1);
    const audit1 = blocks('AUDIT')[0] || '';
    check('the model was asked for one draft, through Groq',
        aiCalls.length === 1 && aiCalls[0].provider === 'groq', JSON.stringify(aiCalls.map(c => c.provider)));
    check('the incoming message is stored as INCOMING / human',
        rowsFor(RAHUL).some(r => r.direction === 'INCOMING' && r.message === 'kal milte kya? 7 baje?' && r.metadata.source === 'human'));
    check('an AUDIT block is printed with the contact and the message',
        audit1.includes('Rahul') && audit1.includes(RAHUL) && audit1.includes('kal milte kya? 7 baje?'), audit1);
    check('the AUDIT block shows the draft', audit1.includes('haan 7 chalega'), audit1);
    check('the AUDIT block says it was not sent', audit1.includes('WOULD SEND · not sent (testing mode)'), audit1);
    check('the AUDIT block says which prompt wrote the draft',
        audit1.includes('prompt v4, per-person (learned from 12 of your messages)'), audit1);
    check('the AUDIT block shows the mood reading',
        audit1.includes('│ MOOD  bored, playful (high) · wants attention · plans · close friend'), audit1);
    check('nothing was sent: no socket method was called', socketCalls.length === 0,
        socketCalls.map(c => c.method).join(', '));
    check('the draft is not stored in chats',
        aiRows().length === 0 && !db.chats.some(r => r.message === 'haan 7 chalega'));
    check('testing mode never waits the random reply delay',
        !requestedDelays.some(ms => ms > 30000 && ms <= 90000), JSON.stringify(requestedDelays));

    print('\n-- testing mode: your own reply is compared with the draft --');
    upsert([waMessage(RAHUL, 'ha chal 7 la', { fromMe: true })]);
    await waitFor(() => blocks('COMPARE').length >= 1);
    const compare1 = blocks('COMPARE')[0] || '';
    check('a COMPARE block shows the draft next to what you actually sent',
        compare1.includes('haan 7 chalega') && compare1.includes('ha chal 7 la'), compare1);
    check('your reply is stored as OUTGOING / human',
        rowsFor(RAHUL).some(r => r.direction === 'OUTGOING' && r.message === 'ha chal 7 la' && r.metadata.source === 'human'));
    check('your reply does not trigger another draft', aiCalls.length === 1, `${aiCalls.length} AI calls`);

    print('\n-- testing mode: a reply you send before the draft is ready shows up in the audit --');
    const PRIYA = '919800000002';
    upsert([
        waMessage(PRIYA, 'notes bhej de', { pushName: 'Priya' }),
        waMessage(PRIYA, 'bhejto 5 min', { fromMe: true })
    ]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('Priya')));
    const audit2 = blocks('AUDIT').find(b => b.includes('Priya')) || '';
    check('the AUDIT block lists the reply you already sent', /YOU\s+bhejto 5 min/.test(audit2), audit2);

    print('\n-- every message in a batch is processed (not just the first) --');
    upsert([
        waMessage('919800000003', 'hi', { pushName: 'Amit' }),
        waMessage('919800000004', 'hello', { pushName: 'Sneha' })
    ]);
    await waitFor(() => blocks('AUDIT').length >= 4);
    check('both messages are stored', rowsFor('919800000003').length === 1 && rowsFor('919800000004').length === 1);
    check('both get a draft', blocks('AUDIT').some(b => b.includes('Amit')) && blocks('AUDIT').some(b => b.includes('Sneha')));

    print('\n-- hand-offs and AI failures are reported, never sent --');
    aiAnswer = () => ({ ok: true, text: 'negative', usage: {} });
    upsert([waMessage('919800000005', 'bank details bhej', { pushName: 'Unknown' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('HAND-OFF')));
    check('a "negative" draft is reported as a HAND-OFF',
        blocks('AUDIT').some(b => b.includes('919800000005') && b.includes('HAND-OFF · not sent')));

    aiAnswer = () => ({ ok: false, text: null, error: 'Groq request failed: 401 Invalid API Key', usage: {} });
    upsert([waMessage('919800000006', 'oye', {})]);
    await waitFor(() => /401 Invalid API Key/.test(allOutput()));
    check('a failed AI call is reported in the terminal',
        /Groq failed for 919800000006: Groq request failed: 401 Invalid API Key/.test(allOutput()));
    check('a failed AI call still keeps the incoming message', rowsFor('919800000006').length === 1);

    print('\n-- groups and status updates are ignored --');
    const before = { ai: aiCalls.length, rows: db.chats.length };
    upsert([
        waMessage('120363000000000000', 'group message', { jid: '120363000000000000@g.us' }),
        waMessage('status', 'a status update', { jid: 'status@broadcast' })
    ]);
    await sleep(100);
    check('no draft for group or status messages', aiCalls.length === before.ai);
    check('group and status messages are not stored', db.chats.length === before.rows);

    print('\n-- the AI reply is highlighted on a terminal --');
    check('with NO_COLOR the log has no colour codes (log files stay clean)', !/\x1b\[/.test(allOutput()));
    process.env.NO_COLOR = '';
    process.env.FORCE_COLOR = '1';
    aiAnswer = () => ({ ok: true, text: 'haan 7 chalega', usage: {} });
    upsert([waMessage('919800000007', 'colour test', { pushName: 'Colour' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('919800000007')));
    const coloured = blocks('AUDIT').find(b => b.includes('919800000007')) || '';
    check('the AI line is highlighted (bold black on bright green)',
        coloured.includes('│ AI    \x1b[1;30;102m haan 7 chalega \x1b[0m'), JSON.stringify(coloured));
    check('their message is left plain', /│ THEM  colour test$/m.test(coloured), JSON.stringify(coloured));
    upsert([waMessage('919800000007', 'mast', { fromMe: true })]);
    await waitFor(() => blocks('COMPARE').some(b => b.includes('919800000007')));
    const colouredCompare = blocks('COMPARE').find(b => b.includes('919800000007')) || '';
    check('the AI line is highlighted in COMPARE too, your reply stays plain',
        colouredCompare.includes('\x1b[1;30;102m haan 7 chalega \x1b[0m') && /│ YOU   mast$/m.test(colouredCompare),
        JSON.stringify(colouredCompare));
    process.env.NO_COLOR = '1';
    delete process.env.FORCE_COLOR;

    print('\n-- testing mode: the next draft for the same person knows what was already drafted --');
    upsert([waMessage(RAHUL, 'aur bata', { pushName: 'Rahul' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('aur bata')));
    const second = draftCalls.find(c => c.latest === 'aur bata');
    check('earlier drafts for that person are passed on as "don\'t repeat"',
        second && second.options.recentDrafts.includes('haan 7 chalega'), JSON.stringify(second && second.options));
    check("...and only that person's drafts", second && second.options.recentDrafts.every(d => d === 'haan 7 chalega'));
    check('the contact name is passed on', second && second.options.contactName === 'Rahul');

    print('\n-- testing mode: emojis only as often as you use them --');
    aiAnswer = () => ({ ok: true, text: 'theek hai 😞', usage: {} });
    upsert([waMessage('919800000013', 'emoji test', { pushName: 'Emoji' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('919800000013')));
    const emojiAudit = blocks('AUDIT').find(b => b.includes('919800000013')) || '';
    check('a draft for someone you never send emojis to loses its emoji (the AUDIT still shows the original)',
        /│ AI    theek hai$/m.test(emojiAudit) && emojiAudit.includes('model wrote: theek hai 😞'), emojiAudit);
    print('\n-- testing mode: a long draft is cut to how you write to them --');
    aiAnswer = () => ({ ok: true, text: 'Bro, Red Bus hi? koi specific time ya route yaad aa raha?\nKoi plan?', usage: {} });
    upsert([waMessage('919800000014', 'length test', { pushName: 'Length' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('919800000014')));
    const lengthAudit = blocks('AUDIT').find(b => b.includes('919800000014')) || '';
    check('the draft is shortened at a sentence boundary', /│ AI    Bro, Red Bus hi\?$/m.test(lengthAudit), lengthAudit);
    check('the AUDIT shows what the model originally wrote',
        lengthAudit.includes('model wrote: Bro, Red Bus hi? koi specific time ya route yaad aa raha? / Koi plan?'), lengthAudit);
    aiAnswer = () => ({ ok: true, text: 'haan 7 chalega', usage: {} });

    print('\n-- testing mode: questions that need you are handed off without drafting --');
    const callsBeforeHandOff = aiCalls.length;
    upsert([waMessage('919800000015', 'handoff test', { pushName: 'Handoff' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('919800000015')));
    const handAudit = blocks('AUDIT').find(b => b.includes('919800000015')) || '';
    check('no draft is requested, so no tokens are spent', aiCalls.length === callsBeforeHandOff, `${aiCalls.length - callsBeforeHandOff} AI calls`);
    check('the AUDIT shows a HAND-OFF and why',
        handAudit.includes('HAND-OFF · not sent') && handAudit.includes('handed to you without drafting: needs you (asks whether Rohan is coming)'), handAudit);
    upsert([waMessage('919800000016', 'context test', { pushName: 'Context' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('919800000016')));
    const ctxAudit = blocks('AUDIT').find(b => b.includes('919800000016')) || '';
    check('a message that relies on context the chat lacks is handed off too',
        ctxAudit.includes('HAND-OFF · not sent') && ctxAudit.includes('⚠ refers to something not in the chat: which colour they mean'), ctxAudit);
    check('...also without drafting', aiCalls.length === callsBeforeHandOff);

    print('\n-- testing mode: a Devanagari draft is rewritten in Roman letters, or dropped --');
    let attempt = 0;
    aiAnswer = () => (++attempt === 1
        ? { ok: true, text: 'हो, उद्या भेटू', usage: {} }
        : { ok: true, text: 'Ho, udya bhetu', usage: {} });
    const callsBeforeScript = aiCalls.length;
    upsert([waMessage('919800000010', 'udya bhetuya ka?', { pushName: 'Script' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('919800000010')));
    const scriptAudit = blocks('AUDIT').find(b => b.includes('919800000010')) || '';
    check('a Devanagari draft triggers exactly one retry', aiCalls.length - callsBeforeScript === 2,
        `${aiCalls.length - callsBeforeScript} AI calls`);
    check('the retry asks for Roman letters', /Roman \(English\) letters only/.test(JSON.stringify(aiCalls[aiCalls.length - 1].history)));
    const retryRoles = aiCalls[aiCalls.length - 1].history.map(m => m.role).join(',');
    check('the retry keeps the turns alternating (their message is not sent twice)',
        retryRoles === 'system,user,assistant,user', retryRoles);
    check('the audit shows the Roman rewrite and no Devanagari', scriptAudit.includes('Ho, udya bhetu') && !containsDevanagari(scriptAudit), scriptAudit);

    aiAnswer = () => ({ ok: true, text: 'नाही रे', usage: {} });
    upsert([waMessage('919800000011', 'yetoy ka?', { pushName: 'Script Two' })]);
    await waitFor(() => blocks('AUDIT').some(b => b.includes('919800000011')));
    const droppedAudit = blocks('AUDIT').find(b => b.includes('919800000011')) || '';
    check('if it stays in Devanagari, the draft is dropped (SILENT)',
        droppedAudit.includes('SILENT · not sent') && !containsDevanagari(droppedAudit), droppedAudit);

    print('\n-- across the whole testing-mode run --');
    check('NO socket method was ever called: nothing reached WhatsApp', socketCalls.length === 0,
        socketCalls.map(c => c.method).join(', '));
    check('no AI-authored row was ever written to chats', aiRows().length === 0);
    check('testing mode drafted right away: the 30s quiet window was never used',
        !requestedDelays.includes(30000) && requestedDelays.includes(0), JSON.stringify(requestedDelays));

    print('\n-- LIVE MODE (TESTING_MODE=false): the reply is sent after a random 30-90s wait --');
    process.env.TESTING_MODE = 'false';
    aiAnswer = () => ({ ok: true, text: 'haan bol', usage: { promptTokens: 900, completionTokens: 4, totalTokens: 904 } });
    await startWhatsApp();                       // a fresh socket picks up the new mode
    sock.ev.emit('connection.update', { connection: 'open' });
    check('the startup banner warns that LIVE MODE sends real messages', /LIVE MODE/.test(allOutput()));
    check('live mode keeps the original presence behaviour (markOnlineOnConnect on)',
        socketOptions && socketOptions.markOnlineOnConnect === true);

    const LIVE = '919800000009';
    const delaysBefore = requestedDelays.length;
    upsert([waMessage(LIVE, 'kya chal raha hai', { pushName: 'Live Test' })]);
    await waitFor(() => socketCalls.some(c => c.method === 'sendMessage') && aiRows().length >= 1);
    const send = socketCalls.find(c => c.method === 'sendMessage');
    check('the reply is SENT to the contact through Baileys',
        !!send && send.args[0] === `${LIVE}@s.whatsapp.net` && send.args[1] && send.args[1].text === 'haan bol',
        JSON.stringify(send && send.args.slice(0, 2)));

    // Delays asked for during this live turn: the 30s bundle window, then the
    // random reply delay. Drop one 30s entry (the window) and the reply delay is left.
    const liveDelays = requestedDelays.slice(delaysBefore);
    const windowAt = liveDelays.indexOf(30000);
    check('live mode still waits the 30s quiet window first', windowAt >= 0, JSON.stringify(liveDelays));
    if (windowAt >= 0) liveDelays.splice(windowAt, 1);
    const replyDelay = liveDelays.find(ms => ms >= 30000 && ms <= 90000);
    const logged = (allOutput().match(/\[DELAY\] Waiting (\d+)s before sending reply to 919800000009/) || [])[1];
    check('it waited a random delay between 30s and 90s before sending',
        replyDelay !== undefined && Number(logged) >= 30 && Number(logged) <= 90,
        `requested: ${JSON.stringify(requestedDelays.slice(delaysBefore))}, logged: ${logged}s`);
    check('the sent reply is stored as OUTGOING / ai',
        aiRows().length === 1 && aiRows()[0].message === 'haan bol' && aiRows()[0].direction === 'OUTGOING',
        JSON.stringify(aiRows()));
    check('no AUDIT block in live mode (the reply really went out)', !blocks('AUDIT').some(b => b.includes(LIVE)));
    check('sendMessage was the only socket call', socketCalls.every(c => c.method === 'sendMessage'),
        socketCalls.map(c => c.method).join(', '));

    print('\n-- live mode: a draft that stays in Devanagari is never sent --');
    aiAnswer = () => ({ ok: true, text: 'हो नक्की', usage: {} });
    const sendsBefore = socketCalls.filter(c => c.method === 'sendMessage').length;
    upsert([waMessage('919800000012', 'nakki ye', { pushName: 'Live Script' })]);
    await waitFor(() => /dropping the draft for 919800000012/.test(allOutput()));
    await sleep(50);
    check('nothing is sent when the draft stays in Devanagari',
        socketCalls.filter(c => c.method === 'sendMessage').length === sendsBefore,
        socketCalls.map(c => c.method).join(', '));

    print('\n-- live mode: a question that needs you is never answered --');
    const sendsBeforeHandOff = socketCalls.filter(c => c.method === 'sendMessage').length;
    upsert([waMessage('919800000017', 'handoff test', { pushName: 'Live Handoff' })]);
    await waitFor(() => /Not drafting for 919800000017/.test(allOutput()));
    await sleep(50);
    check('nothing is sent', socketCalls.filter(c => c.method === 'sendMessage').length === sendsBeforeHandOff,
        socketCalls.map(c => c.method).join(', '));

    check('no unhandled errors anywhere in the run', !/Unhandled Rejection|\[UPSERT\] Failed/.test(allOutput()), allOutput());

    return { audit1, compare1, audit2 };
}

main().then(({ audit1, compare1, audit2 }) => {
    const failed = results.filter(r => !r.pass).length;
    print(`\n${results.length - failed}/${results.length} checks passed.`);
    print('\nSample testing-mode output from this run:\n');
    [audit1, compare1, audit2].filter(Boolean).forEach(block => print(block + '\n'));
    process.exit(failed ? 1 : 0);
}).catch((err) => {
    print('  FAIL  the test crashed:', err && err.stack ? err.stack : err);
    print('\n--- captured service output ---\n' + allOutput());
    process.exit(1);
});
