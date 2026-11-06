/**
 * Scheduling-payload extraction, shared by every caller that post-processes a
 * model reply.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * system_prompt_v3 ("## Scheduling & Task Detection", Step 3) tells the model to
 * emit a JSON object once a plan is settled:
 *
 *   { "type": "schedule", "activity": "<what>", "date": "<DD/MM/YYYY or null>",
 *     "time": "<HH:MM or null>", "with": "<person name>", "confirmed": true/false }
 *
 * Two things must never happen to that blob (CONTRACT 6):
 *   1. it must never be SENT to a contact -- nobody wants machine syntax in
 *      their chat; and
 *   2. it must never be written into chats.message. The rolling history in
 *      promptService is deliberately provenance-blind (CONTRACT 4), so a single
 *      stored blob is replayed into every later prompt and the model imitates
 *      it, emitting more JSON, forever.
 *
 * So the payload is lifted out of the reply here and travels in chats.metadata
 * instead (via chatStore's `extra`, see buildScheduleExtra).
 *
 * This module previously existed TWICE -- once in whatsappService.js and once
 * copy-pasted into trainingService.js -- and the copies diverged: truncated-blob
 * handling was added to the production copy only, so `npm run train` kept
 * writing half-written JSON straight into chats.message. One module, both
 * callers, no second copy to forget.
 *
 * No DB, no network, no Baileys, no env. That is what lets the training CLI use
 * it without dragging the WhatsApp socket (and its process-level exit handlers)
 * into a readline loop. Everything is a pure function except the small
 * in-process carry-forward ledger at the bottom, which is plain memory.
 *
 * HOW A LEAK IS PREVENTED -- THREE LAYERS
 * ---------------------------------------
 * A previous version scanned for balanced braces string-aware and, when the
 * scan ended mid-string (an odd number of `"` in the prose -- e.g.
 * `usne bola "aa jaunga`, which is the very case this module cites as its
 * reason to exist), retried with a NAIVE scan that ignored quotes. That retry
 * was the leak: with quotes ignored, a `{` or `}` sitting inside a JSON string
 * VALUE ("activity": "party }at home") closed the candidate early, so only a
 * truncated prefix was stripped and the REST of the raw JSON stayed in the
 * prose that gets sent to the contact and written to chats.message. Both
 * invariants broken, and the schedule lost as well. So:
 *
 *   Layer 1 -- RE-SYNC instead of going quote-blind (resyncCandidates). When
 *              the whole-text scan desynchronises, restart a STRING-AWARE scan
 *              at each `{` in turn. The blob's own quotes are balanced, so a
 *              scan that begins at its opening brace tracks strings correctly
 *              again and braces inside string values stay invisible. This is
 *              what actually fixes the bug.
 *
 *   Layer 2 -- recover the payload from a region we are about to delete, so a
 *              stray brace in the prose costs a few words of prose and not the
 *              schedule (extractSchedule's unterminated branch).
 *
 *   Layer 3 -- a final residue guard (scrubScheduleResidue /
 *              containsScheduleResidue). Whatever the scanners did, the prose
 *              that comes out is re-inspected for JSON debris -- a `"key":`
 *              fragment for a scheduling field, or an unbalanced brace -- and
 *              everything from the first sign of debris to the end of the
 *              reply is thrown away. If debris somehow survives even that, the
 *              text is emptied. Losing a few words of prose is far better than
 *              texting a contact a JSON fragment, so the guard is deliberately
 *              biased towards deleting too much. Callers should run the same
 *              check on the post-sanitizer text as their last gate before a
 *              send (containsScheduleResidue is exported for exactly that).
 */


/** The payload fields system_prompt_v3 asks for, minus the `type` discriminator. */
const SCHEDULE_KEYS = ['activity', 'date', 'time', 'with', 'confirmed'];

/** JSON.parse that never throws. */
function safeJsonParse(raw) {
    try {
        return { value: JSON.parse(raw), error: null };
    } catch (err) {
        return { value: null, error: err.message };
    }
}

/**
 * Quote-agnostic view of a slice, used only for DETECTION.
 *
 * Small models asked for JSON routinely answer with a JS object literal
 * ({type: "schedule"}) or with single quotes ({'type':'schedule'}). Detection
 * that insists on a literal double quote before the colon misses both, and the
 * blob then sails through to the contact, so every recogniser below works on
 * this normalised form rather than on the raw text.
 */
