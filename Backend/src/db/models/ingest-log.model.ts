import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const Mixed = Schema.Types.Mixed;

/**
 * Durable record of every `/v1/activity/*` request, independent of whether it validated.
 *
 * The extension-facing routes are the only place evidence enters the system, so a
 * payload that fails `EventBatchSchema`/`SessionPayloadSchema` parsing (a 400) would
 * otherwise leave no trace at all — the request is rejected and nothing is stored. This
 * collection is written first, before validation, so a rejected payload can still be
 * inspected or replayed once the underlying cause (extension bug, stale schema version,
 * malformed field) is fixed.
 */
const IngestLogSchema = new Schema(
  {
    log_id: { type: String, required: true, unique: true, index: true },
    route: { type: String, enum: ['events', 'finalize'], required: true, index: true },
    session_id: { type: String, default: null, index: true },
    request_id: { type: String, default: null },
    raw_body: { type: Mixed, required: true },
    status: { type: String, enum: ['accepted', 'rejected'], required: true, index: true },
    error: { type: Mixed, default: null },
    received_at: { type: Date, required: true, default: () => new Date() },
    replayed_at: { type: Date, default: null },
    replay_status: { type: String, enum: ['success', 'failed'], default: null },
    replay_error: { type: Mixed, default: null },
  },
  { collection: 'ingest_log', versionKey: false },
);

IngestLogSchema.index({ status: 1, received_at: -1 });

export type IngestLogDoc = InferSchemaType<typeof IngestLogSchema>;

export const IngestLogModel: Model<IngestLogDoc> = model<IngestLogDoc>('IngestLog', IngestLogSchema);
