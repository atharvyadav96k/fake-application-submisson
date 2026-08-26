import { adapterManager } from '../adapters/adapter-manager';
import type { PortalAdapter } from '../adapters/types';
import { getConfig } from '@/common/config';
import type {
  CanonicalField,
  FieldDescriptor,
  FieldRecord,
  FieldState,
  InputMethod,
} from '@/models/field';
import { emptyInteraction } from '@/models/field';
import type { CandidateRecord } from '@/models/session';
import { hashValue } from '@/utils/hashing';
import { shortId } from '@/utils/ids';
import { createLogger } from '@/utils/logger';
import { classifySensitivity, sanitizeStorableValue } from '../utils/redaction';
import { throttle } from '@/utils/text';
import { elapsedMs, monotonicMs, nowIso } from '@/utils/timestamps';
import { matchField } from './candidate-matcher';
import {
  collectHints,
  controlKind,
  domPath,
  isDisabled,
  isPasswordControl,
  isRequired,
  isVisible,
  inputType,
  readValue,
  scanControls,
} from './dom-utils';
import type { EventBuffer } from './event-buffer';

const log = createLogger('field-tracker');


const AAV_DEBUG_FIELD_VALUES = true;

function debugLogFieldValue(record: FieldRecord, value: string | null): void {
  if (!AAV_DEBUG_FIELD_VALUES) return;
  console.debug(
    '[aav:field-tracker] value',
    record.canonical_field,
    `(${record.sensitivity})`,
    record.field_id,
    value,
  );
}

interface TrackedField {
  record: FieldRecord;
  element: HTMLElement;
  lastValue: string | null;
  lastLength: number;
  keysSinceInput: number;
  lastKeyAt: number;
  sawPasteAt: number;
  methods: Set<InputMethod>;
  focusStartedAt: number | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  hasBeenFilled: boolean;
  matchPending: boolean;
}

export interface FieldTrackerDeps {
  buffer: EventBuffer;
  adapter: () => PortalAdapter;
  candidate: () => CandidateRecord | null;
  salt: () => string;
  onFirstFill: (at: string) => void;
  onSnapshot: (fields: FieldRecord[]) => void;
}

/**
 * Discovers form controls, tracks interaction, infers how each field was populated,
 * and compares values against the candidate record.
 *
 * Listeners are delegated at the document level in the capture phase — one set of
 * handlers regardless of how many controls the page renders, which keeps the cost
 * flat on large React/Angular forms.
 */
export class FieldTracker {
  private readonly fields = new Map<string, TrackedField>();
  private readonly byElement = new WeakMap<HTMLElement, string>();
  private readonly instanceCounters = new Map<string, number>();
  private fillSequence = 0;
  private started = false;
  private readonly detachers: (() => void)[] = [];
  private readonly pushSnapshot: () => void;

  constructor(
    private readonly deps: FieldTrackerDeps,
    private readonly doc: Document = document,
  ) {
    this.pushSnapshot = throttle(() => this.deps.onSnapshot(this.snapshot()), 2000);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const on = <K extends keyof DocumentEventMap>(
      type: K,
      handler: (e: DocumentEventMap[K]) => void,
    ) => {
      const wrapped = (e: Event) => {
        try {
          handler(e as DocumentEventMap[K]);
        } catch (err) {
          log.warn(`handler ${type} failed`, err);
        }
      };
      this.doc.addEventListener(type, wrapped, { capture: true, passive: true });
      this.detachers.push(() => this.doc.removeEventListener(type, wrapped, { capture: true }));
    };

    on('focusin', (e) => this.onFocus(e));
    on('focusout', (e) => this.onBlur(e));
    on('input', (e) => this.onInput(e as InputEvent));
    on('change', (e) => this.onChange(e));
    on('paste', (e) => this.onPaste(e));
    on('keydown', (e) => this.onKeyDown(e));

    this.scan(this.doc);
  }

