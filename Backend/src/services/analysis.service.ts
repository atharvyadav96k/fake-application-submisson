import { z } from 'zod';
import { buildSessionDigest } from '../ai/digest.js';
import type { GeminiClient } from '../ai/gemini.client.js';
import { PROMPT_VERSION, RESPONSE_SCHEMA, SYSTEM_INSTRUCTION, buildPrompt } from '../ai/prompt.js';
import { AnalysisModel } from '../db/models/analysis.model.js';
import { SessionModel } from '../db/models/session.model.js';
import { HttpError, badRequest, notFound } from '../utils/errors.js';
import { fingerprint, uuid } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('analysis');

/**
 * AI analysis of a stored session.
 *
 * The analysis is advisory and is stored beside — never merged into — the deterministic
 * record. Runs are append-only and tagged with model and prompt version, so a reviewer
 * can always see what produced a given conclusion.
 */

const AnalysisResponseSchema = z.object({
  summary: z.string().max(4_000),
  risk_level: z.enum(['low', 'medium', 'high', 'indeterminate']),
  confidence: z.number().min(0).max(1),
  recommended_action: z.enum(['accept', 'review', 'investigate', 'insufficient_evidence']),
  findings: z
    .array(
      z.object({
        code: z.string().max(128),
        severity: z.enum(['info', 'warning', 'critical']),
        detail: z.string().max(2_000),
        evidence_refs: z.array(z.string().max(128)).max(50).default([]),
      }),
    )
    .max(50)
    .default([]),
  unanswered_questions: z.array(z.string().max(500)).max(20).default([]),
  submission_assessment: z.object({
    verdict: z.enum(['likely_submitted', 'likely_not_submitted', 'indeterminate']),
    reasoning: z.string().max(2_000),
    evidence_refs: z.array(z.string().max(128)).max(50).default([]),
  }),
  portal_legitimacy: z.object({
    verdict: z.enum(['consistent', 'suspicious', 'indeterminate']),
    reasoning: z.string().max(2_000),
    evidence_refs: z.array(z.string().max(128)).max(50).default([]),
  }),
});

export type AnalysisResult = Omit<z.infer<typeof AnalysisResponseSchema>, 'submission_assessment' | 'portal_legitimacy'> & {
  // Nullable rather than the Zod-inferred required object: records produced under an
  // earlier prompt_version (before these verdicts existed) are read back through this
  // same type and genuinely lack them.
  submission_assessment: z.infer<typeof AnalysisResponseSchema>['submission_assessment'] | null;
  portal_legitimacy: z.infer<typeof AnalysisResponseSchema>['portal_legitimacy'] | null;
  analysis_id: string;
  session_id: string;
  model: string;
  prompt_version: string;
  latency_ms: number;
  created_at: string;
  cached: boolean;
};

export interface AnalyseOptions {
  /** Re-run even when an analysis of this exact input already exists. */
  force?: boolean;
}

export async function analyseSession(
  sessionId: string,
  client: GeminiClient,
  options: AnalyseOptions = {},
): Promise<AnalysisResult> {
  const doc = await SessionModel.findOne({ session_id: sessionId }).lean();
  if (!doc) throw notFound(`No session '${sessionId}'`);
  if (!doc.finalized) {
    // Analysing a live session would produce a conclusion about a half-written record
    // that is then cached as if it were about the whole thing.
    throw badRequest(`Session '${sessionId}' has not been finalized yet.`);
  }

  const digest = buildSessionDigest(doc as Record<string, any>);
  const inputDigest = fingerprint({ digest, prompt_version: PROMPT_VERSION, model: client.model });

  if (!options.force) {
    const cached = await AnalysisModel.findOne({
      session_id: sessionId,
      input_digest: inputDigest,
      status: 'ok',
    })
      .sort({ created_at: -1 })
      .lean();

    if (cached) {
      log.debug('serving cached analysis', { session_id: sessionId });
      return toResult(cached as Record<string, any>, true);
    }
  }

  const started = Date.now();
  try {
    const generated = await client.generate({
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(digest),
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    });

    const parsed = AnalysisResponseSchema.safeParse(JSON.parse(generated.text));
    if (!parsed.success) {
      throw new HttpError(
        502,
        'ai_invalid_response',
        'The AI response did not match the expected schema.',
        parsed.error.issues.slice(0, 5),
        true,
      );
    }

    const analysisId = uuid();
    const createdAt = new Date();
    const record = {
      analysis_id: analysisId,
      session_id: sessionId,
      model: generated.model,
      prompt_version: PROMPT_VERSION,
      confidence: parsed.data.confidence,
      risk_level: parsed.data.risk_level,
      summary: parsed.data.summary,
      findings: parsed.data.findings,
      recommended_action: parsed.data.recommended_action,
      unanswered_questions: parsed.data.unanswered_questions,
      submission_assessment: parsed.data.submission_assessment,
      portal_legitimacy: parsed.data.portal_legitimacy,
      input_digest: inputDigest,
      token_usage: {
        prompt_tokens: generated.usage.prompt_tokens,
        completion_tokens: generated.usage.completion_tokens,
        total_tokens: generated.usage.total_tokens,
      },
      latency_ms: generated.latency_ms,
      status: 'ok' as const,
      error: null,
      created_at: createdAt,
    };

    await AnalysisModel.create(record);
    await SessionModel.updateOne(
      { session_id: sessionId },
      {
        $set: {
          latest_analysis: {
            analysis_id: analysisId,
            risk_level: record.risk_level,
            recommended_action: record.recommended_action,
            summary: record.summary,
            confidence: record.confidence,
            model: record.model,
            prompt_version: PROMPT_VERSION,
            created_at: createdAt,
            submission_assessment: record.submission_assessment,
            portal_legitimacy: record.portal_legitimacy,
          },
        },
      },
    );

    log.info('analysis complete', {
      session_id: sessionId,
      risk_level: record.risk_level,
      latency_ms: generated.latency_ms,
    });

    return toResult(record, false);
  } catch (err) {
    // Failures are recorded too: a session that could never be analysed should look
    // different from one that was never submitted for analysis.
    await AnalysisModel.create({
      analysis_id: uuid(),
      session_id: sessionId,
      model: client.model,
      prompt_version: PROMPT_VERSION,
      input_digest: inputDigest,
      latency_ms: Date.now() - started,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      created_at: new Date(),
    }).catch(() => undefined);
    throw err;
  }
}

export async function listAnalyses(sessionId: string, limit = 20): Promise<Record<string, unknown>[]> {
  const docs = await AnalysisModel.find({ session_id: sessionId }).sort({ created_at: -1 }).limit(limit).lean();
  return docs as Record<string, unknown>[];
}

function toResult(doc: Record<string, any>, cached: boolean): AnalysisResult {
  return {
    analysis_id: doc.analysis_id,
    session_id: doc.session_id,
    model: doc.model,
    prompt_version: doc.prompt_version,
    summary: doc.summary ?? '',
    risk_level: doc.risk_level,
    confidence: doc.confidence ?? 0,
    recommended_action: doc.recommended_action,
    findings: doc.findings ?? [],
    unanswered_questions: doc.unanswered_questions ?? [],
    submission_assessment: doc.submission_assessment ?? null,
    portal_legitimacy: doc.portal_legitimacy ?? null,
    latency_ms: doc.latency_ms ?? 0,
    created_at: new Date(doc.created_at).toISOString(),
    cached,
  };
}
