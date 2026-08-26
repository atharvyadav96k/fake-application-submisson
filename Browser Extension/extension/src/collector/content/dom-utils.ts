import { getConfig } from '@/common/config';
import type { ControlKind } from '@/models/field';
import { sanitizeText } from '../utils/redaction';
import { normalizeLabel } from '@/utils/text';

/** DOM inspection helpers. Nothing here reads or returns a user-entered value. */

const FORM_CONTROL_SELECTOR = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="spinbutton"]',
].join(',');

export function formControlSelector(): string {
  return FORM_CONTROL_SELECTOR;
}

export function isFormControl(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  return el.matches(FORM_CONTROL_SELECTOR);
}

export function controlKind(el: HTMLElement): ControlKind {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'file') return 'file';
    return 'input';
  }
  if (el.isContentEditable) return 'contenteditable';
  return 'custom';
}

export function inputType(el: HTMLElement): string | null {
  if (el instanceof HTMLInputElement) return el.type.toLowerCase();
  return null;
}

/**
 * Reads the control's current value.
 *
 * Callers MUST pass the result through the sensitivity policy before storing it.
 * Password inputs return `null` so a raw password can never even enter a variable
 * that might be logged.
 */
export function readValue(el: HTMLElement): string | null {
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === 'password') return null;
    if (type === 'checkbox' || type === 'radio') return el.checked ? (el.value || 'on') : '';
    if (type === 'file') {
      const count = el.files?.length ?? 0;
      return count > 0 ? `file:${count}` : '';
    }
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLSelectElement) {
    if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value).join(', ');
    return el.value;
  }
  if (el.isContentEditable) return el.textContent ?? '';
  const ariaValue = el.getAttribute('aria-valuenow') ?? el.getAttribute('data-value');
  return ariaValue;
}

/** True for file inputs — their "value" is a count, never a path or contents. */
export function isFileControl(el: HTMLElement): boolean {
  return el instanceof HTMLInputElement && el.type.toLowerCase() === 'file';
}

export function isPasswordControl(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') return true;
  const ac = el.getAttribute('autocomplete');
  return ac === 'current-password' || ac === 'new-password';
}

export function isRequired(el: HTMLElement): boolean {
  if (el.hasAttribute('required')) return true;
  if (el.getAttribute('aria-required') === 'true') return true;
  const labelText = getLabelText(el);
  if (labelText && /\*|\(required\)|\brequired\b/i.test(labelText)) return true;
  const wrapper = el.closest('[class*="required" i],[data-required="true"]');
  return wrapper !== null;
}

export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  // offsetParent is null for display:none (and for position:fixed — hence the fallback).
  if (el.offsetParent === null) {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style) return true; // jsdom without layout: assume visible rather than guess
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.position !== 'fixed') return false;
  }
  return true;
}

export function isDisabled(el: HTMLElement): boolean {
  if ('disabled' in el && (el as HTMLInputElement).disabled) return true;
  return el.getAttribute('aria-disabled') === 'true';
}

/** Resolves the accessible label text for a control, trying several strategies. */
export function getLabelText(el: HTMLElement): string | null {
  const doc = el.ownerDocument;

  const ariaLabelledBy = el.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const parts = ariaLabelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length) return sanitizeText(parts.join(' '), 120);
  }

  const id = el.getAttribute('id');
  if (id) {
    // CSS.escape is unavailable in some test environments.
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const label = doc.querySelector(`label[for="${escaped}"]`);
    if (label?.textContent) return sanitizeText(label.textContent, 120);
  }

  const wrapping = el.closest('label');
  if (wrapping?.textContent) return sanitizeText(wrapping.textContent, 120);

  // Common pattern: a labelled wrapper div containing both a label span and the control.
  const group = el.closest('[class*="field" i],[class*="form-group" i],[class*="input" i]');
  if (group) {
    const candidate = group.querySelector('label,legend,[class*="label" i]');
    if (candidate?.textContent && !candidate.contains(el)) {
      return sanitizeText(candidate.textContent, 120);
    }
  }

  const fieldset = el.closest('fieldset');
  const legend = fieldset?.querySelector('legend');
  if (legend?.textContent) return sanitizeText(legend.textContent, 120);

  return null;
}

/** Nearest preceding text node content — a weak, last-resort signal. */
export function getSurroundingText(el: HTMLElement, maxChars = 80): string | null {
  let node: Node | null = el.previousSibling;
  let hops = 0;
  while (node && hops < 4) {
    const text = node.textContent?.trim();
    if (text && text.length > 1) return sanitizeText(text, maxChars);
    node = node.previousSibling;
    hops++;
  }
  const parent = el.parentElement;
  if (parent) {
    const own = Array.from(parent.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (own) return sanitizeText(own, maxChars);
  }
  return null;
}

/** Short structural path for debugging. Contains no attribute values beyond tag/class. */
export function domPath(el: HTMLElement, maxDepth = 5): string {
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  let depth = 0;
  while (current && depth < maxDepth) {
    let part = current.tagName.toLowerCase();
    const cls = current.getAttribute('class');
    if (cls) {
      const first = cls.trim().split(/\s+/)[0];
      if (first && first.length < 30) part += `.${first}`;
    }
    const parent: HTMLElement | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
      if (siblings.length > 1) part += `:nth(${siblings.indexOf(current)})`;
    }
    parts.unshift(part);
    current = parent;
    depth++;
  }
  return parts.join('>');
}

/** All identification hints for a control, already sanitized. */
export interface ControlHints {
  name: string | null;
  id: string | null;
  label: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  autocomplete: string | null;
  surrounding: string | null;
  type: string | null;
  dataAttrs: string | null;
}

