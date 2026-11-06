/**
 * Scrubs "model tells" out of a generated reply before it is sent or stored.
 *
 * LLMs punctuate like a typesetter: en dashes, curly quotes, the ellipsis
 * character, non-breaking spaces, stray zero-width joiners. Nobody thumbing a
 * message into WhatsApp produces any of that. A real case from this project:
 * the model answered "B-10" spelled with U+2011 NON-BREAKING HYPHEN, where the
 * source row plainly said "B-10" with an ASCII '-'. Invisible in a diff,
 * obvious to the contact.
 *
 * Deliberately narrow. This agent speaks Hinglish and Marathi, so Devanagari,
 * ordinary ASCII punctuation, digits and word spacing come through untouched.
 * ZERO WIDTH JOINER / NON-JOINER are dropped only when they are NOT doing real
 * work -- between Devanagari letters they select conjunct forms, and inside an
 * emoji sequence they hold the sequence together, so both cases are preserved.
 *
 *   const { sanitizeReply } = require('./sanitizeReply');
 *   sanitizeReply(text);                        // emoji kept (default)
 *   sanitizeReply(text, { allowEmoji: false }); // system_prompt_v2: "DON'T USE EMOJIS AT ALL"
 *
 * Never throws. Anything that is not a string returns ''.
 */

// --- character tables ------------------------------------------------------
//
// Spelled as \uXXXX escapes on purpose: most of these characters are invisible
// or look identical to their ASCII twin, so writing them literally would make
// this file impossible to review.

// Every dash a model reaches for instead of the key next to '0'.
// U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2012 FIGURE DASH, U+2013 EN DASH,
// U+2014 EM DASH, U+2015 HORIZONTAL BAR, U+2043 HYPHEN BULLET, U+2212 MINUS SIGN,
// U+FE58 / U+FE63 small forms, U+FF0D FULLWIDTH HYPHEN-MINUS.
const DASHES = /[\u2010-\u2015\u2043\u2212\uFE58\uFE63\uFF0D]/g;

// Curly single quotes, primes and modifier apostrophes.
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u2035\u00B4\u02B9\u02BC\uFF07]/g;

// Curly double quotes and double primes.
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u2036\u02BA\uFF02]/g;

// U+2026 HORIZONTAL ELLIPSIS, U+22EF MIDLINE HORIZONTAL ELLIPSIS.
const ELLIPSIS = /[\u2026\u22EF]/g;

// NBSP, ogham space, the U+2000-U+200A family (en/em/thin/hair/figure space),
// narrow NBSP, medium mathematical space, ideographic space.
const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

// Invisible characters that carry no meaning in Devanagari or Latin text:
// soft hyphen, Mongolian vowel separator, zero width space, bidi controls,
// word joiner + invisible math operators, and the BOM / zero width no-break space.
// U+200C and U+200D are deliberately absent -- unlike these they can be load
// bearing, so they are handled separately below.
const INVISIBLE = /[\u00AD\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// Leftovers once an emoji sequence has been removed: the two variation
// selectors and the combining enclosing keycap.
const EMOJI_LEFTOVERS = /[\uFE0E\uFE0F\u20E3]/g;

// A ZWJ/ZWNJ is only load bearing when BOTH neighbours are Indic letters (there
// it picks conjunct vs half forms) or emoji parts (there it holds a ZWJ sequence
// together). Anywhere else it is invisible noise, so these two passes delete a
// joiner whose left neighbour -- or whose right neighbour -- is neither.
// The guard spans U+0900-U+0DFF (Devanagari through Sinhala), Tibetan, Vedic
// Extensions and Devanagari Extended, plus emoji, flags, skin tones and VS16.
const JOINER_LEFT_STRAY =
    /(?<![\u0900-\u0DFF\u0F00-\u0FFF\u1CD0-\u1CFF\uA8E0-\uA8FF\uFE0F]|\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}])[\u200C\u200D]/gu;
const JOINER_RIGHT_STRAY =
    /[\u200C\u200D](?![\u0900-\u0DFF\u0F00-\u0FFF\u1CD0-\u1CFF\uA8E0-\uA8FF\uFE0F]|\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}])/gu;

// One whole emoji: keycaps, flags, skin tones, ZWJ families and tag sequences.
// Extended_Pictographic is used rather than \p{Emoji} on purpose -- \p{Emoji}
// also matches plain ASCII digits, '#' and '*', which would turn "call me at 9"
// into "call me at". The keycap branch comes first so it can swallow its digit.
const EMOJI =
    /(?:[#*0-9]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]{2}|\p{Extended_Pictographic})(?:[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]|\u200D(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])|[\u{E0020}-\u{E007F}])*/gu;

const QUOTE_CHARS = ['"', "'"];

/**
 * Models like to hand the reply back wrapped in quotes, as if reporting it.
 * Only unwrap when the pair is unambiguous -- matching outer quotes with no
 * other copy of that quote inside -- so 'don't' and he said "hi" survive.
 */
function unwrapQuotes(text) {
    let out = text;
    // Twice, so '"arre yaar"' loses both layers.
    for (let pass = 0; pass < 2; pass++) {
        const open = out.charAt(0);
        if (out.length < 3 || QUOTE_CHARS.indexOf(open) === -1) break;
        if (out.charAt(out.length - 1) !== open) break;
        const inner = out.slice(1, -1).trim();
        if (!inner || inner.indexOf(open) !== -1) break;
        out = inner;
    }
    return out;
}

/**
 * @param {string} text  raw model output
 * @param {object} [opts]
 * @param {boolean} [opts.allowEmoji=true]           pass false to strip every emoji
 * @param {boolean} [opts.stripWrappingQuotes=true]  pass false to keep outer quotes
 * @returns {string} the cleaned reply, or '' for any non-string input
 */
function sanitizeReply(text, opts) {
    if (typeof text !== 'string' || text.length === 0) return '';

    // Strict === false, so a stray truthy value cannot silently change behaviour.
    const allowEmoji = !(opts && opts.allowEmoji === false);
    const stripQuotes = !(opts && opts.stripWrappingQuotes === false);

    try {
        let out = text.replace(/\r\n?/g, '\n');

        out = out.replace(DASHES, '-');
        out = out.replace(SINGLE_QUOTES, "'");
        out = out.replace(DOUBLE_QUOTES, '"');
        out = out.replace(ELLIPSIS, '...');
        out = out.replace(EXOTIC_SPACES, ' ');

        if (!allowEmoji) {
            out = out.replace(EMOJI, '');
            out = out.replace(EMOJI_LEFTOVERS, '');
            // Close the holes the emoji left behind, but never touch line breaks.
            out = out.replace(/[ \t]{2,}/g, ' ');
            out = out.replace(/^[ \t]+|[ \t]+$/gm, '');
        }

        out = out.replace(INVISIBLE, '');
        out = out.replace(JOINER_LEFT_STRAY, '');
        out = out.replace(JOINER_RIGHT_STRAY, '');

        out = out.replace(/[ \t]+\n/g, '\n');
        out = out.replace(/\n{3,}/g, '\n\n');
        out = out.trim();

        if (stripQuotes) out = unwrapQuotes(out);

        return out;
    } catch (err) {
        // A sanitiser must never be the reason a reply fails to go out.
        console.warn(`sanitizeReply: falling back to the raw text - ${err.message}`);
        return text.trim();
    }
}

// Callable directly (`require('./sanitizeReply')(text)`) or destructured.
module.exports = sanitizeReply;
module.exports.sanitizeReply = sanitizeReply;
