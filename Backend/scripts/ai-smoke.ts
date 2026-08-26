/**
 * Live check of the AI analysis path: `npm run ai:smoke`.
 *
 * Runs one real request against the configured provider using a fixture session, so a
 * bad key, a wrong model id or a rejected response schema shows up here rather than the
 * first time a reviewer clicks Analyse. It touches no database and writes nothing.
 */
import { buildSessionDigest } from '../src/ai/digest.js';
import { GeminiClient } from '../src/ai/gemini.client.js';
import { RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, buildPrompt } from '../src/ai/prompt.js';
import { loadConfig } from '../src/config/env.js';
import flagged from '../tests/fixtures/session-payload.flagged.json' with { type: 'json' };

const fixture = flagged as Record<string, any>;
const config = loadConfig();

if (!config.ai.enabled) {
  console.error('AI is disabled. Set AI_API_KEY and AI_ENABLED=true in .env.');
  process.exit(1);
}

console.log(`model: ${config.ai.model}`);

// Shaped like a stored session document, which is what the digest builder expects.
const doc = {
  ...fixture.session,
  submission: fixture.submission,
  fields: fixture.fields,
  pages: fixture.pages,
  fill_order: fixture.fill_order ?? [],
  verification: {
    recomputed_score: 0,
    reported_score: 0,
    score_matches: true,
    recomputed_state: 'click_without_submission',
    state_matches: true,
    derived_outcome: 'flagged',
    outcome_matches: true,
    issues: [],
  },
  stats: { event_count: 42, total_keystrokes: 0, total_pastes: 0, autofilled_field_count: 3 },
};

const digest = buildSessionDigest(doc);
const result = await new GeminiClient(config).generate({
  systemInstruction: SYSTEM_INSTRUCTION,
  prompt: buildPrompt(digest),
  responseSchema: RESPONSE_SCHEMA,
});

console.log(`latency: ${result.latency_ms}ms  tokens: ${result.usage.total_tokens ?? '?'}`);
console.log(JSON.stringify(JSON.parse(result.text), null, 2));
