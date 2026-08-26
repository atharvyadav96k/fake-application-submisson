import type { SessionPayload } from '../contract/schemas.js';
import { durationMs } from '../utils/time.js';

/**
 * Denormalised counters stored on the session document.
 *
 * These exist so the review list and dashboards never have to scan the event collection.
 * Every number here is derivable from the stored payload — nothing is authoritative.
 */
export interface SessionStats {
  field_count: number;
  filled_field_count: number;
  page_count: number;
  duration_ms: number | null;
  time_to_first_fill_ms: number | null;
  total_keystrokes: number;
  total_pastes: number;
  autofilled_field_count: number;
}

export function computeStats(payload: SessionPayload): SessionStats {
  const t = payload.session.timestamps;
  const fields = payload.fields;

  return {
    field_count: fields.length,
    filled_field_count: fields.filter((f) => f.state === 'filled').length,
    page_count: payload.pages.length,
    duration_ms: durationMs(payload.session.created_at, t.ended ?? payload.session.updated_at),
    time_to_first_fill_ms: durationMs(t.selected ?? payload.session.created_at, t.first_fill ?? t.first_field_fill_at),
    total_keystrokes: fields.reduce((sum, f) => sum + f.interaction.keystroke_count, 0),
    total_pastes: fields.reduce((sum, f) => sum + f.interaction.paste_count, 0),
    autofilled_field_count: fields.filter((f) => f.input_method === 'autofilled' || f.input_method === 'programmatic')
      .length,
  };
}
