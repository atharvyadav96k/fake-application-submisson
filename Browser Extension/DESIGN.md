# Application-Activity Verification Extension — Design

**Schema version:** `1.0`
**Manifest:** MV3 (Chrome/Chromium)
**Language:** TypeScript

The extension observes an operator/candidate filling a job-application portal and emits
**structured, privacy-conscious evidence**. It never decides whether an application is
legitimate — it produces inspectable signals and a confidence score for downstream analysis.

---

## 1. Architecture

Four isolated runtime contexts, connected by explicit, typed messages.

```text
┌────────────────────────────── Web page (portal) ──────────────────────────────┐
│                                                                               │
│  MAIN world  ─ page-hook.ts                                                   │
│    · patches window.fetch / XMLHttpRequest / navigator.sendBeacon             │
│    · emits REQUEST METADATA ONLY (method, sanitized URL, status, timing)      │
│    · never reads request/response bodies                                      │
│                        │ window.postMessage (origin-checked, tagged)          │
│                        ▼                                                      │
│  ISOLATED world ─ content bundle                                              │
│    observer.ts        orchestrator + lifecycle                                │
│    page-detector.ts   URL/SPA/route tracking, page classification             │
│    field-tracker.ts   discovery, canonical mapping, state, interaction events │
│    form-tracker.ts    form registry, required/validation, fill order          │
│    submission-detector.ts  signal fusion + confidence scoring                 │
│    adapters/*         portal-specific rules (generic fallback)                │
│                        │ chrome.runtime.sendMessage (batched)                 │
└────────────────────────┼──────────────────────────────────────────────────────┘
                         ▼
┌───────────────── Background service worker (MV3) ─────────────────┐
│  session-store   session lifecycle, outcome resolution            │
│  event-store     append-only queue, dedupe, persistence           │
│  api/client      batching, backoff, retry, offline durability     │
│  chrome.alarms   flush ticks + session timeout                    │
└────────────────────────┬──────────────────────────────────────────┘
                         ▼  HTTPS  (schema_version-tagged batches)
                    Backend API
```

**Popup** reads session state read-only and exposes the evidence log for inspection.

Modularity rule: the core never contains portal names. Portal knowledge lives only in
`adapters/portals/*`, selected at runtime by `adapter-manager`.

---

## 2. Data flow

```text
DOM event ─▶ field-tracker ─┐
Route change ─▶ page-detector ─┤
Network meta (MAIN world) ─────┼─▶ EventBuffer (content, in-memory, deduped)
Submit/confirm signal ─────────┘        │ debounce 750ms / 25 events / flush-on-hide
                                        ▼
                          chrome.runtime.sendMessage(EVENT_BATCH)
                                        ▼
                    background: event-store.append() (append-only, idempotent by event_id)
                                        ▼
                       chrome.storage.local (durable ring buffer, capped)
                                        ▼
                  api/client: batch ≤100 events, exponential backoff + jitter
                                        ▼
                            POST /v1/activity/events  (retried until acked)
                                        ▼
                 session end ─▶ POST /v1/activity/sessions/:id/finalize (full payload)
```

Back-pressure: if the backend is unreachable, events remain in `chrome.storage.local`
and are replayed on the next alarm tick or browser restart. Nothing is dropped except by
an explicit cap (`MAX_STORED_EVENTS`), and a cap drop itself emits a `buffer_truncated`
event so the loss is visible in the record.

---

## 3. Event schema

Append-only. `event_id` is a UUID; the store is idempotent on it.

```jsonc
{
  "schema_version": "1.0",
  "event_id": "uuid",
  "session_id": "uuid",
  "timestamp": "2026-08-15T09:12:04.221Z",
  "monotonic_ms": 41233,              // performance.now() since page context start
  "event_type": "field_input",
  "page": { "domain": "...", "path": "...", "title": "...", "frame": "top|iframe" },
  "field": {                          // optional
    "field_id": "f_7",
    "canonical_name": "current_company",
    "instance_index": 0
  },
  "metadata": {}                      // event-type specific, always redacted
}
```

