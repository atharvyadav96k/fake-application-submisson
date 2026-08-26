import type { ActivityEvent } from './event';
import type { FieldRecord } from './field';
import type { Session } from './session';
import type { SubmissionAssessment } from './submission';

export interface JobContext {
  title: string | null;
  company: string | null;
  location: string | null;
  employment_type: string | null;
  date_posted: string | null;
  requisition_id: string | null;
  source: 'json_ld' | 'meta';
}
export interface PageContent {
  headline: string | null;
  summary: string | null;
  site_name: string | null;
  job: JobContext | null;
  sections: string[];
  status_text: string[];
  captured_at: string;
  truncated: boolean;
}

export interface PageRecord {
  page_id: string;
  sanitized_url: string;
  domain: string;
  path: string;
  title: string;
  referrer: string | null;
  entry_point: 'initial_load' | 'spa_navigation' | 'full_navigation' | 'iframe' | 'unknown';
  frame: 'top' | 'iframe';
  page_type: string;
  first_seen_at: string;
  last_seen_at: string;
  sequence: number;
  content?: PageContent | null;
}

export interface EnvironmentInfo {
  browser: string;
  browser_version: string;
  engine: string | null;
  platform: string | null;
  extension_version: string;
  timestamp: string;
  timezone: string;
  timezone_offset_minutes: number;
  language: string | null;
  viewport: { width: number; height: number } | null;
}

export interface FillOrderEntry {
  canonical_field: string;
  instance_index: number;
  field_id: string;
  fill_sequence_number: number;
  timestamp: string;
}

export interface SessionPayload {
  schema_version: string;
  session: Session;
  pages: PageRecord[];
  fields: FieldRecord[];
  events: ActivityEvent[];
  submission: SubmissionAssessment;
  fill_order: FillOrderEntry[];
  environment: EnvironmentInfo;
  partial: boolean;
  generated_at: string;
}

export interface EventBatchPayload {
  schema_version: string;
  session_id: string;
  batch_id: string;
  events: ActivityEvent[];
  environment: EnvironmentInfo;
  sent_at: string;
  attempt: number;
}
