# Application-Activity Verification — Backend

TypeScript / Express / Mongoose service that receives the evidence produced by the
[browser extension](../Browser%20Extension/DESIGN.md), verifies it independently, stores
it, and offers an AI reading of it for human reviewers.

Like the extension, this service **never decides whether an application is legitimate**.
It stores what was observed, checks whether the observation is internally consistent, and
hands a reviewer something inspectable.

> **Picking this up cold?** [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md) records the
> design decisions and their rationale, what is and isn't verified, the environment
> gotchas already hit, and the open items.

---

## 1. What it does

Three layers are kept deliberately separate, and every response makes clear which layer a
statement came from:

| Layer | Source | Authority |
|---|---|---|
| `session`, `submission`, `pages`, `fields` | reported by the extension, stored verbatim | what the browser observed |
| `verification` | recomputed here from the same evidence | authoritative on arithmetic and policy |
| `latest_analysis` / `/analyses` | Google Gemini | advisory only, never a verdict |

**Independent re-scoring.** [`src/services/scoring.ts`](src/services/scoring.ts) is a
deliberate re-implementation of the extension's noisy-OR fusion (DESIGN §6), not a shared
library — sharing the code would make the check vacuous. Weights come from *this
service's* configuration, never from the payload, so a client cannot raise its own score
by inflating the weight it claims for a signal. The recomputed score, state and outcome
are stored beside the reported ones with a match flag on each.

**Privacy enforced twice.** The extension applies the three-tier sensitivity policy
before anything leaves the page. This service does not trust that:
[`sanitize.ts`](src/services/sanitize.ts) strips anything that violates the policy
*before* it reaches storage, and [`integrity.ts`](src/services/integrity.ts) records the
violation as a `critical` issue. Both run — the value is gone and the breach is visible.

---

## 2. Quick start

```bash
npm install
cp .env.example .env        # then fill in AI_API_KEY and the two tokens
npm run dev                 # http://127.0.0.1:8080
```

Requires MongoDB reachable at `MONGODB_URI` (default `mongodb://127.0.0.1:27017`).

```bash
npm test          # 51 tests, no database required
npm run typecheck
npm run build && npm start
npm run ai:smoke  # one live request against the AI provider
```

### Pointing the extension at it

In the extension's `extension/src/common/config.ts`:

```ts
api: { base_url: 'http://127.0.0.1:8080', /* paths already match */ }
```

The three paths the extension calls (`/v1/activity/events`, `.../finalize`,
`.../candidate`) are implemented exactly as the extension's `ApiClient` expects, including
the `{ accepted: [...] }` acknowledgement shape.

---

## 3. API

All endpoints take `Authorization: Bearer <token>`. Two scopes:

* **ingest** — what the extension holds. Writes evidence, reads the candidate record for
  its own session, and can list/select candidates by email to start one — the same
  narrow, operator-appropriate actions the dashboard offers. It cannot read the session
  archive, events, or analysis, so a token compromised on an operator's machine is not a
  data breach.
* **admin** — reviewers and dashboards. Read access plus analysis. Accepted anywhere an
  ingest token is; never the reverse.

### Extension-facing (`ingest`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/activity/events` | Batch append. Idempotent on `event_id`. |
| `POST` | `/v1/activity/sessions/:id/finalize` | Full record. Idempotent on payload fingerprint. |
| `GET` | `/v1/activity/sessions/:id/candidate` | Reference data for in-browser comparison. |
| `GET` | `/v1/candidates` | Directory the extension's popup picks a candidate from — email, latest session status. |
| `POST` | `/v1/candidates/start` | Pick a candidate by **email only**, get back a fresh `session_id`, bound server-side. |
| `POST` | `/v1/auth/login` | Unauthenticated — trades a registered account's username/password for the ingest token. |

`POST /events` replies `202` with the ids the client may drop:

```jsonc
{ "accepted": ["<event_id>", ...], "inserted": 3, "duplicates": 0, "rejected": [] }
```

Anything omitted from `accepted` stays queued in the browser and is retried. Duplicates
are *accepted*, not rejected — a lost ack is indistinguishable from a lost batch, so
telling the client to keep retrying an event we already hold would loop forever.

### Review (`admin`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/sessions` | Filter by `outcome`, `state`, `portal_domain`, `candidate_id`, `operator_id`, `finalized`, `min_severity`, `from`, `to`. |
| `GET` | `/v1/sessions/statistics` | Aggregate counts, including score/outcome mismatch totals. |
| `GET` | `/v1/sessions/:id` | Full stored record. |
| `GET` | `/v1/sessions/:id/events` | Event timeline, paginated. |
| `POST` | `/v1/sessions/:id/analyze` | Run AI analysis. `?force=true` bypasses the cache. |
| `GET` | `/v1/sessions/:id/analyses` | Analysis history, newest first. |
| `PUT` | `/v1/candidates` | Upsert candidate reference data. `candidate_id` is optional — derived from `email` if omitted. |
| `POST` | `/v1/candidates/bind` | Bind a session to a candidate before observation starts (by id). |

### Unauthenticated

`GET /health/live`, `GET /health/ready` — deliberately uninformative: dependency
reachability only, no versions, counts, or connection details.

### Errors

```jsonc
{ "error": { "code": "database_unavailable", "message": "...", "request_id": "..." },
  "retryable": true }
```