Event types:

| Group | Types |
|---|---|
| Session | `session_started`, `session_resumed`, `session_finalized`, `buffer_truncated` |
| Page | `page_view`, `page_transition`, `frame_attached` |
| Candidate | `candidate_record_opened` |
| Field | `field_discovered`, `field_focus`, `field_blur`, `field_input`, `field_change`, `field_paste`, `field_autofill`, `field_fill`, `field_edit`, `field_cleared`, `field_skip` |
| Submission | `submit_button_click`, `form_submit`, `network_request`, `navigation_confirmation`, `dom_confirmation`, `validation_error`, `form_removed`, `form_disabled`, `submission_evaluated` |

---

## 4. Session schema

```jsonc
{
  "session_id": "uuid",
  "operator_id": "op_123",
  "candidate_id": "cand_456",
  "candidate_email": "[REDACTED]",      // hash retained separately
  "candidate_email_hash": "sha256:...",
  "portal_domain": "jobs.example.com",
  "matched_adapter": "known | unknown",
  "adapter_name": "example-portal",
  "timestamps": {
    "selected": "...",                  // session created / candidate selected
    "candidate_record_opened": "...",
    "first_fill": "...",
    "applied_clicked": "...",
    "submit_detected": "...",
    "confirmed": "...",
    "ended": "..."
  },
  "candidate_record_opened_before_fill": true,
  "state": "active | ended",
  "outcome": "confirmed | flagged | abandoned | timed_out | unknown"
}
```

**Outcome resolution** (never `confirmed` from a click alone):

| Condition | Outcome |
|---|---|
| `confidence ≥ CONFIRM_THRESHOLD` **and** ≥1 confirmation-class signal | `confirmed` |
| submit evidence present but no confirmation, or contradictory signals (click + validation error, click + no request) | `flagged` |
| fields filled, no submit evidence, session closed by operator | `abandoned` |
| no activity for `SESSION_TIMEOUT_MS` | `timed_out` |
| anything else | `unknown` |

---

## 5. Field schema

```jsonc
{
  "field_id": "f_7",                    // stable per-session synthetic id
  "canonical_field": "current_company",
  "instance_index": 1,                  // employer[0], employer[1]…
  "descriptor": {                       // how it was identified, for auditability
    "tag": "input", "type": "text",
    "name_hint": "company", "label_hint": "Current company",
    "autocomplete": "organization",
    "signals": ["adapter", "label", "autocomplete"],
    "confidence": 0.86
  },
  "sensitivity": "storable | hashed_only | never_store",
  "required": true,
  "state": "empty | partial | filled",
  "input_method": "typed | pasted | autofilled | programmatic | mixed | unknown",
  "interaction": {
    "focus_count": 2, "first_focus_at": "...", "last_blur_at": "...",
    "time_in_field_ms": 4210, "keystroke_count": 14, "edit_count": 1,
    "fill_sequence_number": 5, "first_fill_at": "...", "skipped": false
  },
  "value": "Example Ltd | [REDACTED]",  // by sensitivity policy
  "value_hash": "sha256:...",           // for hashed_only
  "match_result": "match | mismatch | unverifiable | not_available"
}
```

**Identification** fuses adapter rules, `autocomplete`, label (`<label for>`,
wrapping label, `aria-label`, `aria-labelledby`), `name`/`id` tokens, placeholder, and
nearest preceding text node — each contributing weighted score. Below
`FIELD_MATCH_MIN_CONFIDENCE` the field is recorded with `canonical_field: "unknown"`
rather than guessed.

---

## 6. Submission detection strategy

Four **independent** signal classes; no single one is sufficient.

