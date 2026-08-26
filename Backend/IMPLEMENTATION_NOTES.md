# Backend — implementation notes & handoff

Context for picking this work up cold. [README.md](README.md) documents *how to use* the
service; this file records *why it is built this way*, what has actually been verified,
and what is still open.

**Status as of 2026-08-15:** feature-complete first pass. 51 tests passing, typecheck and
build clean, AI path verified against the live provider. Not yet run against a live
MongoDB.

---

## 1. Where this sits

```text
Fake Job application submisson/
├── Browser Extension/   MV3 extension (pre-existing). DESIGN.md is the spec.
└── Backend/             this service — built to receive what the extension emits
```

The extension was already complete. This backend was written *to its published
contract*, not the other way round: `extension/src/api/client.ts`,
`extension/src/models/*.ts` and `extension/src/common/config.ts` were read first, and the
wire types in [src/contract/](src/contract/) mirror them. **If those change, this service
must change with them** — start at [src/contract/vocabulary.ts](src/contract/vocabulary.ts).

The extension's `examples/*.json` are copied verbatim into `tests/fixtures/`, so a break
in the wire contract fails `tests/contract.test.ts` here.

---

## 2. Decisions worth knowing (and why)

### The three-layer separation

Every stored session keeps three things apart, and no endpoint blurs them:

| Layer | Field | Authority |
|---|---|---|
| What the browser reported | `session`, `submission`, `pages`, `fields` | stored verbatim |
| What this service recomputed | `verification` | authoritative on arithmetic + policy |
| What the model concluded | `latest_analysis` | advisory, never a verdict |

This mirrors the extension's own posture: produce inspectable evidence, never a
judgement about a person. A reviewer must always be able to tell which layer a statement
came from.

### Re-scoring is a deliberate re-implementation, not shared code

[src/services/scoring.ts](src/services/scoring.ts) duplicates the extension's noisy-OR
fusion on purpose. Importing the extension's `scoreSignals` would make the check vacuous
— a stale or tampered client would be verifying itself. **Do not refactor these into a
shared package.** The duplication is the feature.

Corollary: weights come from *this service's* config, never from the payload. A client
inflating the weight it claims for a signal cannot raise its own score; the discrepancy
is recorded as `scoring.weight_mismatch` instead. Asserted in `tests/scoring.test.ts`.

### Privacy is enforced twice, on purpose

The extension applies the three-tier sensitivity policy before data leaves the page.
This service does not trust that:

* [sanitize.ts](src/services/sanitize.ts) strips the offending value **before storage**
* [integrity.ts](src/services/integrity.ts) records the violation as a `critical` issue

Both run. The value is gone *and* the breach is visible in the record. A client bug must
not be able to write a credential into this database.

### The AI never sees personal data

[src/ai/digest.ts](src/ai/digest.ts) is the privacy boundary — the single place that
decides what crosses to a third party. It sends canonical field *names*, interaction
counts, durations, signal kinds/weights and the deterministic check results. It excludes
values, hashes, URLs, page text, emails, candidate ids and DOM hints: none of them help
decide whether evidence is coherent, so sending them would be pure downside.

`tests/privacy.test.ts` asserts the serialized digest contains no `sha256:`, no `@`, no
`https://` and no candidate id. **Anything added to the digest must keep that test
green.**

### Idempotency semantics

* **Events** — unique index on `event_id`; `$setOnInsert` only, so a retry never rewrites
  the first-stored version. Duplicates are **accepted, not rejected**: a lost ack is
  indistinguishable from a lost batch, so rejecting them would loop the client forever.
* **Finalize** — fingerprinted with `stableStringify` + sha256. An identical re-send is
  reported as `duplicate: true` without a rewrite.

### `retryable` decides whether evidence survives

The extension keeps events queued until acked, and retries `429`/`5xx`. So error mapping
is not cosmetic:

* infrastructure failure → `503` + `retryable: true` → client keeps its queue
* unsupported schema → `422` (outside the retry set) → incompatible client backs off
  instead of hammering

A bug here silently destroys evidence, which is why `tests/app.test.ts` covers the
database-down path explicitly. **It already caught one such bug** (see §4).

### Two auth scopes

`ingest` (the extension) can write evidence and read the candidate record for its own
session — it cannot enumerate the archive. `admin` (reviewers) can read everything and
trigger analysis, and is accepted anywhere an ingest token is; never the reverse. An
ingest token compromised on an operator's machine is therefore not a data breach.

---

## 3. Verified vs. not

**Verified**

