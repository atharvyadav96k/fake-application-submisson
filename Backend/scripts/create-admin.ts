/**
 * One-off bootstrap: creates the first admin account directly, bypassing the email
 * whitelist (there's no admin yet to whitelist anyone). Run once, then manage every
 * other account through the whitelist + signup flow.
 *
 * Usage: npm run create-admin -- <email> <password> [name]
 */
import { loadConfig } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { createAccountAs } from '../src/services/account.service.js';
import { configureLogger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password> [name]');
    process.exit(1);
  }

  configureLogger('info', false);
  const config = loadConfig();
  await connectDatabase(config);

  try {
    const account = await createAccountAs(email, password, name ?? email, 'admin');
    console.log(`Admin account ready: ${account.email} (role: ${account.role})`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