  stop(): void {
    for (const off of this.detachers) off();
    this.detachers.length = 0;
    for (const field of this.fields.values()) {
      if (field.settleTimer !== null) clearTimeout(field.settleTimer);
    }
    this.started = false;
  }

  scan(root: ParentNode): FieldRecord[] {
    const discovered: FieldRecord[] = [];
    for (const el of scanControls(root)) {
      const record = this.register(el);
      if (record) discovered.push(record);
    }
    if (discovered.length > 0) this.pushSnapshot();
    return discovered;
  }

  reconcileDetached(): void {
    for (const field of this.fields.values()) {
      if (field.record.detached_at !== null) continue;
      if (field.element.isConnected) continue;
      field.record.detached_at = nowIso();
      field.record.visible = false;
      this.deps.buffer.emit('field_detached', {
        field: this.fieldContext(field),
        metadata: { state: field.record.state },
      });
    }
    this.pushSnapshot();
  }

  reconcileValues(): void {
    for (const field of this.fields.values()) {
      if (!field.element.isConnected) continue;
      if (field.record.sensitivity === 'never_store') continue;
      const value = readValue(field.element);
      if (value === null) continue;
      if (value === field.lastValue) continue;
      log.debug('value changed without events', field.record.canonical_field);
      field.methods.add('programmatic');
      this.applyValueChange(field, value, 'programmatic', { source: 'reconcile' });
    }
  }

  private register(el: HTMLElement): FieldRecord | null {
    if (this.byElement.has(el)) return null;
    if (this.fields.size >= getConfig().dom.max_scan_nodes) return null;

    const adapter = this.deps.adapter();
    const ctx = adapterManager.contextFor(this.doc);
    const mapping = adapterManager.safeCall(adapter, 'mapField', (a) => a.mapField(el, ctx), null);

    const hints = collectHints(el);
    const canonical: CanonicalField = mapping?.canonical_field ?? 'unknown';
    const kind = controlKind(el);
    const type = inputType(el);

    const sensitivity = classifySensitivity(canonical, {
      inputType: type,
      nameHints: [hints.name, hints.id, hints.label, hints.placeholder, hints.ariaLabel, hints.autocomplete],
    });

    const group = mapping?.group_key ?? null;
    const instanceIndex =
      mapping?.instance_index ?? this.nextInstanceIndex(canonical, group);

    const descriptor: FieldDescriptor = {
      kind,
      tag: el.tagName.toLowerCase(),
      input_type: type,
      name_hint: hints.name,
      id_hint: hints.id,
      label_hint: hints.label,
      placeholder_hint: hints.placeholder,
      aria_label_hint: hints.ariaLabel,
      autocomplete: hints.autocomplete,
      dom_path: domPath(el),
      signals: mapping?.signals ?? [],
      confidence: mapping?.confidence ?? 0,
    };

    const fieldId = shortId('f');
    const initialValue = sensitivity === 'never_store' ? null : readValue(el);

    const record: FieldRecord = {
      field_id: fieldId,
      canonical_field: canonical,
      instance_index: instanceIndex,
      group_key: group,
      descriptor,
      sensitivity,
      required: isRequired(el),
      state: deriveState(initialValue, kind),
      input_method: 'unknown',
      interaction: emptyInteraction(),
      value: null,
      value_hash: null,
      value_redacted: sensitivity !== 'storable',
      value_length: valueLength(el),
      match_result: 'unverifiable',
      match_note: null,
      first_seen_at: nowIso(),
      last_seen_at: nowIso(),
      visible: isVisible(el),
      detached_at: null,
    };

    debugLogFieldValue(record, initialValue);

    const tracked: TrackedField = {
      record,
      element: el,
      lastValue: initialValue,
      lastLength: record.value_length,
      keysSinceInput: 0,
      lastKeyAt: Number.NEGATIVE_INFINITY,
      sawPasteAt: Number.NEGATIVE_INFINITY,
      methods: new Set(),
      focusStartedAt: null,
      settleTimer: null,
      hasBeenFilled: record.state === 'filled',
      matchPending: false,
    };

    this.fields.set(fieldId, tracked);
    this.byElement.set(el, fieldId);

    this.deps.buffer.emit('field_discovered', {
      field: this.fieldContext(tracked),
      metadata: {
        kind,
        input_type: type,
        required: record.required,
        visible: record.visible,
        disabled: isDisabled(el),
        sensitivity,
        mapping_confidence: descriptor.confidence,
        mapping_signals: descriptor.signals,
        is_password_control: isPasswordControl(el),
      },
    });

    // A pre-populated field (server-rendered value) is evidence too.
    if (record.state !== 'empty' && initialValue) {
      tracked.methods.add('programmatic');
      void this.finalizeValue(tracked, initialValue, 'programmatic', { prefilled: true });
    }

    return record;
  }

