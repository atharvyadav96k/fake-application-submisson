# Application Activity Verification Extension

A Manifest V3 browser extension that observes how a job application is filled in a portal
and produces **structured, privacy-conscious evidence** about the activity: which session
and portal, which fields were touched, how they were populated, whether the values match
the candidate record the system already holds, and — most importantly — whether multiple
independent signals indicate the application was actually submitted.

The extension **collects evidence. It does not make decisions.** It never approves,
rejects, scores, or flags a person. When it cannot determine something it says
`unknown` / `unverifiable` rather than guessing.

* Design rationale, schemas, and the submission-detection strategy: [DESIGN.md](DESIGN.md)
* What is and is not collected, in plain language: [PRIVACY.md](PRIVACY.md)
* Example backend payloads: [examples/](examples/)

---

## Quick start

```bash
npm install
npm run build          # generates icons + bundles into extension/dist
npm test               # 156 unit + integration tests
npm run typecheck
```

Load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` directory (not `extension/dist`)
4. Pin the extension, open the popup, and start a session with an operator ID and a
   candidate ID

`npm run build:watch` rebuilds on change; use the extension page's reload button to pick
up a new build.

### Pointing it at your backend

Everything deployment-specific lives in [`extension/src/common/config.ts`](extension/src/common/config.ts).
At minimum, change:

| Setting | Meaning |
|---|---|
| `api.base_url` | Your ingestion service |
| `allowed_origins` | Portal origins the extension may observe at all |
| `network.submission_path_hints` | Endpoint fragments that indicate a submission |
| `confirmation.phrases` | Success wording used by your portals |

Then mirror the origins in [`extension/manifest.json`](extension/manifest.json)
(`host_permissions` and both `content_scripts` entries), and rebuild.

A deployment can also override any of this at runtime without a rebuild by writing a
partial config object to `chrome.storage.local` under the key `aav.config` — it is
deep-merged onto the defaults on every service-worker wake-up.

---

## What it collects

For each session:

```text
session      operator, candidate id, hashed candidate email, portal, adapter, timestamps,
             whether the candidate record was opened before the first fill, outcome
pages        sanitized URL, path, title, referrer, page type, entry point, frame, order
fields       canonical name, instance index, how it was identified, required, state,
             input method, focus/dwell/keystroke *counts*, edit count, fill order,
             match result — value only where policy allows, hash otherwise
events       append-only interaction and submission events (see DESIGN.md §3)
submission   confidence score plus the full evidence list that produced it
environment  browser family/version, extension version, timezone, locale
```

It never collects passwords, keystrokes, clipboard contents, tokens, cookies, request or
response bodies, or any activity outside the configured portal origins. Those guarantees
are enforced in code and asserted in [`tests/privacy.test.ts`](tests/privacy.test.ts).

---

## How submission detection works

Clicking "Apply" is treated as *intent*, never as proof. Four independent signal classes
are fused, and repeats within one class cannot inflate the score:

| Class | Example signals | Weight |
|---|---|---|
| DOM intent | submit control clicked, Enter pressed in a form | 0.20 |
| DOM submit | native `submit` event, form removed, form disabled | 0.40–0.50 |
| Network | submission-shaped request, 2xx response | 0.60–0.80 |
| Navigation | routed to a confirmation page | 0.80 |
| Confirmation | success text/toast/modal, portal-specific rule | 0.85–1.00 |
| **Negative** | validation errors after submit, 4xx/5xx, form still present | −0.10 to −0.40 |

```text
positive = 1 − Π(1 − wᵢ)      one contribution per class
score    = clamp(positive + Σ negatives, 0, 1)
```

`confirmed` requires **both** a confirmation-class signal and a score at or above
`confirm_threshold` (default 0.85). A click plus a successful POST reaches `submitted`,
never `confirmed`.

The states are deliberately distinct:

| State | Meaning |
|---|---|
| `clicked_only` | intent observed, nothing has followed yet |
| `click_without_submission` | intent observed, then contradicting evidence |
| `submission_without_click` | submission observed with no click we recognised |
| `submitted` | submission evidence, no portal confirmation |
| `confirmed` | portal confirmed it |
| `unknown` | not enough evidence |

Every score ships with its `evidence[]`, including the weight applied and whether each
item was counted, so any number can be recomputed offline from the stored record.

---

## Adding support for a new portal

Adapters are the only place portal knowledge lives. Copy
[`extension/src/adapters/portals/example-portal.ts`](extension/src/adapters/portals/example-portal.ts)
and implement only what the generic heuristics get wrong — everything else can delegate
to `genericAdapter`:

```ts
export class MyPortalAdapter implements PortalAdapter {
  readonly name = 'my-portal';
  readonly kind = 'known' as const;
  readonly priority = 100;

  matches(url: URL) {
    return url.hostname.endsWith('.my-portal.com');
  }

