/**
 * One-off backfill: creates a `Candidate` record for every existing `Client` whose email
 * predates the automatic client->candidate sync added to `client.service.ts`. Safe to
 * re-run — `upsertCandidate` is idempotent per email.
 */
import { loadConfig } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { ClientModel } from '../src/db/models/client.model.js';
import { upsertCandidate } from '../src/services/candidate.service.js';
import { configureLogger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  configureLogger('info', false);
  const config = loadConfig();
  await connectDatabase(config);

  try {
    const clients = await ClientModel.find().lean();
    let synced = 0;
    let skipped = 0;
    for (const client of clients) {
      if (!client.contact_email) {
        skipped++;
        continue;
      }
      try {
        await upsertCandidate({ email: client.contact_email, fields: {}, hashed_fields: {} });
        synced++;
        console.log(`synced: ${client.name} <${client.contact_email}>`);
      } catch (err) {
        skipped++;
        console.warn(`skipped ${client.name} <${client.contact_email}>: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`done: ${synced} synced, ${skipped} skipped, ${clients.length} total clients`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