  private nextInstanceIndex(canonical: CanonicalField, group: string | null): number {
    const key = `${group ?? ''}:${canonical}`;
    const next = this.instanceCounters.get(key) ?? 0;
    this.instanceCounters.set(key, next + 1);
    return next;
  }

  private lookup(target: EventTarget | null): TrackedField | null {
    if (!(target instanceof HTMLElement)) return null;
    let id = this.byElement.get(target);
    if (!id) {
      // The event may originate from a child of a contenteditable/custom control.
      const host = target.closest<HTMLElement>('[contenteditable],[role="textbox"],[role="combobox"]');
      if (host) id = this.byElement.get(host);
    }
    if (!id) {
      // Newly rendered control we have not registered yet.
      const el = target.closest<HTMLElement>('input,textarea,select,[contenteditable],[role="textbox"]');
      if (el && !this.byElement.has(el)) {
        this.register(el);
        id = this.byElement.get(el);
      }
    }
    return id ? (this.fields.get(id) ?? null) : null;
  }

  private fieldContext(field: TrackedField) {
    return {
      field_id: field.record.field_id,
      canonical_name: field.record.canonical_field,
      instance_index: field.record.instance_index,
      group_key: field.record.group_key,
    };
  }

  // ---- event handlers -----------------------------------------------------

  private onFocus(e: Event): void {
    const field = this.lookup(e.target);
    if (!field) return;
    const at = nowIso();
    field.focusStartedAt = monotonicMs();
    field.record.interaction.focus_count++;
    field.record.interaction.last_focus_at = at;
    if (!field.record.interaction.first_focus_at) field.record.interaction.first_focus_at = at;
    field.record.last_seen_at = at;
    this.deps.buffer.emit('field_focus', {
      field: this.fieldContext(field),
      metadata: { focus_count: field.record.interaction.focus_count },
    });
  }

  private onBlur(e: Event): void {
    const field = this.lookup(e.target);
    if (!field) return;
    const at = nowIso();
    if (field.focusStartedAt !== null) {
      field.record.interaction.time_in_field_ms += Math.max(0, monotonicMs() - field.focusStartedAt);
      field.focusStartedAt = null;
    }
    field.record.interaction.last_blur_at = at;
    field.record.last_seen_at = at;

    // Blur is the natural settle point; force the pending evaluation now.
    if (field.settleTimer !== null) {
      clearTimeout(field.settleTimer);
      field.settleTimer = null;
      void this.settle(field);
    }

    this.deps.buffer.emit('field_blur', {
      field: this.fieldContext(field),
      metadata: {
        time_in_field_ms: field.record.interaction.time_in_field_ms,
        state: field.record.state,
        keystroke_count: field.record.interaction.keystroke_count,
      },
    });
    this.pushSnapshot();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const field = this.lookup(e.target);
    if (!field) return;
    field.record.interaction.keystroke_count++;
    field.keysSinceInput++;
    field.lastKeyAt = monotonicMs();
  }

