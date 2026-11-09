/**
 * Prompt v4: the per-person layout (services/promptService.js -> buildDraftMessages).
 *
 *   - the chat with THIS contact is replayed as real turns: their messages are
 *     "user", Rohan's are "assistant", ending on their latest message;
 *   - style notes and Rohan's complete vocabulary with this person are
 *     measured from Rohan's own messages to them -- nobody else's chat ever
 *     appears, and AI-written / mock rows never stand in for Rohan;
 *   - a contact with fewer than STYLE_MIN_MESSAGES of Rohan's messages falls
 *     back to the classic layout with PROMPT_FALLBACK_VERSION (v3);
 *   - SYSTEM_PROMPT_VERSION=v3 keeps the classic layout exactly as before.
 *
 * Offline: Supabase is replaced by an in-memory fake.
 *
 *   node tests/testPromptV4.js        (npm run test:v4)
 *
 * Exits non-zero if any case fails.
 */
'use strict';

const fs = require('fs');
const Module = require('module');
const path = require('path');

// Pinned before promptService loads .env (dotenv never overrides a set variable).
process.env.SYSTEM_PROMPT_VERSION = 'v4';
process.env.PROMPT_FALLBACK_VERSION = 'v3';
process.env.STYLE_MIN_MESSAGES = '10';
process.env.HISTORY_MESSAGE_LIMIT = '200';
process.env.MAX_CONTEXT_TOKENS = '3000';
process.env.EXEMPLAR_SCOPE = 'contact';

const ROOT = path.join(__dirname, '..');
const fileText = version => fs.readFileSync(path.join(ROOT, 'system_prompts', `system_prompt_${version}.txt`), 'utf8');
const squash = s => String(s).replace(/\s+/g, ' ').trim();

const print = console.log.bind(console);
const results = [];
function check(name, pass, detail) {
    results.push({ name, pass: !!pass });
    let line = `${pass ? '  PASS' : '  FAIL'}  ${name}`;
    if (!pass && detail !== undefined) line += `\n        ${String(detail).slice(0, 400)}`;
    print(line);
}

// ------------------------------- fake data ------------------------------- //

const human = { source: 'human' };
let clock = Date.parse('2026-11-01T10:00:00Z');
const CHATS = [];
const say = (contact_id, direction, message, metadata = human) =>
    CHATS.push({ contact_id, direction, message, metadata, created_at: new Date(clock += 60000).toISOString() });

// Contact 1: 12 of Rohan's messages -- short, lowercase, two with 😂, sent in pairs.
const ROHAN_TO_ONE = ['ha bol', 'abbe kya hua', 'sahiye 😂', 'khana hua?', 'bata na', 'kya hua re',
    'kal milte', 'haan pakka', 'arre wah 😂', 'mast', 'bata na yaar', 'ok done'];
for (let i = 0; i < ROHAN_TO_ONE.length; i += 2) {
    say(1, 'INCOMING', `their message ${i}`);
    say(1, 'OUTGOING', ROHAN_TO_ONE[i]);
    say(1, 'OUTGOING', ROHAN_TO_ONE[i + 1]);
}
say(1, 'OUTGOING', 'AI WROTE THIS ONE', { source: 'ai' });   // the bot's own words: never "Rohan"
say(1, 'INCOMING', 'MOCK LINE', { source: 'mock' });        // invented seed data
say(1, 'INCOMING', 'kal free hai kya?');                    // the message being answered

// Contact 2: only 3 of Rohan's messages -> not enough to learn a tone from.
say(2, 'INCOMING', 'hello');
say(2, 'OUTGOING', 'hi');
say(2, 'OUTGOING', 'kaisa hai');
say(2, 'OUTGOING', 'bol');

// Contact 3: someone else entirely, with plenty of messages.
for (let i = 0; i < 12; i++) { say(3, 'INCOMING', `CONTACT THREE SAYS ${i}`); say(3, 'OUTGOING', `CONTACT THREE REPLY ${i}`); }

// Contact 4: a long chat (300 long messages) that cannot fit the token budget.
const filler = ' blah'.repeat(28);
say(4, 'INCOMING', `OLDEST-ROW-MARKER${filler}`);
for (let i = 1; i < 299; i++) say(4, i % 2 ? 'OUTGOING' : 'INCOMING', `row ${i}${filler}`);
say(4, 'INCOMING', `NEWEST-ROW-MARKER${filler}`);