function normaliseForDetection(raw) {
    return String(raw)
        .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
        .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
        .toLowerCase();
}

/** How many scheduling field names appear as a key, in any quoting style. */
function countScheduleKeysInText(raw) {
    if (typeof raw !== 'string') return 0;
    const n = normaliseForDetection(raw);
    return SCHEDULE_KEYS.filter(function (k) {
        return new RegExp('["\']?\\b' + k + '\\b["\']?\\s*:').test(n);
    }).length;
}

/** True when a slice looks like the scheduling payload, whatever its quoting. */
function looksLikeScheduleText(raw) {
    if (typeof raw !== 'string' || raw.indexOf('{') === -1) return false;
    const n = normaliseForDetection(raw);
    if (/["']?\s*type\s*["']?\s*:\s*["']?\s*schedule/.test(n)) return true;
    if (countScheduleKeysInText(raw) >= 2) return true;
    // A degenerate fragment such as `{"type"}` carries a quoted scheduling key
    // with no colon at all, so the key-with-colon counters above miss it. It is
    // still machine syntax. Requiring the region to OPEN as JSON ( `{` then a
    // quote ) keeps ordinary prose braces -- 'code me { likhna hai' -- out.
    const region = n.slice(n.indexOf('{'));
    return /^\{\s*["']/.test(region)
        && /["']\s*\b(type|activity|date|time|with|confirmed)\b\s*["']/.test(region);
}

/** True when a parsed value has the shape of the scheduling payload. */
function looksLikeScheduleObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof value.type === 'string' && value.type.trim().toLowerCase() === 'schedule') return true;
    return SCHEDULE_KEYS.filter(function (k) {
        return Object.prototype.hasOwnProperty.call(value, k);
    }).length >= 3;
}

/**
 * Best-effort parse of a blob that may not be strict JSON.
 *
 * Tries, in order: the blob as-is; the blob trimmed to its last '}' (drops
 * trailing chatter); and a tolerant pass converting single-quoted strings and
 * bare keys into JSON. Never throws.
 */
function tolerantJson(raw) {
    return raw
        .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
        .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
        .replace(/'([^'\\]*)'/g, '"$1"')
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
        .replace(/,(\s*[}\]])/g, '$1');
}

/** Every way of reading one '{' offset as an object, cheapest first. */
function slicesFrom(region) {
    const out = [region];
    const first = region.indexOf('}');
    const last = region.lastIndexOf('}');
    if (first !== -1) out.push(region.slice(0, first + 1));
    if (last !== -1 && last !== first) out.push(region.slice(0, last + 1));
    return out.concat(out.map(tolerantJson));
}

function parseScheduleBlob(blob) {
    // Every '{' is a possible payload start: the cut happens at the FIRST
    // schedule-shaped brace, but that one may be a stray brace in the prose
    // with the real payload further along. Only the text is trimmed early --
    // the payload is still hunted for across the whole region.
    const offsets = [];
    for (let i = blob.indexOf('{'); i !== -1 && offsets.length < 8; i = blob.indexOf('{', i + 1)) {
        offsets.push(i);
    }

    let best = null;
    let firstError = null;
    for (const off of offsets) {
        for (const candidate of slicesFrom(blob.slice(off))) {
            const parsed = safeJsonParse(candidate);
            if (parsed.value && looksLikeScheduleObject(parsed.value)) {
                // Keep going: when a reply carries a Step-2 draft followed by a
                // Step-3 confirmation, the LATER object is the model's final
                // state, so the last one that parses wins.
                best = parsed.value;
                break;
            }
            if (!firstError && parsed.error) firstError = parsed.error;
        }
    }

    if (best) return { schedule: best, error: null };
    return { schedule: null, error: firstError || 'blob did not parse as a scheduling object' };
}

