/**
 * Table-driven check of services/scheduleExtract.js (and the shared model-id
 * resolver it grew alongside, services/modelId.js).
 *
 * Pure and offline -- no DB, no network, no test framework, no Baileys. That is
 * the point: this module regressed twice in a row precisely because nothing
 * exercised it, and a test that needed Supabase would never be run.
 *
 *   node tests/testScheduleExtract.js      (npm run test:schedule)
 *
 * WHAT IT GUARDS
 *
 *   CONTRACT 6, both invariants: raw scheduling JSON must never be sent to a
 *   contact and must never be written into chats.message. Both are the same
 *   string -- extractSchedule().text -- so every case below asserts its exact
 *   value AND goes through one blanket assertion class: no case, ever, leaves
 *   JSON residue in result.text. The residue detector used for that assertion
 *   is written here from scratch, deliberately NOT imported from the module, so
 *   the test cannot pass by agreeing with a broken implementation.
 *
 *   The acknowledgement policy (when a JSON-only reply may be answered with a
 *   canned "done"), which has now been wrong in both directions: too loose
 *   (confirming unconfirmed plans) and then too strict (total silence on a
 *   confirmed plan whose date the model left null).
 *
 *   The carry-forward ledger: a refused turn stores no chats row, and the
 *   payload used to die in a console.log.
 *
 * Exits non-zero if any case fails.
 */
const schedule = require('../services/scheduleExtract');
const modelId = require('../services/modelId');

const {
    extractSchedule,
    buildScheduleExtra,
    isAcknowledgeablePlan,
    describeAckRefusal,
    unfilledScheduleSlots,
    containsScheduleResidue,
    hasConcreteValue,
    deferScheduleExtra,
    drainDeferredScheduleExtras,
    pendingScheduleCount,
    resetDeferredSchedules,
    saveWithCarriedSchedules,
    MAX_DEFERRED_PER_CONTACT
} = schedule;

// ------------------------------- reporting ------------------------------- //

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass });
    let line = `${pass ? '  PASS' : '  FAIL'}  ${name}`;
    if (!pass && detail) line += `\n        ${detail}`;
    console.log(line);
}

function show(value) {
    if (value === null) return '<null>';
    if (value === undefined) return '<undefined>';
    if (typeof value !== 'string') return JSON.stringify(value);
    return `"${value.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// ------------------------- the assertion class ------------------------- //
//
// An INDEPENDENT residue detector. If this and the module ever disagree, the
// module is the one that has to change -- that is what makes the assertion
// worth anything. Everything it looks for is something a WhatsApp reply
// effectively never contains but a half-stripped scheduling blob always does.

const RESIDUE_SIGNALS = [
    // The opening quote must sit IMMEDIATELY before the key. That is what
    // separates machine syntax from a person quoting a phrase: `"confirmed":`
    // is debris, `"kal same time":` and `"be on time":` are ordinary replies
    // reporting what someone said, and truncating those corrupts real messages.
    { why: 'a "<schedule field>": fragment', re: /["']\s*\b(?:type|activity|date|time|with|confirmed)\b\s*["']?\s*:/i },
    { why: 'a type:schedule discriminator', re: /type"?\s*:\s*"?\s*schedule/i },
    { why: 'a JSON key/value pair', re: /"\s*:\s*(?:true|false|null|"[^"]*")\s*[},]/ },
    { why: 'a dangling ```json fence', re: /```[a-z]*\s*$/i }
];

