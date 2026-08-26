import { durationMs } from '../utils/time.js';

/**
 * Builds the model-facing digest of a stored session.
 *
 * This is the privacy boundary for the AI path, aligned with — not stricter than — what
 * `sanitize.ts` already allows to exist server-side. Fields whose sensitivity policy is
 * `never_store` (password, OTP, credit card, SSN, national ID) or `hashed_only` (email,
 * phone, date of birth, address, name, salary, etc.) never have a plaintext value in this
 * database in the first place — this digest cannot leak what was never stored, regardless
 * of anything below. For every other canonical field (company, job title, city, work
 * authorization, URLs, education, experience, etc.) the digest includes the actual stored
 * value, along with the real navigation domains/URLs/titles and the portal's own published
 * job-posting metadata — because the AI's job now includes judging genuine-submission and
 * portal-legitimacy questions that metadata-only signals cannot answer. Hashes, DOM paths
 * and raw candidate identifiers (candidate_id, plaintext email) remain excluded regardless.
 */
export function buildSessionDigest(doc: Record<string, any>): Record<string, unknown> {
  const t = doc.timestamps ?? {};
  const submission = doc.submission ?? {};
  const verification = doc.verification ?? {};
  const fields: Record<string, any>[] = doc.fields ?? [];
  const pages: Record<string, any>[] = doc.pages ?? [];

  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

  return {
    session: {
      portal_domain: doc.portal_domain ?? null,
      /** The full redirect chain, in visiting order — needed to judge whether the
       *  destination the session ended on plausibly continues the job posting it started from. */
      portal_domains: doc.portal_domains ?? [],
      matched_adapter: doc.matched_adapter ?? 'unknown',
      adapter_name: doc.adapter_name ?? null,
      state: doc.state ?? null,
      candidate_record_opened_before_fill: doc.candidate_record_opened_before_fill ?? null,
      // Durations rather than wall-clock times: the shape of the session is what matters,
      // and absolute timestamps are needlessly identifying.
      durations_ms: {
        total: doc.stats?.duration_ms ?? null,
        selected_to_first_fill: durationMs(iso(t.selected), iso(t.first_fill)),
        first_fill_to_click: durationMs(iso(t.first_fill), iso(t.applied_clicked)),
        click_to_submit_detected: durationMs(iso(t.applied_clicked), iso(t.submit_detected)),
        submit_to_confirmation: durationMs(iso(t.submit_detected), iso(t.confirmed)),
      },
      milestones_present: {
        selected: Boolean(t.selected),
        candidate_record_opened: Boolean(t.candidate_record_opened),
        first_fill: Boolean(t.first_fill),
        applied_clicked: Boolean(t.applied_clicked),
        submit_detected: Boolean(t.submit_detected),
        confirmed: Boolean(t.confirmed),
        ended: Boolean(t.ended),
      },
      // Confirmation-page text and the control that was clicked, if any — direct
      // evidence for judging real-vs-fake completion. `dom_path` is deliberately
      // omitted: structural DOM position, not evidence of intent.
      context_excerpt: submission.context_excerpt ?? null,
      clicked_control: submission.clicked_control
        ? { text: submission.clicked_control.text ?? null, tag: submission.clicked_control.tag ?? null }
        : null,
    },

    reported: {
      outcome: doc.outcome ?? 'unknown',
      outcome_reasons: doc.outcome_reasons ?? [],
      submission_state: submission.state ?? null,
      confidence_score: submission.confidence_score ?? null,
      applied_clicked: submission.applied_clicked ?? null,
      submit_detected: submission.submit_detected ?? null,
      confirmation_detected: submission.confirmation_detected ?? null,
      notes: submission.notes ?? [],
    },

    evidence: {
      positive: (submission.evidence ?? []).map((e: Record<string, any>) => ({
        kind: e.kind,
        signal_class: e.signal_class,
        weight: e.weight,
        counted: e.counted,
      })),
      negative: (submission.negative_evidence ?? []).map((e: Record<string, any>) => ({
        kind: e.kind,
        weight: e.weight,
        counted: e.counted,
      })),
    },

    verification: {
      recomputed_score: verification.recomputed_score ?? null,
      reported_score: verification.reported_score ?? null,
      score_matches: verification.score_matches ?? null,
      recomputed_state: verification.recomputed_state ?? null,
      state_matches: verification.state_matches ?? null,
      derived_outcome: verification.derived_outcome ?? null,
      outcome_matches: verification.outcome_matches ?? null,
      issues: (verification.issues ?? []).map((i: Record<string, any>) => ({
        code: i.code,
        severity: i.severity,
        message: i.message,
      })),
    },

    fields: {
      total: fields.length,
      by_state: countBy(fields, (f) => f.state),
      by_input_method: countBy(fields, (f) => f.input_method),
      by_match_result: countBy(fields, (f) => f.match_result),
      required_total: fields.filter((f) => f.required).length,
      required_empty: fields.filter((f) => f.required && f.state === 'empty').length,
      totals: {
        keystrokes: doc.stats?.total_keystrokes ?? 0,
        pastes: doc.stats?.total_pastes ?? 0,
        autofilled_or_programmatic: doc.stats?.autofilled_field_count ?? 0,
      },
      // Per-field metadata, restricted to fields that are actually informative:
      // something happened in them, or they were required and left empty (a real gap
      // worth a reviewer knowing *which* field it was). An untouched, non-required
      // field with zero interaction adds nothing beyond what `by_state`/`required_empty`
      // above already say — and on a large modern form (a real session had 262 detected
      // controls, 177 of them decorative MUI internals the candidate never touched)
      // sending each one individually was pure token cost with no analytical value.
      // `value` is included but is already `null` server-side (via sanitize.ts) for
      // anything `never_store`/`hashed_only` — this does not expose anything new for
      // those fields, only stops omitting it for fields that were already safe to send.
      // Descriptor hints and DOM paths remain excluded regardless.
      detail: fields
        .filter((f) => f.state !== 'empty' || f.required || hasInteraction(f))
        .slice(0, 120)
        .map((f) => ({
          canonical_field: f.canonical_field,
          instance_index: f.instance_index,
          required: f.required,
          state: f.state,
          input_method: f.input_method,
          sensitivity: f.sensitivity,
          match_result: f.match_result,
          value: f.value ?? null,
          identification_confidence: f.descriptor?.confidence ?? null,
          keystrokes: f.interaction?.keystroke_count ?? 0,
          pastes: f.interaction?.paste_count ?? 0,
          focus_count: f.interaction?.focus_count ?? 0,
          edits: f.interaction?.edit_count ?? 0,
          time_in_field_ms: f.interaction?.time_in_field_ms ?? 0,
          fill_sequence_number: f.interaction?.fill_sequence_number ?? null,
        })),
    },

    pages: {
      count: pages.length,
      // Lightweight per-page timeline (see `flow` below for domains/titles/job metadata).
      sequence: pages.slice(0, 50).map((p) => ({
        sequence: p.sequence,
        page_type: p.page_type,
        entry_point: p.entry_point,
        frame: p.frame,
        dwell_ms: durationMs(iso(p.first_seen_at), iso(p.last_seen_at)),
      })),
      // The real navigation flow — domains, URLs, titles and any job-posting metadata
      // the portal published, in visiting order. This is what lets the AI compare
      // "where the job was posted" against "where the candidate actually ended up" and
      // judge portal legitimacy. Ad/tracking iframes are excluded: they never change
      // what's in the address bar, so they aren't part of what the candidate visited.
      flow: pages
        .filter((p) => p.frame !== 'iframe')
        .slice(0, 50)
        .map((p) => ({
          sequence: p.sequence,
          domain: p.domain ?? null,
          sanitized_url: p.sanitized_url ?? null,
          title: p.title ?? null,
          page_type: p.page_type,
          entry_point: p.entry_point,
          frame: p.frame,
          dwell_ms: durationMs(iso(p.first_seen_at), iso(p.last_seen_at)),
          content: p.content
            ? {
                site_name: p.content.site_name ?? null,
                job_title: p.content.job?.title ?? null,
                job_company: p.content.job?.company ?? null,
              }
            : null,
        })),
    },

    events: {
      total: doc.stats?.event_count ?? 0,
      duplicates_received: doc.stats?.duplicate_event_count ?? 0,
      batches: doc.stats?.batch_count ?? 0,
    },

    fill_order: (doc.fill_order ?? []).slice(0, 120).map((f: Record<string, any>) => ({
      canonical_field: f.canonical_field,
      instance_index: f.instance_index,
      fill_sequence_number: f.fill_sequence_number,
    })),
  };
}

/** True when anything was ever recorded happening in this field — focus, a keystroke, a
 *  paste, or an edit — regardless of its final `state`. */
function hasInteraction(f: Record<string, any>): boolean {
  const i = f.interaction ?? {};
  return (i.focus_count ?? 0) > 0 || (i.keystroke_count ?? 0) > 0 || (i.paste_count ?? 0) > 0 || (i.edit_count ?? 0) > 0;
}

function countBy<T>(items: T[], key: (item: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item) ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