  private onPaste(e: Event): void {
    const field = this.lookup(e.target);
    if (!field) return;
    field.record.interaction.paste_count++;
    field.sawPasteAt = monotonicMs();
    field.methods.add('pasted');
    this.deps.buffer.emit('field_paste', {
      field: this.fieldContext(field),
      metadata: { paste_count: field.record.interaction.paste_count },
    });
  }

  private onInput(e: InputEvent | Event): void {
    const field = this.lookup(e.target);
    if (!field) return;
    const method = this.inferInputMethod(field, e);
    field.methods.add(method);
    field.keysSinceInput = 0;

    const value = field.record.sensitivity === 'never_store' ? null : readValue(field.element);
    debugLogFieldValue(field.record, value);
    this.applyValueChange(field, value, method, {
      input_type: 'inputType' in e ? ((e as InputEvent).inputType ?? null) : null,
      trusted: e.isTrusted,
    });

    this.deps.buffer.emit('field_input', {
      field: this.fieldContext(field),
      metadata: {
        input_method: method,
        keystroke_count: field.record.interaction.keystroke_count,
        value_length: field.record.value_length,
      },
      dedupe_key: `input:${field.record.field_id}`,
    });

    if (method === 'autofilled') {
      this.deps.buffer.emit('field_autofill', {
        field: this.fieldContext(field),
        metadata: {
          note: 'value appeared without corresponding keystrokes; autofill, password manager, or assistive input are all plausible causes',
        },
      });
    }
  }

  private onChange(e: Event): void {
    const field = this.lookup(e.target);
    if (!field) return;
    const value = field.record.sensitivity === 'never_store' ? null : readValue(field.element);
    debugLogFieldValue(field.record, value);
    const changed = value !== field.lastValue;
    if (changed) {
      const method: InputMethod =
        field.methods.size === 0 ? (e.isTrusted ? 'autofilled' : 'programmatic') : this.dominantMethod(field);
      field.methods.add(method);
      this.applyValueChange(field, value, method, { via: 'change' });
    }
    this.deps.buffer.emit('field_change', {
      field: this.fieldContext(field),
      metadata: { state: field.record.state, value_length: field.record.value_length },
      dedupe_key: `change:${field.record.field_id}`,
    });
  }

  private inferInputMethod(field: TrackedField, e: InputEvent | Event): InputMethod {
    const inputTypeAttr = 'inputType' in e ? (e as InputEvent).inputType : undefined;
    const now = monotonicMs();

    if (inputTypeAttr === 'insertFromPaste' || now - field.sawPasteAt < 300) return 'pasted';
    if (field.keysSinceInput > 0 && now - field.lastKeyAt < 1500) return 'typed';

    // No keystrokes preceded this value.
    // `insertReplacementText` is what Chromium emits for its own autofill; a script
    // assigning `.value` produces `insertText` or no event at all.
    if (inputTypeAttr === 'insertReplacementText') return 'autofilled';
    // An untrusted event is definitive evidence of script origin.
    if (!e.isTrusted) return 'programmatic';
    if (this.looksAutofilled(field.element)) return 'autofilled';

    const jumped = valueLength(field.element) - field.lastLength >= 4;
    if (jumped) return 'autofilled';

    if (inputTypeAttr === 'insertCompositionText') return 'typed';
    return 'unknown';
  }

  /** Chromium marks browser-autofilled inputs with a vendor pseudo-class. */
  private looksAutofilled(el: HTMLElement): boolean {
    try {
      return el.matches(':-webkit-autofill');
    } catch {
      return false;
    }
  }

  private dominantMethod(field: TrackedField): InputMethod {
    if (field.methods.size === 0) return 'unknown';
    if (field.methods.size === 1) return [...field.methods][0]!;
    const meaningful = [...field.methods].filter((m) => m !== 'unknown');
    if (meaningful.length === 1) return meaningful[0]!;
    return 'mixed';
  }

