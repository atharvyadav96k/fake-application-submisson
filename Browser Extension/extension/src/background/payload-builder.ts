import { SCHEMA_VERSION } from '@/models/event';
import type { FillOrderEntry, SessionPayload } from '@/models/payload';
import type { EventStore } from '@/storage/event-store';
import type { SessionStore } from '@/storage/session-store';
import { scrubObject } from '@/collector/utils/redaction';
import { nowIso } from '@/utils/timestamps';
import { collectEnvironment } from './environment';

/**
 * Assembles the versioned session payload.
 *
 * `hash_salt` is stripped here: it stays in the browser so the backend cannot brute-force
 * the hashed values it receives.
 */
export async function buildSessionPayload(
  sessions: SessionStore,
  events: EventStore,
  options: { partial?: boolean } = {},
): Promise<SessionPayload | null> {
  const session = await sessions.get();
  if (!session) return null;

  const [fields, pages, submission, eventList] = await Promise.all([
    sessions.getFields(),
    sessions.getPages(),
    sessions.getSubmission(),
    events.allForSession(session.session_id),
  ]);

  const fillOrder: FillOrderEntry[] = fields
    .filter((f) => f.interaction.fill_sequence_number !== null && f.interaction.first_fill_at !== null)
    .sort((a, b) => (a.interaction.fill_sequence_number ?? 0) - (b.interaction.fill_sequence_number ?? 0))
    .map((f) => ({
      canonical_field: f.canonical_field,
      instance_index: f.instance_index,
      field_id: f.field_id,
      fill_sequence_number: f.interaction.fill_sequence_number as number,
      timestamp: f.interaction.first_fill_at as string,
    }));

  const { hash_salt: _salt, ...sessionForUpload } = session;

  const payload: SessionPayload = {
    schema_version: SCHEMA_VERSION,
    session: { ...sessionForUpload, hash_salt: '' },
    pages,
    fields,
    events: eventList,
    submission,
    fill_order: fillOrder,
    environment: collectEnvironment(),
    partial: options.partial ?? false,
    generated_at: nowIso(),
  };

  return scrubObject(payload);
}
