/**
 * Derives relation_persons.my_dictionary from Rohan's own outgoing messages.
 *
 * my_dictionary is injected into the prompt as "MY DICTIONARY" -- it is meant to
 * be the vocabulary that makes a reply sound like Rohan instead of like a
 * helpful assistant. Hand-writing it per contact does not scale and it is empty
 * for the contacts that matter, so mine it from what he actually typed.
 *
 *   node scripts/deriveDictionary.js --phone=918485078050
 *   node scripts/deriveDictionary.js --all
 *   node scripts/deriveDictionary.js --phone=918485078050 --limit=25 --min-count=3 --apply
 *   node scripts/deriveDictionary.js --all --source=any          (see the warning below)
 *
 * Flags:
 *   --phone=<number>   derive for one contact (matched on contacts.phone)
 *   --all              derive for every contact that has qualifying messages
 *   --limit=<n>        how many words to emit          (default 40; prompt caps at 100)
 *   --min-count=<n>    ignore words seen fewer times   (default 2)
 *   --min-messages=<n> low-sample floor                (default 20)
 *   --source=<s>       'human' (default) or 'any'
 *   --keep=a,b,c       force these words past the English stop-list (see HOMOGRAPHS)
 *   --apply            actually write my_dictionary. Without it this is a DRY RUN.
 *   --help
 *
 * PROVENANCE: only OUTGOING rows are read (messages Rohan sent), and by default
 * only those with metadata->>'source' = 'human'. Rows the agent wrote ('ai'),
 * synthetic seed rows ('mock') and legacy rows with metadata = NULL are excluded
 * -- feeding the model's own output back as "Rohan's vocabulary" is exactly the
 * self-imitation loop this work exists to break. --source=any widens the net and
 * is loudly warned about; it is a preview mode, and --apply refuses to run under it.
 */
require('../loadEnv');
const { supabase } = require('../services/supabaseClient');

const DEFAULT_LIMIT = 40;
const DEFAULT_MIN_COUNT = 2;
// Below this many qualifying messages the ranking is noise, not a voice print.
const DEFAULT_MIN_MESSAGES = 20;
// services/promptService.js splits my_dictionary on "," and slices to 100 words.
const PROMPT_DICTIONARY_CAP = 100;
// PostgREST caps a single response, so paging is not optional on a big table.
const PAGE_SIZE = 1000;

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const int = (name, fallback) => {
    const raw = arg(name, null);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1) {
        console.error(`--${name} must be a positive integer (got "${raw}")`);
        process.exit(1);
    }
    return n;
};

// ---------------------------------------------------------------------------
// English reference vocabulary
// ---------------------------------------------------------------------------

// Hard filter. Function words and chat boilerplate carry no voice signal at all.
const STOP_WORDS = new Set([
    'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'another',
    'any', 'anything', 'are', 'arent', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
    'below', 'between', 'both', 'but', 'by', 'can', 'cannot', 'cant', 'could', 'couldnt',
    'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each',
    'either', 'else', 'even', 'ever', 'every', 'few', 'for', 'from', 'further', 'had',
    'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he', 'hed', 'hell', 'her', 'here',
    'heres', 'hers', 'herself', 'hes', 'him', 'himself', 'his', 'how', 'hows', 'i', 'id',
    'if', 'ill', 'im', 'in', 'into', 'is', 'isnt', 'it', 'its', 'itself', 'ive', 'just',
    'lets', 'me', 'more', 'most', 'much', 'must', 'my', 'myself', 'no', 'nor', 'not',
    'nothing', 'now', 'of', 'off', 'on', 'once', 'one', 'only', 'or', 'other', 'others',
    'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'shall', 'she',
    'shes', 'should', 'shouldnt', 'so', 'some', 'something', 'such', 'than', 'that',
    'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'theres',
    'these', 'they', 'theyll', 'theyre', 'theyve', 'this', 'those', 'though', 'through',
    'to', 'too', 'under', 'until', 'up', 'us', 'very', 'was', 'wasnt', 'we', 'well',
    'were', 'weve', 'what', 'whats', 'when', 'where', 'which', 'while', 'who', 'whom',
    'whos', 'why', 'will', 'with', 'without', 'wont', 'would', 'wouldnt', 'yes', 'yet',
    'you', 'youd', 'youll', 'your', 'youre', 'yours', 'yourself', 'youve',
    // chat boilerplate that every English speaker types
    'hi', 'hello', 'hey', 'ok', 'okay', 'okk', 'thanks', 'thank', 'thankyou', 'please',
    'sorry', 'bye', 'pls', 'plz',
    // WhatsApp export / media artefacts
    'media', 'omitted', 'image', 'video', 'audio', 'sticker', 'gif', 'document', 'deleted',
    'http', 'https', 'www', 'com'
]);

