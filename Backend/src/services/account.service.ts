import { UserModel } from '../db/models/user.model.js';
import { WhitelistedEmailModel } from '../db/models/whitelisted-email.model.js';
import { conflict, forbidden, notFound, unauthorized } from '../utils/errors.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import type { UserRole } from '../utils/jwt.js';

/**
 * Accounts backing both the frontend and the extension login (`auth.routes.ts`).
 */

export interface Account {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAccount(doc: { _id: unknown; email: string; name: string; role: string; active: boolean }): Account {
  return { id: String(doc._id), email: doc.email, name: doc.name, role: doc.role as UserRole, active: doc.active };
}

/**
 * Self-service signup. Only an email an admin has whitelisted may register; the
 * whitelist entry's role becomes the new account's role, and the entry is consumed.
 */
export async function signup(email: string, password: string, name: string): Promise<Account> {
  const normalized = normalizeEmail(email);

  if (await UserModel.exists({ email: normalized })) {
    throw conflict(`An account for '${normalized}' already exists.`);
  }

  const invite = await WhitelistedEmailModel.findOne({ email: normalized }).lean();
  if (!invite) {
    throw forbidden(`'${normalized}' has not been approved for access. Ask an admin to whitelist it first.`);
  }

  const password_hash = await hashPassword(password);
  const created = await UserModel.create({
    email: normalized,
    name: name.trim() || normalized,
    password_hash,
    role: invite.role,
    active: true,
  });
  await WhitelistedEmailModel.deleteOne({ _id: invite._id });

  return toAccount(created);
}

/** Admin-created account, bypassing the whitelist requirement. */
export async function createAccountAs(email: string, password: string, name: string, role: UserRole): Promise<Account> {
  const normalized = normalizeEmail(email);
  if (await UserModel.exists({ email: normalized })) {
    throw conflict(`An account for '${normalized}' already exists.`);
  }
  const password_hash = await hashPassword(password);
  const created = await UserModel.create({ email: normalized, name: name.trim() || normalized, password_hash, role, active: true });
  return toAccount(created);
}

export async function listAccounts(): Promise<(Account & { created_at: string })[]> {
  const users = await UserModel.find().sort({ created_at: -1 }).lean();
  return users.map((u) => ({ ...toAccount(u), created_at: u.created_at.toISOString() }));
}

/** Verifies a login attempt against a registered, active account. */
export async function authenticate(email: string, password: string): Promise<Account | null> {
  const normalized = normalizeEmail(email);
  const user = await UserModel.findOne({ email: normalized }).lean();
  if (!user) return null;
  if (!user.active) return null;
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? toAccount(user) : null;
}

export async function setUserActive(userId: string, active: boolean): Promise<Account> {
  const updated = await UserModel.findByIdAndUpdate(userId, { active, updated_at: new Date() }, { new: true }).lean();
  if (!updated) throw notFound('User not found.');
  return toAccount(updated);
}

export async function changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
  const user = await UserModel.findById(userId);
  if (!user) throw notFound('User not found.');
  const ok = await verifyPassword(oldPassword, user.password_hash);
  if (!ok) throw unauthorized('Current password is incorrect.');
  user.password_hash = await hashPassword(newPassword);
  user.updated_at = new Date();
  await user.save();
}

export async function getAccountById(userId: string): Promise<Account> {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw notFound('User not found.');
  return toAccount(user);
}

/* ── Whitelist management ────────────────────────────────────────────────────── */

export async function listWhitelist(): Promise<{ email: string; role: UserRole; created_at: string }[]> {
  const entries = await WhitelistedEmailModel.find().sort({ created_at: -1 }).lean();
  return entries.map((e) => ({ email: e.email, role: e.role as UserRole, created_at: e.created_at.toISOString() }));
}

export async function addToWhitelist(email: string, role: UserRole, addedBy: string): Promise<{ email: string; role: UserRole }> {
  const normalized = normalizeEmail(email);
  if (await UserModel.exists({ email: normalized })) {
    throw conflict(`'${normalized}' already has an account.`);
  }
  await WhitelistedEmailModel.findOneAndUpdate(
    { email: normalized },
    { $set: { role, added_by: addedBy }, $setOnInsert: { created_at: new Date() } },
    { upsert: true },
  );
  return { email: normalized, role };
}

export async function removeFromWhitelist(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  const result = await WhitelistedEmailModel.deleteOne({ email: normalized });
  if (result.deletedCount === 0) throw notFound(`'${normalized}' is not on the whitelist.`);
}
