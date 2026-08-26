/** One-off diagnostic: dumps ingest-log entries for a session id, accepted or rejected. */
import { loadConfig } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { IngestLogModel } from '../src/db/models/ingest-log.model.js';
import { configureLogger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: npm run inspect-ingest-log -- <session_id>');
    process.exit(1);
  }
  configureLogger('info', false);
  await connectDatabase(loadConfig());

  try {
    const entries = await IngestLogModel.find({ session_id: sessionId }).sort({ received_at: -1 }).lean();
    console.log(`found ${entries.length} ingest-log entr${entries.length === 1 ? 'y' : 'ies'} for ${sessionId}`);
    for (const e of entries) {
      console.log(
        JSON.stringify(
          { route: e.route, status: e.status, received_at: e.received_at, error: e.error },
          null,
          2,
        ),
      );
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
