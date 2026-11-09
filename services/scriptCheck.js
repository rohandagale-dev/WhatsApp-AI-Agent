/**
 * Devanagari detection -- the one place that decides what "not Roman letters" means.
 *
 * Rohan writes Hindi and Marathi in Roman letters only ("kasa ahe", "chalega"):
 * Hinglish or Marathi-English, never Devanagari. Two places enforce that, and
 * both use this module so they can never disagree:
 *
 *   - whatsappService: a draft in Devanagari gets one rewrite request, and is
 *     dropped (never sent) if it is still in Devanagari;
 *   - promptService: messages in Devanagari are never shown to the model as
 *     "how I text" style examples, so it is not taught that script.
 *
 * Pure: no DB, no network.
 */

// Devanagari (used by Marathi and Hindi) plus its extension blocks.
const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ᳐-᳿]/;

function containsDevanagari(text) {
    return typeof text === 'string' && DEVANAGARI.test(text);
}

module.exports = { containsDevanagari, DEVANAGARI };