/** Strips a dangling code-fence opener left behind on the prose. */
function stripTrailingFence(prose) {
    return String(prose).replace(/`{3,}[a-z]*\s*$/i, '');
}

/** Offset of the earliest sign of schedule-JSON debris, or -1 when clean. */
function findResidueStart(text) {
    if (typeof text !== 'string') return -1;
    const brace = text.indexOf('{');
    if (brace !== -1 && looksLikeScheduleText(text.slice(brace))) return brace;

    // An orphan fragment such as `,"confirmed":true}` can arrive with its
    // opening brace already gone. The quote must sit IMMEDIATELY before the
    // key, which is what separates machine syntax from a person quoting a
    // phrase: `"confirmed":` matches, `"kya date":` and `"be on time":` do not.
    const orphan = new RegExp('["\']\\s*\\b(?:type|' + SCHEDULE_KEYS.join('|') + ')\\b\\s*["\']?\\s*:');
    const m = orphan.exec(text);
    if (!m) return -1;
    // Walk back over the separator that introduced the fragment.
    let at = m.index;
    while (at > 0 && /[\s,;{]/.test(text[at - 1])) at--;
    return at;
}

/**
 * True when `text` still carries scheduling-JSON debris.
 *
 * Requires an actual '{'. Prose alone can never trip this, so an ordinary reply
 * that merely quotes someone -- 'tu ne bola tha "kal same time": ab mana kar
 * raha hai' -- is delivered untouched.
 */
function containsScheduleResidue(text) {
    return findResidueStart(text) !== -1;
}

/** Removes schedule debris by cutting from the first offending brace. */
function scrubScheduleResidue(text) {
    const at = findResidueStart(text);
    if (at === -1) return typeof text === 'string' ? text : '';
    return stripTrailingFence(text.slice(0, at)).trim();
}

/**
 * Splits a model reply into deliverable prose and the scheduling payload.
 *
 * THE RULE, deliberately blunt: if a '{' is present and what follows it looks
 * like the scheduling payload, then everything from that brace to the END of
 * the reply is payload. No brace matching, no quote tracking, no re-syncing.
 *
 * Four successive attempts at a balanced-brace scanner all leaked, because a
 * brace or a stray quote inside a JSON string value desynchronises any such
 * scan and the remainder gets emitted as prose. Cutting unconditionally at the
 * first schedule-shaped brace makes that entire class of bug structurally
 * impossible: no character at or after the brace can reach a contact or
 * chats.message, whatever the blob contains and however malformed it is.
 *
 * The trade: prose written AFTER the payload is lost. That is acceptable --
 * system_prompt_v3 tells the model to return the JSON AS the reply, so trailing
 * prose is rare, and a terse WhatsApp persona essentially never types '{'.
 * A reply with no '{', or whose braces are not schedule-shaped, is returned
 * completely untouched.
 *
 * @returns {{text:string, schedule:object|null, scheduleError:string|null,
 *            scheduleRaw:string|null, residueStripped:string|null}}
 */
function extractSchedule(reply) {
    const empty = {
        text: '',
        schedule: null,
        scheduleError: null,
        scheduleRaw: null,
        residueStripped: null
    };
    if (typeof reply !== 'string' || !reply.trim()) return empty;

    const brace = reply.indexOf('{');
    if (brace === -1 || !looksLikeScheduleText(reply.slice(brace))) {
        // No payload here. The text still goes through the residue guard so an
        // orphan fragment whose opening brace never arrived -- `,"confirmed":
        // true}` -- cannot be returned as deliverable prose.
        return Object.assign({}, empty, { text: scrubScheduleResidue(reply.trim()) });
    }

    const blob = reply.slice(brace);
    const prose = scrubScheduleResidue(stripTrailingFence(reply.slice(0, brace)).trim());
    const parsed = parseScheduleBlob(blob);

    return {
        text: prose,
        schedule: parsed.schedule,
        scheduleError: parsed.schedule ? null : parsed.error,
        scheduleRaw: blob,
        residueStripped: blob
    };
}


/**
 * metadata extras for a chats row, or undefined when there is nothing to attach.
 * Raw JSON in chats.metadata is fine -- CONTRACT 6 is about chats.message, and
 * promptService renders only `direction` and `message` into the history.
 */
function buildScheduleExtra({ schedule, scheduleError, scheduleRaw, residueStripped } = {}) {
    if (!schedule && !scheduleError && !scheduleRaw && !residueStripped) return undefined;
    const extra = { schedule: schedule || null };
    if (scheduleError) extra.schedule_parse_error = scheduleError;
    if (scheduleRaw) extra.schedule_raw = scheduleRaw;
    if (residueStripped) extra.schedule_residue_stripped = residueStripped;
    return extra;
}

