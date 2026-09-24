# CEN-010: Privacy inventory, retention, and deletion

- ID: CEN-010
- Status: Backlog
- Priority: P0
- Milestone: Foundation
- Owner: Privacy engineer and service owner (unassigned)
- Depends on: CEN-001

## Goal

Make the privacy promise measurable for every central capability. Keep document
content outside the central service, disclose the data independent approval needs,
and define finite, operationally enforced retention before public availability.
Do not invent a universal legal retention period for contracts or approval data.

## Scope and deliverables

- Create a data-flow inventory with one row per field and copy: source, purpose,
  capability, controller/processor responsibility to be determined, recipients,
  access roles, encryption, retention trigger, deletion mechanism, and backup fate.
- Cover recipient email, claimed participant names if accepted, instance and
  transaction identifiers, document/signature digests, consent identifiers/text,
  challenge/token hashes, attempt counters, receipt payloads, signing key IDs,
  timestamps, IP addresses, user agents, mail delivery events, and support data.
- Treat emails and linkable digests/identifiers as potentially identifying data.
  Hashing an email or document is not a claim of anonymisation. Assess correlation
  across requests, tenants, delivery systems, timestamp providers, and repeated
  document versions; avoid a public hash lookup or index.
- Inventory reverse proxy, CDN/WAF, load balancer, DNS/hosting where applicable,
  mail provider, timestamp gateway/TSA, queues/dead letters, analytics/error tools,
  tracing, CI artifacts, support exports, and backups. Include headers, URLs,
  referrers, failed payloads, retry dumps, and provider metadata in the review.
- Specify three separate disclosures: local verification, timestamp-only use,
  and independent email approval. Explain that local verification keeps file
  bytes on the device; page delivery can still reveal connection metadata.
- Explain that approval processes an email address, document commitment, consent
  context, and connection metadata. A signed participant receipt may expose its
  included address when shared; minimisation must not make offline binding false.
- Define consent templates and opaque context fields so arbitrary document titles,
  clauses, filenames, and sender-provided free text do not accidentally become
  central document storage. Reject unexpected fields and disable payload capture.
- Publish a field-specific retention configuration and deletion schedule for
  pending/failed/consumed challenges, rate limits, replay/idempotency state,
  receipt retrieval, delivery errors, operational logs, and administrative audit.
- Choose concrete durations and accountable owners before launch, based on service
  purposes and reviewed obligations. Define expiry anchors, deletion job intervals,
  grace/retry bounds, and behaviour when a purge fails; placeholders block release.
- Distinguish short-lived receipt retrieval from archival storage. Tell users when
  retrieval expires and that the central service cannot restore lost document
  files or replace the hosting organisation's document-retention obligations.
- Design deletion/export and incident-response access for central personal data.
  Separate legitimate erasure from public-key/history preservation, and explain
  that deleting service data cannot recall receipts already downloaded by others.
- Define backup expiry and restore reconciliation. Reapply deletion tombstones or
  an equivalent minimising mechanism before restored data serves traffic; bound
  tombstone retention and avoid retaining plaintext identifiers just for erasure.
- Review legal roles, processing basis, notices, subprocessors, hosting regions,
  contracts, access requests, and whether a privacy impact assessment is needed.
  Record decisions with the accountable service owner; do not assert compliance
  from this engineering design or treat signing consent as a universal legal basis.
- Add log/trace redaction, low-cardinality metrics, access control, support handling,
  retention monitoring, and documentation for disabling unnecessary provider logs.

## Acceptance criteria

- [ ] The inventory covers every live store, queue, log/export, provider, and backup;
  each has an owner, purpose, approved duration, and executable deletion approach.
- [ ] No request sends PDF bytes or private audit files to central APIs/providers;
  synthetic canary strings remain absent from network captures, logs, and errors.
- [ ] Local verification, timestamp-only, and independent approval have accurate,
  separate notices and no marketing analytics or session replay on trust pages.
- [ ] Production retention configuration rejects missing or unbounded durations
  for personal challenge, retrieval, and operational data.
- [ ] Expiry/deletion tests cover active tables, replicas/caches, queues and dead
  letters, attachments if prohibited, log sinks, and provider retention settings.
- [ ] A backup restore drill proves erased/expired personal records do not become
  available again; backup expiry and any unavoidable delay are documented.
- [ ] Receipt retrieval expiry is visible before use and in participant guidance;
  preserved receipts and public verification material remain independently usable.
- [ ] Raw tokens, OTPs, emails, document digests, and request bodies do not leak
  through URLs/referrers, mail-provider events, traces, alerts, or support exports.
- [ ] Data-subject handling and operator access are exercised without exposing
  another tenant or deleting public trust history needed for old artifacts.

## Verification evidence

Attach the approved data-flow matrix, retention configuration, notices, provider
settings review, canary network/log captures, deletion reports, and a restored
backup reconciliation report. Record unresolved legal decisions as release blockers
with an owner rather than using a general compliance badge.

## Open decisions and exclusions

- Decide exact challenge/replay/retrieval windows with CEN-001 and CEN-002, balancing
  security, delivery retries, participant access, and minimisation.
- Decide whether a portable receipt includes a full email address or another
  verifiable representation; document disclosure and dictionary-attack limits.
- Central document archiving, unlimited receipt recovery, a public registry, and
  a guaranteed statutory retention period are excluded from the first service.