// Soft demotion. Approximate occurrences per million words of ordinary English.
// These survive the stop-list but are still unremarkable, so they must not
// outrank a genuinely Rohan-shaped word that happens to be less frequent. Only
// the order of magnitude matters -- the score takes a log of this number.
const ENGLISH_PER_MILLION = {
    good: 1100, time: 1900, know: 1500, think: 900, going: 700, go: 900, goes: 120,
    went: 300, right: 800, need: 500, needed: 90, work: 900, working: 200, day: 800,
    days: 300, see: 900, seen: 200, come: 700, coming: 200, came: 400, back: 900,
    take: 700, taking: 120, took: 250, make: 800, making: 150, made: 400, look: 700,
    looking: 200, way: 800, people: 800, person: 200, thing: 500, things: 400,
    really: 400, new: 1000, old: 500, first: 1000, second: 200, last: 600, next: 400,
    long: 700, little: 500, great: 500, big: 400, small: 300, lot: 300, sure: 300,
    done: 300, said: 1600, say: 800, saying: 150, tell: 300, told: 250, ask: 200,
    asked: 200, give: 400, given: 150, get: 900, getting: 150, got: 700, find: 400,
    found: 300, call: 300, called: 250, help: 300, try: 300, trying: 150, keep: 300,
    let: 400, put: 300, use: 400, used: 400, using: 150, feel: 300, feeling: 100,
    seem: 200, leave: 200, left: 300, still: 700, always: 400, never: 500, often: 200,
    sometimes: 100, today: 200, tomorrow: 60, yesterday: 60, morning: 150, evening: 80,
    night: 250, home: 400, house: 400, room: 300, man: 1100, guy: 100, girl: 200,
    friend: 200, friends: 150, life: 700, world: 600, year: 900, years: 700, week: 200,
    month: 100, place: 500, name: 300, number: 200, part: 600, problem: 200, issue: 100,
    question: 200, money: 300, food: 100, water: 300, phone: 100, message: 60, msg: 20,
    meeting: 100, office: 100, class: 150, school: 300, college: 60, book: 300,
    game: 200, bad: 300, nice: 100, cool: 40, fine: 200, better: 400, best: 400,
    worse: 60, wait: 150, waiting: 80, stop: 200, start: 300, started: 150, end: 400,
    open: 300, close: 200, hope: 100, mean: 300, means: 200, maybe: 150, actually: 100,
    probably: 100, already: 200, enough: 300, together: 200, away: 300, around: 400,
    soon: 100, late: 200, early: 200, ready: 100, free: 200, sir: 100, love: 400,
    like: 1800, want: 700, send: 150, sent: 150, check: 150, sleep: 100, eat: 100,
    watch: 150, read: 300, write: 200, talk: 200, meet: 150, bring: 200, buy: 150,
    pay: 150, lol: 50, haha: 20, hahaha: 6, yeah: 200, yep: 10, yup: 5, nope: 10,
    nah: 15, hmm: 10, uh: 20, oh: 200, wow: 20
};

// Anything absent from the table above is assumed rare in ordinary English. That
// is the whole trick: Hinglish/Marathi tokens land here and pick up the maximum
// rarity weight without needing a Hindi or Marathi reference corpus.
const UNKNOWN_PER_MILLION = 0.5;

