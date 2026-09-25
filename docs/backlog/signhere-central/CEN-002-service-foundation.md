# CEN-002: Central service foundation and isolation

- ID: CEN-002
- Status: In progress
- Priority: P0
- Milestone: Foundation
- Owner: Backend/platform engineer (unassigned)
- Depends on: CEN-001

## Goal

Provide the central runtime, API boundaries, and short-lived state needed for
independent approval, receipt delivery, and optional timestamp forwarding.
An instance account authorises service use; registration does not establish
legal identity, domain ownership, or the truth of that instance's audit events.

## Scope and deliverables

- Record an architecture decision for a separate Node.js/TypeScript service and
  PostgreSQL state, reusing repository tooling where suitable. Do not couple its
  availability or administrative credentials to a self-hosted installation.
- Define a dedicated trust origin/deployment for verification and approval, with
  separate service API and administration boundaries. Marketing scripts and
  administrative sessions must not share the approval/verifier trust boundary.
  Document cookies, CORS, CSP, framing, and cross-origin communication rules.
- Specify a versioned API contract and error vocabulary from CEN-001. Maintain
  machine-readable schemas with strict field lengths, digest algorithm allowlists,
  byte limits, content types, response validation, and explicit version rejection.
- Implement instance provisioning, scoped credentials, rotation, suspension, and
  revocation. Use opaque instance identifiers, least-privilege scopes, hashed
  bearer secrets where appropriate, and a separate administrative access path.
- Derive tenant scope from authenticated credentials. Scope every transaction,
  challenge, idempotency record, and machine retrieval to that tenant. Treat
  instance-supplied transaction/participant identifiers as untrusted identifiers.
- Model challenge creation, expiry, confirmation, consumption, receipt signing,
  and delivery as explicit states. Enforce legal transitions atomically; no
  endpoint may mark mailbox access confirmed on an instance's assertion alone.
- Store independently generated nonces, short-lived challenge state, attempt
  counters, replay prevention, receipt delivery state, and minimal audit records.
  Apply CEN-010's field inventory and deletion policy during implementation.
- Define receipt retrieval separately for the participant and authenticated
  instance. Bind capabilities to a single receipt and audience; store token hashes,
  expire them, prevent enumeration, and exclude secrets from URLs and logs where
  the browser flow permits. Document unavoidable link-token handling explicitly.
- Make idempotency keys tenant- and operation-scoped with a request fingerprint.
  Identical retries return the same outcome; changed payloads under the same key
  fail. Concurrent consumption must produce at most one accepted approval.
- Use a transactional outbox or equivalent durable queue handoff so crashes
  between approval, signing, and delivery do not fabricate or lose state changes.
  Receipt content must remain stable through signing/delivery retries.
- Isolate signing behind CEN-006's key service interface; persist key identifiers
  and public verification material, never production signing keys in application
  tables, images, source control, or ordinary environment dumps.
- Provide per-instance and per-recipient quotas, bounded queues, timeout budgets,
  and circuit breakers. Throttle anonymous endpoints and mail attempts without
  creating an email-existence oracle. CEN-011 owns operational tuning/runbooks.
- Reject document/PDF uploads and arbitrary attachments at central APIs. Do not
  fetch caller-provided document URLs from the server. Approval document transfer
  belongs to the independent browser flow in CEN-003, including its own limits.
- Provide health/readiness checks, migration procedures, local development data,
  contract fixtures, and typed interfaces for CEN-004 and CEN-007 integrations.

## Acceptance criteria

- [ ] An API/schema document identifies callers, authentication, authorisation,
  data fields, idempotency semantics, state transitions, and relevant retention.
- [ ] Two tenant fixtures cannot read, mutate, replay, or retrieve each other's
  records even when valid identifiers, idempotency keys, or receipt IDs are known.
- [ ] Expired, consumed, revoked, malformed, and cross-audience capabilities fail
  without exposing participant details or providing a recovery bypass.
- [ ] Parallel approval submissions and retries across process restarts create
  one accepted event and one stable receipt payload, with recoverable delivery.
- [ ] Registration and API responses distinguish service-account status from
  domain/organisation recognition and from participant identity assurance.
- [ ] Instance suspension blocks new use under a documented policy without
  rewriting issued receipts or making preserved public keys disappear.
- [ ] API, proxy, queue, and error paths enforce request limits and reject document
  content; no server-side PDF retrieval endpoint exists in this release.
- [ ] Deployment defaults enforce origin isolation and do not accept wildcard
  credentialed CORS or rely on third-party cookies for the approval boundary.
- [ ] Secrets, email addresses, raw capabilities, and document digests are absent
  from default logs, traces, metrics labels, and unhandled-error payloads.

## Verification evidence

Attach the architecture decision, API schemas, state-transition model, migration
review, cross-tenant negative-test output, concurrent retry/crash results, and
redacted representative logs. Include the tests that prove a dishonest instance
cannot set independently verified fields or consume a participant challenge.

## Open decisions and exclusions

- Choose final hostnames, service-account onboarding, credential mechanism, and
  whether database row-level security supplements application tenant checks.
- Resolve idempotency/replay retention and post-deletion duplicate handling with
  CEN-001 and CEN-010 before coding; a literally stateless witness is not promised.
- Billing, public document search, general file storage, organisation verification,
  and participant civil-identity verification are outside this foundation.

## Progress (2026-09-25)

Implemented: separate Node/PostgreSQL service (`server/central/`), own schema and entry point, scoped hashed API keys with rotation/suspension via the admin CLI, tenant-derived scoping, idempotent approval creation with request fingerprints, explicit states with an immutability trigger, capability hashes, rate limits and an open-approval quota, no document upload or URL fetching, strict CSP/frame-ancestors, redacted logs, health endpoint and retention cleanup. Tests cover cross-tenant access, idempotency, concurrency and expiry.

Still open: separate administration boundary beyond the CLI, restricted runtime database role/RLS, a durable outbox for code emails (sent in-request today; failure returns 503 and the participant can retry), and crash-injection tests.
