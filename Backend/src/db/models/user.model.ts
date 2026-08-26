import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * A portal account — admin, manager, or user.
 *
 * Separate from `Candidate` (who the extension observes) and from the API bearer
 * tokens in `auth.ts` (what server-to-server clients hold). This is a real account a
 * human registers (subject to `WhitelistedEmailModel`) and signs into, backing per-user
 * JWTs issued by `/v1/auth/login`.
 */
const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'manager', 'user'], required: true, default: 'user' },
    active: { type: Boolean, required: true, default: true },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'ui_users', versionKey: false },
);

export type UserDoc = InferSchemaType<typeof UserSchema>;

export const UserModel: Model<UserDoc> = model<UserDoc>('UiUser', UserSchema);