// Hinglish/Marathi words that are homographs of English function words and so
// get swallowed by STOP_WORDS: "he" (hai), "to" (toh), "me" (mein), "hi"
// (Marathi "this"), "so", "in", "am". Nothing at the token level can tell them
// apart, so the English reading wins by default and --keep is the escape hatch:
//   node scripts/deriveDictionary.js --phone=... --keep=he,to,me
const HOMOGRAPHS = ['he', 'to', 'me', 'hi', 'so', 'in', 'am', 'is', 'a', 'an'];

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

// Unicode-aware on purpose. \p{M} is required or Devanagari gets shredded: "काय"
// is क + ा (a nonspacing mark) + य, so a \p{L}-only class would split it into
// pieces. ZWNJ/ZWJ (U+200C/U+200D) hold conjuncts together. No ASCII filter and
// no stemming -- "sahiye" and "sahi" are different words in this voice.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d'-]*/gu;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;

function tokenise(text) {
    if (!text) return [];
    const cleaned = String(text)
        .replace(URL_RE, ' ')
        // curly apostrophes -> straight, so "don't" and "don’t" are one word
        .replace(/[\u2018\u2019]/g, "'");

    const out = [];
    for (const match of cleaned.matchAll(WORD_RE)) {
        // toLowerCase is a no-op on Devanagari, which is caseless.
        const word = match[0].toLowerCase().replace(/^['-]+|['-]+$/g, '');
        if (word.length < 2) continue;          // single letters are never vocabulary
        if (/^[\p{N}]+$/u.test(word)) continue; // bare numbers: "10", "2025", "411058"
        out.push(word);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
//
// WHY NOT RAW FREQUENCY: the top of a raw count is "the", "hai", "ok" -- English
// filler plus things every Hinglish speaker types. A dictionary of those tells
// the model nothing about Rohan in particular, and it spends prompt budget
// teaching the model words it already produces.
//
// The measure here is TF-IDF where the IDF comes from an EXTERNAL English
// reference rather than from the corpus itself. In-corpus IDF is meaningless
// when the corpus is one person's chat log: every word has near-identical
// document frequency, so it degenerates back to raw counts. Three factors,
// multiplied:
//
//   1. log2(1 + count)  -- how much he uses it, damped. A word used 40 times is
//                          more characteristic than one used 4, but not 10x more.
//   2. log2(1 + docs)   -- across how many distinct messages. This is the
//                          burstiness penalty: an address or a pasted block
//                          repeated inside one message racks up `count` but has
//                          docs = 1, so it cannot climb the ranking.
//   3. log2(1e6 / p_en) -- rarity in ordinary English, from ENGLISH_PER_MILLION,
//                          falling back to UNKNOWN_PER_MILLION. This is what
//                          lifts "nivant"/"bhava"/"sahiye" above "good"/"time".
//
// The spread between a word unknown to English (rarity ~21) and a very common
// one (~9) is about 2.3x -- enough to demote ordinary English decisively without
// letting a single freak token beat a word he genuinely leans on. Ties break on
// raw count then alphabetically, so the output is deterministic.

// hasOwnProperty, not a bare lookup: a message containing "constructor" or
// "toString" would otherwise resolve to an inherited function and make the whole
// score NaN. Developers do type those words into WhatsApp.
function englishFrequency(word) {
    return Object.prototype.hasOwnProperty.call(ENGLISH_PER_MILLION, word)
        ? ENGLISH_PER_MILLION[word]
        : UNKNOWN_PER_MILLION;
}

function rarity(word) {
    return Math.log2(1e6 / englishFrequency(word));
}

function score(count, docs, word) {
    return Math.log2(1 + count) * Math.log2(1 + docs) * rarity(word);
}

/**
 * @param {string[]}    messages  qualifying OUTGOING message bodies
 * @param {Set<string>} keep      words exempted from the stop-list
 */
function rankVocabulary(messages, keep) {
    const counts = new Map();
    const docs = new Map();

    for (const message of messages) {
        const seen = new Set();
        for (const token of tokenise(message)) {
            if (STOP_WORDS.has(token) && !keep.has(token)) continue;
            counts.set(token, (counts.get(token) || 0) + 1);
            if (!seen.has(token)) {
                seen.add(token);
                docs.set(token, (docs.get(token) || 0) + 1);
            }
        }
    }

    return [...counts.entries()]
        .map(([word, count]) => ({
            word,
            count,
            docs: docs.get(word) || 0,
            score: score(count, docs.get(word) || 0, word),
            known: englishFrequency(word) !== UNKNOWN_PER_MILLION
        }))
        .sort((a, b) => (b.score - a.score) || (b.count - a.count) || a.word.localeCompare(b.word));
}

// ---------------------------------------------------------------------------
// Data access (read-only apart from the --apply write)
// ---------------------------------------------------------------------------

/**
 * Every OUTGOING row, paged. Provenance filtering happens in JS rather than in
 * the query so the report can show the full breakdown -- including why the
 * human-only count is zero -- instead of silently returning nothing.
 */
async function fetchOutgoing(contactIds) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        let query = supabase
            .from('chats')
            .select('contact_id, message, metadata')
            .eq('direction', 'OUTGOING')
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (contactIds) query = query.in('contact_id', contactIds);

        const { data, error } = await query;
        if (error) throw error;
        rows.push(...data);
        if (data.length < PAGE_SIZE) break;
    }
    return rows;
}