/** @returns {string|null} why the text looks like JSON debris, or null if clean. */
function whyResidue(text) {
    if (typeof text !== 'string' || text === '') return null;
    for (const signal of RESIDUE_SIGNALS) {
        if (signal.re.test(text)) return signal.why;
    }
    // An unbalanced brace counts as debris only when something schedule-shaped
    // sits with it. A bare '{' or '}' is ordinary text -- ':}' is an emoticon,
    // and this project's author texts about code -- so flagging braces alone
    // would demand truncating genuine messages.
    const opens = (text.match(/\{/g) || []).length;
    const closes = (text.match(/\}/g) || []).length;
    const scheduleish = /\b(?:type|activity|date|time|with|confirmed)\b\s*["']?\s*:/i.test(text);
    if (opens !== closes && scheduleish) {
        return `unbalanced braces (${opens} '{' vs ${closes} '}') alongside a schedule key`;
    }
    return null;
}

// ------------------------------ fixtures ------------------------------ //

const CONFIRMED = {
    type: 'schedule', activity: 'chai', date: '12/09/2026', time: '20:00', with: 'Amit', confirmed: true
};
const CONFIRMED_JSON = JSON.stringify(CONFIRMED);

/** The exact blob from the FINDING 1 report: a '}' inside a string VALUE. */
const BRACE_IN_VALUE = {
    type: 'schedule', activity: 'party }at home', date: '12/09/2026', time: '20:00', with: 'Amit', confirmed: true
};
const BRACE_IN_VALUE_JSON = '{"type":"schedule","activity":"party }at home","date":"12/09/2026","time":"20:00","with":"Amit","confirmed":true}';

const BRACE_OPEN_IN_VALUE = {
    type: 'schedule', activity: 'party {at home', date: null, time: '20:00', with: 'Amit', confirmed: true
};
const BRACE_OPEN_IN_VALUE_JSON = '{"type":"schedule","activity":"party {at home","date":null,"time":"20:00","with":"Amit","confirmed":true}';

const UNCONFIRMED = {
    type: 'schedule', activity: 'chai', date: null, time: null, with: 'Amit', confirmed: false
};
const NULL_DATE = {
    type: 'schedule', activity: 'call', date: null, time: '19:00', with: 'Amit', confirmed: true
};
const NULL_TIME = {
    type: 'schedule', activity: 'bhetu', date: '13/09/2026', time: null, with: 'Amit', confirmed: true
};
const PLACEHOLDERS = {
    type: 'schedule', activity: 'chai', date: '<DD/MM/YYYY or null>', time: '<HH:MM or null>', with: 'Amit', confirmed: true
};
/** system_prompt_v3's template echoed back completely unfilled. */
const TEMPLATE_ECHO = {
    type: 'schedule', activity: '<what>', date: '<DD/MM/YYYY or null>',
    time: '<HH:MM or null>', with: '<person name>', confirmed: 'true/false'
};

// `schedule: undefined` on a case means "do not assert the payload";
// `parseError: true` means scheduleError must be set, `false` means it must not.
const CASES = [
    // ---- the ordinary, designed paths ------------------------------------
    {
        name: 'well-formed confirmed plan, JSON only',
        input: CONFIRMED_JSON,
        text: '', schedule: CONFIRMED, parseError: false
    },
    {
        name: 'prose + JSON: the prose survives, the blob does not',
        input: `haan chalo\n${CONFIRMED_JSON}`,
        text: 'haan chalo', schedule: CONFIRMED, parseError: false
    },
    {
        name: 'prose only: passes through untouched',
        input: 'haan bhai aa jaunga',
        text: 'haan bhai aa jaunga', schedule: null, parseError: false
    },
    {
        name: 'Devanagari prose + JSON',
        input: `बरं, भेटू\n${CONFIRMED_JSON}`,
        text: 'बरं, भेटू', schedule: CONFIRMED, parseError: false
    },
    {
        name: 'confirmed:false is still lifted out of the reply',
        input: JSON.stringify(UNCONFIRMED),
        text: '', schedule: UNCONFIRMED, parseError: false
    },
    {
        name: 'confirmed:true with a null date',
        input: JSON.stringify(NULL_DATE),
        text: '', schedule: NULL_DATE, parseError: false
    },
    {
        name: 'confirmed:true with a null time',
        input: JSON.stringify(NULL_TIME),
        text: '', schedule: NULL_TIME, parseError: false
    },
    {
        name: 'placeholder "<DD/MM/YYYY or null>" parses and is lifted out',
        input: JSON.stringify(PLACEHOLDERS),
        text: '', schedule: PLACEHOLDERS, parseError: false
    },
    {
        name: 'the whole template echoed back unfilled',
        input: JSON.stringify(TEMPLATE_ECHO),
        text: '', schedule: TEMPLATE_ECHO, parseError: false
    },
    {
        name: 'no "type" discriminator, but three payload keys',
        input: '{"activity":"chai","date":"12/09/2026","time":"20:00","confirmed":true}',
        text: '', parseError: false,
        schedule: { activity: 'chai', date: '12/09/2026', time: '20:00', confirmed: true }
    },

    // ---- fences ----------------------------------------------------------
    {
        name: 'blob inside a closed ```json fence: fence goes too',
        input: `chalo phir\n\`\`\`json\n${CONFIRMED_JSON}\n\`\`\``,
        text: 'chalo phir', schedule: CONFIRMED, parseError: false
    },
    {
        name: 'blob inside a bare ``` fence',
        input: `chalo phir\n\`\`\`\n${CONFIRMED_JSON}\n\`\`\``,
        text: 'chalo phir', schedule: CONFIRMED, parseError: false
    },

    // ---- truncation ------------------------------------------------------
    {
        name: 'truncated blob (no closing brace)',
        input: 'theek hai\n{"type":"schedule","activity":"chai","date":"12/09/2026',
        text: 'theek hai', schedule: null, parseError: true
    },
    {
        name: 'truncated blob in an UNCLOSED ```json fence',
        input: 'chalo phir\n```json\n{"type":"schedule","activity":"chai',
        text: 'chalo phir', schedule: null, parseError: true
    },
    {
        name: 'truncated blob with no discriminator but two payload keys',
        input: 'ok\n{"activity":"chai","date":"12/09/2026","time":"2',
        text: 'ok', schedule: null, parseError: true
    },

    // ---- malformed -------------------------------------------------------
    {
        name: 'malformed JSON (trailing comma) is still stripped',
        // The tolerant parse recovers this rather than reporting a failure --
        // a trailing comma is a formatting slip, not a lost plan. Stripping is
        // what matters and still happens; recovering the payload is a bonus.
        input: '{"type":"schedule","activity":"chai",}',
        text: '', schedule: { type: 'schedule', activity: 'chai' }, parseError: false
    },
    {
        name: 'malformed JSON after prose',
        input: 'haan\n{"type":"schedule" "activity":"chai","confirmed":true}',
        text: 'haan', schedule: null, parseError: true
    },

    // ---- FINDING 1: the leak, and four variants of it --------------------
    {
        name: 'FINDING 1: odd prose quote + "}" inside a string value',
        input: `usne bola "aa jaunga\n${BRACE_IN_VALUE_JSON}`,
        text: 'usne bola "aa jaunga', schedule: BRACE_IN_VALUE, parseError: false
    },
    {
        name: 'variant: "}" inside a string value, even quotes in the prose',
        input: `pakka\n${BRACE_IN_VALUE_JSON}`,
        text: 'pakka', schedule: BRACE_IN_VALUE, parseError: false
    },
    {
        name: 'variant: "{" inside a string value, odd quotes in the prose',
        input: `bola "theek\n${BRACE_OPEN_IN_VALUE_JSON}`,
        text: 'bola "theek', schedule: BRACE_OPEN_IN_VALUE, parseError: false
    },
    {
        name: 'variant: odd quotes in the prose, ordinary blob',
        input: `usne bola "aa jaunga\n${CONFIRMED_JSON}`,
        text: 'usne bola "aa jaunga', schedule: CONFIRMED, parseError: false
    },
    {
        name: 'variant: two blobs in one reply, odd quotes in the prose',
        // The LAST payload wins: a later blob is the model's newer statement.
        input: `he said "hi\n${JSON.stringify(UNCONFIRMED)}\n${CONFIRMED_JSON}`,
        text: 'he said "hi', schedule: CONFIRMED, parseError: false
    },
    {
        name: 'variant: two blobs, the second one truncated',
        // The complete earlier blob is recovered, so there is nothing to report
        // as a parse failure -- the plan survived.
        input: `${CONFIRMED_JSON}\n{"type":"schedule","activity":"chai`,
        text: '', schedule: CONFIRMED, parseError: false
    },

    // ---- stray braces in the prose --------------------------------------
    {
        name: 'stray "{" in the prose hides a complete blob: blob still recovered',
        // The text is cut at the FIRST schedule-shaped brace, so 'there' is
        // lost -- the documented trade. The payload is still hunted for at
        // every later brace, so the plan is recovered and there is no error.
        input: `hi { there\n${CONFIRMED_JSON}`,
        text: 'hi', schedule: CONFIRMED, parseError: false
    },
    {
        name: 'a stray "}" alone is prose, not residue, and survives',
        // Deliberate: an unbalanced brace on its own is not JSON debris. ':}'
        // is an emoticon and 'code me { likhna hai' is a developer texting
        // about code; truncating either would corrupt a real message. Braces
        // count as debris only when schedule keys accompany them.
        input: 'theek hai }',
        text: 'theek hai }', schedule: null, parseError: false
    },
    {
        name: 'orphan `,"confirmed":true}` with no opening brace is scrubbed',
        // Scrubbed by the residue guard rather than by extraction: with no
        // opening brace no blob was ever parsed, so there is no parse error.
        input: 'theek hai,"confirmed":true}',
        text: 'theek hai', schedule: null, parseError: false
    },

    // ---- the guard must NOT over-fire ------------------------------------
    {
        name: 'non-schedule JSON is left alone (not this module\'s business)',
        input: 'here is json {"a":1,"b":2}',
        text: 'here is json {"a":1,"b":2}', schedule: null, parseError: false
    },
    {
        name: 'balanced braces in ordinary prose survive',
        input: 'aaj {party} hai',
        text: 'aaj {party} hai', schedule: null, parseError: false
    },
    {
        name: 'the words date/time/with in prose are not residue',
        input: 'kal same time pe bhetu, date confirm kar dena',
        text: 'kal same time pe bhetu, date confirm kar dena', schedule: null, parseError: false
    },
    {
        name: 'an unmatched quote alone is not residue',
        input: 'usne bola "aa jaunga',
        text: 'usne bola "aa jaunga', schedule: null, parseError: false
    },

    // ---- degenerate input ------------------------------------------------
    { name: 'null input', input: null, text: '', schedule: null, parseError: false },
    { name: 'undefined input', input: undefined, text: '', schedule: null, parseError: false },
    { name: 'number input', input: 42, text: '', schedule: null, parseError: false },
    { name: 'object input', input: { a: 1 }, text: '', schedule: null, parseError: false },
    { name: 'array input', input: ['{"type":"schedule"}'], text: '', schedule: null, parseError: false },
    { name: 'boolean input', input: true, text: '', schedule: null, parseError: false },
    { name: 'empty string input', input: '', text: '', schedule: null, parseError: false },
    { name: 'whitespace-only input', input: '   \n\n  ', text: '', schedule: null, parseError: false }
];

// Extra inputs that carry no exact expectation but must still never leak.
const RESIDUE_ONLY_INPUTS = [
    '{',
    '}',
    '{{{{',
    '}}}}',
    '{"type":"schedule"',
    '"type":"schedule","confirmed":true}',
    '```json\n{"type":"schedule","activity":"a","date":"1/1/2027"',
    'a"b"c"d{"type":"schedule","activity":"x }y","confirmed":true}',
    '{"type":"schedule","activity":"\\"quoted\\" }brace","confirmed":true}',
    `${CONFIRMED_JSON}${CONFIRMED_JSON}`,
    `"${CONFIRMED_JSON}`,
    `{${CONFIRMED_JSON}`,
    `${CONFIRMED_JSON}{`,
    'ok " ok " ok " {"type":"schedule","activity":"}{","confirmed":true}',
    '{"type":"schedule","activity":"a","nested":{"x":"}"},"confirmed":true}'
];

// --------------------------- acknowledgement --------------------------- //

const ACK_CASES = [
    { name: 'confirmed:true with date and time', input: CONFIRMED, expected: true },
    { name: 'confirmed:true with a null date (the FINDING 2 regression)', input: NULL_DATE, expected: true },
    { name: 'confirmed:true with a null time (the mirror case)', input: NULL_TIME, expected: true },
    { name: 'confirmed:true with date AND time null', input: { type: 'schedule', activity: 'call', date: null, time: null, with: 'A', confirmed: true }, expected: true },
    { name: 'confirmed:true with placeholder date and time', input: PLACEHOLDERS, expected: true },
    // confirmed:true ALONE is not a plan. The template echoed back with only
    // that field resolved would otherwise have the bot confirm an agreement
    // with no activity, no date, no time and no person. At least one concrete
    // slot is required, and these two fixtures carry none.
    { name: 'confirmed quoted as "true" but no concrete slot', input: { confirmed: 'true', date: null, time: null }, expected: false },
    { name: 'confirmed quoted as "TRUE" but no concrete slot', input: { confirmed: '  TRUE ' }, expected: false },
    { name: 'confirmed quoted as "true" WITH a concrete slot', input: { confirmed: 'true', activity: 'chai', date: null }, expected: true },
    { name: 'confirmed:false', input: UNCONFIRMED, expected: false },
    { name: 'confirmed:"false"', input: { confirmed: 'false', date: '12/09/2026', time: '20:00' }, expected: false },
    { name: 'confirmed left as the template\'s own "true/false"', input: TEMPLATE_ECHO, expected: false },
    { name: 'confirmed missing entirely', input: { type: 'schedule', activity: 'chai' }, expected: false },
    { name: 'confirmed:1 (truthy but not true)', input: { confirmed: 1 }, expected: false },
    { name: 'no payload at all (null)', input: null, expected: false },
    { name: 'no payload at all (undefined)', input: undefined, expected: false },
    { name: 'an array is not a payload', input: [{ confirmed: true }], expected: false },
    { name: 'a string is not a payload', input: '{"confirmed":true}', expected: false }
];

const CONCRETE_CASES = [
    ['12/09/2026', true], ['20:00', true], ['kal', true], [0, true], [7, true],
    ['', false], ['   ', false], [null, false], [undefined, false], [NaN, false],
    ['null', false], ['NULL', false], ['undefined', false], ['none', false],
    ['tbd', false], ['TBD', false], ['n/a', false], ['N/A', false],
    ['<DD/MM/YYYY or null>', false], ['<HH:MM or null>', false], ['<what>', false],
    [true, false], [{}, false], [[], false]
];

// ------------------------------- runner ------------------------------- //

function runExtractionCases() {
    console.log('-- extractSchedule: text / payload / parse-error --');
    for (const c of CASES) {
        let r;
        try {
            r = extractSchedule(c.input);
        } catch (err) {
            check(c.name, false, `threw ${err.name}: ${err.message}`);
            continue;
        }

        const problems = [];
        if (r.text !== c.text) problems.push(`text: expected ${show(c.text)}, got ${show(r.text)}`);
        if (c.schedule !== undefined && !deepEqual(r.schedule, c.schedule)) {
            problems.push(`schedule: expected ${JSON.stringify(c.schedule)}, got ${JSON.stringify(r.schedule)}`);
        }
        if (c.parseError === true && !r.scheduleError) problems.push('expected a scheduleError, got none');
        if (c.parseError === false && r.scheduleError) problems.push(`expected no scheduleError, got ${show(r.scheduleError)}`);

        check(c.name, problems.length === 0, problems.join('\n        '));
    }
}

function runResidueAssertionClass() {
    console.log('\n-- assertion class: no case leaves JSON residue in result.text --');

    const inputs = [
        ...CASES.map(c => ({ label: c.name, input: c.input })),
        ...RESIDUE_ONLY_INPUTS.map(input => ({ label: `extra: ${show(input)}`, input }))
    ];

    const leaks = [];
    for (const { label, input } of inputs) {
        let r;
        try {
            r = extractSchedule(input);
        } catch (err) {
            leaks.push(`${label} -- threw ${err.message}`);
            continue;
        }
        const why = whyResidue(r.text);
        if (why) leaks.push(`${label} -- ${why} in ${show(r.text)}`);
    }
    check(`${inputs.length} inputs leave no JSON residue in result.text`,
        leaks.length === 0, leaks.join('\n        '));

    // The module's own guard must agree with this test's independent one.
    const disagreements = inputs
        .map(({ label, input }) => ({ label, text: extractSchedule(input).text }))
        .filter(({ text }) => containsScheduleResidue(text));
    check('containsScheduleResidue() also passes every extracted text',
        disagreements.length === 0,
        disagreements.map(d => `${d.label} -- ${show(d.text)}`).join('\n        '));

    // Stronger still: no output may contain a run of the raw blob.
    const echoed = inputs
        .filter(({ input }) => typeof input === 'string' && input.includes('"type":"schedule"'))
        .map(({ label, input }) => ({ label, text: extractSchedule(input).text }))
        .filter(({ text }) => text.includes('"type"') || text.includes('"confirmed"') || text.includes('schedule"'));
    check('no output echoes a recognisable fragment of the blob',
        echoed.length === 0,
        echoed.map(e => `${e.label} -- ${show(e.text)}`).join('\n        '));
}

function runAckPolicy() {
    console.log('\n-- acknowledgement policy: confirmed === true, nothing more --');
    for (const c of ACK_CASES) {
        let actual;
        try {
            actual = isAcknowledgeablePlan(c.input);
        } catch (err) {
            check(c.name, false, `threw ${err.name}: ${err.message}`);
            continue;
        }
        check(`ack ${c.expected ? 'YES' : 'NO '}: ${c.name}`, actual === c.expected,
            `expected ${c.expected}, got ${actual}`);
    }

    // A parse failure never reaches the acknowledgement gate: `schedule` is null.
    const truncated = extractSchedule('{"type":"schedule","activity":"chai","confirmed":tru');
    check('a blob that failed to parse is never acknowledgeable',
        truncated.schedule === null && isAcknowledgeablePlan(truncated.schedule) === false);

    // End to end: the exact FINDING 2 scenario.
    const sameDay = extractSchedule(JSON.stringify(NULL_DATE));
    check('FINDING 2 end to end: "aaj 7 baje" (date:null, confirmed:true) is acknowledged',
        sameDay.text === '' && isAcknowledgeablePlan(sameDay.schedule) === true);

    console.log('\n-- describeAckRefusal --');
    const refusals = [
        ['no payload', { schedule: null, scheduleError: null }, 'no scheduling payload in the reply'],
        ['parse failure', { schedule: null, scheduleError: 'boom' }, 'schedule JSON did not parse (boom)'],
        ['unconfirmed', { schedule: UNCONFIRMED }, 'plan is not confirmed (confirmed !== true)'],
        ['fully specified', { schedule: CONFIRMED }, 'plan is acknowledgeable']
    ];
    for (const [label, extracted, expected] of refusals) {
        const actual = describeAckRefusal(extracted);
        check(`describeAckRefusal: ${label}`, actual === expected, `expected ${show(expected)}, got ${show(actual)}`);
    }
    const partial = describeAckRefusal({ schedule: NULL_DATE });
    check('describeAckRefusal names unfilled slots on an acknowledgeable plan',
        partial.includes('acknowledgeable') && partial.includes('date'), show(partial));
    check('describeAckRefusal survives undefined', typeof describeAckRefusal(undefined) === 'string');

    check('unfilledScheduleSlots reports placeholders as unfilled',
        deepEqual(unfilledScheduleSlots(PLACEHOLDERS), ['date', 'time']),
        JSON.stringify(unfilledScheduleSlots(PLACEHOLDERS)));
    check('unfilledScheduleSlots is empty for a fully specified plan',
        unfilledScheduleSlots(CONFIRMED).length === 0);
}

function runConcreteValues() {
    console.log('\n-- hasConcreteValue: placeholder junk is never concrete --');
    const wrong = CONCRETE_CASES.filter(([value, expected]) => hasConcreteValue(value) !== expected);
    check(`${CONCRETE_CASES.length} value cases`, wrong.length === 0,
        wrong.map(([v, e]) => `${show(v)}: expected ${e}, got ${hasConcreteValue(v)}`).join('\n        '));
}

function runBuildScheduleExtra() {
    console.log('\n-- buildScheduleExtra: metadata shape --');
    const cases = [
        ['nothing to attach', {}, undefined],
        ['called with no argument', undefined, undefined],
        ['a parsed payload', { schedule: CONFIRMED }, { schedule: CONFIRMED }],
        ['a parse failure', { schedule: null, scheduleError: 'boom', scheduleRaw: '{oops' },
            { schedule: null, schedule_parse_error: 'boom', schedule_raw: '{oops' }],
        ['a payload plus scrubbed residue', { schedule: CONFIRMED, residueStripped: '}' },
            { schedule: CONFIRMED, schedule_residue_stripped: '}' }]
    ];
    for (const [label, input, expected] of cases) {
        const actual = buildScheduleExtra(input);
        check(`buildScheduleExtra: ${label}`, deepEqual(actual, expected),
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }

    // Every path that stores a row must be able to attach something, and a
    // refused turn must have something to defer.
    const refused = extractSchedule('{"type":"schedule","activity":"chai","confirmed":false}');
    check('a refused (confirmed:false) turn still yields metadata to carry forward',
        buildScheduleExtra(refused) !== undefined);
    const broken = extractSchedule('{"type":"schedule","activity":"chai');
    check('a truncated turn still yields metadata to carry forward',
        buildScheduleExtra(broken) !== undefined);
}

async function runCarryForwardLedger() {
    console.log('\n-- carry-forward ledger: a refused turn never loses its payload --');
    resetDeferredSchedules();

    const extra = buildScheduleExtra(extractSchedule(JSON.stringify(UNCONFIRMED)));
    check('deferScheduleExtra queues a payload', deferScheduleExtra(7, extra, 'not confirmed') === true);
    check('pendingScheduleCount sees it', pendingScheduleCount(7) === 1);
    check('a different contact is unaffected', pendingScheduleCount(8) === 0);
    check('deferScheduleExtra refuses a missing contact key', deferScheduleExtra(null, extra) === false);
    check('deferScheduleExtra refuses a missing payload', deferScheduleExtra(7, undefined) === false);

    // The next stored row picks it up.
    const stored = [];
    const fakeSave = async (opts) => { stored.push(opts); return { id: stored.length }; };
    await saveWithCarriedSchedules(fakeSave, 7, {
        contactId: 7, message: 'kal bhetu?', direction: 'INCOMING', source: 'human'
    });
    const row = stored[0];
    check('the next stored row carries the deferred payload',
        !!row && Array.isArray(row.extra && row.extra.carried_schedules) && row.extra.carried_schedules.length === 1,
        JSON.stringify(row));
    check('the ledger is emptied once the payload has a home', pendingScheduleCount(7) === 0);
    check('CONTRACT 6: the carried payload never touches chats.message',
        row.message === 'kal bhetu?' && whyResidue(row.message) === null, show(row.message));
    check('CONTRACT 1: metadata.source is untouched, so exemplar eligibility does not change',
        row.source === 'human' && row.direction === 'INCOMING');
    check('the deferral records why no row was stored',
        row.extra.carried_schedules[0].deferred_reason === 'not confirmed');

    // A second row gets nothing extra.
    await saveWithCarriedSchedules(fakeSave, 7, { contactId: 7, message: 'haan', direction: 'OUTGOING', source: 'ai' });
    check('a later row is not given the payload a second time',
        stored[1].extra === undefined, JSON.stringify(stored[1]));

    // A failed store puts the payload back rather than swallowing it.
    deferScheduleExtra(9, extra, 'send failed');
    const boom = async () => { throw new Error('supabase down'); };
    let threw = false;
    try {
        await saveWithCarriedSchedules(boom, 9, { contactId: 9, message: 'x', direction: 'INCOMING', source: 'human' });
    } catch (err) {
        threw = err.message === 'supabase down';
    }
    check('a storage failure is re-thrown to the caller', threw);
    check('a storage failure puts the deferred payload back', pendingScheduleCount(9) === 1);

    // Existing metadata is preserved alongside the carried payload.
    resetDeferredSchedules();
    deferScheduleExtra(10, extra, 'silence');
    const kept = [];
    await saveWithCarriedSchedules(async (o) => kept.push(o), 10, {
        contactId: 10, message: 'hi', direction: 'OUTGOING', source: 'ai',
        extra: { channel: 'training', schedule: null }
    });
    check('a row\'s own metadata survives the merge',
        kept[0].extra.channel === 'training' && kept[0].extra.carried_schedules.length === 1,
        JSON.stringify(kept[0].extra));

    // Bounded, and loud about it.
    resetDeferredSchedules();
    const warn = console.warn;
    let warnings = 0;
    console.warn = () => { warnings += 1; };
    try {
        for (let i = 0; i < MAX_DEFERRED_PER_CONTACT + 3; i++) deferScheduleExtra(11, { schedule: { n: i } }, 'flood');
    } finally {
        console.warn = warn;
    }
    check('the per-contact queue is bounded', pendingScheduleCount(11) === MAX_DEFERRED_PER_CONTACT);
    check('an eviction is logged, never silent', warnings >= 3, `${warnings} warning(s)`);
    const drained = drainDeferredScheduleExtras(11);
    check('eviction drops the OLDEST entries', drained[0].schedule.n === 3, JSON.stringify(drained[0]));
    check('draining an empty ledger returns an array', deepEqual(drainDeferredScheduleExtras(11), []));

    resetDeferredSchedules();
}

function runModelIdResolver() {
    console.log('\n-- modelId: one resolver, and it trims (FINDING 4) --');
    const saved = {
        GEMINI_MODEL: process.env.GEMINI_MODEL,
        GROQ_MODEL: process.env.GROQ_MODEL,
        OLLAMA_MODEL: process.env.OLLAMA_MODEL
    };
    const set = (name, value) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    };

    try {
        set('GEMINI_MODEL', undefined);
        set('GROQ_MODEL', undefined);
        set('OLLAMA_MODEL', undefined);
        check('v1 default matches geminiService', modelId.resolveModelId('v1') === 'gemini-2.5-flash');
        check('v2 default matches groqService', modelId.resolveModelId('v2') === 'openai/gpt-oss-120b');
        check('v3 default matches ollamaService', modelId.resolveModelId('v3') === 'llama3.1:8b');
        check('an unknown AI_VERSION falls back to v1', modelId.resolveModelId('v9') === 'gemini-2.5-flash');
        check('an undefined AI_VERSION falls back to v1', modelId.resolveModelId(undefined) === 'gemini-2.5-flash');

        // The actual regression: geminiService trims, the two copied resolvers
        // did not, so '   ' was recorded as the model that answered.
        set('GEMINI_MODEL', '   ');
        check('whitespace-only GEMINI_MODEL resolves to the default, as geminiService does',
            modelId.resolveModelId('v1') === 'gemini-2.5-flash', modelId.resolveModelId('v1'));
        set('GEMINI_MODEL', '  gemini-2.5-pro  ');
        check('a padded GEMINI_MODEL is trimmed',
            modelId.resolveModelId('v1') === 'gemini-2.5-pro', modelId.resolveModelId('v1'));
        set('GROQ_MODEL', ' \t ');
        check('whitespace-only GROQ_MODEL resolves to the default', modelId.resolveModelId('v2') === 'openai/gpt-oss-120b');
        set('OLLAMA_MODEL', '\n');
        check('whitespace-only OLLAMA_MODEL resolves to the default', modelId.resolveModelId('v3') === 'llama3.1:8b');

        check('providerLabel maps every version', modelId.providerLabel('v1') === 'Gemini'
            && modelId.providerLabel('v2') === 'Groq' && modelId.providerLabel('v3') === 'Ollama');

        // There must be exactly ONE resolver. Checked by reading the sources
        // rather than by requiring them: whatsappService drags in Baileys and
        // trainingService opens a readline loop, and this test stays offline.
        const fs = require('fs');
        const path = require('path');
        const copies = ['whatsappService.js', 'trainingService.js'].filter((file) => {
            const src = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
            return /function\s+resolveModelId\s*\(/.test(src);
        });
        check('neither caller still defines its own resolveModelId', copies.length === 0,
            `still local in: ${copies.join(', ')}`);
    } finally {
        Object.keys(saved).forEach(name => set(name, saved[name]));
    }
}

function runRobustness() {
    console.log('\n-- robustness --');
    const NEVER_THROW = [
        ['a lone open brace', '{'],
        ['200 open braces', '{'.repeat(200)],
        ['200 quotes', '"'.repeat(200)],
        ['alternating brace and quote', '{"'.repeat(500)],
        ['a very long prose reply', 'haan bhava '.repeat(5000)],
        ['a very long blob', `{"type":"schedule","activity":"${'x'.repeat(20000)}","confirmed":true}`],
        ['deeply nested objects', `${'{"a":'.repeat(200)}1${'}'.repeat(200)}`],
        ['escaped quotes inside a value', '{"type":"schedule","activity":"he said \\"hi\\" }","confirmed":true}'],
        ['a lone surrogate', '\uD83D'],
        ['CRLF line endings', `haan chalo\r\n${CONFIRMED_JSON}\r\n`]
    ];
    for (const [label, input] of NEVER_THROW) {
        let pass = false;
        let detail = '';
        try {
            const r = extractSchedule(input);
            pass = typeof r.text === 'string' && whyResidue(r.text) === null;
            if (!pass) detail = `text was ${show(r.text.slice(0, 120))}`;
        } catch (err) {
            detail = `threw ${err.name}: ${err.message}`;
        }
        check(`never throws / never leaks: ${label}`, pass, detail);
    }

    // Extraction must be idempotent: running it on its own output changes nothing.
    const unstable = CASES.filter((c) => {
        const once = extractSchedule(c.input).text;
        return extractSchedule(once).text !== once;
    });
    check('extraction is idempotent on its own output', unstable.length === 0,
        unstable.map(c => c.name).join('; '));

    // The re-syncing rescan is O(n * braces); make sure it stays usable.
    const started = Date.now();
    extractSchedule(`{"a":"${'{'.repeat(2000)}`);
    const elapsed = Date.now() - started;
    check('a pathological brace run finishes quickly', elapsed < 2000, `${elapsed}ms`);

    check('module exports the pieces its callers require',
        ['extractSchedule', 'buildScheduleExtra', 'isAcknowledgeablePlan', 'describeAckRefusal',
            'containsScheduleResidue', 'deferScheduleExtra', 'saveWithCarriedSchedules']
            .every(name => typeof schedule[name] === 'function'));
}

async function main() {
    console.log('--- scheduleExtract test ---');
    console.log(`${CASES.length} extraction cases, ${ACK_CASES.length} acknowledgement cases, `
        + `plus the residue assertion class, the carry-forward ledger and the shared model-id resolver.\n`);

    runExtractionCases();
    runResidueAssertionClass();
    runAckPolicy();
    runConcreteValues();
    runBuildScheduleExtra();
    await runCarryForwardLedger();
    runModelIdResolver();
    runRobustness();

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error('test harness crashed:', err);
    process.exit(1);
});
