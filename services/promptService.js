require("../loadEnv");
const { supabase } = require("./supabaseClient");
const { loadSystemPrompt, DEFAULT_VERSION } = require("./systemPrompt");
const { containsDevanagari } = require("./scriptCheck");
const { analyzeMoment } = require("./moodService");

function positiveIntFromEnv(raw, fallback) {
    const parsed = parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// How many past messages are replayed into the prompt. Single source of truth --
// the query limit and the section header both derive from it, so they cannot drift.
// Override with HISTORY_MESSAGE_LIMIT in .env.
const DEFAULT_HISTORY_LIMIT = 100;
const HISTORY_LIMIT = positiveIntFromEnv(process.env.HISTORY_MESSAGE_LIMIT, DEFAULT_HISTORY_LIMIT);

// THE TOKEN GUARD. Groq's limit on this account is 8,000 tokens per MINUTE,
// shared by every draft -- not per message -- so one draft must never eat it.
// After HISTORY_LIMIT messages are fetched, the OLDEST are dropped until the
// whole prompt fits MAX_CONTEXT_TOKENS. The newest messages and the one being
// answered always stay. Default 3500: about two drafts a minute.
// Override with MAX_CONTEXT_TOKENS in .env.
const DEFAULT_MAX_CONTEXT_TOKENS = 3500;
const MAX_CONTEXT_TOKENS = positiveIntFromEnv(process.env.MAX_CONTEXT_TOKENS, DEFAULT_MAX_CONTEXT_TOKENS);

/**
 * Deliberately pessimistic token count: Hinglish, Devanagari and emoji split
 * into more tokens than English, so ~3 characters per token. Over-counting
 * leaves a little room unused; under-counting would hit Groq's limit.
 */
function estimateTokens(text) {
    return Math.ceil(String(text == null ? '' : text).length / 3);
}

/** Per-message overhead the chat format adds (role markers etc.). */
const TOKENS_PER_MESSAGE = 4;

/** The newest items (oldest-first array) whose estimated cost fits `budget`. */
function newestThatFit(items, costOf, budget) {
    let used = 0;
    let start = items.length;
    for (let i = items.length - 1; i >= 0; i--) {
        const cost = costOf(items[i]);
        if (used + cost > budget) break;
        used += cost;
        start = i;
    }
    return items.slice(start);
}

// How many real, human-authored replies are shown as style exemplars. Abstract
// rules ("be brief", "be casual") lose to concrete samples, so the prompt shows
// the model what Rohan actually types instead of describing it.
// Override with EXEMPLAR_LIMIT in .env.
const DEFAULT_EXEMPLAR_LIMIT = 20;
const EXEMPLAR_LIMIT = positiveIntFromEnv(process.env.EXEMPLAR_LIMIT, DEFAULT_EXEMPLAR_LIMIT);

// Where those style examples may come from. Override with EXEMPLAR_SCOPE in .env.
//   'contact' (default) -- only messages Rohan sent to the contact being
//       answered, so one relationship's register (pet names, inside jokes, its
//       language mix) never leaks into another contact's drafts.
//   'all' -- the old behaviour: top up from every thread when a contact has
//       fewer than EXEMPLAR_LIMIT examples of its own.
const EXEMPLAR_SCOPE = String(process.env.EXEMPLAR_SCOPE || '').trim().toLowerCase() === 'all' ? 'all' : 'contact';

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
    const dropped = { empty: 0, "too-long": 0, "json-like": 0, "link-like": 0, devanagari: 0, duplicate: 0 };
    let demoted = 0;

    pool.forEach((row, index) => {
        // Multi-line messages are collapsed so each exemplar stays one bullet.
        const text = clean(row && row.message).replace(/\s*\n\s*/g, " ");
        if (!text) { dropped.empty += 1; return; }
        if (text.length > MAX_EXEMPLAR_CHARS) { dropped["too-long"] += 1; return; }
        if (looksLikeJson(text)) { dropped["json-like"] += 1; return; }
        if (containsUrl(text)) { dropped["link-like"] += 1; return; }
        // Replies must be in Roman letters (Hinglish / Marathi-English), so a
        // Devanagari message is never shown as an example of how Rohan texts.
        if (containsDevanagari(text)) { dropped.devanagari += 1; return; }

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

    // EXEMPLAR_SCOPE=contact (the default) stops here: a contact only ever sees
    // examples from its own chat. A brand-new contact simply has none yet.
    if (EXEMPLAR_SCOPE !== 'all') return scoped;

    // EXEMPLAR_SCOPE=all only: top up from every thread. How Rohan writes is a property of Rohan, not of
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

/**
 * The classic layout (v1-v3): everything in one system message.
 * @param {object} [options]
 * @param {string} [options.promptVersion] persona file to use instead of
 *        SYSTEM_PROMPT_VERSION -- how v4 falls back to v3 for a contact it
 *        cannot learn a tone from yet.
 */
async function buildDynamicPrompt(contactId, latestMessageText, options = {}) {
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
        //
        // A contact without a persona of its own gets the base system prompt file,
        // system_prompts/system_prompt_<SYSTEM_PROMPT_VERSION>.txt (v3 by default),
        // instead of a one-liner: that file carries the mood matching, reply
        // length, language and hand-off rules. It is read on every draft, so edits
        // to the file apply to the next reply without a restart. If the file is
        // missing, loadSystemPrompt hands back the same one-liner as before.
        const myPersona = clean(relation.my_persona) ||
            clean(loadSystemPrompt(options.promptVersion).text) ||
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

        // History with timestamps, displayed in chronological order. Kept as
        // lines for now: the token guard trims it once the rest is assembled.
        const historyLines = (messages || []).reverse().map(m => {
            const dateObj = new Date(m.created_at);
            const timestamp = dateObj.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            return `[${timestamp}] ${m.direction === "INCOMING" ? "User" : "Assistant"}: ${m.message}`;
        });

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

        // TOKEN GUARD: everything except the history is fixed, so the history
        // gets whatever budget is left, newest lines first.
        const latestSection = `LATEST MESSAGE (REPLY TO THIS):\n${latestMessage}`;
        const historyHeader = `LAST ${HISTORY_LIMIT} MESSAGES (HISTORY):\n`;
        const fixedTokens = estimateTokens([...sections, historyHeader, latestSection].join("\n\n")) + TOKENS_PER_MESSAGE * 2;
        const keptLines = newestThatFit(historyLines, line => estimateTokens(line) + 1, MAX_CONTEXT_TOKENS - fixedTokens);
        const history = keptLines.join("\n");
        if (options.report) {
            options.report.historyMessages = keptLines.length;
            options.report.trimmed = historyLines.length - keptLines.length;
        }

        sections.push(`${historyHeader}${history || "No previous history."}`);
        sections.push(latestSection);

        return sections.join("\n\n");
    } catch (error) {
        console.error("Error building dynamic prompt:", error);
        return "You are a helpful AI assistant.";
    }
}

// ---------------------------------------------------------------------------
// Prompt versions and layouts
// ---------------------------------------------------------------------------
//
// SYSTEM_PROMPT_VERSION (.env) picks system_prompts/system_prompt_<version>.txt
// AND the layout the draft is built with:
//
//   v1, v2, v3 -> 'classic' (buildDynamicPrompt above): the persona file, the
//       per-contact fields, style examples and the last HISTORY_MESSAGE_LIMIT
//       messages, all in one system message.
//
//   v4 -> 'per-person' (buildPerPersonMessages below): the chat with THIS
//       contact replayed as real turns -- Rohan's own messages become the
//       model's earlier replies, so its job is literally "write Rohan's next
//       message to this person" -- plus style notes and Rohan's complete
//       vocabulary with this person, measured from Rohan's own messages to
//       them and nobody else. Different people get different tones.
//       A contact with fewer than STYLE_MIN_MESSAGES of Rohan's own messages
//       has no tone to learn yet, so it falls back to the classic layout with
//       PROMPT_FALLBACK_VERSION (v3 by default).
//
//   v5 -> the same per-person layout with system_prompt_v5.txt: the general,
//       principle-only rules (no examples taken from particular chats) plus
//       understanding Marathi / Hindi / English in Devanagari or Roman letters.
//
// Giving a future version a layout is one line in PROMPT_LAYOUTS.
const PROMPT_LAYOUTS = { v4: 'per-person', v5: 'per-person' };
const DEFAULT_FALLBACK_VERSION = 'v3';
// 0 is allowed: v4 then handles every contact, even one Rohan has never written to.
const STYLE_MIN_MESSAGES = (() => {
    const parsed = parseInt(process.env.STYLE_MIN_MESSAGES, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 10;
})();
// Rohan's most recent messages to the contact that style and vocabulary are
// measured from. 1000 is also the most PostgREST returns in one request.
const STYLE_SAMPLE_LIMIT = 1000;
// Words listed in the vocabulary, most used first. A small chat lists every
// word; a big one keeps the most used, which also drops one-off names/places.
const VOCAB_LIMIT = 150;
const PHRASE_LIMIT = 20;

function currentPromptVersion() {
    return String(process.env.SYSTEM_PROMPT_VERSION || '').trim() || DEFAULT_VERSION;
}

function fallbackPromptVersion() {
    const version = String(process.env.PROMPT_FALLBACK_VERSION || '').trim() || DEFAULT_FALLBACK_VERSION;
    // A per-person version cannot be its own fallback.
    return PROMPT_LAYOUTS[version] ? DEFAULT_FALLBACK_VERSION : version;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_ALL = /\p{Extended_Pictographic}/gu;
const URL_LIKE = /https?:\/\/\S+|www\.\S+/gi;
// English-only function words carry no style. Deliberately short: Hinglish
// words ("kya", "nhi", "hai", "to") stay, because they ARE the style.
const VOCAB_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'is', 'are', 'was', 'were', 'been', 'am',
    'and', 'or', 'it', 'its', 'this', 'that', 'for', 'with', 'as', 'by', 'from', 'i']);

const countInto = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const ranked = counts => Object.entries(counts).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

/**
 * How Rohan writes to ONE person, measured from Rohan's own messages to them
 * (`ownTexts`) and the chat rows, oldest first (`historyRows`, for bursts).
 * Pure: no DB, no network.
 */
function describeStyle(ownTexts, historyRows = []) {
    const texts = (ownTexts || []).map(t => clean(t)).filter(Boolean);
    const n = texts.length;
    if (!n) return { count: 0 };

    const words = texts.map(t => t.split(/\s+/).length).sort((a, b) => a - b);
    const quantile = q => words[Math.min(n - 1, Math.floor(q * n))];

    const withEmoji = texts.filter(t => EMOJI.test(t));
    const emojiCounts = {};
    withEmoji.forEach(t => (t.match(EMOJI_ALL) || []).forEach(e => countInto(emojiCounts, e)));

    const firstLetters = texts.map(t => (t.match(/\p{L}/u) || [])[0]).filter(Boolean);
    const capitals = firstLetters.filter(ch => ch !== ch.toLowerCase()).length;

    // Vocabulary and phrases: Roman-letter words only, spelling kept exactly
    // ("nhi" and "nahi" are different words -- spelling IS the style), counted
    // once per message so one long rant cannot dominate.
    const wordCounts = {};
    const phraseCounts = {};
    texts.forEach(t => {
        const tokens = t.toLowerCase().replace(URL_LIKE, ' ').match(/[a-z][a-z']*/g) || [];
        new Set(tokens.filter(w => !VOCAB_STOPWORDS.has(w))).forEach(w => countInto(wordCounts, w));
        const phrases = new Set();
        for (let i = 0; i + 1 < tokens.length; i++) {
            if (!VOCAB_STOPWORDS.has(tokens[i]) && !VOCAB_STOPWORDS.has(tokens[i + 1])) phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
        }
        phrases.forEach(p => countInto(phraseCounts, p));
    });

    // Bursts: runs of Rohan's own consecutive messages in the chat window.
    const runs = [];
    let run = 0;
    (historyRows || []).forEach(r => {
        const mine = r.direction === 'OUTGOING' && r.metadata && r.metadata.source === 'human';
        if (mine) run += 1;
        else if (r.direction === 'INCOMING') { if (run) runs.push(run); run = 0; }
    });
    if (run) runs.push(run);

    return {
        count: n,
        medianWords: quantile(0.5),
        longWords: quantile(0.9),
        emojiRate: withEmoji.length / n,
        emojis: ranked(emojiCounts).slice(0, 8).map(([e]) => e),
        emojiCounts: ranked(emojiCounts).slice(0, 8),
        capitalRate: firstLetters.length ? capitals / firstLetters.length : null,
        ellipsisRate: texts.filter(t => /\.\.|…/.test(t)).length / n,
        burstRate: runs.length ? runs.filter(r => r >= 2).length / runs.length : 0,
        vocabulary: ranked(wordCounts).slice(0, VOCAB_LIMIT).map(([w]) => w),
        vocabularyCounts: ranked(wordCounts).slice(0, VOCAB_LIMIT),
        phrases: ranked(phraseCounts).filter(([, c]) => c >= 2).slice(0, PHRASE_LIMIT).map(([p]) => p)
    };
}

/** The style notes block of a v4 prompt. '' when there is nothing to describe. */
function renderStyleNotes(style) {
    const count = (style && style.count) || 0;
    // Too few of Rohan's own messages to measure anything: say so, and point the
    // model at the chat itself rather than at made-up habits.
    if (count < 3) {
        return `STYLE NOTES: Rohan has sent this person only ${count} message${count === 1 ? '' : 's'} so far, `
            + 'so there is little to copy yet. Copy what there is, otherwise match their language and energy: '
            + 'react to what they actually said, short and natural, the way a close friend would.';
    }
    const pct = r => `${Math.round(r * 100)}%`;
    const lines = [`- Length: usually about ${style.medianWords} word${style.medianWords === 1 ? '' : 's'}; `
        + `rarely more than ${Math.max(style.longWords, style.medianWords)}.`];
    if (style.emojiRate < 0.05) lines.push('- Emojis: almost never. Do not add them.');
    // Counts, not just a list: a list made a twice-ever emoji look like a habit.
    else lines.push(`- Emojis: in about ${pct(style.emojiRate)} of Rohan's messages, not every one`
        + `${style.emojiCounts.length ? `. Each one, in how many of ${style.count} messages: `
            + style.emojiCounts.map(([e, c]) => `${e} ${c}`).join(', ') : ''}.`);
    if (style.capitalRate !== null && style.capitalRate >= 0.7) lines.push('- Usually starts a message with a capital letter.');
    else if (style.capitalRate !== null && style.capitalRate <= 0.3) lines.push('- Usually types in lowercase.');
    // Habits are given as rates, not rules: "often trails off" turned into
    // "..." on every single reply.
    if (style.ellipsisRate >= 0.15) lines.push(`- In about ${pct(style.ellipsisRate)} of messages Rohan trails off with "...", not every one.`);
    if (style.burstRate >= 0.3) lines.push(`- About ${pct(style.burstRate)} of the time Rohan sends a few short messages in a row; then put each one on its own line.`);
    // Vocabulary in tiers by how often Rohan uses each word with this person:
    // one flat list made a once-ever word look as normal as a daily one, and the
    // model then used it in every reply.
    const tier = test => style.vocabularyCounts.filter(([, c]) => test(c)).map(([w]) => w);
    const often = tier(c => c >= 3);
    const sometimes = tier(c => c === 2);
    const once = tier(c => c === 1);
    if (often.length) lines.push(`- Words Rohan uses often with them (exact spellings, most used first): ${often.join(', ')}.`);
    if (sometimes.length) lines.push(`- Words Rohan has used twice with them: ${sometimes.join(', ')}.`);
    if (once.length) lines.push(`- Words Rohan has used only once with them (rare: at most one per reply, only if it fits): ${once.join(', ')}.`);
    if (style.phrases.length) lines.push(`- Phrases Rohan repeats with them: ${style.phrases.map(p => `"${p}"`).join(', ')}.`);
    return `STYLE NOTES (measured from Rohan's last ${style.count} messages to this person, nobody else):\n${lines.join('\n')}`;
}

/**
 * The chat as alternating turns: their messages are "user", Rohan's are
 * "assistant". Only what Rohan really typed may stand in for Rohan's earlier
 * replies, so AI-written, mock and unknown-provenance outgoing rows are left
 * out, as are mock (invented) incoming rows. Consecutive messages from the
 * same side are joined, one per line. Always ends on their latest message.
 */
function toTurns(historyRows, latestMessageText) {
    const turns = [];
    for (const row of historyRows || []) {
        const source = row.metadata && row.metadata.source;
        if (source === 'mock' || (row.direction === 'OUTGOING' && source !== 'human')) continue;
        const text = clean(row.message);
        if (!text) continue;
        const role = row.direction === 'INCOMING' ? 'user' : 'assistant';
        const last = turns[turns.length - 1];
        if (last && last.role === role) last.content += `\n${text}`;
        else turns.push({ role, content: text });
    }
    // Rohan's opening messages STAY, even when the chat starts with them. They
    // used to be dropped so the chat would start with a "user" turn, and that
    // cut exactly the message the reply depends on whenever Rohan started the
    // conversation: the model saw only "Thanks bro" (not Rohan's birthday wish)
    // and only "Red bus" (not Rohan's question about which app), and answered
    // the wrong thing. The chat API accepts an assistant turn first.

    // Normally their latest message is already stored and closes the chat. If
    // storing it failed, add it so the model still answers the right thing.
    const latest = clean(latestMessageText == null ? '' : String(latestMessageText));
    const last = turns[turns.length - 1];
    if (latest && !(last && last.role === 'user' && last.content.includes(latest))) {
        if (last && last.role === 'user') last.content += `\n${latest}`;
        else turns.push({ role: 'user', content: latest });
    }
    return turns;
}

// How many of the bot's recent replies to one person are listed as "don't repeat".
const RECENT_REPLY_LIMIT = 8;

/** Unique, non-empty replies, at most RECENT_REPLY_LIMIT. */
function recentReplies(texts) {
    const seen = new Set();
    const out = [];
    for (const text of texts || []) {
        const cleaned = clean(text == null ? '' : String(text)).replace(/\s*\n\s*/g, ' / ');
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
        if (out.length >= RECENT_REPLY_LIMIT) break;
    }
    return out;
}

function timeAgo(ms) {
    const hours = ms / 3600000;
    if (hours < 48) return `${Math.round(hours)} hours`;
    return `${Math.round(hours / 24)} days`;
}

/**
 * The RIGHT NOW block: who, when, how long since Rohan last wrote, and the
 * mood reading (services/moodService.js) when there is one. Pure.
 */
function renderSituation({ now = new Date(), contactName, history = [], moment } = {}) {
    const lines = [];
    if (contactName) lines.push(`- Texting with: ${clean(String(contactName))}`);
    const when = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
    lines.push(`- For Rohan it is ${when}.`);
    // Who said what last, worked out in code so it cannot be misread: Rohan's
    // last message, and what they said after it -- the thing being replied to.
    const isRohan = r => r.direction === 'OUTGOING' && r.metadata && r.metadata.source === 'human';
    let lastRohanAt = -1;
    history.forEach((r, i) => { if (isRohan(r)) lastRohanAt = i; });
    const quote = t => clean(String(t == null ? '' : t)).replace(/\s*\n\s*/g, ' / ').replace(/"/g, "'").slice(0, 200);
    if (lastRohanAt >= 0) {
        const lastRohan = history[lastRohanAt];
        lines.push(`- Rohan's last message to them: "${quote(lastRohan.message)}"`);
        const after = history.slice(lastRohanAt + 1)
            .filter(r => r.direction === 'INCOMING' && !(r.metadata && r.metadata.source === 'mock'))
            .map(r => r.message);
        if (after.length) lines.push(`- What they said after it (what you are replying to): "${quote(after.join('\n'))}"`);
        const gap = now.getTime() - Date.parse(lastRohan.created_at);
        if (gap >= 6 * 3600000) lines.push(`- Rohan's last message to them was ${timeAgo(gap)} ago.`);
    } else {
        lines.push('- Rohan has not written to them in this chat yet.');
    }
    if (moment) {
        lines.push('- A quick read of the moment (it can be wrong; the chat itself always wins):');
        if (moment.lastExchange) lines.push(`  - Last exchange: ${moment.lastExchange}`);
        lines.push(`  - They seem ${moment.mood} (energy: ${moment.energy}). They want: ${moment.intent}.${moment.topic ? ` Topic: ${moment.topic}.` : ''}`);
        if (moment.relationship) lines.push(`  - How these two talk: ${moment.relationship}.`);
        if (moment.rohanPattern && !/not enough history/i.test(moment.rohanPattern)) {
            lines.push(`  - In moments like this Rohan usually: ${moment.rohanPattern}`);
        }
        if (moment.missingContext) {
            lines.push(`  - Their message seems to depend on something that is not in this chat (${moment.missingContext}), `
                + 'maybe talked about in person. If you can\'t find it in the chat, reply exactly: negative');
        }
        if (moment.needsRohan) {
            lines.push(`  - This looks like it needs the real Rohan (${moment.needsRohanReason || 'see the hand-off rules'}). If it does, reply exactly: negative`);
        }
    }
    return `RIGHT NOW (use this to pick the tone; never mention these notes):\n${lines.join('\n')}`;
}

/** The DON'T REPEAT YOURSELF block. '' when there is nothing to avoid. */
function renderAvoid(replies) {
    if (!replies || !replies.length) return '';
    return 'DON\'T REPEAT YOURSELF (replies already written for this person recently; say something different, in different words):\n'
        + replies.map(r => `- ${r}`).join('\n');
}

/**
 * v4: { messages, ownMessages, ... } -- or { messages: null, reason } when there is no tone to learn yet.
 * @param {object} [options] { contactName, recentDrafts: [text], now: Date }
 */
async function buildPerPersonMessages(contactId, latestMessageText, version, options = {}) {
    const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('*, persona:personas(*), relationPerson:relation_persons(*)')
        .eq('id', contactId)
        .maybeSingle();
    if (contactError) throw contactError;
    if (!contact) throw new Error(`Contact not found: ${contactId}`);

    // Rohan's own, human-typed messages to THIS contact only.
    const { data: own, error: ownError } = await supabase
        .from('chats')
        .select('message, created_at')
        .eq('contact_id', contactId)
        .eq('direction', 'OUTGOING')
        .eq('metadata->>source', 'human')
        .order('created_at', { ascending: false })
        .limit(STYLE_SAMPLE_LIMIT);
    if (ownError) throw ownError;
    const ownTexts = (own || []).map(r => r.message).filter(t => clean(t));
    if (ownTexts.length < STYLE_MIN_MESSAGES) {
        return { messages: null, ownMessages: ownTexts.length,
            reason: `only ${ownTexts.length} of your messages to them, needs ${STYLE_MIN_MESSAGES}` };
    }

    const { data: recent, error: historyError } = await supabase
        .from('chats')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT);
    if (historyError) throw historyError;
    const history = (recent || []).slice().reverse();

    const { data: insights, error: insightsError } = await supabase
        .from('insights')
        .select('*')
        .eq('contact_id', contactId)
        .order('created_at', { ascending: false })
        .limit(1);
    if (insightsError) throw insightsError;
    const summary = clean(insights && insights[0] && insights[0].summary);

    const relation = contact.relationPerson || {};
    const about = clean(relation.user_persona) || clean(contact.notes);

    // Replies the bot already wrote for this person, so it does not repeat
    // itself: drafts from this run (testing mode, passed in by the caller) plus
    // replies it really sent (live mode, stored as source:'ai'). Listed only as
    // things to avoid -- never as Rohan's own words.
    const { data: sentByBot, error: botError } = await supabase
        .from('chats')
        .select('message, created_at')
        .eq('contact_id', contactId)
        .eq('direction', 'OUTGOING')
        .eq('metadata->>source', 'ai')
        .order('created_at', { ascending: false })
        .limit(RECENT_REPLY_LIMIT);
    if (botError) throw botError;
    const avoid = recentReplies([...(options.recentDrafts || []).slice().reverse(), ...(sentByBot || []).map(r => r.message)]);

    // Mood reading. Never throws: on any failure it is null and the draft
    // simply goes ahead without it.
    const moment = await analyzeMoment(history, latestMessageText);

    // Style is measured from the full window, before the guard trims anything.
    const style = describeStyle(ownTexts, history);
    const sections = [clean(loadSystemPrompt(version).text), renderStyleNotes(style)];
    sections.push(renderSituation({ now: options.now || new Date(), contactName: options.contactName, history, moment }));
    if (about) sections.push(`ABOUT THIS PERSON:\n${about}`);
    if (summary) sections.push(`EARLIER IN THIS CHAT (summary):\n${summary}`);
    sections.push(renderAvoid(avoid));
    const system = sections.filter(Boolean).join('\n\n');

    // TOKEN GUARD: the instructions, style notes and their latest message are
    // fixed; the chat history gets what is left, newest messages first.
    const fixedTokens = estimateTokens(system) + estimateTokens(latestMessageText) + TOKENS_PER_MESSAGE * 2;
    const kept = newestThatFit(history, row => estimateTokens(row.message) + TOKENS_PER_MESSAGE, MAX_CONTEXT_TOKENS - fixedTokens);

    return {
        messages: [{ role: 'system', content: system }, ...toTurns(kept, latestMessageText)],
        ownMessages: ownTexts.length,
        historyMessages: kept.length,
        trimmed: history.length - kept.length,
        mood: moment,
        avoided: avoid.length,
        // Only from a real sample: a rate from 1-4 messages is noise.
        emojiRate: style.count >= 5 ? style.emojiRate : null,
        // How long Rohan writes to this person, for the length habit in
        // whatsappService: maxWords = how long 90% of Rohan's messages to them
        // are at most (never below 4), maxLines from how often Rohan sends a
        // few messages in a row.
        lengthHabit: style.count >= 5 ? {
            maxWords: Math.max(style.longWords, 4),
            maxLines: style.burstRate >= 0.5 ? 3 : style.burstRate >= 0.3 ? 2 : 1
        } : null
    };
}

/**
 * The messages for one draft, in whichever layout SYSTEM_PROMPT_VERSION picks.
 * Returns { messages, meta } -- meta says which version and layout actually
 * ran (and why, after a fallback), for the AUDIT block.
 */
async function buildDraftMessages(contactId, latestMessageText, options = {}) {
    const version = currentPromptVersion();

    if (PROMPT_LAYOUTS[version] === 'per-person') {
        let perPerson;
        try {
            perPerson = await buildPerPersonMessages(contactId, latestMessageText, version, options);
        } catch (error) {
            console.error(`promptService: the ${version} prompt failed (${(error && error.message) || error}); using the classic layout.`);
            perPerson = { messages: null, reason: 'it failed to build' };
        }
        if (perPerson.messages) {
            return {
                messages: perPerson.messages,
                meta: { version, layout: 'per-person', ownMessages: perPerson.ownMessages,
                    historyMessages: perPerson.historyMessages, trimmed: perPerson.trimmed, budget: MAX_CONTEXT_TOKENS,
                    mood: perPerson.mood || null, avoided: perPerson.avoided || 0, emojiRate: perPerson.emojiRate,
                    lengthHabit: perPerson.lengthHabit || null }
            };
        }
        const fallback = fallbackPromptVersion();
        const report = {};
        const prompt = await buildDynamicPrompt(contactId, latestMessageText, { promptVersion: fallback, report });
        return {
            messages: [{ role: 'system', content: prompt }],
            meta: { version: fallback, layout: 'classic', requested: version, reason: perPerson.reason,
                historyMessages: report.historyMessages, trimmed: report.trimmed, budget: MAX_CONTEXT_TOKENS }
        };
    }

    const report = {};
    const prompt = await buildDynamicPrompt(contactId, latestMessageText, { report });
    return {
        messages: [{ role: 'system', content: prompt }],
        meta: { version, layout: 'classic', historyMessages: report.historyMessages, trimmed: report.trimmed, budget: MAX_CONTEXT_TOKENS }
    };
}

module.exports = {
    buildDynamicPrompt,
    buildDraftMessages,
    describeStyle,
    renderStyleNotes,
    renderSituation,
    renderAvoid,
    recentReplies,
    toTurns,
    fetchExemplars,
    selectExemplars,
    estimateTokens,
    HISTORY_LIMIT,
    MAX_CONTEXT_TOKENS,
    EXEMPLAR_LIMIT,
    EXEMPLAR_SCOPE,
    PROMPT_LAYOUTS,
    STYLE_MIN_MESSAGES
};
