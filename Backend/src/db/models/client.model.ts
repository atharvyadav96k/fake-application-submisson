import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * A business/company an application can be submitted to.
 *
 * Readable by every authenticated role; write access is not currently role-restricted
 * (nothing in the product requirements scoped client CRUD to admin/manager).
 */
const ClientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    domain: { type: String, default: '', trim: true, lowercase: true },
    contact_email: { type: String, default: '', trim: true, lowercase: true },
    phone: { type: String, default: '', trim: true },
    notes: { type: String, default: '' },
    created_by: { type: Schema.Types.ObjectId, ref: 'UiUser', default: null },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'clients', versionKey: false },
);

ClientSchema.index({ created_at: -1 });

export type ClientDoc = InferSchemaType<typeof ClientSchema>;

export const ClientModel: Model<ClientDoc> = model<ClientDoc>('Client', ClientSchema);
