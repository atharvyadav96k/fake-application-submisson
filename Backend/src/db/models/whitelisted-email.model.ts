import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * An email pre-approved by an admin to sign up.
 *
 * Signup checks this collection before creating a `User` — anyone not on it is rejected.
 * The entry is deleted once the matching account is created, so the whitelist only ever
 * lists emails that are approved but have not yet registered.
 */
const WhitelistedEmailSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    role: { type: String, enum: ['admin', 'manager', 'user'], required: true, default: 'user' },
    added_by: { type: Schema.Types.ObjectId, ref: 'UiUser', default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'whitelisted_emails', versionKey: false },
);

export type WhitelistedEmailDoc = InferSchemaType<typeof WhitelistedEmailSchema>;

export const WhitelistedEmailModel: Model<WhitelistedEmailDoc> = model<WhitelistedEmailDoc>(
  'WhitelistedEmail',
  WhitelistedEmailSchema,
);
