/**
 * Table-driven check of services/sanitizeReply.js.
 *
 * Pure and offline -- no DB, no network, no test framework. It asserts the two
 * halves of the contract that pull against each other:
 *
 *   1. typographic junk a phone keyboard cannot produce is normalised away
 *      (the real regression: the model wrote "B-10" with U+2011 NON-BREAKING
 *      HYPHEN where the source row had a plain ASCII '-'), and
 *   2. Marathi / Hindi Devanagari and ordinary Hinglish come out byte for byte
 *      identical, including the zero-width joiners Devanagari actually needs.
 *
 *   node tests/testSanitizeReply.js
 *
 * Exits non-zero if any case fails.
 */
const sanitizeModule = require('../services/sanitizeReply');
const { sanitizeReply } = sanitizeModule;

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    let line = `${pass ? '  PASS' : '  FAIL'}  ${name}`;
    if (!pass && detail) line += `\n        ${detail}`;
    console.log(line);
}

// The characters this module exists to police, plus controls. They get escaped
// when printing a failure, because otherwise the expected and actual strings
// are the same picture and the diff is unreadable.
const SNEAKY = /[\u0000-\u001F\u007F\u00A0\u00AD\u180E\u2000-\u200F\u2028\u2029\u202A-\u202F\u205F\u2060-\u2064\u2066-\u2069\u3000\uFE0E\uFE0F\uFEFF\u2010-\u2015\u2018-\u201F\u2032-\u2036\u2043\u2212\u2026\u22EF\uFF02\uFF07\uFF0D]/;

function show(value) {
    if (typeof value !== 'string') {
        if (value === null) return '<null>';
        if (Array.isArray(value)) return '<array>';
        return `<${typeof value} ${String(value)}>`;
    }
    let out = '';
    for (const ch of value) {                   // iterate code points, so emoji stay whole
        if (ch === '\n') out += '\\n';
        else if (ch === '\t') out += '\\t';
        else if (SNEAKY.test(ch)) out += '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
        else out += ch;
    }
    return `"${out}"`;
}

// `unchanged: true` asserts output === input, which is the stronger claim for
// text that must survive the sanitiser untouched.
const CASES = [
    // --- the regression that started this ---------------------------------
    {
        name: 'B-10: U+2011 NON-BREAKING HYPHEN folds to ASCII -',
        input: 'B\u201110 chalu aahe ka',
        expected: 'B-10 chalu aahe ka'
    },
    {
        name: 'B-10 already written with an ASCII hyphen is left alone',
        input: 'B-10 chalu aahe ka',
        unchanged: true
    },

    // --- dashes ------------------------------------------------------------
    {
        name: 'en, em, figure, plain hyphen and minus all fold to ASCII -',
        input: 'a\u2013b a\u2014b a\u2012b a\u2010b \u22125',
        expected: 'a-b a-b a-b a-b -5'
    },

    // --- quotes ------------------------------------------------------------
    {
        name: 'curly apostrophes become ASCII',
        input: 'don\u2019t worry, it\u2019s sorted',
        expected: "don't worry, it's sorted"
    },
    {
        name: 'curly double quotes become ASCII mid-sentence',
        input: 'he said \u201Chi\u201D to me',
        expected: 'he said "hi" to me'
    },

    // --- ellipsis ----------------------------------------------------------
    {
        name: 'ellipsis character expands to three dots',
        input: 'hmm\u2026 theek aahe',
        expected: 'hmm... theek aahe'
    },

    // --- spaces ------------------------------------------------------------
    {
        name: 'NBSP, narrow NBSP and em space become normal spaces',
        input: 'kal\u00A0bhetu\u202Fyaar\u2003nakki',
        expected: 'kal bhetu yaar nakki'
    },

    // --- zero width --------------------------------------------------------
    {
        name: 'zero width space and BOM are removed',
        input: 'ha\u200Bha\uFEFF bhava',
        expected: 'haha bhava'
    },
    {
        name: 'a stray ZWJ between Latin letters is removed',
        input: 'ok\u200Dnahi',
        expected: 'oknahi'
    },
    {
        name: 'soft hyphen is removed',
        input: 'sam\u00ADjha',
        expected: 'samjha'
    },

    // --- what must NOT change ---------------------------------------------
    {
        name: 'Marathi Devanagari survives byte for byte',
        input: 'नमस्कार, कसं चाललंय? उद्या भेटूया.',
        unchanged: true
    },
    {
        name: 'Hindi Devanagari survives byte for byte',
        input: 'क्या हाल है भाई, कल मिलते हैं शाम को।',
        unchanged: true
    },
    {
        name: 'a load-bearing ZWNJ inside Devanagari is preserved',
        input: 'हिन्\u200Cदी',
        unchanged: true
    },
    {
        name: 'ordinary Hinglish is left completely alone',
        input: 'haan bhava, kal bhetu. thoda kaam aahe - 6 nantar free',
        unchanged: true
    },
    {
        name: 'mixed Hinglish + Devanagari is left completely alone',
        input: 'arre yaar, उद्या 6 nantar free aahe - bhetu?',
        unchanged: true
    },
    {
        name: 'ASCII punctuation and digits survive even with emoji stripping on',
        input: 'call me at 9:30 (sharp) - ok? yes! #done *now*',
        opts: { allowEmoji: false },
        unchanged: true
    },

    // --- emoji -------------------------------------------------------------
    {
        name: 'emoji are kept by default',
        input: 'done 🔥',
        unchanged: true
    },
    {
        name: 'a ZWJ family emoji stays intact by default',
        input: '👨\u200D👩\u200D👧 nice',
        unchanged: true
    },
    {
        name: 'allowEmoji:false strips an emoji and closes the gap',
        input: 'thumbs 👍 up',
        opts: { allowEmoji: false },
        expected: 'thumbs up'
    },
    {
        name: 'allowEmoji:false strips a skin-tone modifier with its emoji',
        input: 'thumbs 👍🏽 up',
        opts: { allowEmoji: false },
        expected: 'thumbs up'
    },
    {
        name: 'allowEmoji:false strips flags, keycaps and ZWJ families',
        input: '🇮🇳 1\uFE0F\u20E3 👨\u200D👩\u200D👧 chalu',
        opts: { allowEmoji: false },
        expected: 'chalu'
    },
    {
        name: 'Devanagari survives emoji stripping',
        input: 'उद्या भेटू 🔥 नक्की',
        opts: { allowEmoji: false },
        expected: 'उद्या भेटू नक्की'
    },
    {
        name: 'allowEmoji strips only on a strict false, not a truthy "false"',
        input: 'done 🔥',
        opts: { allowEmoji: 'false' },
        unchanged: true
    },

    // --- wrapping quotes ---------------------------------------------------
    {
        name: 'a reply the model wrapped in curly quotes is unwrapped',
        input: '\u201Chaan, kal bhetu\u201D',
        expected: 'haan, kal bhetu'
    },
    {
        name: 'both layers of a doubly quoted reply come off',
        input: '"\'arre yaar\'"',
        expected: 'arre yaar'
    },
    {
        name: 'wrapping quotes are kept when the text contains its own',
        input: "'don't'",
        unchanged: true
    },
    {
        name: 'stripWrappingQuotes:false keeps the outer quotes',
        input: '"haan, kal bhetu"',
        opts: { stripWrappingQuotes: false },
        unchanged: true
    },

    // --- whitespace --------------------------------------------------------
    {
        name: 'surrounding whitespace is trimmed',
        input: '   haan bhava   ',
        expected: 'haan bhava'
    },
    {
        name: '3+ consecutive newlines collapse to 2',
        input: 'hey\n\n\n\n\nthere',
        expected: 'hey\n\nthere'
    },
    {
        name: 'a single blank line is preserved',
        input: 'one\n\ntwo',
        unchanged: true
    },
    {
        name: 'CRLF becomes LF',
        input: 'one\r\ntwo',
        expected: 'one\ntwo'
    },

    // --- degenerate input --------------------------------------------------
    { name: 'null returns an empty string', input: null, expected: '' },
    { name: 'undefined returns an empty string', input: undefined, expected: '' },
    { name: 'a number returns an empty string', input: 12345, expected: '' },
    { name: 'an object returns an empty string', input: {}, expected: '' },
    { name: 'an array returns an empty string', input: [], expected: '' },
    { name: 'an empty string returns an empty string', input: '', expected: '' },
    { name: 'whitespace-only input returns an empty string', input: '   \n\n  ', expected: '' },
    { name: 'zero-width-only input returns an empty string', input: '\u200B\uFEFF', expected: '' }
];