| Class | Signal | Default weight |
|---|---|---|
| A — DOM intent | `submit_button_click` | 0.20 |
| A — DOM | `form_submit_event` | 0.40 |
| B — Network | `submission_request` (POST/PUT to an apply-ish endpoint) | 0.60 |
| B — Network | `submission_request_success` (2xx) | 0.80 |
| C — Navigation | `confirmation_navigation` (success URL / redirect) | 0.80 |
| D — DOM confirm | `confirmation_text` / `success_toast` / `confirmation_modal` | 0.90 |
| D — DOM confirm | `adapter_confirmation` (portal-specific rule) | 1.00 |
| D — DOM confirm | `application_status_changed` (clicked control's own label changes, e.g. "Apply" → "Applied" — many "easy apply" flows show nothing else) | 0.90 |
| D — DOM | `form_removed` / `form_disabled` after submit | 0.50 |
| Negative | `validation_error_after_submit` | −0.35 |
| Negative | `submission_request_failed` (4xx/5xx) | −0.40 |

Fusion (configurable, default *noisy-OR* over positive weights so independent weak
signals accumulate but never saturate from repeats of the same class):

```text
positive = 1 − Π(1 − w_i)           // one contribution per signal *class*
score    = clamp(positive + Σ negatives, 0, 1)
```

Result is always returned **with its evidence array**, and every evidence item carries the
raw signal, timestamp, and the weight applied — the score is reproducible from the log.

The assessment also carries `clicked_control` — the tag, sanitized label, and structural
DOM path (no attribute values) of whichever control the submit-adjacent click actually
landed on. A reviewer can see "the `<button>` labelled 'Submit application'", not just
"a click happened somewhere". Captured once, at the click itself, alongside the same
control used for the button-relabel confirmation check below.

**Applied-click vs actual submit** are tracked separately and combined into a state:

```text
clicked_only              click, nothing else yet
click_without_submission  click + (validation error | no request within window)
submission_without_click  network/form submit with no observed click (SPA/keyboard)
submitted                 submit evidence, no confirmation
confirmed                 confirmation-class signal + score ≥ threshold
unknown                   insufficient evidence
```

Confirmation is also checked against the page **title**, not only on-page DOM text — many
portals state the outcome precisely in `document.title` even when the visible page uses
custom components none of the selector/phrase rules match (Indeed's post-apply page is
exactly this case: title "Your application has been submitted | Indeed", no matching
heading). It's checked once when a page first loads (not only after a click observed on
*that* page) and periodically thereafter — a confirmation page reached by a full
top-level navigation gets a brand-new content-script instance with no memory of an
earlier click, so nothing would otherwise ever look at it.

**Iframe contamination.** Content scripts run in every same-tab frame (`all_frames: true`
in the manifest), including third-party ad/tracking iframes that a job portal happens to
embed — these are never navigated to by the candidate, but a real flagged Naukri session
showed their domains (doubleclick.net, LinkedIn's ad platform, a Zoho-hosted widget)
leaking into `portal_domains`, and — worse — the negative `validation_error_after_submit`
evidence that flagged the session traced back to one of these iframes' own unrelated
markup (an element with a class matching `/error|invalid|required/i`, which is common in
ad/consent templates) being picked up by the ambient DOM-mutation scanner running
independently inside that iframe. Fixed on both sides: the backend's redirect-chain
computation (`computePortalDomains` in `ingest.service.ts`) only counts pages whose
`frame` is `'top'`; and the extension's `Observer` only starts `FormTracker` (the mutation
observer behind confirmation/validation-error detection) and the confirmation/validation
checks in the reconcile loop when running in the top frame (`this.isTopFrame`). Field
tracking and click/submit detection still run in iframes, for the rarer case of a portal
that genuinely embeds its whole application form in one.

