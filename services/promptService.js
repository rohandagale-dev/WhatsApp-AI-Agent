require("../loadEnv");
const { supabase } = require("./supabaseClient");

function positiveIntFromEnv(raw, fallback) {
    const parsed = parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// How many past messages are replayed into the prompt. Single source of truth --
// the query limit and the section header both derive from it, so they cannot drift.
// Override with HISTORY_MESSAGE_LIMIT in .env.
const DEFAULT_HISTORY_LIMIT = 100;
const HISTORY_LIMIT = positiveIntFromEnv(process.env.HISTORY_MESSAGE_LIMIT, DEFAULT_HISTORY_LIMIT);

// How many real, human-authored replies are shown as style exemplars. Abstract
// rules ("be brief", "be casual") lose to concrete samples, so the prompt shows
// the model what Rohan actually types instead of describing it.
// Override with EXEMPLAR_LIMIT in .env.
const DEFAULT_EXEMPLAR_LIMIT = 20;
const EXEMPLAR_LIMIT = positiveIntFromEnv(process.env.EXEMPLAR_LIMIT, DEFAULT_EXEMPLAR_LIMIT);

// Longer than this is a paragraph, not a WhatsApp one-liner: a bad demo of a
// terse voice, and expensive.
const MAX_EXEMPLAR_CHARS = 400;
// Length past which a candidate stops getting any worse in the ranking.
const LONG_MESSAGE_CHARS = 160;
// Ranking weights (lower total = better). Shortness leads, recency nudges.
const LENGTH_WEIGHT = 0.65;
const RECENCY_WEIGHT = 0.35;
// Rows pulled before filtering, so dedupe/JSON/URL rejects still leave a choice.
const EXEMPLAR_POOL_MULTIPLIER = 5;
const EXEMPLAR_POOL_CAP = 200;

/**
 * Trims a value and strips indentation shared by all of its lines. Section
 * bodies come from the DB (a persona file, a pasted rule list) and any leading
 * whitespace they carry is pure token waste in the rendered prompt.
 */
function clean(value) {
    if (typeof value !== "string") return "";
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    const indents = lines
        .filter(line => line.trim())
        .map(line => line.match(/^[ \t]*/)[0].length);
    const shared = indents.length > 0 ? Math.min(...indents) : 0;
    return lines
        .map(line => line.slice(shared).replace(/\s+$/, ""))
        .join("\n")
        .trim();
}

/** Payload-looking text a human would never type into WhatsApp. */
function looksLikeJson(text) {
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed)) return false;
    if (/[\]}]$/.test(trimmed)) return true;
    try {
        JSON.parse(trimmed);
        return true;
    } catch (error) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Link detection
// ---------------------------------------------------------------------------
//
// A URL teaches the model nothing about how Rohan talks and eats the token
// budget, so an exemplar containing one is dropped. The hard part is that
// WhatsApp Hinglish routinely omits the space after a full stop -- "theek
// hai.in kal bolu", "ok done.me too", "chalo.in bhetu" -- which produces the
// exact same character shape as a bare Indian domain ("amazon.in", "nic.in",
// "swiggy.in pe order kr"). Dropping the first kind deletes the register this
// block exists to teach; keeping the second kind poisons it.
//
// NO TLD LIST CAN SEPARATE THEM. `.in`/`.co`/`.me` are the commonest Indian
// TLDs *and* the start of ordinary words, and after a missing space the next
// word can be anything at all ("theek hai.kal bolu"), so every entry added to
// a "these are links" list trades one error for the other, and every entry
// left out (youtu.be, goo.gl, amzn.to, forms.gle) is a link that slips through.
// The two cases are also structurally identical -- "swiggy.in pe order kr" and
// "haan.in ghar aa ja" are both `word.tld` + three words, at the start of the
// message -- so message shape alone cannot decide it either.
//
// What does separate them is how the token behaves IN THE SENTENCE:
//
//   a domain is a NOUN               -- it carries a path or query, or it
//                                       stands alone as the entire message
//                                       ("amazon.in"), or it takes a locative
//                                       case marker ("swiggy.in PE order kr"
//                                       = "order ON swiggy.in"). Case markers
//                                       attach to a noun phrase; they cannot
//                                       follow the end of a sentence.
//   a missing full stop is a SEAM    -- the fragment after the dot is the
//                                       first word of the next clause, and
//                                       ordinary words follow it ("chalo.in
//                                       bhetu", "arre.co ka scene").
//
// So a drop needs positive evidence, and the genuinely ambiguous case defaults
// to KEEPING the message: losing one exemplar to a stray link is cheap, losing
// Rohan's actual register is the bug this whole block was written to fix.

