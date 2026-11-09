/**
 * Which model id / provider answers a given AI_VERSION.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * whatsappService.js and trainingService.js each carried a byte-identical
 * `resolveModelId`, kept in step by a comment that said "keep in sync with the
 * other copy". They were already out of sync with the thing they are supposed
 * to mirror: geminiService resolves its model as
 *
 *     (process.env.GEMINI_MODEL || '').trim() || 'gemini-2.5-flash'
 *
 * while both copies used the untrimmed `process.env.GEMINI_MODEL || default`.
 * With GEMINI_MODEL='   ' the provider therefore called gemini-2.5-flash while
 * chats.metadata.model recorded '   ' -- a model id that never saw the request,
 * which is exactly the dishonesty this resolver exists to prevent.
 *
 * One resolver, both callers, and it TRIMS -- matching geminiService.
 *
 * Trimming is also the right answer for the other two providers even though
 * neither trims today: groqService sends `process.env.GROQ_MODEL || default`
 * and ollamaService sends `process.env.OLLAMA_MODEL || default`, so a
 * whitespace-only value makes the request itself fail. CONTRACT 2 then turns
 * that into { ok:false, text:null, error }, the caller stores nothing, and no
 * model id is recorded at all -- so trimming here can never invent an id for a
 * request that did happen. What it does fix is the ordinary ' gemini-2.5-pro '
 * case, where the provider trims and the metadata must agree.
 *
 * Resolved per call (not at module load) so anything that mutates process.env
 * after require() -- tests, a reload -- still gets the model it asked for.
 *
 * Pure: no DB, no network, no Baileys. Reads process.env only.
 */

/**
 * Per AI_VERSION: the env var the provider reads, and the default it falls back
 * to. Every entry must match the provider service byte for byte; a mismatch
 * here silently mislabels rows in chats.metadata.model.
 */
const PROVIDERS = {
    v1: { label: 'Gemini', envVar: 'GEMINI_MODEL', defaultModel: 'gemini-2.5-flash' },
    v2: { label: 'Groq', envVar: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-120b' },
    v3: { label: 'Ollama', envVar: 'OLLAMA_MODEL', defaultModel: 'llama3.1:8b' }
};

/** v1 is the default for an unset or unrecognised AI_VERSION, as both callers assume. */
const DEFAULT_AI_VERSION = 'v1';

function providerFor(aiVersion) {
    return PROVIDERS[aiVersion] || PROVIDERS[DEFAULT_AI_VERSION];
}

/**
 * The model id that actually answers a request for this AI_VERSION.
 * @param {string} aiVersion 'v1' | 'v2' | 'v3'; anything else is treated as v1.
 * @returns {string}
 */
function resolveModelId(aiVersion) {
    const provider = providerFor(aiVersion);
    // .trim() -- see the header. geminiService trims, so this must too.
    const configured = (process.env[provider.envVar] || '').trim();
    return configured || provider.defaultModel;
}

/** Human-readable provider name for log lines. */
function providerLabel(aiVersion) {
    return providerFor(aiVersion).label;
}

module.exports = {
    resolveModelId,
    providerLabel,
    PROVIDERS,
    DEFAULT_AI_VERSION
};