`retryable` is the field that matters to the extension. Infrastructure failures are `503`
+ `retryable: true` so queued evidence is replayed rather than dropped. An unsupported
schema version is `422` — outside the extension's retry set — so an incompatible client
backs off instead of hammering.

---

## 4. AI analysis

Google Gemini (`AI_MODEL`, default `gemini-2.5-flash`), called over plain REST with a
forced response schema, so the output is always parseable and is re-validated with Zod
before storage.

**The model never sees personal data.** [`src/ai/digest.ts`](src/ai/digest.ts) is the
privacy boundary: it sends canonical field *names*, interaction counts, durations, signal
kinds and weights, and the deterministic check results. Values, hashes, URLs, page text,
emails, candidate ids and DOM hints are all excluded — none of them help decide whether
the evidence is coherent, and sending them would put personal data in a third-party
service for no analytical gain. This is asserted in `tests/privacy.test.ts`.

**Per-field detail is filtered to what's actually informative.** The digest's aggregate
counts (`by_state`, `required_empty`, etc.) already summarize every field; the per-field
`detail` list only repeats a field individually when something happened in it (a focus,
keystroke, paste, or edit) or it was required and left empty — a real gap worth knowing
*which* field it was. An untouched, non-required field adds nothing beyond the aggregate,
and on a large modern form (a real session had 262 detected controls, 177 of them
decorative framework internals the candidate never touched) sending each one individually
was pure token cost with no analytical value.

Runs are append-only and tagged with model and `prompt_version`, so a change in
conclusions can be traced to a prompt change rather than mistaken for a change in the
data. Results are cached against a fingerprint of the exact model input; failures are
recorded too, so "could not be analysed" looks different from "never analysed".

The prompt constrains the model to describe evidence, not people: automation-looking
patterns are reported as observations with mundane explanations (autofill, password
managers, portals repopulating their own forms), and `risk_level` grades *evidence
quality*, not the candidate.

**Auto-run on `flagged`, still only advisory.** Whenever `POST /finalize` resolves to
`derived_outcome: "flagged"` (and isn't a duplicate retry), analysis runs automatically
in the background — a reviewer gets a second opinion without having to remember to ask
for one. This never changes the stored outcome: the AI result is written to
`latest_analysis` beside the deterministic record, exactly like a manual
`POST /analyze` call, and a failure here is only logged, never surfaced to the client
that finalized the session.

---

## 5. Configuration

See [.env.example](.env.example). Notable:

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` / `MONGODB_DB_NAME` | `mongodb://127.0.0.1:27017` / `activity_verification` | |
| `INGEST_TOKEN` / `ADMIN_TOKEN` | — | Required in production; startup fails without them. |
| `AUTH_DISABLED` | `false` | Cannot be `true` when `NODE_ENV=production`. |
| `AI_ENABLED` / `AI_API_KEY` | `true` / — | With no key, analysis endpoints return `503`. |
| `SUPPORTED_SCHEMA_VERSIONS` | `1.0` | Payloads outside this list are rejected `422`. |
| `MAX_EVENTS_PER_BATCH` | `100` | Matches the extension's `max_batch_size`. |
| `RATE_LIMIT_*` | 600 / 60s | In-memory and per-instance; use an edge limiter behind >1 replica. |

The process refuses to start on invalid configuration rather than failing later at a
request boundary.

---

## 6. Layout

```text
src/
├── contract/       vocabulary + Zod schemas — the wire contract, one source of truth
├── db/             connection + Mongoose models (sessions, events, candidates, analyses)
├── services/       scoring · integrity · sanitize · ingest · session · candidate · analysis
├── ai/             gemini client · prompt · digest (the privacy boundary)
├── middleware/     auth · rate-limit · schema-version · error-handler · request-context
├── routes/         activity (extension) · sessions (review) · candidates · health
├── config/env.ts   validated configuration
└── utils/          logger · errors · ids · time
tests/              contract · scoring · integrity · privacy · app (no database needed)
scripts/ai-smoke.ts live AI check
```

### Collections

| Collection | Key | Notes |
|---|---|---|
| `sessions` | `session_id` unique | Report + verification + latest analysis. `portal_domain` is where it started; `portal_domains` is the full redirect chain, in visiting order — a job board handing off to the employer's own ATS shows up there, computed once at finalize from `pages[].domain`. |
| `activity_events` | `event_id` unique | Append-only; the unique index *is* the idempotency guarantee. |
| `candidates` | `candidate_id` unique | Reference data; prefer `hashed_fields`. |
| `session_analyses` | `analysis_id` unique | Append-only AI history. |

---

## 7. Notes on the fixtures

`tests/fixtures/` are the extension repository's published example payloads, used
verbatim so a break in the wire contract fails a test here.

One is worth knowing about: `session-payload.confirmed.json` reports
`confidence_score: 0.9976`, but its evidence array contains `adapter_confirmation`
(weight `1.0`), which saturates the noisy-OR — the extension's own rule yields exactly
`1.0` for that evidence. `0.9976` is what the same rule produces from a
`confirmation_text`/`success_toast` pair, so the example appears to have been written
against a different evidence set. The 0.0024 gap sits inside `SCORE_TOLERANCE`, so
verification passes it; the test documents it rather than asserting the stale number.
