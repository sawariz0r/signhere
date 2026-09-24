# CEN-011: Deployment, recovery, and service exit

- ID: CEN-011
- Status: Backlog
- Priority: P0
- Milestone: Production operations
- Owner: Platform engineer and incident lead (unassigned)
- Depends on: CEN-002, CEN-006, CEN-010

## Goal

Operate signhere.se's trust capabilities as an independent service with bounded
failure behaviour, protected signing keys, tested recovery, and an exit plan that
preserves offline verification of artifacts already downloaded by participants.

## Scope and deliverables

- Write a deployment decision record and reproducible deployment templates.
  Prefer compatibility with the repository's Node.js/TypeScript, PostgreSQL, and
  Docker tooling where appropriate; document scaling, region, availability, and
  provider requirements without committing to a provider or purchasing services.
- Define separate production/staging environments, databases, credentials, mail
  domains, trust keys, and endpoint allowlists. Development keys and test receipts
  must be visibly and cryptographically distinct from production trust material.
- Configure dedicated trust delivery (proposed verify.signhere.se), API and admin
  boundaries; signhere.se entry pages may redirect to the trust origin. Establish
  DNS/TLS ownership, certificate renewal, secure headers, minimal CSP, framing
  restrictions, explicit CORS, and protected administrative authentication.
- Keep marketing, advertising, third-party analytics, session replay, and unrelated
  site deployments outside the trust origin. Document approved renderer/worker
  assets and their versioned release process, including rollback limitations.
- Integrate CEN-006's restricted signing service, production secrets management,
  key access audit, rotation, revocation/status publication, and emergency signing
  stop. Give web/API/worker roles only the secrets and network egress they need.
- Run mail, signing, and timestamp work with bounded queues, delivery timeouts,
  controlled retries/backoff, dead-letter handling, and per-instance/recipient
  quotas. Prevent email spray, resend loops, account enumeration, and queue
  starvation; redact provider errors and alert payloads.
- Declare outage behaviour for each capability: existing offline verification
  continues, approval may remain pending, and a required timestamp cannot silently
  become optional. Never issue approval receipts from failed verification state.
- Provide readiness/dependency checks, saturation and queue-age metrics, deletion
  job monitoring, certificate/key expiry alerts, clock-skew detection, and an
  actionable alert policy. Avoid personal identifiers or digests as metric labels.
- Decide measurable service objectives and recovery time/data-loss targets.
  Capacity-test realistic PDF-free API loads, mail throttling, timestamp provider
  failures, concurrent retries, expensive parser work in clients, and attack spikes.
- Encrypt backups, restrict restore access, and test database/queue restore with
  CEN-010 deletion reconciliation. Preserve immutable public key/status releases
  separately; production private-key recovery follows the key service's controls.
- Define safe schema migrations, rolling upgrades, queue draining, deployment
  verification, and rollback. Rollback must not reactivate revoked keys, restore
  consumed challenges, reissue inconsistent receipts, or reopen closed protocols.
- Write incident runbooks for central/client-code compromise, signing-key exposure,
  mailbox-provider breach, database disclosure, suspicious instance activity,
  prolonged TSA/mail outage, failed erasure, and loss of the trust domain.
- In compromise response, halt affected issuance, preserve necessary evidence,
  publish authenticated key-status/incident material, and assess affected time
  ranges. Do not silently declare all historical receipts valid or invalid; the
  verifier must distinguish cryptographic integrity from historical trust status.
- Create a shutdown playbook: stop new requests, finish or expire in-flight work,
  announce retrieval deadlines, support final participant exports, publish final
  public trust material and authenticated offline verifier releases, then erase
  personal service data under policy. Do not promise indefinite hosted recovery.

## Acceptance criteria

- [ ] A clean environment can be provisioned from reviewed templates with no
  embedded production secrets, and a documented operator can deploy and roll back.
- [ ] Trust, API, administration, and marketing boundaries match the threat model;
  staged inspection confirms DNS/TLS, headers, CORS, CSP, and dependency inventory.
- [ ] Queue limits, mail abuse controls, error redaction, and graceful saturation
  preserve tenant isolation and do not cause duplicate or unauthorised receipts.
- [ ] Mail/TSA/signing/database outages have tested pending/failure paths and alerts;
  a retry cannot downgrade an instance's transaction protection policy.
- [ ] Backup restore meets approved recovery objectives and reconciles deletions,
  consumed challenges, delivery state, key status, and idempotency records.
- [ ] Key rotation and emergency-stop exercises preserve existing portable proof
  while blocking new issuance by revoked credentials or compromised keys.
- [ ] A deployment/client-code compromise exercise demonstrates authenticated
  release recovery; a same-origin checksum alone is not accepted as assurance.
- [ ] An on-call owner, escalation process, access review, incident communication
  procedure, and maintenance schedule exist before production approval issuance.
- [ ] A shutdown drill verifies preserved packages with central/self-hosted services
  disconnected and records limitations when historical status evidence is absent.

## Verification evidence

Attach deployment manifests, architecture/egress diagrams, redacted operational
screenshots, load/failure results, restore timings, migration/rollback output,
key-rotation exercise, incident tabletop notes, and the tested shutdown package.
No real participant data or production credentials belong in the evidence bundle.

## Open decisions and exclusions

- Select provider/region, mail and timestamp contracts, availability/recovery
  targets, key-service deployment, and operational ownership before launch.
- Decide independent publication channels for keys, releases, and incident notices
  with CEN-006/CEN-008, including domain loss and service closure.
- Provisioning paid production infrastructure, purchasing domains/certificates,
  and sending announcements are separate implementation/launch actions.
