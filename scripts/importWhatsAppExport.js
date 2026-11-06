/**
 * Imports a real WhatsApp "Export chat" .txt file into `chats` as ground truth.
 *
 * The database currently holds only a handful of messages Rohan actually typed;
 * everything else is AI output or synthetic seed data. A voice cannot be learned
 * from three samples, so this script turns a WhatsApp export into thousands of
 * genuinely human-authored rows.
 *
 * Rows are written through services/chatStore.js. OUTGOING rows stamped
 * source:'human' are what the few-shot style exemplars are drawn from, so the
 * provenance of an outgoing line decides whether the model will imitate it.
 * created_at is written explicitly from the parsed timestamp: the DEFAULT NOW()
 * is the transaction clock, so a batch insert would stamp every row identically
 * and destroy the ordering the whole import exists to preserve.
 *
 * THE BOT-ERA TRAP
 * This agent replies from Rohan's own WhatsApp account, so every reply it ever
 * sent appears in the export under Rohan's name, indistinguishable from a line
 * he typed himself. Imported blind, that generated text becomes a top-quality
 * "real Rohan" exemplar - and because imported rows carry provenance while the
 * older rows have metadata = NULL, it would dominate the exemplar pool and
 * amplify the very drift this import exists to correct. --ai-since /
 * --ai-before mark the window in which the agent was running so those OUTGOING
 * lines land as source:'ai' (never exemplar-eligible) instead of 'human'.
 *
 *   node scripts/importWhatsAppExport.js --file=<export.txt> --phone=<contactPhone> --me="<your name>"
 *
 * Flags:
 *   --file=<path>        WhatsApp export .txt (required)
 *   --phone=<number>     existing contact to import into (required, must already exist)
 *   --me=<name>          sender name that is YOU -> OUTGOING; everyone else -> INCOMING.
 *                        Accepts a comma-separated list of aliases ("Rohan,Rohan Dagale,+91 84850 78050").
 *   --dateformat=dmy|mdy how to read "03/09/2026" (default dmy). WhatsApp follows the
 *                        phone's locale and the file itself does not say which it used;
 *                        guessing wrong silently reorders the entire conversation.
 *   --ai-since=<date>    OUTGOING messages at or after this local timestamp are imported
 *                        as source:'ai' instead of 'human' - i.e. "the bot was live from
 *                        here on, assume it wrote these".
 *   --ai-before=<date>   the mirror image: OUTGOING messages strictly before this local
 *                        timestamp are imported as source:'ai' (bot ran only early on).
 *                        Both accept YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS], both are
 *                        optional, and given TOGETHER they intersect into a single bot
 *                        era [--ai-since, --ai-before): outside that window, 'human'.
 *                        INCOMING is always 'human' - a real person on the other end
 *                        typed it - and is never exemplar-eligible anyway.
 *   --dry-run            parse and report only, write NOTHING (start here, always)
 *   --reset              delete this contact's existing chats first (never implicit)
 *   --limit=N            import only the most recent N parsed messages
 *   --batch=N            rows per insert (default 500)
 *
 * Recommended flow:
 *   1) node scripts/importWhatsAppExport.js --file=chat.txt --phone=91... --me="Rohan" --dry-run
 *   2) check the direction split, the human/ai split, the date range and the first/last messages
 *   3) work out when the agent started answering for you and add --ai-since=YYYY-MM-DD
 *      (and/or --ai-before=), then dry-run again until the 'human' range is text you typed
 *   4) re-run without --dry-run (add --reset only if you mean to replace what is there)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const FILE = arg('file');
const PHONE = arg('phone');
const ME = arg('me');
const DATE_FORMAT = String(arg('dateformat', 'dmy')).toLowerCase();
const DRY_RUN = flag('dry-run');
const RESET = flag('reset');
const RAW_LIMIT = arg('limit');
const RAW_BATCH = arg('batch', '500');
const RAW_AI_SINCE = arg('ai-since');
const RAW_AI_BEFORE = arg('ai-before');

const USAGE = `
Usage:
  node scripts/importWhatsAppExport.js --file=<export.txt> --phone=<contactPhone> --me="<your name>"
                                       [--dateformat=dmy|mdy] [--ai-since=YYYY-MM-DD] [--ai-before=YYYY-MM-DD]
                                       [--dry-run] [--reset] [--limit=N] [--batch=N]

Start with --dry-run. It writes nothing and shows exactly what would be imported.

--ai-since / --ai-before mark the period when THIS agent was replying from your account.
OUTGOING messages inside that period are imported as source:'ai' and are excluded from the
style exemplars; everything else outgoing is imported as source:'human' and IS imitated.
Given together they intersect into one window: [--ai-since, --ai-before).
`;

function die(message) {
    console.error(message);
    process.exit(1);
}

/* ------------------------------------------------------------------ parsing */

