# aav-collector

Internal library that implements the extension's evidence-collection engine: DOM field
tracking, form/submission detection, portal adapters, and the MAIN-world network-metadata
hook. The extension's own source (`extension/src/`) only wires this library up and never
re-implements collection logic itself.

This package is not published — it is vendored locally and consumed the same way any
other `node_modules` dependency is.

## Usage

**ISOLATED-world content script** — starts the observer (field tracking, form/submission
detection, messaging with the background service worker):

```ts
import 'aav-collector';
```

Side-effecting import: on load it constructs the `Observer`, calls `observer.start()`,
and wires up `chrome.runtime.onMessage` so the background service worker can pause/end
sessions. Nothing further to call from consuming code.

**MAIN-world network hook** — patches `fetch`/`XMLHttpRequest`/`sendBeacon` to report
request *metadata only* (method, sanitized URL, status, duration, body size — never a
body) via `postMessage` to the ISOLATED-world bridge:

```ts
import 'aav-collector/page-hook';
```

Also side-effecting; safe to import more than once (it no-ops after the first call via an
internal `window.__aav_hooked__` guard).

## Deep imports (internals, mainly for tests)

Everything under `content/` and `adapters/` is resolvable as a subpath import, e.g.:

```ts
import { EventBuffer } from 'aav-collector/content/event-buffer';
import { FieldTracker } from 'aav-collector/content/field-tracker';
import { genericAdapter } from 'aav-collector/adapters/generic-adapter';
import { adapterManager } from 'aav-collector/adapters/adapter-manager';
```

These are implementation details, not a stable public API — reach for them only from
unit tests or when adding a new portal adapter (see below), not from application code.

## Sensitive-data detection (`utils/redaction`)

The library also ships the sensitive-data classifier used everywhere a value is about to
be stored, hashed, or dropped — both inside this library and by the host extension's
background/storage code:

```ts
import {
  classifySensitivity,   // canonical field + name/value hints -> 'storable' | 'hashed_only' | 'never_store'
  isSensitiveName,       // does a field name/label look like a credential?
  looksLikeSecretValue,  // does a raw value look like a token/JWT/card number/etc, regardless of field name?
  sanitizeText,          // free text: length-capped, control chars stripped, inline secrets redacted
  sanitizeUrl,           // strips creds/tokens from authority, redacts sensitive query params, drops the fragment
  urlParts,              // {domain, path, sanitized} for grouping/reporting
  sanitizeStorableValue, // length-capped plain value for fields policy allows to store
  scrubObject,           // recursively redacts secret-shaped keys/values in any object before persist/upload
  redactInlineSecrets,   // the substring-level redaction sanitizeText applies internally
  REDACTED,              // the '[REDACTED]' sentinel these functions emit
} from 'aav-collector/utils/redaction';
```

Detection is two-layered: `isSensitiveName` matches field names/labels against known
credential/PII patterns (password, OTP, 2FA, CVV/card, SSN, national ID, bank
account/IBAN, API keys/tokens, …), and `looksLikeSecretValue` matches the *value itself*
by shape (JWTs, card-number-length digit runs, long base64/opaque tokens, known key
prefixes) so a secret is still caught even under an innocuous field name.
`classifySensitivity` combines both with the deployment's configured
`never_store_fields`/`hashed_fields` lists to pick a storage tier — see `PRIVACY.md`'s
three-tier table in the host repo for what each tier persists.

`scrubObject` is the last line of defense: run it on any payload right before it leaves
the browser, and it strips secret-shaped keys/values at any nesting depth, independent of
whichever upstream classification ran (or didn't).

## Adding a portal adapter

Adapters live in `adapters/portals/*.ts` and implement the `PortalAdapter` interface from
`adapters/types.ts`. Copy `adapters/portals/example-portal.ts`, implement only what the
generic heuristics get wrong, and register the new adapter in
`adapters/adapter-manager.ts`. See the main repo's `DESIGN.md` for the full adapter
contract and the submission-scoring model this library implements.

## What this library does not do

It collects. It does not decide, upload, or persist anything — `EventBuffer` hands
batched events to whatever `chrome.runtime.sendMessage` listener the host extension
registers (see `extension/src/background/service-worker.ts`), and this library has no
knowledge of the backend, storage, or upload retry logic.

## Privacy invariants

Enforced in this library's code and asserted in the host repo's `tests/privacy.test.ts`:
no passwords, raw keystrokes, clipboard contents, request/response bodies, cookies, or
storage are ever read. See the host repo's `PRIVACY.md` for the full data-collection
disclosure.