**Validation-error false positives.** `collectValidationErrors()` (in
`submission-detector.ts`) scans for on-page evidence that a submission actually failed.
Two real flagged sessions traced back to this scan being too trusting:
1. `[aria-invalid="true"]` was treated as evidence on its own, with no rendered message
   required — but MUI, React Hook Form, and Formik all set that attribute on an empty
   required field the moment it's touched, whether or not anything is ever shown to the
   user. Fixed: an `aria-invalid` node with no text of its own now has its
   `aria-describedby` target's text checked instead (the actual accessible message, MUI's
   real linkage for a shown error) — no message there either means no evidence.
2. A hidden node matching an "error"-ish selector (`.error`, `[class*="error" i]`, etc.)
   still counted, because it had genuine non-empty static text baked into its template —
   just never displayed. A real session showed this exactly: the candidate opened their
   GitHub profile in the same tab mid-application (to copy a project URL), and GitHub's
   own always-in-the-DOM, hidden error-boundary fallback ("Uh oh! There was an error while
   loading...") got counted as validation-error evidence against the job application on a
   completely different site. Fixed: a match is now also required to pass `isVisible()`.

**Naukri's real confirmation route.** A direct/easy-apply session scored 0.84 — above the
submit threshold, just under the 0.85 confirm threshold — and got flagged with "no portal
confirmation observed" even though the application had genuinely gone through: the
extension's own captured events showed the tab landing on `/myapply/saveApply`, titled
"Apply Confirmation", right after the real `apply-workflow/v1/apply` POST succeeded.
Neither the route nor that exact title was recognised anywhere. Fixed in two places, the
way Indeed's post-apply route was: the Naukri adapter now maps `/myapply/saveApply` to
`confirmation` and returns `adapter_confirmation` for it directly, and the generic
phrase list also gained an `apply_confirmation` entry (`/\bapply confirmation\b/i`) as a
fallback for any other portal that titles its confirmation page the same way.

**High-confidence override.** `resolveOutcome()` (`session-store.ts`) used to report
`flagged` for any submission lacking a recognised confirmation signal, regardless of
score — correct when the score is genuinely weak, but a poor fit for the (recurring)
case where the score is high and it's the *confirmation detector* that has a gap, not the
application. Per explicit instruction: any outcome that would land on `flagged` is now
promoted to `confirmed` when `confidence_score > 0.8`, with a reason noting the override.
Implemented by wrapping the existing branch logic (renamed to `classifyOutcome`) rather
than threading the check into every branch, so the override applies uniformly regardless
of *why* a session would have been flagged.

**Capture indicator stuck on after Stop.** `PAUSE_SESSION` and the idle-timeout path both
broadcast `SESSION_PAUSED` to every tracked tab, which the content-script `Observer`
handles by calling `stop()` (and with it, `hideCaptureIndicator()`). `END_SESSION` (the
popup's Stop button) never did — it only broadcast `FLUSH_NOW`, which flushes buffers but
never stops the observer — so clicking Stop ended the session on the backend while the
on-page indicator stayed visible indefinitely. Fixed by broadcasting `SESSION_PAUSED`
from `END_SESSION` too, right after the session is marked ended.

**"Not doing this job now" — discard without submitting.** The popup previously had one
terminal action ("Stop"), which always finalized and uploaded whatever had been
collected. Per explicit request, the popup now distinguishes two outcomes: **Mark as
completed** (renamed from Stop; unchanged behavior — finalizes and uploads, same
`END_SESSION` message) versus **Not doing this job now** (new `DISCARD_SESSION` message),
for when the operator decides not to pursue a job they started a session on. The discard
path never calls `uploader.finalize()` — the call that actually creates the visible
session record server-side — so nothing about a declined job ever reaches the backend:
the session, fields, pages, submission assessment, and any not-yet-uploaded queued events
are wiped locally (`SessionStore.clear()` + `EventStore.clear()`), and every tracked tab
is told to stop immediately (same `SESSION_PAUSED` broadcast used elsewhere), hiding the
capture indicator right away.

One honest limitation: if the periodic upload alarm had already drained a batch of raw
events to the backend *before* the operator discards, those events remain in
`EventModel` with no corresponding session record (since finalize never runs, no
`SessionModel` document is ever created for that session id) — invisible in the review
UI (which lists from `SessionModel`), but not physically deleted from the archive. Fully
deleting server-side would need a new backend endpoint; out of scope for this fix, which
covers the common case (declining before much time has passed).

**Naukri adapter.** Registered alongside Indeed and the example portal
(`adapters/portals/naukri-adapter.ts`), but deliberately thinner: it has not been built
from a captured live session the way Indeed was, so it only encodes route naming that's
stable and publicly observable — job listing URLs (`/job-listings-...`) and the candidate
profile route (`/mnjuser/profile`) — for page identification. Click detection, field
mapping, confirmation text, and network classification are all deferred to the generic
heuristics. This is intentional, not an oversight: Naukri's "Easy Apply" flow relabels its
own button from "Apply" to "Applied" in place, which the generic button-relabel
confirmation heuristic already catches, and its "apply on company site" flow hands off to
the employer's own domain, which tab-based session scoping and redirect-chain tracking
already cover — neither is portal-specific. Tighten this adapter once a real Naukri
session (flagged or confirmed) is captured and inspected, same as Indeed was.

**Session-level outcome floor.** Independent of the state machine above: any session with
real submit-adjacent activity (a click, or confirmation evidence that still didn't clear
the score threshold) whose final confidence score is below `0.7` is reported `flagged`,
never silently `unknown` — a low-confidence session with real activity behind it is
exactly what "flagged" means.

**Network path hints are deliberately conservative.** `'graphql'` is not one of them: a
single GraphQL endpoint serves every mutation a site has (autosave, follow, notification
reads, the real apply), so a path match alone can't tell those apart — a GraphQL call
only counts when it's temporally correlated with an actual click. Common non-submission
actions (`draft`, `autosave`, `follow`, `notification`, `bookmark`, …) are explicit
`ignored_path_hints` for the same reason.

---

## 7. Permission requirements (least privilege)

```jsonc
"permissions": ["storage", "alarms"],
"host_permissions": [                      // backend + configured portals only
  "https://api.example-ats.internal/*",
  "https://jobs.example-portal.com/*"
],
"optional_host_permissions": ["https://*/*"]   // requested per-origin, only if a
                                               // deployment adds a portal at runtime
```

* No `<all_urls>`, no `tabs`, no `webRequest`, no `cookies`, no `history`, no `scripting`.
* Content scripts are declared for the configured portal origins only. Host permission
  for those same origins is what lets the worker message their tabs — nothing wider.
* Adding a portal without shipping a new build means requesting that one origin through
  `optional_host_permissions` and registering the script for it; the user sees and
  approves that grant.
* Network observation uses a MAIN-world hook on the page's own `fetch`/XHR — metadata only —
  instead of `webRequest`, so the extension can never see other sites' traffic.
* Backend host is a single configured origin in `host_permissions` at package time.

---

## 8. Privacy / security model

Three-tier value policy, applied **before** a value ever leaves the content script:

| Tier | Applies to | Stored |
|---|---|---|
| `never_store` | password, OTP/2FA, card number/CVV, SSN/national id, any field whose type is `password` or matched by the sensitive-pattern list | nothing — metadata + match status only |
| `hashed_only` | email, phone, DOB, full address, postal code, government ids | `sha256(normalize(value) + session_salt)`, plus match result |
| `storable` | company, job title, city, country, public profile URLs, years of experience | normalized value (length-capped) |

Hard guarantees, enforced in code and asserted in `tests/privacy.test.ts`:

* Raw keystrokes are never captured — only `keystroke_count`.
* Password-type inputs are excluded at discovery; only their existence/state is noted.
* No request or response **bodies** are read, ever.
* No cookies, `localStorage`, `sessionStorage`, or auth headers are read.
* URLs pass through `sanitizeUrl()` (token/key/session/password/signature params redacted,
  long opaque path segments that look like credentials redacted) before storage or logging.
* Candidate matching happens **locally**; the backend receives match results and hashes,
  not the raw candidate PII the extension compared against.
* A page-level kill switch (`session paused`) stops all collection immediately.
* While a session is `active`, a small on-page badge ("Application activity is being
  recorded") is rendered in closed shadow DOM (`content/indicator.ts`) so whoever is at
  the keyboard can always see that capture is running — it disappears the instant the
  session is paused or ends. It carries no controls of its own; pause/end stays in the
  popup.

Starting a session no longer asks the popup for an operator id, candidate id, or session
id: the operator signs in (the same account as `Backend`'s `/ui`), the popup lists
candidates by **email** (`GET /v1/candidates`), and picking one and pressing Start calls
`POST /v1/candidates/start` directly — the session id it returns is used immediately,
never typed or pasted anywhere.

**What a session is allowed to run on** is the browser tab the operator is actually
working in — plus any tab opened *from* it — not a fixed domain. A job portal routinely
redirects the real apply step to the employer's own ATS on a completely different
domain, and that has to keep being tracked; a domain-based lock would break exactly
there. The background service worker (`background/service-worker.ts`) tracks the set of
tab ids a session has been asked from (`sessions.getAllowedTabs()` /
`sessions.allowTab()`), seeded *deterministically* with `chrome.tabs.query({active:
true, currentWindow: true})` at the moment Start is pressed — not by passively waiting to
see which tab's content script asks for context first. "Whoever asks first" was tried and
found racy: any other tab reloading at the wrong moment could steal that slot before the
real tab ever got a chance, leaving the intended tab silently refused. A request from any
tab outside the tracked set gets `session: null` back — the content script there stays
completely idle, as if no session existed — and is now logged at `warn`, not `debug`, so
this is diagnosable from the service worker's console instead of invisible by default.

Failure posture: when a determination cannot be made, emit `unknown` / `unverifiable`.
Never fabricate `mismatch`.

---

## 9. Folder structure

```text
.
├── extension/
│   ├── manifest.json
│   ├── icons/
│   └── src/
│       ├── background/service-worker.ts
│       ├── content/{observer,page-detector,field-tracker,form-tracker,
│       │            submission-detector,dom-utils,page-hook,network-bridge,event-buffer}.ts
│       ├── adapters/{types,adapter-manager,generic-adapter,portals/example-portal,portals/indeed-adapter,portals/naukri-adapter}.ts
│       ├── storage/{session-store,event-store,local}.ts
│       ├── models/{session,field,event,submission,candidate,payload}.ts
│       ├── api/client.ts
│       ├── popup/{popup.html,popup.ts,popup.css}
│       ├── common/{messages,config}.ts
│       └── utils/{hashing,redaction,timestamps,ids,logger,text}.ts
├── tests/            unit + integration (vitest + jsdom)
├── examples/         example backend payloads
├── scripts/build.mjs esbuild bundler
└── README.md · PRIVACY.md · DESIGN.md
```

---

## 10. Implementation plan

1. Models + config + utils (ids, timestamps, hashing, redaction) — no DOM dependencies.
2. Storage layer over `chrome.storage.local` with an injectable driver (testable in node).
3. Adapter interface, adapter manager, generic heuristic adapter, one example portal adapter.
4. Content: dom-utils → page-detector → field-tracker → form-tracker.
5. MAIN-world page hook + network bridge (metadata only).
6. Submission detector: signal registry, configurable scoring, state machine.
7. Event buffer + messaging + background service worker (queue, batch, retry, alarms).
8. API client with backoff, dedupe, and offline durability.
9. Popup (read-only evidence inspector).
10. Tests: field tracking, submission fusion, SPA, privacy invariants, integration.
11. Build scripts, README, example payloads.