/** 'human' | 'ai' | 'mock' | 'unknown' (legacy rows with metadata = NULL). */
function provenanceOf(row) {
    if (!row.metadata || !row.metadata.source) return 'unknown';
    return row.metadata.source;
}

async function fetchContacts(ids) {
    const { data, error } = await supabase
        .from('contacts').select('id, phone, name').in('id', ids);
    if (error) throw error;
    return new Map(data.map((c) => [c.id, c]));
}

async function fetchStoredDictionaries(ids) {
    const { data, error } = await supabase
        .from('relation_persons').select('contact_id, my_dictionary').in('contact_id', ids);
    if (error) throw error;
    return new Map(data.map((r) => [r.contact_id, r.my_dictionary]));
}

async function writeDictionary(contactId, dictionary) {
    // Only these two columns are in the payload, so PostgREST's ON CONFLICT DO
    // UPDATE touches only them -- my_persona / user_persona / style / rules on an
    // existing row are left exactly as they were.
    const { error } = await supabase
        .from('relation_persons')
        .upsert({ contact_id: contactId, my_dictionary: dictionary }, { onConflict: 'contact_id' });
    if (error) throw error;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printUsage() {
    console.log([
        "Derive relation_persons.my_dictionary from Rohan's own outgoing messages.",
        '',
        '  node scripts/deriveDictionary.js --phone=<number> [options]',
        '  node scripts/deriveDictionary.js --all [options]',
        '',
        `  --limit=<n>         words to emit                 (default ${DEFAULT_LIMIT}, prompt caps at ${PROMPT_DICTIONARY_CAP})`,
        `  --min-count=<n>     ignore words seen fewer times (default ${DEFAULT_MIN_COUNT})`,
        `  --min-messages=<n>  low-sample floor              (default ${DEFAULT_MIN_MESSAGES})`,
        '  --source=human|any  provenance filter             (default human)',
        `  --keep=a,b,c        force words past the English stop-list, e.g. ${HOMOGRAPHS.slice(0, 3).join(',')}`,
        '  --apply             write to the database (default is a dry run)'
    ].join('\n'));
}

function label(contact, id) {
    const bits = [`contact ${id}`];
    if (contact && contact.phone) bits.push(contact.phone);
    if (contact && contact.name) bits.push(contact.name);
    return bits.join('  ');
}

function printWarning(lines) {
    const width = Math.max(...lines.map((l) => l.length));
    const bar = '!'.repeat(width + 4);
    console.log(bar);
    for (const line of lines) console.log(`! ${line.padEnd(width)} !`);
    console.log(bar);
}

// ---------------------------------------------------------------------------

async function main() {
    if (flag('help') || process.argv.length <= 2) {
        printUsage();
        return 0;
    }

    const PHONE = arg('phone', null);
    const ALL = flag('all');
    const APPLY = flag('apply');
    const SOURCE = arg('source', 'human');
    const LIMIT = int('limit', DEFAULT_LIMIT);
    const MIN_COUNT = int('min-count', DEFAULT_MIN_COUNT);
    const MIN_MESSAGES = int('min-messages', DEFAULT_MIN_MESSAGES);
    const KEEP = new Set(
        arg('keep', '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
    );

    if (PHONE && ALL) {
        console.error('Choose either --phone=<number> or --all, not both.');
        return 1;
    }
    if (!PHONE && !ALL) {
        console.error('Nothing to do: pass --phone=<number> or --all (--help for usage).');
        return 1;
    }
    if (SOURCE !== 'human' && SOURCE !== 'any') {
        console.error(`--source must be 'human' or 'any' (got "${SOURCE}")`);
        return 1;
    }
    if (LIMIT > PROMPT_DICTIONARY_CAP) {
        console.log(`Note: --limit=${LIMIT} exceeds the ${PROMPT_DICTIONARY_CAP}-word cap applied in`
            + ' promptService.js; the surplus would be sliced off at prompt-build time.\n');
    }

    if (SOURCE === 'any') {
        printWarning([
            'WARNING: --source=any',
            '',
            'AI-authored replies, mock seed rows and legacy rows of unknown origin',
            'are being counted as if Rohan typed them. The agent then relearns its',
            "own output as \"Rohan's vocabulary\" -- the exact self-imitation loop",
            'that provenance tracking exists to break. Provider error strings that',
            'were stored as outgoing messages get mined too.',
            '',
            'PREVIEW ONLY: --apply is refused while --source=any.'
        ]);
        console.log('');
    }

    // Resolve targets.
    let contactIds = null;
    if (PHONE) {
        const { data: contact, error } = await supabase
            .from('contacts').select('id').eq('phone', PHONE).maybeSingle();
        if (error) throw error;
        if (!contact) {
            console.error(`Contact ${PHONE} not found in contacts.`);
            return 1;
        }
        contactIds = [contact.id];
    }

    const rows = await fetchOutgoing(contactIds);
    if (!rows.length) {
        console.log(PHONE
            ? `No OUTGOING messages at all for ${PHONE}. Nothing to derive.`
            : 'No OUTGOING messages in the chats table. Nothing to derive.');
        return APPLY ? 1 : 0;
    }

    // Group by contact, counting provenance as we go.
    const byContact = new Map();
    for (const row of rows) {
        if (!byContact.has(row.contact_id)) {
            byContact.set(row.contact_id, {
                all: [],
                counts: { human: 0, ai: 0, mock: 0, unknown: 0 }
            });
        }
        const bucket = byContact.get(row.contact_id);
        bucket.all.push(row);
        const src = provenanceOf(row);
        bucket.counts[src] = (bucket.counts[src] || 0) + 1;
    }

    const ids = [...byContact.keys()].sort((a, b) => a - b);
    const contacts = await fetchContacts(ids);
    const stored = await fetchStoredDictionaries(ids);

    console.log(`Provenance filter: source=${SOURCE}`
        + (SOURCE === 'human' ? "  (metadata->>'source' = 'human')" : '  (EVERY outgoing row)'));
    console.log(`Mode: ${APPLY ? 'APPLY (will write my_dictionary)' : 'DRY RUN (nothing will be written)'}`);
    console.log(`Ranking: log2(1+count) x log2(1+messages) x English-rarity`);
    console.log(`Contacts with outgoing messages: ${ids.length}\n`);

    let written = 0;
    let refused = 0;

    for (const id of ids) {
        const { all, counts } = byContact.get(id);
        console.log('-'.repeat(72));
        console.log(label(contacts.get(id), id));
        console.log(`  OUTGOING rows: ${all.length}`
            + `   (human ${counts.human} | ai ${counts.ai} | mock ${counts.mock}`
            + ` | unknown/legacy ${counts.unknown})`);

        const qualifying = SOURCE === 'any'
            ? all
            : all.filter((r) => provenanceOf(r) === 'human');
        console.log(`  Considered under source=${SOURCE}: ${qualifying.length}`);

        if (!qualifying.length) {
            console.log('  SKIP: no qualifying messages.');
            if (SOURCE === 'human' && counts.unknown === all.length) {
                console.log('        Every row predates provenance tracking (metadata IS NULL), so');
                console.log('        none of them can be trusted as human-authored. Load real');
                console.log('        messages first:');
                console.log('          node scripts/importWhatsAppExport.js --file=<export.txt> \\');
                console.log(`            --phone=${(contacts.get(id) || {}).phone || '<number>'} --me="Rohan"`);
                console.log('        then re-run this. --source=any previews the ranking meanwhile.');
            }
            console.log(`  Stored my_dictionary: ${JSON.stringify(stored.has(id) ? stored.get(id) : null)}`);
            if (APPLY) refused++;
            continue;
        }

        const ranked = rankVocabulary(qualifying.map((r) => r.message), KEEP);
        const eligible = ranked.filter((r) => r.count >= MIN_COUNT);
        const top = eligible.slice(0, LIMIT);
        const dictionary = top.map((r) => r.word).join(', ');

        console.log(`  Distinct words after stop-list: ${ranked.length}`
            + `   (${eligible.length} seen >= ${MIN_COUNT}x,`
            + ` ${ranked.length - eligible.length} below --min-count)`);

        if (top.length) {
            console.log('\n  rank  word                      count   msgs    score');
            top.forEach((r, i) => {
                console.log(`  ${String(i + 1).padStart(4)}  ${r.word.padEnd(24)}`
                    + `${String(r.count).padStart(5)}${String(r.docs).padStart(7)}`
                    + `${r.score.toFixed(1).padStart(9)}`
                    + `${r.known ? '   (common English)' : ''}`);
            });
        }

        console.log(`\n  Derived my_dictionary (${top.length} words):`);
        console.log(`    ${dictionary || '(empty)'}`);
        console.log(`  Stored my_dictionary: ${JSON.stringify(stored.has(id) ? stored.get(id) : null)}`);

        // Low-sample guard. A dictionary built from a handful of messages is
        // noise wearing the costume of a voice print, and it gets injected into
        // every future prompt for this contact -- strictly worse than leaving
        // the field empty and letting the persona and exemplars carry the style.
        if (qualifying.length < MIN_MESSAGES) {
            console.log(`\n  LOW SAMPLE: ${qualifying.length} qualifying message(s), need at least ${MIN_MESSAGES}.`);
            console.log('  The ranking above is not meaningful -- treat it as a curiosity, not a');
            console.log('  dictionary. Refusing to store it.');
            if (APPLY) {
                console.log('  --apply IGNORED for this contact.');
                refused++;
            }
            continue;
        }

        if (!top.length) {
            console.log(`\n  Nothing met --min-count=${MIN_COUNT}. Refusing to write an empty dictionary.`);
            if (APPLY) refused++;
            continue;
        }

        if (!APPLY) {
            console.log('\n  DRY RUN: nothing written. Re-run with --apply to store this.');
            continue;
        }

        if (SOURCE === 'any') {
            console.log('\n  REFUSING to --apply under --source=any: the result is contaminated by');
            console.log('  AI/mock/unknown text. Re-run with the default --source=human.');
            refused++;
            continue;
        }

        await writeDictionary(id, dictionary);
        console.log(`\n  APPLIED: relation_persons.my_dictionary updated for contact ${id}.`);
        written++;
    }

    console.log('-'.repeat(72));
    if (APPLY) {
        console.log(`Done. ${written} contact(s) written, ${refused} refused.`);
        return written === 0 ? 1 : 0;
    }
    console.log('Dry run complete. Nothing was written.');
    return 0;
}

module.exports = { tokenise, rankVocabulary, score, rarity, STOP_WORDS, HOMOGRAPHS };

if (require.main === module) {
    // Set exitCode and let the loop drain rather than calling process.exit().
    // Forcing an exit while a supabase-js (undici) socket is still tearing down
    // trips a libuv assertion on Windows -- "!(handle->flags & UV_HANDLE_CLOSING)"
    // -- which replaces the intended exit code with a 127 crash and makes the
    // refusal paths look like the script itself blew up.
    main()
        .then((code) => { process.exitCode = code || 0; })
        .catch((e) => {
            console.error('deriveDictionary failed:', e.message || e);
            process.exitCode = 1;
        });
}