// Inputs that must not blow up, whatever they come back as.
const NEVER_THROW = [
    ['lone high surrogate', '\uD83D', undefined],
    ['lone low surrogate', '\uDE00', undefined],
    ['surrogate wedged between letters', 'a\uD83Db', undefined],
    ['lone surrogate with emoji stripping on', 'a\uD83Db', { allowEmoji: false }],
    ['opts is null', 'hi', null],
    ['opts is a string', 'hi', 'nonsense'],
    ['opts is a number', 'hi', 5],
    ['a very long reply', 'haan bhava '.repeat(5000), { allowEmoji: false }]
];

function main() {
    console.log('--- sanitizeReply test ---');
    console.log(`${CASES.length} table cases, plus idempotence, robustness and export shape.\n`);

    for (const c of CASES) {
        const expected = c.unchanged ? c.input : c.expected;
        let actual;
        try {
            actual = sanitizeReply(c.input, c.opts);
        } catch (err) {
            check(c.name, false, `threw ${err.name}: ${err.message}`);
            continue;
        }
        check(c.name, actual === expected,
            `expected ${show(expected)}\n        actual   ${show(actual)}`);
    }

    // Sanitising twice must not keep changing the text, otherwise the output
    // would depend on how many times the pipeline happened to run.
    const unstable = CASES.filter((c) => {
        const once = sanitizeReply(c.input, c.opts);
        return sanitizeReply(once, c.opts) !== once;
    });
    check('every case is idempotent',
        unstable.length === 0,
        `unstable: ${unstable.map((c) => c.name).join('; ')}`);

    for (const [label, input, opts] of NEVER_THROW) {
        let pass = false;
        let detail = '';
        try {
            pass = typeof sanitizeReply(input, opts) === 'string';
            if (!pass) detail = 'did not return a string';
        } catch (err) {
            detail = `threw ${err.name}: ${err.message}`;
        }
        check(`never throws: ${label}`, pass, detail);
    }

    check('module is callable directly and as a named export',
        typeof sanitizeModule === 'function' && sanitizeModule.sanitizeReply === sanitizeModule);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    process.exit(failed.length ? 1 : 0);
}

main();