  identifyPage(ctx) { /* route → PageType */ }
  getCandidateFields(ctx) { /* fields the form should contain */ }
  mapField(el, ctx) { /* portal attributes → canonical field */ }
  detectSubmission(event, ctx) { /* portal submit control */ }
  detectConfirmation(ctx) { /* the authoritative success rule */ }
  classifyNetwork(meta, ctx) { /* true / false / null to defer */ }
}
```

Register it in [`adapter-manager.ts`](extension/src/adapters/adapter-manager.ts), add the
origin to `allowed_origins` and the manifest, and add tests. The manager selects the
highest-priority adapter whose `matches()` returns true and falls back to the generic
heuristic adapter; an adapter that throws is caught and downgraded rather than breaking
collection.

---

## Architecture

```text
MAIN world      page-hook.ts        patches fetch/XHR/sendBeacon → metadata only
                     │ postMessage
ISOLATED world  observer.ts         lifecycle + wiring
                ├── page-detector   SPA routing, URL sanitization, page typing
                ├── field-tracker   discovery, canonical mapping, interaction, matching
                ├── form-tracker    one MutationObserver, debounced, budgeted
                ├── submission-detector  signal fusion + scoring
                └── adapters/*      portal rules, generic fallback
                     │ chrome.runtime (batched)
Service worker  event-store         append-only, deduped, durable queue
                session-store       lifecycle + outcome resolution
                uploader/api        batching, backoff, offline retry
                     │ HTTPS
                Backend
```

Full detail in [DESIGN.md](DESIGN.md).

### Performance

* One delegated listener set per document, not per control.
* A single `MutationObserver` with `attributes: false`, debounced, with a per-batch node
  budget; subtrees are only descended into when they actually contain form controls.
* Hashing and candidate matching are debounced until input settles.
* Reconciliation (programmatic fills, detached controls) runs on a 4 s idle callback,
  never as a continuous scan.
* Events are batched in the page, batched again in the worker, and uploaded on an alarm —
  never one request per event.

---

## Backend contract

| Endpoint | Purpose |
|---|---|
| `POST /v1/activity/events` | streamed batches; respond `{ "accepted": [event_id…] }` |
| `POST /v1/activity/sessions/{id}/finalize` | complete session payload at session end |
| `GET /v1/activity/sessions/{id}/candidate` | candidate record for **local** comparison |

Every payload carries `schema_version` so the schema can evolve without breaking older
installed extensions. Events are idempotent on `event_id`; anything the backend does not
acknowledge stays queued in the browser and is retried with exponential backoff, across
service-worker restarts and browser restarts.

Examples: [`examples/event-batch.json`](examples/event-batch.json),
[`examples/session-payload.confirmed.json`](examples/session-payload.confirmed.json),
[`examples/session-payload.flagged.json`](examples/session-payload.flagged.json),
[`examples/candidate-record.json`](examples/candidate-record.json).

---

## Testing

```bash
npm test                 # everything
npm run test:coverage
npx vitest run tests/privacy.test.ts
```

| Suite | Covers |
|---|---|
| `privacy.test.ts` | URL/value redaction, sensitivity tiers, password and keystroke guarantees, payload scrubbing |
| `field-tracker.test.ts` | discovery, canonical mapping, typed/pasted/autofilled/programmatic input, state transitions, edits, clears, repeated groups, dynamic fields, matching |
| `submission.test.ts` | scoring algebra, all four signal classes, negative evidence, watchdog, network bridge filtering |
| `spa.test.ts` | pushState/replaceState/popstate, dynamic forms, modals, multi-step flows |
| `adapters.test.ts` | adapter selection and isolation, generic heuristics, example portal |
| `storage.test.ts` | queue durability, dedupe, caps, acks, session lifecycle, outcome resolution |
| `integration.test.ts` | full application flow end to end, uploader retry/offline/finalize |

---

## Repository layout

```text
extension/
  manifest.json
  icons/                 generated by scripts/make-icons.mjs
  src/
    background/          service worker, uploader, payload builder, environment
    content/             observer, page/field/form/submission trackers, page hook
    adapters/            interface, manager, generic adapter, portals/
    storage/             session store, event store, storage drivers
    models/              session, field, event, submission, payload types
    api/                 backend client
    popup/               evidence inspector UI
    common/              config + message contracts
    utils/               hashing, redaction, timestamps, ids, text, logger
tests/                   unit + integration suites
examples/                example backend payloads
scripts/                 esbuild build, icon generation
```

---

## Limitations

Worth stating plainly, because the evidence is only as good as its caveats:

* **Absence of keystrokes is not evidence of wrongdoing.** Browser autofill, password
  managers, assistive technology, IME composition, and other extensions all produce
  keystroke-free fills. The extension labels the observed *pattern* and says so in the
  event metadata.
* **Cross-origin iframes** are only observed if the extension is granted their origin too;
  otherwise their fields are invisible to it.
* **Shadow DOM** with `mode: 'closed'` cannot be inspected.
* **Portals that submit from a service worker or a cross-origin frame** may not surface a
  network signal; detection then falls back to DOM and navigation evidence.
* The generic adapter is a heuristic. On an unknown portal, expect `unknown` canonical
  fields and rely on the adapter mechanism for portals that matter.