// Contact 5: Rohan STARTS the chat (as with a birthday wish or a question), and
// they reply. Rohan's opening messages must reach the model.
for (let i = 0; i < 9; i++) say(5, 'OUTGOING', `earlier line ${i}`);
say(5, 'OUTGOING', 'Bro tu uss din konse app pe buses dekh rhi thi?');
say(5, 'INCOMING', 'Red bus');

const CONTACTS = {
    1: { id: 1, name: null, notes: null, relationPerson: null },
    2: { id: 2, name: null, notes: null, relationPerson: null },
    3: { id: 3, name: null, notes: null, relationPerson: null },
    4: { id: 4, name: null, notes: null, relationPerson: null },
    5: { id: 5, name: null, notes: null, relationPerson: null }
};

const value = (row, key) => key === 'metadata->>source' ? (row.metadata && row.metadata.source) : row[key];
const supabase = {
    from(table) {
        const q = { table, filters: {}, ascending: true, limit: Infinity };
        const builder = {
            select() { return builder; },
            eq(column, v) { q.filters[column] = v; return builder; },
            order(_column, opts) { q.ascending = !!(opts && opts.ascending); return builder; },
            limit(n) { q.limit = n; return builder; },
            maybeSingle() { return builder; },
            then(resolve, reject) {
                let result;
                if (table === 'contacts') {
                    result = { data: CONTACTS[q.filters.id] || null, error: null };
                } else if (table === 'chats') {
                    let rows = CHATS.filter(r => Object.entries(q.filters).every(([k, v]) => value(r, k) === v));
                    rows = rows.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
                    if (!q.ascending) rows.reverse();
                    result = { data: rows.slice(0, q.limit), error: null };
                } else {
                    result = { data: [], error: null };
                }
                return Promise.resolve(result).then(resolve, reject);
            }
        };
        return builder;
    }
};
const stubPath = path.join(ROOT, 'services', 'supabaseClient.js');
const stub = new Module(stubPath, module);
stub.filename = stubPath;
stub.loaded = true;
stub.exports = { supabase };
require.cache[stubPath] = stub;

// The mood reader makes a real Groq call; replace it with a stand-in whose
// answer each scenario sets.
let MOMENT = null;
const moodPath = path.join(ROOT, 'services', 'moodService.js');
const moodStub = new Module(moodPath, module);
moodStub.filename = moodPath;
moodStub.loaded = true;
moodStub.exports = { analyzeMoment: async () => MOMENT };
require.cache[moodPath] = moodStub;

console.log = console.warn = console.error = () => {};   // keep the module's notes out of the report

const { buildDraftMessages, describeStyle, renderStyleNotes, estimateTokens, HISTORY_LIMIT, MAX_CONTEXT_TOKENS } =
    require(path.join(ROOT, 'services', 'promptService.js'));
const promptTokens = messages => messages.reduce((n, m) => n + 4 + estimateTokens(m.content), 0);

// ------------------------------- checks ------------------------------- //

