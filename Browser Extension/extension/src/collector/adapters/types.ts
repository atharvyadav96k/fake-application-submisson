import type { CanonicalField, IdentificationSignal } from '@/models/field';
import type { SubmissionSignal } from '@/models/submission';

export type PageType =
  | 'application_form'
  | 'application_step'
  | 'job_listing'
  | 'confirmation'
  | 'candidate_record'
  | 'dashboard'
  | 'login'
  | 'unknown';

export interface CanonicalMapping {
  canonical_field: CanonicalField;
  confidence: number;
  signals: IdentificationSignal[];
  group_key?: string | null;
  instance_index?: number;
}

export interface FieldDefinition {
  canonical_field: CanonicalField;
  selector: string;
  required?: boolean;
  group_key?: string | null;
}

export interface ConfirmationSignal {
  kind: 'confirmation_text' | 'success_toast' | 'confirmation_modal' | 'adapter_confirmation' | 'application_status_changed';
  detail: string;
  excerpt?: string;
  selector?: string | null;
}

export interface NetworkMetaForAdapter {
  method: string;
  url: string;
  status: number | null;
  transport: 'fetch' | 'xhr' | 'beacon' | 'navigation';
}

export interface AdapterContext {
  url: URL;
  document: Document;
  isFrame: boolean;
}

export interface PortalAdapter {
  readonly name: string;
  readonly kind: 'known' | 'generic';
  readonly priority: number;

  matches(url: URL): boolean;

  identifyPage(ctx: AdapterContext): PageType;
  getCandidateFields(ctx: AdapterContext): FieldDefinition[];

  mapField(element: HTMLElement, ctx: AdapterContext): CanonicalMapping | null;

  detectSubmission(event: Event, ctx: AdapterContext): SubmissionSignal | null;
  detectConfirmation(ctx: AdapterContext): ConfirmationSignal | null;

  classifyNetwork?(meta: NetworkMetaForAdapter, ctx: AdapterContext): boolean | null;
  isSubmitControl?(element: HTMLElement, ctx: AdapterContext): boolean;

  resolveGroup?(element: HTMLElement, ctx: AdapterContext): { group_key: string; instance_index: number } | null;
  onNavigate?(ctx: AdapterContext): void;
}