  private applyValueChange(
    field: TrackedField,
    value: string | null,
    method: InputMethod,
    metadata: Record<string, unknown>,
  ): void {
    const at = nowIso();
    const previousState = field.record.state;
    field.lastValue = value;
    field.lastLength = valueLength(field.element);
    field.record.value_length = field.lastLength;
    field.record.state = deriveState(value, field.record.descriptor.kind, field.lastLength);
    field.record.input_method = this.dominantMethod(field);
    field.record.interaction.last_change_at = at;
    field.record.last_seen_at = at;
    field.record.visible = isVisible(field.element);

    if (previousState === 'filled' && field.record.state === 'empty') {
      field.record.interaction.clear_count++;
      this.deps.buffer.emit('field_cleared', {
        field: this.fieldContext(field),
        metadata: { previous_state: previousState },
      });
    } else if (field.hasBeenFilled && field.record.state !== 'empty' && previousState !== 'empty') {
      field.record.interaction.edit_count++;
      this.deps.buffer.emit('field_edit', {
        field: this.fieldContext(field),
        metadata: { edit_count: field.record.interaction.edit_count, input_method: method },
        dedupe_key: `edit:${field.record.field_id}`,
      });
    }

    void metadata;

    // Debounce the expensive part (hashing + matching) until input settles.
    if (field.settleTimer !== null) clearTimeout(field.settleTimer);
    field.settleTimer = setTimeout(() => {
      field.settleTimer = null;
      void this.settle(field);
    }, getConfig().dom.fill_settle_ms);
  }

  private async settle(field: TrackedField): Promise<void> {
    const value = field.record.sensitivity === 'never_store' ? null : field.lastValue;
    await this.finalizeValue(field, value, field.record.input_method, {});
  }

  private async finalizeValue(
    field: TrackedField,
    value: string | null,
    method: InputMethod,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (field.matchPending) return;
    field.matchPending = true;
    try {
      const record = field.record;
      const hasValue = record.state !== 'empty';

      // Privacy policy applied here — this is the only place a value is written down.
      if (hasValue && value !== null) {
        if (record.sensitivity === 'storable') {
          record.value = sanitizeStorableValue(value);
          record.value_hash = null;
          record.value_redacted = false;
        } else if (record.sensitivity === 'hashed_only') {
          record.value = null;
          record.value_hash = await hashValue(value, this.deps.salt());
          record.value_redacted = true;
        }
      } else if (!hasValue) {
        record.value = null;
        record.value_hash = null;
      }

      const outcome = await matchField({
        canonical: record.canonical_field,
        sensitivity: record.sensitivity,
        observedValue: value,
        candidate: this.deps.candidate(),
        salt: this.deps.salt(),
      });
      record.match_result = outcome.match_result;
      record.match_note = outcome.note;

      if (hasValue && !field.hasBeenFilled) {
        field.hasBeenFilled = true;
        const at = nowIso();
        record.interaction.first_fill_at = at;
        record.interaction.fill_sequence_number = ++this.fillSequence;
        record.interaction.skipped = false;
        this.deps.onFirstFill(at);
        this.deps.buffer.emit('field_fill', {
          field: this.fieldContext(field),
          metadata: {
            input_method: method,
            fill_sequence_number: record.interaction.fill_sequence_number,
            state: record.state,
            match_result: record.match_result,
            match_note: record.match_note,
            keystroke_count: record.interaction.keystroke_count,
            paste_count: record.interaction.paste_count,
            value_length: record.value_length,
            ...extra,
          },
        });
      }
      this.pushSnapshot();
    } catch (err) {
      log.warn('finalizeValue failed', err);
    } finally {
      field.matchPending = false;
    }
  }

  // ---- skipped fields -----------------------------------------------------

