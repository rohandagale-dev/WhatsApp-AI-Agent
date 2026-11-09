/**
 * What goes into a WhatsApp draft's prompt (services/promptService.js).
 *
 * Persona:
 *   - a contact with its own persona in relation_persons keeps it;
 *   - a contact without one (no row, or an empty my_persona) gets the base
 *     system prompt file, system_prompts/system_prompt_<SYSTEM_PROMPT_VERSION>.txt
 *     (v3 by default) -- not the old one-line fallback;
 *   - if that file is missing, the one-liner is still there as a last resort.
 *
 * Per-contact context:
 *   - history AND style examples come only from the contact being answered;
 *     one chat's messages never appear in another contact's prompt
 *     (EXEMPLAR_SCOPE=contact, the default).
 *
 * Offline: Supabase is replaced by an in-memory fake.
 *
 *   node tests/testPromptPersona.js        (npm run test:persona)
 *
 * Exits non-zero if any case fails.
 */
'use strict';

const fs = require('fs');
const Module = require('module');
const path = require('path');

// Pinned before promptService loads .env (dotenv never overrides a set variable).
process.env.SYSTEM_PROMPT_VERSION = 'v3';
process.env.EXEMPLAR_SCOPE = 'contact';

const ROOT = path.join(__dirname, '..');
const ONE_LINER = 'You are Rohan, chill, sarcastic and supportive. Reply briefly.';
const fileText = version => fs.readFileSync(path.join(ROOT, 'system_prompts', `system_prompt_${version}.txt`), 'utf8');
// promptService trims trailing spaces per line; compare content, not whitespace.
const same = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();

const print = console.log.bind(console);
const results = [];
function check(name, pass, detail) {
    results.push({ name, pass: !!pass });
    let line = `${pass ? '  PASS' : '  FAIL'}  ${name}`;
    if (!pass && detail !== undefined) line += `\n        ${String(detail).slice(0, 200)}`;
    print(line);
}

// Fake Supabase. Contact 1 has its own chat; contacts 2 and 3 have none.
const CONTACTS = {
    1: { id: 1, notes: null, relationPerson: { my_persona: 'CUSTOM PERSONA FOR THIS CONTACT' } },
    2: { id: 2, notes: null, relationPerson: null },                                  // no persona row
    3: { id: 3, notes: null, relationPerson: { my_persona: '   ', my_dictionary: 'ha, nako' } }  // empty persona, like Mrudu
};
const human = { source: 'human' };
const CHATS = [
    { contact_id: 1, direction: 'INCOMING', message: 'contact one asks something', metadata: human, created_at: '2026-01-01T09:59:00Z' },
    { contact_id: 1, direction: 'OUTGOING', message: 'only for contact one haha pakka', metadata: human, created_at: '2026-01-01T10:00:00Z' },
    { contact_id: 1, direction: 'OUTGOING', message: 'another line just for contact one', metadata: human, created_at: '2026-01-01T10:01:00Z' },
    { contact_id: 1, direction: 'OUTGOING', message: 'हो नक्की contact one', metadata: human, created_at: '2026-01-01T10:02:00Z' }
];
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

// Keep the module's own notes (missing-file warning etc.) out of the report.
console.log = console.warn = () => {};

const { buildDynamicPrompt, EXEMPLAR_SCOPE } = require(path.join(ROOT, 'services', 'promptService.js'));

/** The MY PERSONA section of a built prompt. */
function personaOf(prompt) {
    const start = prompt.indexOf('MY PERSONA:\n');
    if (start < 0) return null;
    const body = prompt.slice(start + 'MY PERSONA:\n'.length);
    const ends = ['\n\nMY DICTIONARY:', "\n\nUSER'S PERSONA:"].map(h => body.indexOf(h)).filter(i => i >= 0);
    return body.slice(0, Math.min(...ends)).trim();
}

(async () => {
    print('\n-- which persona a draft gets --');
    const custom = personaOf(await buildDynamicPrompt(1, 'hi'));
    check('a contact with its own persona keeps it', custom === 'CUSTOM PERSONA FOR THIS CONTACT', custom);

    const noRow = personaOf(await buildDynamicPrompt(2, 'hi'));
    check('a contact with no persona row gets system_prompt_v3.txt', same(noRow, fileText('v3')), noRow);

    const empty = personaOf(await buildDynamicPrompt(3, 'hi'));
    check('an empty persona (like Mrudu) also gets system_prompt_v3.txt', same(empty, fileText('v3')), empty);

    check('neither gets the old one-liner any more', noRow !== ONE_LINER && empty !== ONE_LINER);

    print('\n-- every contact gets only its own chat --');
    check('EXEMPLAR_SCOPE defaults to "contact"', EXEMPLAR_SCOPE === 'contact', EXEMPLAR_SCOPE);
    const own = await buildDynamicPrompt(1, 'hi');
    check('a contact sees its own messages as "how I text" examples',
        /HOW I ACTUALLY TEXT[\s\S]*- only for contact one haha pakka/.test(own), own);
    check('...and in its own history', /\] Assistant: another line just for contact one/.test(own));
    const examples = (own.match(/HOW I ACTUALLY TEXT[^\n]*\n((?:- [^\n]*\n?)*)/) || [])[1] || '';
    check('a message written in Devanagari is never used as a style example',
        examples.includes('only for contact one') && !/[ऀ-ॿ]/.test(examples), examples);
    const other = await buildDynamicPrompt(2, 'hi');
    check("another contact's chat never appears in this prompt (history or examples)",
        !/contact one/.test(other), other);
    check('a contact with no messages of its own gets no borrowed examples', !/HOW I ACTUALLY TEXT/.test(other));

    print('\n-- choosing and falling back --');
    process.env.SYSTEM_PROMPT_VERSION = 'v2';
    const v2 = personaOf(await buildDynamicPrompt(2, 'hi'));
    check('SYSTEM_PROMPT_VERSION=v2 switches to system_prompt_v2.txt (read per draft, no restart)', same(v2, fileText('v2')), v2);

    process.env.SYSTEM_PROMPT_VERSION = 'v_missing';
    const missing = personaOf(await buildDynamicPrompt(2, 'hi'));
    check('if the file is missing, the one-liner is still the last resort', missing === ONE_LINER, missing);

    const failed = results.filter(r => !r.pass).length;
    print(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    print('  FAIL  the test crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