(async () => {
    print('\n-- v4 builds a per-person conversation --');
    const one = await buildDraftMessages(1, 'kal free hai kya?');
    check('a contact with 12 of your messages gets the per-person layout',
        one.meta.layout === 'per-person' && one.meta.version === 'v4' && one.meta.ownMessages === 12, JSON.stringify(one.meta));
    const system = one.messages[0];
    check('it starts with the v4 instructions', system.role === 'system' && squash(system.content).includes(squash(fileText('v4'))));
    const turns = one.messages.slice(1);
    check('the chat follows as alternating turns, starting with them',
        turns.length > 2 && turns[0].role === 'user' && turns.every((t, i) => i === 0 || t.role !== turns[i - 1].role),
        turns.map(t => t.role).join(','));
    check('your messages are the "assistant" turns (sent in pairs, one per line)',
        turns.some(t => t.role === 'assistant' && t.content === 'ha bol\nabbe kya hua'));
    check('it ends on their latest message', turns[turns.length - 1].role === 'user' && turns[turns.length - 1].content.endsWith('kal free hai kya?'));
    const turnsText = JSON.stringify(turns);
    check('AI-written and mock rows never appear as your words', !turnsText.includes('AI WROTE THIS ONE') && !turnsText.includes('MOCK LINE'));
    check("another contact's chat never appears", !JSON.stringify(one.messages).includes('CONTACT THREE'));

    print('\n-- style notes and vocabulary are measured from your messages to this person --');
    check('length: "usually about 2 words; rarely more than 3"', system.content.includes('usually about 2 words; rarely more than 3'), system.content);
    check('emojis: 17% of messages, and which ones', system.content.includes('in about 17%') && system.content.includes('😂'));
    check('lowercase habit is noticed', system.content.includes('Usually types in lowercase.'));
    check('sending a few messages in a row is noticed', system.content.includes('a few short messages in a row'));
    check('your length and emoji habits with them go to the bot for its checks',
        one.meta.lengthHabit && one.meta.lengthHabit.maxWords === 4 && one.meta.lengthHabit.maxLines === 3
            && Math.abs(one.meta.emojiRate - 2 / 12) < 1e-9, JSON.stringify(one.meta));
    const tierLine = label => (system.content.match(new RegExp(`- ${label}[^\\n]*: ([^\\n]+)`)) || [])[1] || '';
    const often = tierLine('Words Rohan uses often with them');
    const twice = tierLine('Words Rohan has used twice with them');
    const once = tierLine('Words Rohan has used only once with them');
    const vocab = [often, twice, once].join(', ');
    check('the vocabulary lists every word you used with them, split by how often',
        often.startsWith('hua') && twice.startsWith('bata, kya, na')
            && ['abbe', 'sahiye', 'khana', 'pakka', 'mast', 'done'].every(w => once.includes(w)), `${often} | ${twice} | ${once}`);
    check('once-only words are marked rare', system.content.includes('only once with them (rare: at most one per reply'));
    check('each emoji comes with how often you use it', system.content.includes('Each one, in how many of 12 messages: 😂 2'), system.content);
    check('your exact spellings are kept (no "nahi" invented, "kya" stays "kya")', !/\bnahi\b/.test(vocab) && /\bkya\b/.test(vocab));
    check('repeated phrases are listed', /Phrases Rohan repeats with them: "bata na", "kya hua"/.test(system.content), system.content);
    check('no other contact leaks into the vocabulary', !/contact|three|reply/.test(vocab));

    print('\n-- when YOU start the chat (the "Red bus" bug) --');
    const opener = await buildDraftMessages(5, 'Red bus');
    const openerTurns = opener.messages.slice(1);
    check('your opening messages are kept, not dropped',
        openerTurns[0].role === 'assistant' && openerTurns[0].content.includes('Bro tu uss din konse app pe buses dekh rhi thi?'),
        JSON.stringify(openerTurns));
    check('...followed by their answer', openerTurns.length === 2 && openerTurns[1].role === 'user' && openerTurns[1].content === 'Red bus');
    check('RIGHT NOW spells out your last message and their reply to it',
        opener.messages[0].content.includes(`Rohan's last message to them: "Bro tu uss din konse app pe buses dekh rhi thi?"`)
            && opener.messages[0].content.includes('What they said after it (what you are replying to): "Red bus"'), opener.messages[0].content);
    check('the v4 rules say who is who and never to answer your own question back',
        /Keep track of who said what/.test(fileText('v4')) && /Never answer Rohan's own question back to them/.test(fileText('v4')));

    print('\n-- the moment: who, when, mood, and not repeating yourself --');
    MOMENT = { mood: 'bored, playful', energy: 'high', intent: 'attention', topic: 'weekend plans',
        relationship: 'close friend', rohanPattern: 'teases back, short', needsRohan: false, needsRohanReason: '' };
    const withMood = await buildDraftMessages(1, 'kal free hai kya?', { contactName: 'Priya', recentDrafts: ['haan pakka kal', 'abbe bata na'] });
    const sys2 = withMood.messages[0].content;
    check('RIGHT NOW says who and when', sys2.includes('Texting with: Priya') && /For Rohan it is \w+/.test(sys2), sys2);
    check('the mood reading is labelled as a read that can be wrong', sys2.includes('A quick read of the moment (it can be wrong; the chat itself always wins)'));
    check('the mood reading goes into the prompt',
        sys2.includes('They seem bored, playful (energy: high). They want: attention. Topic: weekend plans.')
            && sys2.includes('In moments like this Rohan usually: teases back, short'), sys2);
    check('...and comes back for the AUDIT block', withMood.meta.mood && withMood.meta.mood.mood === 'bored, playful');
    check("DON'T REPEAT lists recent drafts (newest first) and replies the bot really sent",
        /DON'T REPEAT YOURSELF[^\n]*\n- abbe bata na\n- haan pakka kal\n- AI WROTE THIS ONE/.test(sys2), sys2);
    check("...but the bot's sent replies are still never shown as Rohan's own turns",
        !JSON.stringify(withMood.messages.slice(1)).includes('AI WROTE THIS ONE'));
    MOMENT = { ...MOMENT, needsRohan: true, needsRohanReason: 'asks for photos' };
    const needs = await buildDraftMessages(1, 'pic bhej');
    check('"needs the real Rohan" is passed on with the hand-off word',
        needs.messages[0].content.includes('needs the real Rohan (asks for photos). If it does, reply exactly: negative'));
    MOMENT = { ...MOMENT, needsRohan: false, needsRohanReason: '', missingContext: 'which plan they mean' };
    const missing = await buildDraftMessages(1, 'to kay tharavla?');
    check('"depends on something not in the chat" is passed on with the hand-off word',
        missing.messages[0].content.includes("depend on something that is not in this chat (which plan they mean), maybe talked about in person. "
            + "If you can't find it in the chat, reply exactly: negative"), missing.messages[0].content);
    MOMENT = null;
    const noMood = await buildDraftMessages(1, 'kal free hai kya?');
    check('without a mood reading the draft still builds, just without mood lines',
        !noMood.messages[0].content.includes('They seem') && noMood.meta.mood === null && noMood.messages[0].content.includes('RIGHT NOW'));

    print('\n-- v5: the general version --');
    process.env.SYSTEM_PROMPT_VERSION = 'v5';
    const five = await buildDraftMessages(1, 'kal free hai kya?');
    process.env.SYSTEM_PROMPT_VERSION = 'v4';
    check('SYSTEM_PROMPT_VERSION=v5 uses the per-person layout with the v5 file',
        five.meta.layout === 'per-person' && five.meta.version === 'v5'
            && squash(five.messages[0].content).includes(squash(fileText('v5'))), JSON.stringify(five.meta));
    const v5 = fileText('v5');
    check('v5 understands Marathi, Hindi and English, in Devanagari or Roman letters',
        /Marathi, Hindi, English or any mix, in Devanagari or in Roman letters/.test(v5));
    check('v5 still replies in Roman letters only (even to Devanagari), and keeps the hand-off word',
        /Never write in Devanagari script, even when they write in it\. ALWAYS use Roman \(English\) letters only/.test(v5)
            && /reply exactly: negative/.test(v5));
    const v4Lines = fileText('v4').split('\n').filter(l => l.trim());
    const kept = v4Lines.filter(l => v5.includes(l)).length;
    check('v5 is v4 plus targeted changes (most of v4 carried over word for word)',
        kept >= v4Lines.length - 5, `${kept} of ${v4Lines.length} v4 lines kept`);
    const quoted = (v5.match(/"[^"]*"/g) || []).filter(q => !['"assistant"', '"user"'].includes(q));
    check('v5 stays general: no quoted example words (they get copied into replies)', quoted.length === 0, quoted.join(', '));
    check('v5: things talked about in person are handed off unless the chat explains them',
        /talked about in person, on a call or somewhere else/.test(v5) && /depends on something that isn't in this chat/.test(v5));
    check('v5: questions that need your attention are handed off, never answered',
        /Never answer a question that needs Rohan's own attention/.test(v5) && /they ask something that needs Rohan's own attention/.test(v5));
    const specific = ['birthday', 'red bus', 'outfit', 'krri', 'kr rha', 'chill', 'acha', 'take care', 'dekhte', 'bro', 'vibes',
        'car', 'colour', 'color', 'parcel', 'sarika', 'shraddha', 'pratibha', 'kartik', 'mrudu'];
    const found = specific.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(v5));
    check('v5 stays general: nothing taken from particular chats or people', found.length === 0, found.join(', '));

    print('\n-- falling back and switching versions --');
    const two = await buildDraftMessages(2, 'hello');
    check('a contact with only 3 of your messages falls back to classic v3',
        two.meta.layout === 'classic' && two.meta.version === 'v3' && two.meta.requested === 'v4' && /only 3/.test(two.meta.reason), JSON.stringify(two.meta));
    check('...using the v3 persona file', two.messages.length === 1 && squash(two.messages[0].content).includes(squash(fileText('v3'))));

    process.env.SYSTEM_PROMPT_VERSION = 'v3';
    const classic = await buildDraftMessages(1, 'kal free hai kya?');
    check('SYSTEM_PROMPT_VERSION=v3 keeps the classic layout exactly as before',
        classic.meta.layout === 'classic' && classic.meta.version === 'v3' && !classic.meta.requested && classic.messages.length === 1, JSON.stringify(classic.meta));
    process.env.SYSTEM_PROMPT_VERSION = 'v4';

    const unsaved = await buildDraftMessages(1, 'a brand new line not saved yet');
    check('if their latest message was not saved, it is still what gets answered',
        unsaved.messages[unsaved.messages.length - 1].content.endsWith('a brand new line not saved yet'));

    print('\n-- the token guard --');
    check('HISTORY_MESSAGE_LIMIT=200 and MAX_CONTEXT_TOKENS are read from .env', HISTORY_LIMIT === 200 && MAX_CONTEXT_TOKENS === 3000);
    check('a short chat is never trimmed', one.meta.trimmed === 0 && one.meta.historyMessages === 21, JSON.stringify(one.meta));
    const big = await buildDraftMessages(4, `NEWEST-ROW-MARKER${filler}`);
    const bigText = JSON.stringify(big.messages);
    check('a long chat is trimmed to fit the budget (v4)',
        big.meta.trimmed > 0 && big.meta.historyMessages < 200 && promptTokens(big.messages) <= MAX_CONTEXT_TOKENS,
        `${JSON.stringify(big.meta)} ~${promptTokens(big.messages)} tokens`);
    check('...the oldest messages go, the newest stay',
        !bigText.includes('OLDEST-ROW-MARKER') && big.messages[big.messages.length - 1].content.includes('NEWEST-ROW-MARKER'));
    check('...and the chat still alternates', big.messages.slice(1).every((t, i, all) => i === 0 || t.role !== all[i - 1].role));
    process.env.SYSTEM_PROMPT_VERSION = 'v3';
    const bigClassic = await buildDraftMessages(4, `NEWEST-ROW-MARKER${filler}`);
    process.env.SYSTEM_PROMPT_VERSION = 'v4';
    check('the classic layout (v3) is guarded the same way',
        bigClassic.meta.trimmed > 0 && promptTokens(bigClassic.messages) <= MAX_CONTEXT_TOKENS
            && !bigClassic.messages[0].content.includes('OLDEST-ROW-MARKER') && bigClassic.meta.historyMessages >= 1
            // the newest stored message is the last history line, right before LATEST MESSAGE
            && /\[[^\n]*NEWEST-ROW-MARKER[^\n]*\n\nLATEST MESSAGE/.test(bigClassic.messages[0].content),
        `${JSON.stringify(bigClassic.meta)} ~${promptTokens(bigClassic.messages)} tokens`);

    print('\n-- the measuring itself --');
    const caps = renderStyleNotes(describeStyle(['Hello there...', 'Ok...', 'Cool'], []));
    check('capital letters and "..." habits are noticed', caps.includes('starts a message with a capital letter') && caps.includes('trails off with "..."'), caps);
    const fewMessages = renderStyleNotes(describeStyle(['ha'], []));
    check('with only 1-2 of your messages, the notes say so instead of inventing habits',
        fewMessages.includes('only 1 message so far') && !fewMessages.includes('Length:'), fewMessages);
    const noEmoji = renderStyleNotes(describeStyle(['ha', 'nahi re', 'chal'], []));
    check('no emojis in your messages => "almost never. Do not add them."', noEmoji.includes('almost never. Do not add them.'), noEmoji);
    check('Devanagari never enters the vocabulary', !/[ऀ-ॿ]/.test(renderStyleNotes(describeStyle(['हो ok', 'नाही re', 'ok'], []))));
    check('the v4 file keeps your rules: Roman letters only, and the "negative" hand-off',
        /ALWAYS use Roman \(English\) letters/.test(fileText('v4')) && /reply exactly: negative/.test(fileText('v4')));

    const failed = results.filter(r => !r.pass).length;
    print(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    print('  FAIL  the test crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