// One host label: letters/digits, inner hyphens allowed.
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
// A TLD is letters only, so "9.30", "no.1" and "2.5" stay numbers, not hosts.
const TLD = "[a-z]{2,24}";
const HOST = `${HOST_LABEL}\\.${TLD}`;
// TLDs that are never the first letters of a Hinglish word, so `word.tld` on
// its own reads as a link (github.com, bit.ly). Deliberately SHORT: this is a
// fast path, not the mechanism. Shorteners are caught by their path and bare
// domains by the sentence-role rules below, so this list never has to grow to
// keep pace with the registry -- which is what made the old one leak.
const LINK_TLDS = "com|net|org|io|app|dev|xyz|ly|info|edu|gov";
// Locative case markers -- Hindi/Marathi "on, at, in". A closed word class (it
// does not grow the way a TLD list does), and the only markers narrow enough to
// be evidence: "X pe" means X is a place or platform. Genitive/ablative markers
// ("ka", "se") attach to any noun at all, so they prove nothing and are left
// out on purpose -- "arre.co ka scene" and "aaj nahi.co se aa" stay.
const LOCATIVE_MARKERS = "pe|pey|par|pr|var|vr|madhe|madhye|mein";

const URL_PATTERNS = [
    // 1. Explicit link: scheme or www. prefix.
    /\b(?:https?:\/\/|www\.)\S+/i,
    // 2. Host carrying a path, query or fragment. Prose never puts a slash
    //    straight after a dotted word, so this needs no TLD knowledge at all --
    //    it is what catches every shortener (youtu.be/..., goo.gl/maps/...,
    //    amzn.to/..., forms.gle/...) without naming a single one of them.
    new RegExp(`\\b${HOST}[/?#]\\S`, "i"),
    // 3. Two or more labels before the TLD (sbi.co.in). A missing space after a
    //    full stop produces one dot, never two.
    new RegExp(`\\b${HOST_LABEL}\\.${HOST_LABEL}\\.${TLD}\\b`, "i"),
    // 4. Unambiguous TLD anywhere in the message (github.com, bit.ly).
    new RegExp(`\\b${HOST_LABEL}\\.(?:${LINK_TLDS})\\b`, "i"),
    // 5. The host IS the message -- a bare share ("amazon.in", "flipkart.in",
    //    "nic.in"). Nothing precedes or follows it, so there is no sentence for
    //    a missing full stop to be the seam of.
    new RegExp(`^${HOST}[.!?]*$`, "i"),
    // 6. The host takes a locative marker ("swiggy.in pe order kr"): a case
    //    marker can only attach to a noun phrase, so the token is a place.
    new RegExp(`\\b${HOST}\\s+(?:${LOCATIVE_MARKERS})\\b`, "i")
];