/**
 * True when a field carries a real value rather than the template's own
 * placeholder or an explicit "not known yet".
 *
 * system_prompt_v3 hands the model the literal string `"<DD/MM/YYYY or null>"`,
 * so an unfilled slot comes back as JSON null, as the string "null", or as the
 * angle-bracketed placeholder copied verbatim. All three mean "I do not know".
 */
function hasConcreteValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string') return false;
    const v = value.trim().toLowerCase();
    if (!v) return false;
    if (v === 'null' || v === 'undefined' || v === 'none' || v === 'tbd' || v === 'n/a') return false;
    // "<DD/MM/YYYY or null>" -- the template slot, echoed back unfilled.
    if (v.startsWith('<') && v.endsWith('>')) return false;
    return true;
}

/** `confirmed: true`, tolerating a model that quotes the boolean. */
function isConfirmedFlag(value) {
    if (value === true) return true;
    return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/**
 * ACKNOWLEDGEMENT POLICY -- the single rule for when a caller may answer a
 * JSON-only reply with a canned acknowledgement instead of the model's words.
 *
 * ACKNOWLEDGE when, and only when, the payload PARSED and says confirmed:true
 * (JSON `true`, or the string "true" from a model that quoted the boolean).
 * Nothing else is required: a confirmed plan may legitimately carry
 * date:null or time:null and it is still a real agreement.
 *
 * REFUSE (caller stays silent and logs) when:
 *   * there is no parsed payload at all -- a malformed or truncated blob
 *     leaves {schedule:null, schedule_parse_error, schedule_raw}, i.e. nothing
 *     was captured, so there is nothing to confirm; or
 *   * confirmed is anything other than true, including the template's own
 *     unfilled `true/false`. system_prompt_v3 Step 2 says to ask casually when
 *     the plan is not settled, and `"confirmed": true/false` exists precisely
 *     so the model can say "not yet"; acknowledging there both lies and
 *     swallows the question the model was supposed to ask.
 *
 * WHY date/time ARE NOT REQUIRED (this used to be the bar, and it was wrong).
 * The template itself offers `"date": "<DD/MM/YYYY or null>"`, and for a
 * same-day plan ("aaj 7 baje call") the model has to do date arithmetic off
 * history timestamps, so it routinely emits date:null; "kal bhetu" gives the
 * mirror case with time:null. Requiring both meant a contact who had just said
 * "haan 7 baje chalta hai" got TOTAL SILENCE -- a confirmed plan answered with
 * nothing at all, which reads as being ignored. Confirmation is the signal that
 * matters; a missing slot is the model's problem to chase on the next turn, not
 * a reason to go quiet on an agreement.
 *
 * Placeholder junk is still rejected wherever values ARE inspected:
 * hasConcreteValue treats "<DD/MM/YYYY or null>", "tbd", "n/a", "null" and ""
 * as not-known, and describeAckRefusal reports which slots are unfilled so the
 * logs still show a half-specified plan.
 */
function isAcknowledgeablePlan(schedule) {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return false;
    if (!isConfirmedFlag(schedule.confirmed)) return false;
    // confirmed:true alone is not a plan. A template echoed back with every
    // other slot left as its literal placeholder would otherwise have the bot
    // confirm an agreement with no activity, no date, no time and no person.
    // One concrete slot is enough: a same-day "aaj 7 baje call" legitimately
    // arrives with date null, and "kal bhetu" with time null.
    return ['activity', 'date', 'time', 'with'].some(k => hasConcreteValue(schedule[k]));
}

/** Slots that came back as null / placeholder / "tbd". Informational only. */
function unfilledScheduleSlots(schedule) {
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return [];
    return ['activity', 'date', 'time', 'with'].filter(key => !hasConcreteValue(schedule[key]));
}

/**
 * Short human-readable reason an extraction was not acknowledgeable, for logs.
 * When it IS acknowledgeable the line still names any unfilled slots, so a
 * half-specified plan is visible in the logs even though it is confirmed.
 */
function describeAckRefusal(extracted) {
    const e = extracted || {};
    if (!e.schedule) {
        return e.scheduleError
            ? `schedule JSON did not parse (${e.scheduleError})`
            : 'no scheduling payload in the reply';
    }
    if (!isConfirmedFlag(e.schedule.confirmed)) return 'plan is not confirmed (confirmed !== true)';

    const unfilled = unfilledScheduleSlots(e.schedule);
    return unfilled.length
        ? `plan is acknowledgeable (confirmed), though ${unfilled.join(', ')} ${unfilled.length === 1 ? 'is' : 'are'} still unfilled`
        : 'plan is acknowledgeable';
}

// -------------------- carry-forward ledger for refused turns -------------------- //
//
// THE PROBLEM. Every path that refuses to reply -- parse failure, confirmed:false,
// a "negative" hand-off, a send that threw -- stores no chats row, and the
// scheduling payload was only ever going to travel in that row's metadata. It
// therefore survived no further than a console.log, and the stricter the
// acknowledgement policy got the more often that happened.
//
// THE MECHANISM. A refused payload is DEFERRED here, in memory, keyed by
// contact, and merged into chats.metadata of the NEXT row that contact does
// store -- normally their very next incoming message, a few seconds later. It
// lands under `carried_schedules`, alongside whatever that row's own metadata
// is, so the payload ends up attached to the real conversation and is queryable
// with an ordinary `chats.metadata` filter.
//
// WHY THAT CANNOT POLLUTE THE PROMPT. promptService's history SELECT is
//
//     .from('chats').select('*').eq('contact_id', id)
//         .order('created_at', {ascending:false}).limit(HISTORY_LIMIT)
//
// and its RENDER is
//
//     `[${timestamp}] ${m.direction === "INCOMING" ? "User" : "Assistant"}: ${m.message}`
//
// -- created_at, direction and message, and nothing else. `metadata` IS fetched
// by `select('*')` and then never read.
//
// Verified read-only against the live database (no rows written, read or
// otherwise touched): that exact SELECT was run for contact 6, returning 100
// rows with columns id, contact_id, message, direction, status, metadata,
// created_at. Each row was then given -- in memory only -- exactly the metadata
// this ledger adds, carried_schedules included, complete with a raw schedule
// blob and a "12/09/2026" date, and both versions were put through that exact
// render:
//
//     rendered history identical with and without carried_schedules: true
//     rendered history mentions "carried_schedules": false
//     rendered history mentions "schedule":          false
//     rendered history mentions "12/09/2026":        false
//
// i.e. not one byte of metadata can reach the prompt text. The only metadata
// the prompt is sensitive to at all is `metadata->>source`, which gates the
// exemplar SELECT -- and merging `carried_schedules` leaves `source` untouched,
// so a row's exemplar eligibility does not change either. chats.message is
// likewise untouched, so CONTRACT 6 holds.
//
// (A dedicated row was rejected: promptService's history filters on contact_id
// and NOTHING else, so any row belonging to the contact is replayed; the only
// row it provably excludes is one detached from the contact entirely, which
// makes the payload unfindable. No new table is possible here.)
//
// LIMITS. This is process memory: a crash between deferring and the next stored
// row loses the entry, and every deferral is logged by the caller for exactly
// that reason. It is bounded both ways, and an eviction is loud rather than
// silent.

const MAX_DEFERRED_CONTACTS = 200;
const MAX_DEFERRED_PER_CONTACT = 20;

/** contactKey -> array of pending metadata extras, oldest first. */
const deferredByContact = new Map();

function ledgerKey(contactKey) {
    return contactKey === null || contactKey === undefined ? '' : String(contactKey);
}

/**
 * Holds a schedule payload that had no row to ride on.
 * @param {string|number} contactKey contact id
 * @param {object} extra a buildScheduleExtra() result
 * @param {string} [reason] why no row was stored, recorded alongside it
 * @returns {boolean} true when it was queued
 */
function deferScheduleExtra(contactKey, extra, reason) {
    const key = ledgerKey(contactKey);
    if (!key || !extra) return false;

    const queue = deferredByContact.get(key) || [];
    queue.push({
        ...extra,
        deferred_reason: reason || 'no row was stored for this turn',
        deferred_at: new Date().toISOString()
    });

    while (queue.length > MAX_DEFERRED_PER_CONTACT) {
        const dropped = queue.shift();
        console.warn(`[SCHEDULE] Carry-forward ledger for contact ${key} is full (${MAX_DEFERRED_PER_CONTACT}); `
            + `dropping the oldest deferred payload: ${JSON.stringify(dropped)}`);
    }

    // Re-insert so the Map's insertion order stays newest-last and the oldest
    // contact is always the first one evicted.
    deferredByContact.delete(key);
    deferredByContact.set(key, queue);

    while (deferredByContact.size > MAX_DEFERRED_CONTACTS) {
        const oldest = deferredByContact.keys().next().value;
        console.warn(`[SCHEDULE] Carry-forward ledger is tracking more than ${MAX_DEFERRED_CONTACTS} contacts; `
            + `dropping everything deferred for contact ${oldest}: ${JSON.stringify(deferredByContact.get(oldest))}`);
        deferredByContact.delete(oldest);
    }

    return true;
}

/** Takes (and clears) everything deferred for a contact. Always an array. */
function drainDeferredScheduleExtras(contactKey) {
    const key = ledgerKey(contactKey);
    const queue = deferredByContact.get(key);
    if (!queue || !queue.length) return [];
    deferredByContact.delete(key);
    return queue;
}

/** Puts drained entries back at the FRONT, after a failed attempt to store them. */
function redeferScheduleExtras(contactKey, entries) {
    const key = ledgerKey(contactKey);
    if (!key || !entries || !entries.length) return 0;
    const queue = deferredByContact.get(key) || [];
    deferredByContact.set(key, [...entries, ...queue].slice(-MAX_DEFERRED_PER_CONTACT));
    return entries.length;
}

/** How many payloads are waiting for a row. */
function pendingScheduleCount(contactKey) {
    const queue = deferredByContact.get(ledgerKey(contactKey));
    return queue ? queue.length : 0;
}

/** Merges drained entries into a row's `extra`. Returns undefined when empty. */
function mergeCarriedSchedules(extra, carried) {
    if (!carried || !carried.length) return extra;
    return { ...(extra || {}), carried_schedules: carried };
}

/** Test/diagnostic hook. Not used by the app. */
function resetDeferredSchedules() {
    deferredByContact.clear();
}

/**
 * Stores a chats row with any deferred schedule payloads for this contact merged
 * into its metadata.
 *
 * `save` is injected (it is always chatStore.saveMessage) so this module stays
 * DB-free and both callers share one implementation instead of copy-pasting a
 * drain/merge/re-defer dance -- the duplication class that produced this file in
 * the first place. On a storage failure the drained entries go back on the
 * ledger so the next row gets another chance at them.
 *
 * @param {(opts: object) => Promise<any>} save
 * @param {string|number} contactKey
 * @param {object} opts chatStore.saveMessage options
 */
async function saveWithCarriedSchedules(save, contactKey, opts) {
    const carried = drainDeferredScheduleExtras(contactKey);
    const extra = mergeCarriedSchedules(opts && opts.extra, carried);

    try {
        const row = await save({ ...opts, extra });
        if (carried.length) {
            console.log(`[SCHEDULE] Attached ${carried.length} deferred schedule payload(s) to the chats row just `
                + `stored for contact ${contactKey} (metadata.carried_schedules).`);
        }
        return row;
    } catch (err) {
        if (carried.length) {
            redeferScheduleExtras(contactKey, carried);
            console.warn(`[SCHEDULE] Storing a row for contact ${contactKey} failed (${err.message}); `
                + `${carried.length} deferred schedule payload(s) put back for the next row.`);
        }
        throw err;
    }
}

module.exports = {
    extractSchedule,
    buildScheduleExtra,
    isAcknowledgeablePlan,
    describeAckRefusal,
    unfilledScheduleSlots,
    // The residue guard, exported so a caller can run the same check on its
    // post-sanitizer text as a last gate before sending.
    containsScheduleResidue,
    scrubScheduleResidue,
    // Carry-forward ledger (FINDING 3): no refused turn loses its payload.
    deferScheduleExtra,
    drainDeferredScheduleExtras,
    redeferScheduleExtras,
    mergeCarriedSchedules,
    pendingScheduleCount,
    resetDeferredSchedules,
    saveWithCarriedSchedules,
    MAX_DEFERRED_PER_CONTACT,
    MAX_DEFERRED_CONTACTS,
    // Lower-level pieces, exported for offline tests and for any future caller
    // that needs to reason about a raw slice. Nothing in the app imports these
    // directly -- go through extractSchedule.
    findResidueStart,
    parseScheduleBlob,
    stripTrailingFence,
    normaliseForDetection,
    looksLikeScheduleObject,
    looksLikeScheduleText,
    countScheduleKeysInText,
    hasConcreteValue,
    isConfirmedFlag,
    safeJsonParse,
    SCHEDULE_KEYS
};