export function collectHints(el: HTMLElement): ControlHints {
  const dataAttrs = Array.from(el.attributes)
    .filter((a) => a.name.startsWith('data-') && a.name.length < 40 && a.value.length < 40)
    .filter((a) => /name|field|test|qa|id|label/.test(a.name))
    .map((a) => a.value)
    .join(' ');

  return {
    name: el.getAttribute('name'),
    id: el.getAttribute('id'),
    label: normalizeLabel(getLabelText(el)) || null,
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    autocomplete: el.getAttribute('autocomplete'),
    surrounding: normalizeLabel(getSurroundingText(el)) || null,
    type: inputType(el),
    dataAttrs: dataAttrs || null,
  };
}

/** Candidate submit/apply controls inside a root. */
export function findSubmitControls(root: ParentNode): HTMLElement[] {
  const selector = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button',
    '[role="button"]',
    'a[class*="apply" i]',
    'a[class*="submit" i]',
  ].join(',');
  const out: HTMLElement[] = [];
  const nodes = root.querySelectorAll<HTMLElement>(selector);
  const limit = getConfig().dom.max_scan_nodes;
  for (let i = 0; i < nodes.length && out.length < limit; i++) {
    const el = nodes[i]!;
    if (looksLikeSubmitControl(el)) out.push(el);
  }
  return out;
}

const SUBMIT_TEXT = /\b(submit|apply|send application|finish|complete application|confirm and submit)\b/i;
const NON_SUBMIT_TEXT = /\b(cancel|back|previous|save draft|close|log ?in|sign ?in|search|filter|upload)\b/i;

export function looksLikeSubmitControl(el: HTMLElement): boolean {
  const text = sanitizeText(
    [el.textContent, el.getAttribute('aria-label'), el.getAttribute('value'), el.getAttribute('title')]
      .filter(Boolean)
      .join(' '),
    120,
  );

  // Checked first: `<button>` defaults to type="submit", so a Cancel button inside a
  // form is structurally a submit control. Its label is the better evidence.
  if (NON_SUBMIT_TEXT.test(text)) return false;

  if (el instanceof HTMLInputElement && el.type === 'submit') return true;
  // An explicit type="submit" attribute is intent; the implicit default is not.
  if (el instanceof HTMLButtonElement && el.getAttribute('type')?.toLowerCase() === 'submit') return true;

  if (!text) return false;
  return SUBMIT_TEXT.test(text);
}

/** Accessible text of a control, sanitized and capped. */
export function controlText(el: HTMLElement): string {
  return sanitizeText(
    [el.getAttribute('aria-label'), el.textContent, el.getAttribute('value'), el.getAttribute('title')]
      .filter(Boolean)
      .join(' '),
    80,
  );
}

/** Enumerates form controls under `root` with a hard node budget. */
export function scanControls(root: ParentNode, budget = getConfig().dom.max_scan_nodes): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(FORM_CONTROL_SELECTOR);
  const out: HTMLElement[] = [];
  for (let i = 0; i < nodes.length && out.length < budget; i++) {
    const el = nodes[i]!;
    if (el.getAttribute('type') === 'hidden') continue;
    out.push(el);
  }
  return out;
}

/** Nearest form-ish ancestor: a real <form>, or a container that behaves as one. */
export function nearestFormContainer(el: HTMLElement): HTMLElement | null {
  const form = el.closest('form');
  if (form) return form;
  return el.closest('[role="form"],[data-form],[class*="application" i],[class*="form" i]');
}

/** Detects repeated-block containers (employment history, education). */
export function findRepeaterIndex(el: HTMLElement): { group_key: string; instance_index: number } | null {
  // Pattern 1: indexed name attribute, e.g. employer[1].title or education.2.degree
  const name = el.getAttribute('name') ?? '';
  const bracket = /([A-Za-z_][\w-]*)\s*\[\s*(\d+)\s*\]/.exec(name);
  if (bracket) return { group_key: bracket[1]!.toLowerCase(), instance_index: Number(bracket[2]) };
  const dotted = /([A-Za-z_][\w-]*)[._-](\d+)[._-]/.exec(name);
  if (dotted) return { group_key: dotted[1]!.toLowerCase(), instance_index: Number(dotted[2]) };

  // Pattern 2: repeated sibling containers with a shared class or data-index.
  const container = el.closest('[data-index],[data-item-index],[data-repeat-index]');
  if (container) {
    const raw =
      container.getAttribute('data-index') ??
      container.getAttribute('data-item-index') ??
      container.getAttribute('data-repeat-index');
    const idx = Number(raw);
    if (Number.isFinite(idx)) {
      const key =
        container.getAttribute('data-group') ??
        container.getAttribute('data-section') ??
        (container.getAttribute('class') ?? '').trim().split(/\s+/)[0] ??
        'group';
      return { group_key: key.toLowerCase(), instance_index: idx };
    }
  }

  // Pattern 3: positional index among structurally identical siblings.
  const block = el.closest('fieldset,[class*="item" i],[class*="entry" i],[class*="repeat" i]');
  const parent = block?.parentElement;
  if (block && parent) {
    const sameShape = Array.from(parent.children).filter(
      (c) => c.tagName === block.tagName && c.className === block.className,
    );
    if (sameShape.length > 1) {
      const key = (block.getAttribute('class') ?? block.tagName).trim().split(/\s+/)[0] ?? 'group';
      return { group_key: key.toLowerCase(), instance_index: sameShape.indexOf(block) };
    }
  }

  return null;
}
