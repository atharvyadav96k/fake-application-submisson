import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * A single AI analysis run over one session.
 *
 * Runs are append-only and versioned: re-analysing a session never overwrites the
 * previous conclusion, so a reviewer can see what the model said before and after a
 * prompt or model change. The exact model id and prompt version are stored with the
 * result for the same reason.
 */
const AnalysisSchema = new Schema(
  {
    analysis_id: { type: String, required: true, unique: true, index: true },
    session_id: { type: String, required: true, index: true },

    model: { type: String, required: true },
    prompt_version: { type: String, required: true },

    /** 0..1, model's own stated confidence in its reading of the evidence. */
    confidence: { type: Number, default: null },
    risk_level: { type: String, enum: ['low', 'medium', 'high', 'indeterminate'], default: 'indeterminate' },
    summary: { type: String, default: '' },
    findings: {
      type: [
        new Schema(
          {
            code: { type: String, required: true },
            severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
            detail: { type: String, required: true },
            evidence_refs: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** What a human should do next. Never a hiring judgement. */
    recommended_action: {
      type: String,
      enum: ['accept', 'review', 'investigate', 'insufficient_evidence'],
      default: 'insufficient_evidence',
    },
    unanswered_questions: { type: [String], default: [] },

    /** The AI's own independent read on whether the submission genuinely happened — additive to `verification`, never a replacement for it. */
    submission_assessment: {
      type: new Schema(
        {
          verdict: { type: String, enum: ['likely_submitted', 'likely_not_submitted', 'indeterminate'], required: true },
          reasoning: { type: String, required: true },
          evidence_refs: { type: [String], default: [] },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Whether the domain/page the session ended on plausibly continues the job posting it started from. */
    portal_legitimacy: {
      type: new Schema(
        {
          verdict: { type: String, enum: ['consistent', 'suspicious', 'indeterminate'], required: true },
          reasoning: { type: String, required: true },
          evidence_refs: { type: [String], default: [] },
        },
        { _id: false },
      ),
      default: null,
    },

    /** Exactly what was sent to the model, for reproducibility. */
    input_digest: { type: String, default: null },
    token_usage: {
      prompt_tokens: { type: Number, default: null },
      completion_tokens: { type: Number, default: null },
      total_tokens: { type: Number, default: null },
    },
    latency_ms: { type: Number, default: null },
    status: { type: String, enum: ['ok', 'failed'], default: 'ok', index: true },
    error: { type: String, default: null },

    created_at: { type: Date, required: true, default: () => new Date(), index: true },
  },
  { collection: 'session_analyses', versionKey: false, minimize: false },
);

AnalysisSchema.index({ session_id: 1, created_at: -1 });

export type AnalysisDoc = InferSchemaType<typeof AnalysisSchema>;

export const AnalysisModel: Model<AnalysisDoc> = model<AnalysisDoc>('SessionAnalysis', AnalysisSchema);
