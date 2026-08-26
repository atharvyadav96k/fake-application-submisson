/** One-off diagnostic: dumps sessions for a candidate email so we can see what actually
 *  got stored (state/outcome/verification) vs. what the Applications list derives. */
import { loadConfig } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { CandidateModel } from '../src/db/models/candidate.model.js';
import { SessionModel } from '../src/db/models/session.model.js';
import { configureLogger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run inspect-sessions -- <candidate_email>');
    process.exit(1);
  }
  configureLogger('info', false);
  await connectDatabase(loadConfig());

  try {
    const candidate = await CandidateModel.findOne({ email: email.toLowerCase() }).lean();
    console.log('candidate:', candidate ? { candidate_id: candidate.candidate_id, email: candidate.email } : null);

    const sessions = await SessionModel.find(
      candidate ? { candidate_id: candidate.candidate_id } : { candidate_email_hash: { $ne: null } },
    )
      .sort({ first_seen_at: -1 })
      .lean();

    console.log(`found ${sessions.length} session(s)`);
    for (const s of sessions) {
      console.log(
        JSON.stringify(
          {
            session_id: s.session_id,
            state: s.state,
            outcome: s.outcome,
            finalized: s.finalized,
            manual_entry: s.manual_entry,
            portal_domain: s.portal_domain,
            client_id: s.client_id,
            user_id: s.user_id,
            recomputed_score: s.verification?.recomputed_score,
            reported_score: s.verification?.reported_score,
            stats_event_count: s.stats?.event_count,
            first_seen_at: s.first_seen_at,
            last_event_at: s.last_event_at,
          },
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