/** Links carry no style information and blow up the token budget. */
function containsUrl(text) {
    const trimmed = text.trim();
    return URL_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * One line whenever candidates were thrown away or demoted. Rejects used to be
 * silent, so an over-eager filter could shrink the style block -- or empty it
 * out entirely -- with nothing in the logs to explain why the prompt lost its
 * voice. `demoted` is the softer half of the same story: rows that were kept
 * but pushed to the back of the block.
 */
function logExemplarFiltering(poolSize, keptCount, dropped, demoted) {
    const reasons = Object.keys(dropped)
        .filter(reason => dropped[reason] > 0)
        .map(reason => `${dropped[reason]} ${reason}`);
    if (reasons.length === 0 && !demoted) return;

    const parts = [];
    if (reasons.length > 0) parts.push(`dropped ${reasons.join(", ")}`);
    if (demoted) parts.push(`demoted ${demoted} non-conversational`);

    const tail = keptCount === 0
        ? " -- nothing left, the prompt will omit the style block"
        : "";
    console.log(`promptService: ${keptCount} style exemplar(s) from ${poolSize} candidate row(s); `
        + `${parts.join("; ")}${tail}`);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

// Shortness is a decent proxy for "a real WhatsApp reply", but only down to a
// point: "k", "ok" and ":)" teach nothing, and with an unbounded shortness
// reward the shortest string in the pool wins exemplar #1 automatically. Below
// this length the score climbs back up.
const MIN_VOICE_CHARS = 8;
// Worst score a too-short sample can reach (a 0-char sample, which cannot
// happen -- empties are already filtered). Tuned so "nivant" (6) and "pata
// hain" (9) both still rank near the front.
const TOO_SHORT_CEILING = 0.5;

// Second line of defence behind containsUrl(). That filter decides what is
// SHOWN; this decides what is shown FIRST, and the two failures are not
// equally bad: a link buried at position 18 is noise, a link at position 1 is
// the first thing the model reads under "this is how Rohan writes". Every
// penalty here exceeds the maximum clean score (LENGTH_WEIGHT + RECENCY_WEIGHT
// = 1), so a penalised candidate can never outrank a clean one no matter how
// short or recent it is -- one filter miss costs the tail of the block, never
// the top of it.
const LINK_SHAPED_PENALTY = 4;
const NON_CONVERSATIONAL_PENALTY = 2;
// Minimum share of letters before a sample counts as words rather than
// punctuation, emoji or digits.
const MIN_LETTER_RATIO = 0.4;

// Deliberately looser than URL_PATTERNS: ANY dot-joined host shape, including
// the Hinglish false positives containsUrl() is careful to keep. Those are real
// Rohan and they stay in the block -- they just never lead it.
const HOST_SHAPED = new RegExp(`\\b${HOST_LABEL}\\.${TLD}`, "i");
const SCHEME_SHAPED = /https?:|www\.|\bmailto:/i;
// Handles, e-mail, phone numbers, OTPs, order ids: contact details, not voice.
const CONTACT_DETAIL = /@|\d{6,}/;
// An unbroken run this long is a hash, id or pasted token, never a spoken word.
const OPAQUE_TOKEN = /(?:^|\s)\S{24,}(?:\s|$)/;

/** Share of non-space characters that are letters, in any script. */
function letterRatio(text) {
    const dense = text.replace(/\s+/g, "");
    if (!dense) return 0;
    const letters = dense.match(/\p{L}/gu);
    return (letters ? letters.length : 0) / dense.length;
}

/**
 * Additive ranking penalty. 0 for an ordinary conversational line; anything
 * above 0 is barred from the top of the block by construction (see above).
 */
function rankingPenalty(text) {
    let penalty = 0;
    if (HOST_SHAPED.test(text) || SCHEME_SHAPED.test(text)) penalty += LINK_SHAPED_PENALTY;
    if (CONTACT_DETAIL.test(text) || OPAQUE_TOKEN.test(text)) penalty += NON_CONVERSATIONAL_PENALTY;
    if (letterRatio(text) < MIN_LETTER_RATIO) penalty += NON_CONVERSATIONAL_PENALTY;
    return penalty;
}

/** Lower is better: shortest useful length first, then recent. */
function lengthScore(length) {
    if (length >= MIN_VOICE_CHARS) {
        return Math.min(length, LONG_MESSAGE_CHARS) / LONG_MESSAGE_CHARS;
    }
    // Too short to carry a voice: the further below the floor, the worse.
    return TOO_SHORT_CEILING * ((MIN_VOICE_CHARS - length) / MIN_VOICE_CHARS);
}

/** Lower is better: prefer short, then recent. `index` is 0 for the newest row. */
function exemplarScore(text, index, total) {
    const recencyScore = total > 1 ? index / (total - 1) : 0;
    return (lengthScore(text.length) * LENGTH_WEIGHT)
        + (recencyScore * RECENCY_WEIGHT)
        + rankingPenalty(text);
}

/**
 * Picks up to `limit` distinct style samples out of newest-first chat rows.
 * Returns [] when nothing survives -- the caller then omits the whole section
 * rather than emitting an empty heading.
 */
function selectExemplars(rows, limit) {
    const pool = Array.isArray(rows) ? rows : [];
    const seen = new Set();
    const candidates = [];
    const dropped = { empty: 0, "too-long": 0, "json-like": 0, "link-like": 0, duplicate: 0 };
    let demoted = 0;

    pool.forEach((row, index) => {
        // Multi-line messages are collapsed so each exemplar stays one bullet.
        const text = clean(row && row.message).replace(/\s*\n\s*/g, " ");
        if (!text) { dropped.empty += 1; return; }
        if (text.length > MAX_EXEMPLAR_CHARS) { dropped["too-long"] += 1; return; }
        if (looksLikeJson(text)) { dropped["json-like"] += 1; return; }
        if (containsUrl(text)) { dropped["link-like"] += 1; return; }

        const key = text.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(key)) { dropped.duplicate += 1; return; }
        seen.add(key);

        if (rankingPenalty(text) > 0) demoted += 1;
        candidates.push({ text, score: exemplarScore(text, index, pool.length) });
    });

    // Order within the block is not a conversation, but it is not arbitrary
    // either: the model weights the first examples most, so the cleanest,
    // most Rohan-shaped lines go first and anything link-like or otherwise
    // non-conversational is pinned to the tail by its ranking penalty.
    const chosen = candidates
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map(candidate => candidate.text);

    logExemplarFiltering(pool.length, chosen.length, dropped, demoted);
    return chosen;
}

/**
 * Real messages Rohan typed himself. Provenance-gated on purpose: AI-authored
 * rows would teach the model to imitate its own drift, which is the bug this
 * block exists to fix. Rows written before provenance existed have
 * metadata = NULL and are excluded by the same filter.
 */
async function fetchExemplars(contactId, limit = EXEMPLAR_LIMIT) {
    const poolSize = Math.min(limit * EXEMPLAR_POOL_MULTIPLIER, EXEMPLAR_POOL_CAP);

    const query = (scoped) => {
        let q = supabase
            .from("chats")
            .select("message, created_at, metadata")
            .eq("direction", "OUTGOING")
            .eq("metadata->>source", "human");
        if (scoped) q = q.eq("contact_id", contactId);
        return q.order("created_at", { ascending: false }).limit(poolSize);
    };

    const own = await query(true);
    if (own.error) {
        // The section is optional by design, so never fail the whole prompt over it.
        console.warn("promptService: exemplar lookup failed, continuing without exemplars:", own.error.message || own.error);
        return [];
    }

    const scoped = selectExemplars(own.data, limit);
    if (scoped.length >= limit) return scoped;

    // Top up from every thread. How Rohan writes is a property of Rohan, not of
    // one conversation: a contact he has only just started talking to has no
    // messages of his own to learn from, and that is exactly the contact whose
    // replies most need to sound like him. Per-contact samples still come first,
    // so a thread with its own history keeps its own register.
    const all = await query(false);
    if (all.error) return scoped;

    const seen = new Set(scoped.map((m) => m.trim().toLowerCase()));
    const extra = selectExemplars(all.data, limit * 2)
        .filter((m) => !seen.has(m.trim().toLowerCase()));

    return scoped.concat(extra).slice(0, limit);
}

function renderExemplarSection(exemplars) {
    if (!exemplars || exemplars.length === 0) return "";
    const lines = exemplars.map(text => `- ${text}`).join("\n");
    return `HOW I ACTUALLY TEXT (REAL MESSAGES I TYPED -- COPY THIS VOICE, NOT THE CONTENT):\n${lines}`;
}

async function buildDynamicPrompt(contactId, latestMessageText) {
    try {
        // 1. Fetch Contact, Persona, and RelationPerson
        const { data: contact, error: contactError } = await supabase
            .from('contacts')
            .select('*, persona:personas(*), relationPerson:relation_persons(*)')
            .eq('id', contactId)
            .maybeSingle();

        if (contactError) {
            throw contactError;
        }

        if (!contact) {
            throw new Error(`Contact not found: ${contactId}`);
        }

        const relation = contact.relationPerson || {};

        // 2. Fetch the most recent HISTORY_LIMIT messages (with timestamp).
        //    Deliberately unfiltered: history is conversation context and needs
        //    both directions and both human- and ai-authored rows to stay coherent.
        //    Only the exemplar block below is provenance-gated.
        const { data: messages, error: messagesError } = await supabase
            .from('chats')
            .select('*')
            .eq('contact_id', contactId)
            .order('created_at', { ascending: false })
            .limit(HISTORY_LIMIT);

        if (messagesError) {
            throw messagesError;
        }

        // 3. Fetch Latest Insight (Summary)
        const { data: insights, error: insightsError } = await supabase
            .from('insights')
            .select('*')
            .eq('contact_id', contactId)
            .order('created_at', { ascending: false })
            .limit(1);

        if (insightsError) {
            throw insightsError;
        }

        const latestInsight = insights && insights.length > 0 ? insights[0] : null;

        // 4. Fetch style exemplars (human-authored outgoing messages only)
        const exemplars = await fetchExemplars(contactId);

        // 5. Format Components

        // My Persona -- this text carries its own Style and Rules sections, so no
        // generic defaults are appended below: an absent section beats one that
        // contradicts the persona.
        const myPersona = clean(relation.my_persona) ||
            "You are Rohan, chill, sarcastic and supportive. Reply briefly.";

        // My Dictionary (max 100 words)
        let dictionaryText = "";
        if (relation.my_dictionary) {
            const words = clean(relation.my_dictionary)
                .split(",")
                .map(w => w.trim())
                .filter(Boolean);
            dictionaryText = words.slice(0, 100).join(", ");
        }

        // Users' Persona
        const userPersona = clean(relation.user_persona) || clean(contact.notes) || "A WhatsApp user.";

        // Style / Rules -- rendered only when the relation actually defines them.
        const style = clean(relation.style);
        const rules = clean(relation.rules);

        // Summary
        const summary = clean(latestInsight && latestInsight.summary) ||
            "No long-term summary available yet.";

        // History with timestamps, displayed in chronological order
        const history = (messages || []).reverse().map(m => {
            const dateObj = new Date(m.created_at);
            const timestamp = dateObj.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            return `[${timestamp}] ${m.direction === "INCOMING" ? "User" : "Assistant"}: ${m.message}`;
        }).join("\n");

        // 6. Assemble the prompt. Sections are joined rather than written as one
        //    indented template literal, so no line carries stray leading
        //    whitespace and optional sections can simply be left out.
        const latestMessage = latestMessageText == null ? "" : clean(String(latestMessageText));

        const sections = ["SYSTEM PROMPT"];

        sections.push(`MY PERSONA:\n${myPersona}`);
        if (dictionaryText) sections.push(`MY DICTIONARY:\n${dictionaryText}`);
        sections.push(`USER'S PERSONA:\n${userPersona}`);
        sections.push(`PREVIOUS CONVERSATION SUMMARY:\n${summary}`);
        if (style) sections.push(`STYLE:\n${style}`);
        if (rules) sections.push(`RULES:\n${rules}`);

        const exemplarSection = renderExemplarSection(exemplars);
        if (exemplarSection) sections.push(exemplarSection);

        sections.push(`LAST ${HISTORY_LIMIT} MESSAGES (HISTORY):\n${history || "No previous history."}`);
        sections.push(`LATEST MESSAGE (REPLY TO THIS):\n${latestMessage}`);

        return sections.join("\n\n");
    } catch (error) {
        console.error("Error building dynamic prompt:", error);
        return "You are a helpful AI assistant.";
    }
}

module.exports = {
    buildDynamicPrompt,
    fetchExemplars,
    selectExemplars,
    HISTORY_LIMIT,
    EXEMPLAR_LIMIT
};