// WhatsApp sprinkles LTR/RTL marks around media placeholders and uses a narrow
// no-break space before am/pm. Normalise both away before matching anything.
const INVISIBLE_RE = /[\u200e\u200f\ufeff]/g;
const ODD_SPACE_RE = /[\u202f\u00a0]/g;

// "[12/09/2026, 22:15:03] Sender: text"
const HEADER_BRACKET_RE =
    /^\[(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\]\s*(.*)$/i;
// "12/09/2026, 10:15 pm - Sender: text"
const HEADER_DASH_RE =
    /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s+-\s+(.*)$/i;

// A sender name never contains a colon or a newline, and is never a paragraph.
const SENDER_RE = /^([^:\n]{1,60}):[ \t]?([\s\S]*)$/;

// Checked against the BODY of a line that does have a sender, so they must be
// anchored: "created group for the hackathon" is a real message, not an event.
const BODY_SKIPS = [
    { reason: 'media', re: /^<\s*(media|image|video|audio|sticker|document|gif|photo|voice message|contact card)\s+omitted\s*>$/i },
    { reason: 'media', re: /^(image|video|audio|sticker|document|gif|photo|voice message|contact card)\s+omitted$/i },
    { reason: 'media', re: /^<attached:[\s\S]*>$/i },
    { reason: 'media', re: /\(file attached\)$/i },
    { reason: 'deleted', re: /^(this message was deleted|you deleted this message)\.?$/i },
    { reason: 'deleted', re: /^null$/i },
    { reason: 'system', re: /^messages and calls are end-to-end encrypted/i },
    { reason: 'system', re: /^(missed|silent) (voice|video|group voice|group video) call/i },
    { reason: 'system', re: /^waiting for this message/i },
    { reason: 'system', re: /^this message was edited$/i }
];

// Only ever applied to lines with NO sender. Everything sender-less is skipped
// regardless; these patterns just label the reason in the summary.
const NO_SENDER_REASONS = [
    { reason: 'encryption_notice', re: /end-to-end encrypt|secured with end-to-end/i },
    { reason: 'missed_call', re: /(missed|silent).*(voice|video) call|tap to call back/i },
    { reason: 'group_event', re: /\b(created (this )?group|added|removed|left|joined using this group|changed the subject|changed this group|changed the group|now an admin|no longer an admin|pinned a message|changed their phone number|security code)\b/i }
];

function normalizeYear(y) {
    return y < 100 ? 2000 + y : y;
}

/** Split the three date components according to --dateformat. */
function resolveDate(a, b, c) {
    // A four-digit leading component can only be a year (YYYY/MM/DD), whatever
    // --dateformat says.
    if (String(a).length === 4) return { year: Number(a), month: Number(b), day: Number(c) };
    const year = normalizeYear(Number(c));
    return DATE_FORMAT === 'mdy'
        ? { year, month: Number(a), day: Number(b) }
        : { year, month: Number(b), day: Number(a) };
}

/**
 * Builds a local-time Date, or null when the components do not describe a real
 * date. The round-trip check matters: JS silently rolls 13/09 over into the next
 * year, which is exactly what a wrong --dateformat produces.
 */
function buildTimestamp({ year, month, day }, hour, minute, second, meridiem) {
    let h = hour;
    if (meridiem) {
        const pm = /^p/i.test(meridiem);
        if (h === 12) h = pm ? 12 : 0;
        else if (pm) h += 12;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || minute > 59 || second > 59) return null;
    const at = new Date(year, month - 1, day, h, minute, second);
    if (Number.isNaN(at.getTime())) return null;
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return null;
    return at;
}

function matchHeader(line) {
    const m = HEADER_BRACKET_RE.exec(line) || HEADER_DASH_RE.exec(line);
    if (!m) return null;
    const [, a, b, c, hh, mm, ss, meridiem, rest] = m;
    const parts = resolveDate(a, b, c);
    const at = buildTimestamp(parts, Number(hh), Number(mm), Number(ss || 0), meridiem);
    return {
        at,
        rest,
        // Kept for the ambiguity warning: which slot held a value > 12.
        first: String(a).length === 4 ? null : Number(a),
        second: String(a).length === 4 ? null : Number(b)
    };
}

function classifyNoSender(rest) {
    for (const { reason, re } of NO_SENDER_REASONS) {
        if (re.test(rest)) return reason;
    }
    return 'no_sender';
}

function classifyBody(body) {
    const trimmed = body.trim();
    if (!trimmed) return 'empty';
    for (const { reason, re } of BODY_SKIPS) {
        if (re.test(trimmed)) return reason;
    }
    return null;
}

function normalizeName(name) {
    return String(name).replace(INVISIBLE_RE, '').replace(ODD_SPACE_RE, ' ')
        .replace(/^~\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const digitsOf = (s) => String(s).replace(/\D/g, '');

function makeIsMe(rawMe) {
    const aliases = String(rawMe).split(',').map((a) => a.trim()).filter(Boolean);
    const names = aliases.map(normalizeName);
    // Exports made on another phone show the participant as "+91 84850 78050",
    // so let a numeric --me match a numeric sender on digits alone.
    const numbers = aliases.map(digitsOf).filter((d) => d.length >= 7);
    return (sender) => {
        const n = normalizeName(sender);
        if (names.includes(n)) return true;
        const d = digitsOf(sender);
        return d.length >= 7 && numbers.some((num) => num.endsWith(d) || d.endsWith(num));
    };
}

/**
 * Pushes messages that share a timestamp 1ms apart, in file order.
 *
 * The "10:15 pm" export format has no seconds, so a burst of replies inside one
 * minute all parse to the same instant and ORDER BY created_at would tie-break
 * arbitrarily - shuffling exactly the back-and-forth the exemplars are meant to
 * demonstrate. Only exact ties are spread: a timestamp that genuinely goes
 * backwards is left alone so the wrong-dateformat warning can still see it.
 */
function spreadTies(messages) {
    for (let i = 1; i < messages.length; i++) {
        const prev = messages[i - 1].at.getTime();
        // Must be <=, not ===. Comparing only against the ALREADY-NUDGED previous
        // value means the third message of a same-minute burst is no longer equal
        // to it (prev is now T+1 while this one is still T), so an === test leaves
        // it at T -- i.e. BEHIND its predecessor. A burst of three then reads
        // T, T+1, T and the history replays out of order. Exports have no
        // seconds, and rapid-fire bursts inside one minute are the norm in a real
        // thread, so this fires constantly.
        if (messages[i].at.getTime() <= prev) messages[i].at = new Date(prev + 1);
    }
}

/**
 * @returns {{messages: object[], skipped: object, senders: Map,
 *            totalLines: number, disambiguating: boolean}}
 */
function parseExport(text, isMe) {
    const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
    const messages = [];
    const skipped = {};
    const senders = new Map();
    let disambiguating = false;
    // The message the next continuation line belongs to. When the header line was
    // skipped this is a tombstone, so its continuation lines are skipped too
    // instead of being glued onto an unrelated earlier message.
    let current = null;

    const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

    for (const raw of lines) {
        const line = raw.replace(INVISIBLE_RE, '').replace(ODD_SPACE_RE, ' ');
        const blank = !line.trim();

        const header = blank ? null : matchHeader(line.trimStart());
        if (!header) {
            // Continuation of a multi-line message. A blank line is only content
            // when it sits inside a message we are keeping; anywhere else (between
            // messages, at end of file) it is nothing and must not be counted.
            if (current && current.kept) current.message.message += '\n' + line;
            else if (blank) continue;
            else if (current) skip('continuation_of_skipped');
            else skip('orphan_line');
            continue;
        }

        if (header.first !== null && (header.first > 12 || header.second > 12)) {
            disambiguating = true;
        }

        if (!header.at) {
            current = { kept: false };
            skip('bad_date');
            continue;
        }

        const senderMatch = SENDER_RE.exec(header.rest);
        if (!senderMatch) {
            current = { kept: false };
            skip(classifyNoSender(header.rest));
            continue;
        }

        const sender = senderMatch[1].trim();
        const body = senderMatch[2];
        const bodyReason = classifyBody(body);
        if (bodyReason) {
            current = { kept: false };
            skip(bodyReason);
            continue;
        }

        senders.set(sender, (senders.get(sender) || 0) + 1);
        const message = {
            at: header.at,
            sender,
            direction: isMe(sender) ? 'OUTGOING' : 'INCOMING',
            message: body
        };
        messages.push(message);
        current = { kept: true, message };
    }

    // Trailing whitespace picked up while joining continuation lines is noise; a
    // body that turns out empty once trimmed was a placeholder we could not
    // classify, so drop it rather than insert a blank row.
    const kept = [];
    for (const m of messages) {
        m.message = m.message.replace(/\s+$/, '');
        if (!m.message.trim()) skip('empty');
        else kept.push(m);
    }
    spreadTies(kept);

    return { messages: kept, skipped, senders, totalLines: lines.length, disambiguating };
}

/* --------------------------------------------------------------- provenance */

// "2026-03-01", or "2026-03-01T14:30" / "2026-03-01 14:30:00" when the agent was
// switched on part-way through a day. Interpreted in LOCAL time, because that is
// what the parser builds out of the export's wall-clock stamps.
const BOUNDARY_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parses an --ai-since / --ai-before value into a local Date, or dies. */
function parseBoundary(raw, flagName) {
    const m = BOUNDARY_RE.exec(String(raw).trim());
    if (!m) {
        die(`--${flagName} must look like YYYY-MM-DD (or YYYY-MM-DDTHH:MM), got "${raw}".`);
    }
    const at = buildTimestamp(
        { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), null
    );
    if (!at) die(`--${flagName}="${raw}" is not a real date.`);
    return at;
}

/**
 * Decides metadata.source for one parsed message.
 *
 * INCOMING is always 'human': whatever the agent was doing, the other side of
 * the thread is a person typing. Only OUTGOING can be reattributed, because only
 * OUTGOING is exemplar-eligible and only OUTGOING can be something the agent
 * actually produced. With both bounds set the window is the intersection
 * [since, before) - one contiguous bot era - not the union of two open ends.
 */
function makeClassifySource(aiSince, aiBefore) {
    if (!aiSince && !aiBefore) return () => 'human';
    const from = aiSince ? aiSince.getTime() : -Infinity;
    const until = aiBefore ? aiBefore.getTime() : Infinity;
    return (m) => {
        if (m.direction !== 'OUTGOING') return 'human';
        const t = m.at.getTime();
        return t >= from && t < until ? 'ai' : 'human';
    };
}

function tagSources(messages, classify) {
    for (const m of messages) m.source = classify(m);
    return messages;
}

/* ---------------------------------------------------------------- reporting */

const pad = (n) => String(n).padStart(2, '0');

function fmtStamp(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function oneLine(text, max = 90) {
    const flat = text.replace(/\s*\n\s*/g, ' \\n ');
    return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function preview(m) {
    const dir = m.direction === 'OUTGOING' ? 'OUT' : 'IN ';
    const src = m.source ? ` ${m.source.padEnd(5)}` : '';
    return `  ${fmtStamp(m.at)}  ${dir}${src}  ${m.sender}: ${oneLine(m.message)}`;
}

/** "first  ->  last" over a set, by value: a wrong --dateformat can disorder it. */
function rangeOf(list) {
    if (!list.length) return null;
    let min = list[0].at.getTime();
    let max = min;
    for (const m of list) {
        const t = m.at.getTime();
        if (t < min) min = t;
        if (t > max) max = t;
    }
    return `${fmtStamp(new Date(min))}  ->  ${fmtStamp(new Date(max))}`;
}

function countOutOfOrder(messages) {
    let n = 0;
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].at.getTime() < messages[i - 1].at.getTime()) n++;
    }
    return n;
}

function report(parsed, selected, isMe, bounds) {
    const { aiSince, aiBefore } = bounds;
    const out = selected.filter((m) => m.direction === 'OUTGOING').length;
    const inc = selected.length - out;
    const human = selected.filter((m) => m.source === 'human');
    const ai = selected.filter((m) => m.source === 'ai');
    const humanOut = human.filter((m) => m.direction === 'OUTGOING').length;
    const skippedTotal = Object.values(parsed.skipped).reduce((a, b) => a + b, 0);

    console.log(`\nFile        : ${path.resolve(FILE)}`);
    console.log(`Lines read  : ${parsed.totalLines}`);
    console.log(`Date format : ${DATE_FORMAT} (${DATE_FORMAT === 'dmy' ? 'DD/MM/YYYY' : 'MM/DD/YYYY'})`);
    console.log(`Parsed      : ${parsed.messages.length} messages`
        + (selected.length !== parsed.messages.length ? `  (--limit keeps the most recent ${selected.length})` : ''));
    console.log(`Direction   : ${out} OUTGOING (you) / ${inc} INCOMING`);

    if (selected.length) {
        console.log(`Date range  : ${fmtStamp(selected[0].at)}  ->  ${fmtStamp(selected[selected.length - 1].at)}`);
    }

    // The provenance split is the whole point of --ai-since/--ai-before: it says
    // exactly how many outgoing lines this import will offer up as "Rohan's voice".
    console.log(`\nProvenance  : ${human.length} human / ${ai.length} ai   (written to metadata.source)`);
    if (aiSince || aiBefore) {
        console.log(`AI window   : OUTGOING${aiSince ? ` at or after ${fmtStamp(aiSince)}` : ''}`
            + `${aiSince && aiBefore ? ' and' : ''}${aiBefore ? ` before ${fmtStamp(aiBefore)}` : ''}`);
    } else {
        console.log('AI window   : none given -> every OUTGOING message counts as typed by you');
    }
    console.log(`  human     : ${humanOut} OUTGOING (eligible as style exemplars) + ${human.length - humanOut} INCOMING`);
    if (human.length) console.log(`              ${rangeOf(human)}`);
    console.log(`  ai        : ${ai.length} OUTGOING (never used as a style exemplar)`);
    if (ai.length) console.log(`              ${rangeOf(ai)}`);

    console.log('\nSenders seen (-> direction):');
    for (const [name, count] of [...parsed.senders.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(6)}  ${isMe(name) ? 'OUTGOING' : 'INCOMING'}  ${name}`);
    }

    console.log(`\nSkipped lines: ${skippedTotal}`);
    for (const [reason, count] of Object.entries(parsed.skipped).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(6)}  ${reason}`);
    }

    if (selected.length) {
        console.log(`\nFirst ${Math.min(5, selected.length)}:`);
        selected.slice(0, 5).forEach((m) => console.log(preview(m)));
        console.log(`\nLast ${Math.min(5, selected.length)}:`);
        selected.slice(-5).forEach((m) => console.log(preview(m)));
    }

    const warnings = [];
    if (!out) {
        warnings.push(`No sender matched --me="${ME}", so every message would be imported as INCOMING `
            + 'and none would be usable as one of your style exemplars. Copy a name from the list above.');
    }
    if (out && !aiSince && !aiBefore) {
        warnings.push(`No --ai-since / --ai-before given, so all ${out} OUTGOING message(s) will be imported `
            + "as source:'human' - genuine \"typed by Rohan\" style exemplars. This agent sends from your own "
            + 'account, so anything IT replied is in this export under your name and would be fed back to it '
            + 'as your voice, reinforcing the drift this import exists to fix. If the agent was ever live on '
            + 'this thread, re-run with --ai-since=YYYY-MM-DD (the day it started answering) and/or '
            + '--ai-before=YYYY-MM-DD (the day it stopped) to import that window as source:\'ai\' instead.');
    }
    if ((aiSince || aiBefore) && !ai.length) {
        warnings.push('An --ai-since/--ai-before window was given but it matched 0 OUTGOING messages, so this '
            + `import is identical to one with no window at all. Check the bounds against the date range above `
            + `(the export runs ${selected.length ? rangeOf(selected) : 'empty'}).`);
    }
    if ((aiSince || aiBefore) && ai.length && !humanOut) {
        warnings.push('Every OUTGOING message falls inside the AI window, so this import contributes ZERO style '
            + 'exemplars - only history. That is safe, but if you expected some of your own typing to survive, '
            + 'the bounds are too wide.');
    }
    if (parsed.skipped.bad_date) {
        warnings.push(`${parsed.skipped.bad_date} line(s) had an impossible date. That is the classic symptom `
            + `of the wrong --dateformat; try --dateformat=${DATE_FORMAT === 'dmy' ? 'mdy' : 'dmy'}.`);
    }
    if (!parsed.disambiguating && parsed.messages.length) {
        warnings.push('Every date in this export has both components <= 12, so nothing in the file proves '
            + `whether it is DD/MM or MM/DD. Confirm --dateformat=${DATE_FORMAT} against a date you remember.`);
    }
    const disordered = countOutOfOrder(selected);
    if (disordered) {
        warnings.push(`${disordered} message(s) go backwards in time relative to the previous line. `
            + 'Exports are chronological, so this usually means --dateformat is wrong.');
    }
    if (warnings.length) {
        console.log('\nWarnings:');
        warnings.forEach((w) => console.log(`  ! ${w}`));
    }
    return { out, inc, skippedTotal, human: human.length, ai: ai.length };
}

/* ------------------------------------------------------------------ writing */

async function findContact(supabase, phone) {
    const { data, error } = await supabase
        .from('contacts').select('id, phone, name').eq('phone', phone).maybeSingle();
    if (error) throw error;
    if (data) return data;

    // Tolerate "+91 84850-78050" when the row stores "918485078050".
    const digits = digitsOf(phone);
    if (digits && digits !== phone) {
        const alt = await supabase.from('contacts').select('id, phone, name').eq('phone', digits).maybeSingle();
        if (alt.error) throw alt.error;
        return alt.data || null;
    }
    return null;
}

// Reports and lets main() return: process.exit() while the Supabase client still
// holds open sockets aborts the process with a libuv assertion on Windows, so
// every post-connection failure sets process.exitCode and unwinds normally.
function reportMissingContact(phone) {
    console.error(`\nContact ${phone} does not exist.`);
    console.error('This script never creates contacts: an import that lands on the wrong thread is worse than no import.');
    console.error('Create it first, then re-run:');
    console.error('  node scripts/seed.js          # seeds the demo contacts and their personas');
    console.error('  (or insert the contacts row yourself, then re-run this import)');
}

async function importMessages(contact, messages, batchSize, sourceFile) {
    const { saveMany } = require('../services/chatStore');
    const importedAt = new Date().toISOString();
    let imported = 0;

    for (let i = 0; i < messages.length; i += batchSize) {
        const slice = messages.slice(i, i + batchSize);
        const rows = slice.map((m) => ({
            contactId: contact.id,
            message: m.message,
            direction: m.direction,
            // Set per message by makeClassifySource(): 'human' unless this is an
            // OUTGOING line from inside the --ai-since/--ai-before window, in
            // which case the agent probably wrote it and it must not become an
            // exemplar. buildRow() rejects anything that is not a known source.
            source: m.source,
            createdAt: m.at.toISOString(),
            extra: { importedFrom: 'whatsapp-export', sourceFile, importedAt, sender: m.sender }
        }));
        try {
            const written = await saveMany(rows);
            imported += written ? written.length : rows.length;
        } catch (e) {
            console.error(`\nBatch starting at message ${i + 1} failed: ${e.message || e}`);
            console.error(`${imported} message(s) were already written. Re-run with --reset to start clean.`);
            throw e;
        }
        console.log(`  batch ${Math.floor(i / batchSize) + 1}: ${imported}/${messages.length} written`);
    }
    return imported;
}

/* --------------------------------------------------------------------- main */

async function main() {
    if (flag('help') || !FILE || !PHONE || !ME) {
        if (!flag('help')) console.error('Missing required flag (--file, --phone and --me are all required).');
        console.error(USAGE);
        process.exit(flag('help') ? 0 : 1);
    }
    if (DATE_FORMAT !== 'dmy' && DATE_FORMAT !== 'mdy') {
        die(`--dateformat must be 'dmy' or 'mdy' (got "${DATE_FORMAT}").`);
    }
    if (!fs.existsSync(FILE)) {
        // This is the first thing most people hit, because the export has to be
        // produced on the phone before the script has anything to read. Say so,
        // and point at any .txt already sitting in the usual places.
        const lines = [
            `File not found: ${path.resolve(FILE)}`,
            '',
            'This script reads a WhatsApp "Export chat" file. To produce one:',
            '  1. Open the chat on your phone',
            '  2. Menu (...) -> More -> Export chat -> WITHOUT MEDIA',
            '  3. Send it to yourself, then save the .txt into this project folder',
            ''
        ];
        // One level deep as well as the top level: WhatsApp exports arrive as a
        // FOLDER named "WhatsApp Chat with <name>" containing the .txt, so a
        // top-level-only scan reports "no .txt files found" while the export is
        // sitting right there.
        const seen = [];
        const scan = (dir, depth) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (err) {
                return; // unreadable directory is not worth reporting here
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) seen.push(full);
                else if (entry.isDirectory() && depth > 0 && entry.name !== 'node_modules') scan(full, depth - 1);
            }
        };
        for (const dir of [
            process.cwd(),
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop'),
            path.join(os.homedir(), 'Documents')
        ]) {
            scan(dir, 1);
        }
        if (seen.length) {
            lines.push('.txt files found nearby - one of these may be the export:');
            seen.slice(0, 10).forEach(f => lines.push('  ' + f));
        } else {
            lines.push('No .txt files found in this folder, Downloads or Desktop yet.');
        }
        die(lines.join('\n'));
    }

    const limit = RAW_LIMIT === undefined ? null : parseInt(RAW_LIMIT, 10);
    if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) die('--limit must be a positive integer.');
    const batchSize = parseInt(RAW_BATCH, 10);
    if (!Number.isFinite(batchSize) || batchSize <= 0) die('--batch must be a positive integer.');

    // "--ai-since 2026-01-01" (space, not =) would otherwise parse as no window
    // at all and silently import the whole bot era as your own voice.
    for (const name of ['ai-since', 'ai-before']) {
        if (flag(name)) die(`--${name} needs its value attached: --${name}=YYYY-MM-DD (no space).`);
    }

    const aiSince = RAW_AI_SINCE === undefined ? null : parseBoundary(RAW_AI_SINCE, 'ai-since');
    const aiBefore = RAW_AI_BEFORE === undefined ? null : parseBoundary(RAW_AI_BEFORE, 'ai-before');
    if (aiSince && aiBefore && aiSince.getTime() >= aiBefore.getTime()) {
        die(`--ai-since (${fmtStamp(aiSince)}) must be earlier than --ai-before (${fmtStamp(aiBefore)}): `
            + 'together they describe one bot era [since, before), and this window is empty.');
    }

    const isMe = makeIsMe(ME);
    const parsed = parseExport(fs.readFileSync(FILE, 'utf8'), isMe);
    // --limit keeps the NEWEST messages: the tail of a thread is the most
    // representative sample of how someone writes today.
    const selected = limit && parsed.messages.length > limit
        ? parsed.messages.slice(parsed.messages.length - limit)
        : parsed.messages;
    tagSources(selected, makeClassifySource(aiSince, aiBefore));

    const { skippedTotal, human, ai } = report(parsed, selected, isMe, { aiSince, aiBefore });

    if (DRY_RUN) {
        console.log('\n--dry-run: nothing was written.');
        console.log(`Summary: parsed ${parsed.messages.length} / would import ${selected.length} `
            + `(${human} human, ${ai} ai) / skipped ${skippedTotal}.`);
        if (RESET) console.log('(--reset was ignored; a dry run never deletes anything.)');
        console.log('\nWhen the numbers above look right, re-run the same command without --dry-run.');
        return;
    }

    if (!selected.length) die('\nNothing to import. Re-check --dateformat and the export file.');

    // Required only for a real import, so --dry-run stays a pure parser that runs
    // without database credentials.
    require('../loadEnv');
    const { supabase } = require('../services/supabaseClient');

    const contact = await findContact(supabase, PHONE);
    if (!contact) {
        reportMissingContact(PHONE);
        process.exitCode = 1;
        return;
    }
    console.log(`\nContact ${contact.phone}${contact.name ? ` (${contact.name})` : ''} -> id ${contact.id}`);

    const { count: existing } = await supabase.from('chats')
        .select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);

    if (RESET) {
        const { data: gone, error } = await supabase.from('chats')
            .delete().eq('contact_id', contact.id).select('id');
        if (error) throw error;
        console.log(`--reset: deleted ${gone ? gone.length : 0} existing message(s).`);
    } else if (existing) {
        console.log(`Note: this contact already has ${existing} message(s); the import ADDS to them.`);
        console.log('      Pass --reset if you meant to replace them.');
    }

    console.log(`Importing ${selected.length} message(s) (${human} human, ${ai} ai) in batches of ${batchSize}...`);
    const imported = await importMessages(contact, selected, batchSize, path.basename(FILE));

    const { count: total } = await supabase.from('chats')
        .select('*', { count: 'exact', head: true }).eq('contact_id', contact.id);

    console.log(`\nDone. parsed ${parsed.messages.length} / imported ${imported} `
        + `(${human} human, ${ai} ai) / skipped ${skippedTotal}.`);
    console.log(`Contact ${contact.phone} now has ${total} message(s) total.`);
}

main().catch((e) => {
    console.error('Import failed:', e.message || e);
    process.exitCode = 1;
});
