import type { ActivityEvent } from '@/models/event';
import type { FieldRecord } from '@/models/field';
import type { PageRecord, SessionPayload } from '@/models/payload';
import type { CandidateRecord, Session } from '@/models/session';
import type { SubmissionAssessment } from '@/models/submission';

/** Tag used for MAIN-world -> ISOLATED-world postMessage traffic. */
export const PAGE_HOOK_CHANNEL = '__aav_page_hook__';

export interface PageHookMessage {
  channel: typeof PAGE_HOOK_CHANNEL;
  kind: 'network';
  payload: {
    method: string;
    url: string;
    status: number | null;
    ok: boolean | null;
    duration_ms: number | null;
    transport: 'fetch' | 'xhr' | 'beacon';
    /** Size hint only. Bodies are never read. */
    request_body_bytes: number | null;
    started_at: number;
  };
}

export type ContentToBackground =
  | { type: 'EVENT_BATCH'; session_id: string; events: ActivityEvent[] }
  | { type: 'FIELD_SNAPSHOT'; session_id: string; fields: FieldRecord[] }
  | { type: 'PAGE_SNAPSHOT'; session_id: string; pages: PageRecord[] }
  | { type: 'SUBMISSION_UPDATE'; session_id: string; assessment: SubmissionAssessment }
  | { type: 'REQUEST_CONTEXT'; url: string }
  | { type: 'CONTENT_READY'; url: string; adapter_name: string; adapter_kind: 'known' | 'generic' };

export type BackgroundToContent =
  | {
      type: 'CONTEXT';
      session: Session | null;
      candidate: CandidateRecord | null;
      config_override: Record<string, unknown> | null;
    }
  | { type: 'SESSION_PAUSED'; session_id: string }
  | { type: 'SESSION_RESUMED'; session_id: string }
  | { type: 'FLUSH_NOW' };

export type PopupToBackground =
  | { type: 'GET_STATE' }
  // Requires an authenticated operator (see LOGIN); the candidate being tracked and the
  // client the session is attributed to are chosen in the popup, not fabricated locally.
  | { type: 'START_SESSION'; candidate_email: string; client_id?: string }
  | { type: 'MARK_CANDIDATE_RECORD_OPENED' }
  | { type: 'END_SESSION'; reason: 'operator_ended' | 'abandoned' }
  // Skipping this job for now — the session is discarded locally and never
  // finalized/uploaded, unlike END_SESSION.
  | { type: 'DISCARD_SESSION' }
  | { type: 'PAUSE_SESSION' }
  | { type: 'RESUME_SESSION' }
  | { type: 'FLUSH_QUEUE' }
  | { type: 'GET_PAYLOAD' }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'LIST_CLIENTS' };

export interface PopupAuthState {
  email: string;
  name: string;
  role: string;
}

export interface PopupState {
  session: Session | null;
  candidate: CandidateRecord | null;
  submission: SubmissionAssessment | null;
  field_count: number;
  filled_count: number;
  event_count: number;
  queued_events: number;
  last_upload_at: string | null;
  last_upload_error: string | null;
  online: boolean;
  auth: PopupAuthState | null;
}

export type BackgroundToPopup =
  | { type: 'STATE'; state: PopupState }
  | { type: 'PAYLOAD'; payload: SessionPayload }
  | { type: 'CLIENTS'; items: { id: string; name: string; email: string }[] }
  | { type: 'ERROR'; message: string };

export type AnyMessage = ContentToBackground | PopupToBackground;
