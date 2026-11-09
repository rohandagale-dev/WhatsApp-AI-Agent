/**
 * The mood reader (services/moodService.js), offline.
 *
 *   - its answer is validated before use: missing fields, wrong types or an
 *     unknown energy level are rejected, long text is capped;
 *   - the transcript it reads never includes AI-written or mock rows;
 *   - it never blocks a draft: a network error, bad JSON or MOOD_ANALYSIS=false
 *     all return null (and MOOD_ANALYSIS=false makes no call at all).
 *
 * A fake Groq client stands in for the real one -- no network.
 *
 *   node tests/testMood.js        (npm run test:mood)
 *
 * Exits non-zero if any case fails.
 */
'use strict';

process.env.MOOD_ANALYSIS = 'true';
process.env.GROQ_MODEL_ANALYSIS = 'openai/gpt-oss-20b';

const path = require('path');
const print = console.log.bind(console);
console.warn = () => {};
const { analyzeMoment, validateMoment, transcriptOf } = require(path.join(__dirname, '..', 'services', 'moodService.js'));

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass: !!pass });
    let line = `${pass ? '  PASS' : '  FAIL'}  ${name}`;
    if (!pass && detail !== undefined) line += `\n        ${String(detail).slice(0, 300)}`;
    print(line);
}

const GOOD = { last_exchange: 'Rohan asked a question; they answered it', mood: 'bored, playful', energy: 'high', intent: 'attention',
    topic: 'outfits', relationship: 'flirty / romantic', rohan_pattern: 'teases back', missing_context: '', needs_rohan: false, needs_rohan_reason: '' };
const fakeClient = (answer, calls = []) => ({
    chat: { completions: { create: async (req) => { calls.push(req); if (answer instanceof Error) throw answer; return { choices: [{ message: { content: answer } }] }; } } }
});
const human = { source: 'human' };
const ROWS = [
    { direction: 'INCOMING', message: 'meko bore ho raha', metadata: human },
    { direction: 'OUTGOING', message: 'kya krri he fir?', metadata: human },
    { direction: 'OUTGOING', message: 'BOT SAID THIS', metadata: { source: 'ai' } },
    { direction: 'INCOMING', message: 'MOCK', metadata: { source: 'mock' } },
    { direction: 'INCOMING', message: 'trying outfits 🤭', metadata: human }
];

(async () => {
    print('\n-- validation --');
    const v = validateMoment(GOOD);
    check('a good answer is accepted and tidied', v && v.mood === 'bored, playful' && v.rohanPattern === 'teases back' && v.needsRohan === false, JSON.stringify(v));
    check('a missing field is rejected', validateMoment({ ...GOOD, intent: undefined }) === null);
    check('the last exchange (who said what) is required and kept',
        validateMoment({ ...GOOD, last_exchange: undefined }) === null && v.lastExchange === 'Rohan asked a question; they answered it');
    check('an unknown energy level is rejected', validateMoment({ ...GOOD, energy: 'very high' }) === null);
    check('"what is missing from the chat" is required and kept',
        validateMoment({ ...GOOD, missing_context: undefined }) === null
            && validateMoment({ ...GOOD, missing_context: 'which colour they mean' }).missingContext === 'which colour they mean');
    check('a non-boolean needs_rohan is rejected', validateMoment({ ...GOOD, needs_rohan: 'yes' }) === null);
    check('an empty mood is rejected', validateMoment({ ...GOOD, mood: '   ' }) === null);
    check('long text is capped', validateMoment({ ...GOOD, topic: 'x'.repeat(500) }).topic.length <= 160);
    check('needs_rohan_reason is dropped when needs_rohan is false', validateMoment({ ...GOOD, needs_rohan_reason: 'stale' }).needsRohanReason === '');

    print('\n-- what it reads --');
    const t = transcriptOf(ROWS, 'trying outfits 🤭');
    check('the transcript labels both sides', t.includes('THEM: meko bore ho raha') && t.includes('ROHAN: kya krri he fir?'), t);
    check('AI-written and mock rows are left out', !t.includes('BOT SAID THIS') && !t.includes('MOCK'), t);
    check('their latest message is not added twice', t.split('trying outfits').length === 2, t);

    print('\n-- calling the model --');
    const calls = [];
    const m = await analyzeMoment(ROWS, 'trying outfits 🤭', { client: fakeClient(JSON.stringify(GOOD), calls) });
    check('a valid answer comes back as a clean object', m && m.mood === 'bored, playful' && m.relationship === 'flirty / romantic');
    check('it asks GROQ_MODEL_ANALYSIS for strict structured output',
        calls[0] && calls[0].model === 'openai/gpt-oss-20b' && calls[0].response_format.json_schema.strict === true);
    check('a network error returns null instead of throwing', await analyzeMoment(ROWS, 'x', { client: fakeClient(new Error('429 rate limit')) }) === null);
    check('broken JSON returns null', await analyzeMoment(ROWS, 'x', { client: fakeClient('{not json') }) === null);
    check('a schema-violating answer returns null', await analyzeMoment(ROWS, 'x', { client: fakeClient(JSON.stringify({ mood: 'ok' })) }) === null);
    process.env.MOOD_ANALYSIS = 'false';
    const offCalls = [];
    check('MOOD_ANALYSIS=false returns null and makes no call',
        await analyzeMoment(ROWS, 'x', { client: fakeClient(JSON.stringify(GOOD), offCalls) }) === null && offCalls.length === 0);

    const failed = results.filter(r => !r.pass).length;
    print(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    print('  FAIL  the test crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