* 51 tests pass — contract, scoring, integrity, privacy, HTTP surface.
* Scoring reproduces the extension's published fixtures exactly (modulo §5).
* `npm run typecheck` and `npm run build` clean.
* **Live Gemini call succeeded**: `gemini-2.5-flash`, ~5.4s, 2864 tokens, valid
  structured output, model stayed evidence-scoped. Re-run with `npm run ai:smoke`.
* Boot without MongoDB fails fast with an actionable log line.

**Not verified — do this first next session**

* **Nothing has run against a live MongoDB.** No Mongo on this machine (`27017`
  refused). Ingest, finalize, the review queries and the aggregation pipeline in
  `getSessionStatistics` are typechecked and unit-tested but never executed. Start Mongo,
  `npm run dev`, and POST a fixture.
* No end-to-end run with the actual extension pointed at this service.
* Index behaviour under load is untested; `autoIndex` is on by default.

---

## 4. Gotchas already hit (don't rediscover these)

| Gotcha | Resolution |
|---|---|
| Node's `--experimental-strip-types` cannot compile **constructor parameter properties** | `GeminiClient` and `HttpError` use explicit field assignment. Keep it that way. |
| Strip-types also cannot resolve the `.js` specifiers NodeNext requires | `npm run dev` uses **tsx**. Vitest resolves them natively. |
| `vitest` collected compiled tests from `dist/` (102 "tests") | `vitest.config.ts` excludes `dist/**`. |
| `tsc -p tsconfig.json` emitted tests into the build | Build uses `tsconfig.build.json` (src only, `rootDir: src`). `tsconfig.json` stays broad for typechecking. |
| Disconnected Mongoose throws `MongooseError: ...before initial connection is complete`, which did **not** match the 503 mapping and fell through to a `500` | Regex in [error-handler.ts](src/middleware/error-handler.ts) extended. This mattered: a `500` is not in the extension's retry set, so queued evidence would have been dropped. |

---

## 5. The stale fixture (open item)

`Browser Extension/examples/session-payload.confirmed.json` is **internally
inconsistent** and should be fixed in the extension repo.

It reports `confidence_score: 0.9976`, but its evidence array contains
`adapter_confirmation` (weight `1.0`). Weight 1.0 saturates the noisy-OR, so the
extension's *own* `scoreSignals` yields exactly `1.0` for that evidence — confirmed by
running its fusion rule directly. `0.9976` is what the same rule produces from weights
`{0.2, 0.8, 0.85, 0.9}` — i.e. a `confirmation_text`/`success_toast` pair rather than an
adapter confirmation. The example appears to have been written against a different
evidence set and not updated.

The 0.0024 gap sits inside `SCORE_TOLERANCE` (0.005) in
[integrity.ts](src/services/integrity.ts), so verification passes it. The test in
`tests/scoring.test.ts` asserts the true value (`1`) and documents the discrepancy rather
than encoding the stale number.

**Decide:** fix the example payload in the extension repo, or leave it and keep the note.

---

## 6. Other open items

* **Tokens are still placeholders** — `INGEST_TOKEN` / `ADMIN_TOKEN` are
  `dev-*-change-me`. Startup refuses production without real ones, so this blocks deploy.
* **Rate limiting is in-memory and per-instance.** Fine for one process; behind more than
  one replica it needs an edge limiter or a shared store.
* **No retention/TTL policy.** Events and sessions accumulate indefinitely. A privacy
  service holding evidence about real people probably wants a TTL index on
  `activity_events.received_at` and an archival rule for `sessions`.
* **No pagination cursor** — the review list uses `limit`/`offset`, which drifts under
  concurrent inserts. Fine for a dashboard, wrong for an export job.
* **`getSessionStatistics` aggregates unboundedly.** With a large archive it wants a
  date-range requirement or a materialized rollup.
* `AI_API_NAME` / `AI_API_PROJECT_*` from the original `.env` are carried through but
  unused — the REST endpoint only needs the key.

---

## 7. Fast orientation

```bash
npm test                 # 51 tests, no database needed
npm run ai:smoke         # one live AI request
npm run dev              # needs MongoDB on 27017
```

Read in this order: [src/contract/schemas.ts](src/contract/schemas.ts) (the wire
contract) → [src/services/ingest.service.ts](src/services/ingest.service.ts) (the write
path) → [src/services/scoring.ts](src/services/scoring.ts) +
[integrity.ts](src/services/integrity.ts) (the verification core) →
[src/ai/digest.ts](src/ai/digest.ts) (the privacy boundary).
