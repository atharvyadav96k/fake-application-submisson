# What this extension collects

This document describes exactly what the extension records, what it refuses to record,
and where each guarantee is enforced in code. It is written to be readable by the people
being observed, not only by engineers.

## Scope

The extension is inactive unless an operator has explicitly started a session in the
popup. Outside a session it collects nothing, on any site. There is no background
observation of general browsing.

The extension is registered for all sites so that any job portal works without a code
change. **Site registration is not collection**: with no session running, the content
script reads the page, finds no session, and stops. A deployment that wants a hard origin
boundary back can populate `allowed_origins` in the config — when it is non-empty, the
observer refuses to collect anywhere else — and narrow `host_permissions` in the manifest
to match.

## What is collected

**About the session**

* Operator ID and candidate ID as supplied by the operator
* A salted hash of the candidate email — never the address itself
* The portal domain, which adapter matched, and page paths visited
* Timestamps: session start, candidate record opened, first field filled, submit clicked,
  submission detected, confirmation, session end
* An outcome (`confirmed` / `flagged` / `abandoned` / `timed_out` / `unknown`)

**About form fields**

* A canonical name (`first_name`, `current_company`, …), how confidently it was
  identified, and which signals identified it
* Whether the field is required, its state (`empty` / `partial` / `filled`), and its
  instance index within repeated groups
* Interaction **counts and durations**: focus count, time in field, keystroke *count*,
  paste *count*, edit count, clear count, position in the fill order
* How the value appears to have arrived: typed, pasted, autofilled, programmatic, mixed,
  or unknown
* Whether the value matches the candidate record: `match`, `mismatch`, `unverifiable`,
  or `not_available`
* The value itself **only** for low-sensitivity fields (company, job title, city,
  country, public profile URLs); a salted hash for personal fields; nothing at all for
  credentials

**About the page's own content** (`content_capture`, on by default)

Text the *page publishes* — never text the candidate enters. Each item is capped at 160
characters, the whole per-page capture at 1,500, and everything is redacted for contact
details and token-shaped strings before storage:

* The job the application is for: title, company, location, employment type, posting date,
  and requisition ID — read from the page's own schema.org `JobPosting` JSON-LD, falling
  back to Open Graph tags. This is the portal's published description of the role, so it
  needs no scraping and cannot pick up anything that was typed.
* The page headline (`h1`), and its meta description
* Section and step headings, so the record shows which part of the form was reached
* Announcements from `role="status"`, `role="alert"`, and `aria-live` regions — progress
  messages, validation summaries, confirmation banners

Only `textContent` is read. `innerHTML` appears nowhere in the extractor, so markup,
inline scripts, and embedded JSON state cannot leak through. Any element inside an
`input`, `textarea`, `select`, `contenteditable`, or `role="textbox"` subtree is skipped —
the exclusion that keeps a rich-text cover letter out of a heading query.

Set `content_capture.enabled` to `false` to switch the whole feature off.

**About submission**

* Which submit control was activated and when
* Request **metadata** for submission-related requests: method, sanitized URL, status
  code, duration, and body *size* — never the body
* Navigation to confirmation routes, and confirmation text/toasts/modals (a short
  excerpt, with contact details redacted)
* Validation errors that appear after a submit attempt
* A confidence score with the complete evidence list behind it

**About the environment**

* Browser family and version, extension version, timezone, locale, viewport size

## What is never collected

| Never collected | Enforcement |
|---|---|
| Passwords | `readValue()` returns `null` for `type="password"`; the field is classified `never_store` and no value or hash is kept |
| Raw keystrokes | The `keydown` handler increments a counter and never reads `event.key` |
| Clipboard contents | The `paste` handler increments a counter and never touches `clipboardData` |
| Request or response bodies | The network hook records method/URL/status/size only; it has no body access by construction |
| Cookies, `localStorage`, `sessionStorage` | Never read anywhere in the codebase |
| Auth tokens, API keys, session IDs | Redacted from URLs, query strings, path segments, event metadata, and logs |
| OTPs, card numbers, CVV, SSN/national IDs | Classified `never_store` by name pattern and by value shape |
| Activity outside an operator-started session | The observer returns before starting when no active session exists, on every site |
| Screenshots and page HTML | Never captured; only `textContent` is ever read, so no markup is retained |
| Text the *candidate* entered on the page | Content capture skips `input`, `textarea`, `select`, and `contenteditable` subtrees; typed values reach the record only through the field pipeline, under the sensitivity policy |
| Whole-page text dumps | Capture is limited to a fixed set of regions (below) with a 1,500-character per-page budget |

## The three storage tiers

| Tier | Fields | What is stored |
|---|---|---|
| `never_store` | password, OTP, card details, SSN/national ID, anything matching the credential patterns, any `type="password"` control | metadata and match status only — no value, no hash |
| `hashed_only` | email, phone, name, date of birth, address, postal code, salary, nationality, gender, and **any field we could not confidently identify** | `sha256(session_salt \| normalized_value)` and the match result |
| `storable` | company, job title, city, country, years of experience, public profile URLs | the normalized value, capped at 120 characters |

Unidentified fields default to `hashed_only`: when classification is uncertain, the value
is treated as *more* sensitive, not less.

The per-session hashing salt stays in the browser. It is stripped from every payload
before upload, so the backend cannot brute-force the hashes it receives.

## Candidate matching happens locally

The candidate record fetched for comparison is held in `chrome.storage.session`, which
the browser clears when it closes. Comparison runs entirely in the page. The backend
receives the **verdict** (`match` / `mismatch` / `unverifiable` / `not_available`) and,
where policy allows, a salted hash — never the candidate data it already gave us, and
never the raw value that was typed.

If the backend supplies only hashes, comparison still works: the extension hashes the
observed value with the same salt and compares digests.

## Permissions

```jsonc
"permissions": ["storage", "alarms"]
"host_permissions": ["http://*/*", "https://*/*"]
```

Broad host access is requested so the extension works on any portal without a rebuild.
Narrow `host_permissions` to your portals if your deployment prefers a smaller grant.

No `tabs`, no `webRequest`, no `cookies`, no `history`, no `scripting`.

Network observation deliberately avoids `webRequest` — that permission would let the
extension see traffic across sites. Instead a hook in the page's own JavaScript context
reports metadata for that page only.

## Data lifecycle

* Events are buffered in the page, batched into the service worker, and stored in
  `chrome.storage.local` until the backend acknowledges them.
* If the network is unavailable, data waits and is retried; nothing is dropped silently.
  If the local cap (5,000 events) is reached, the oldest events are dropped **and a
  `buffer_truncated` event records exactly how many** — visible loss, never silent loss.
* On session end, the full payload is uploaded and the session's events are purged from
  local storage.
* The candidate record is deleted when the session ends or the browser closes.

## What the data is not

The record describes browser-side observations. It does not establish intent, effort, or
honesty, and the extension never converts it into a judgement about a person.

In particular, **a keystroke-free fill is not evidence of misconduct**. Browser autofill,
password managers, screen readers and other assistive technology, IME composition, and
other installed extensions all legitimately produce that pattern. The extension records
what it saw and attaches that caveat to the event itself.

Likewise `outcome: "flagged"` means *the browser-side evidence is incomplete or
contradictory and a human should look* — nothing more.

## Verifying these claims

The guarantees above are executable:

```bash
npm test -- tests/privacy.test.ts
```

That suite asserts that password values never reach any record, that no event contains
key identities, that every configured sensitive URL parameter is redacted, that
token-shaped values are scrubbed at any depth of a payload, and that hashes survive
scrubbing intact.