  /**
   * Flags fields that were never populated. Called when a submission is attempted and
   * again at session end — "skipped" is only meaningful relative to a moment in time.
   */
  markSkipped(reason: 'submit_attempt' | 'session_end'): FieldRecord[] {
    const skipped: FieldRecord[] = [];
    for (const field of this.fields.values()) {
      const record = field.record;
      if (record.state !== 'empty') continue;
      if (record.detached_at !== null && reason === 'session_end') continue;
      if (record.interaction.skipped) continue;
      record.interaction.skipped = true;
      skipped.push(record);
      this.deps.buffer.emit('field_skip', {
        field: this.fieldContext(field),
        metadata: {
          reason,
          required: record.required,
          focus_count: record.interaction.focus_count,
          visible: record.visible,
        },
      });
    }
    if (skipped.length > 0) this.pushSnapshot();
    return skipped;
  }

  /** Canonical fields the adapter expected but which never appeared in the DOM. */
  missingExpectedFields(): CanonicalField[] {
    const adapter = this.deps.adapter();
    const ctx = adapterManager.contextFor(this.doc);
    const expected = adapterManager.safeCall(adapter, 'getCandidateFields', (a) => a.getCandidateFields(ctx), []);
    const present = new Set([...this.fields.values()].map((f) => f.record.canonical_field));
    return expected.map((d) => d.canonical_field).filter((c) => !present.has(c));
  }

  fillOrder(): FieldRecord[] {
    return this.snapshot()
      .filter((f) => f.interaction.fill_sequence_number !== null)
      .sort((a, b) => (a.interaction.fill_sequence_number ?? 0) - (b.interaction.fill_sequence_number ?? 0));
  }

  /**
   * Pushes a snapshot immediately, bypassing the throttle.
   *
   * The throttled path is right for steady-state churn, but at moments that matter —
   * a submit attempt, session end — the stored records must be current, or the final
   * payload silently reflects an older state of the form.
   */
  forceSnapshot(): void {
    this.deps.onSnapshot(this.snapshot());
  }

  snapshot(): FieldRecord[] {
    const out: FieldRecord[] = [];
    for (const field of this.fields.values()) {
      // Fold in any in-progress focus time so a snapshot taken mid-focus is accurate.
      const record: FieldRecord = { ...field.record, interaction: { ...field.record.interaction } };
      if (field.focusStartedAt !== null) {
        record.interaction.time_in_field_ms += Math.max(0, monotonicMs() - field.focusStartedAt);
      }
      out.push(record);
    }
    return out;
  }

  stats(): { total: number; filled: number; skipped: number } {
    let filled = 0;
    let skipped = 0;
    for (const f of this.fields.values()) {
      if (f.record.state !== 'empty') filled++;
      if (f.record.interaction.skipped) skipped++;
    }
    return { total: this.fields.size, filled, skipped };
  }

  /** Total time between the first and last fill; `null` when fewer than two fills. */
  fillSpanMs(): number | null {
    const order = this.fillOrder();
    const first = order[0]?.interaction.first_fill_at ?? null;
    const last = order[order.length - 1]?.interaction.first_fill_at ?? null;
    if (order.length < 2) return null;
    return elapsedMs(first, last);
  }
}

/**
 * Length of a control's value.
 *
 * For password controls this reads `.length` and nothing else — the string itself is
 * never assigned to a variable, returned, or logged.
 */
function valueLength(el: HTMLElement): number {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'file') return el.files?.length ?? 0;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 1 : 0;
    return el.value.length;
  }
  if (el instanceof HTMLTextAreaElement) return el.value.length;
  if (el instanceof HTMLSelectElement) return el.value.length;
  if (el.isContentEditable) return (el.textContent ?? '').length;
  return 0;
}

/**
 * `partial` is reserved for controls that have content but plainly are not finished —
 * a couple of characters in a free-text field. Choice controls are binary.
 */
export function deriveState(value: string | null, kind: string, length?: number): FieldState {
  const len = length ?? (value?.length ?? 0);
  if (kind === 'checkbox' || kind === 'radio' || kind === 'select' || kind === 'file') {
    return len > 0 || (value !== null && value !== '') ? 'filled' : 'empty';
  }
  if (value === null) return len > 0 ? 'filled' : 'empty';
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length < 2) return 'partial';
  return 'filled';
}
