/** One-off: replays every rejected ingest-log entry for a session id (events, then
 *  finalize, oldest first — order matters since finalize expects the events to already
 *  exist). Use after a wire-contract fix that a previous rejection no longer hits. */
import { loadConfig } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { IngestLogModel } from '../src/db/models/ingest-log.model.js';
import { replayIngestLogEntry } from '../src/services/ingest-log.service.js';
import { configureLogger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('Usage: npm run replay-session -- <session_id>');
    process.exit(1);
  }
  configureLogger('info', false);
  await connectDatabase(loadConfig());

  try {
    const entries = await IngestLogModel.find({ session_id: sessionId, status: 'rejected' })
      .sort({ received_at: 1 })
      .lean();
    console.log(`replaying ${entries.length} rejected entr${entries.length === 1 ? 'y' : 'ies'}`);
    for (const entry of entries) {
      const result = await replayIngestLogEntry(entry.log_id);
      console.log(entry.route, entry.log_id, '->', result.status, result.error ?? '');
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
