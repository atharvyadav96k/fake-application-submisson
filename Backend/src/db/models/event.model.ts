import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { EVENT_TYPES } from '../../contract/vocabulary.js';

/**
 * Append-only activity event.
 *
 * `event_id` carries a unique index: the store is idempotent on it, which is what lets
 * the extension retry a batch indefinitely without creating duplicates. Nothing in this
 * collection is ever updated after insert.
 */
const EventSchema = new Schema(
  {
    event_id: { type: String, required: true, unique: true, index: true },
    session_id: { type: String, required: true, index: true },
    schema_version: { type: String, required: true },
    timestamp: { type: Date, required: true },
    monotonic_ms: { type: Number, required: true },
    event_type: { type: String, required: true, enum: EVENT_TYPES },

    page: {
      domain: { type: String, default: '' },
      path: { type: String, default: '' },
      sanitized_url: { type: String, default: '' },
      title: { type: String, default: '' },
      frame: { type: String, enum: ['top', 'iframe'], default: 'top' },
      frame_url: { type: String, default: null },
    },

    field: {
      type: new Schema(
        {
          field_id: String,
          canonical_name: String,
          instance_index: Number,
          group_key: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    metadata: { type: Schema.Types.Mixed, default: {} },
    dedupe_key: { type: String, default: null },

    /** Batch the event arrived in, for ingest forensics. */
    batch_id: { type: String, required: true },
    /** Retry attempt of that batch, so duplicate deliveries are visible in the record. */
    attempt: { type: Number, default: 1 },
    received_at: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'activity_events', versionKey: false, minimize: false },
);

// Timeline reads (the dominant query) and per-type filtering.
EventSchema.index({ session_id: 1, timestamp: 1 });
EventSchema.index({ session_id: 1, event_type: 1 });
EventSchema.index({ received_at: -1 });

export type EventDoc = InferSchemaType<typeof EventSchema>;

export const EventModel: Model<EventDoc> = model<EventDoc>('ActivityEvent', EventSchema);
