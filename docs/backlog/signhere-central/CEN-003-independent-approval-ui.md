# CEN-003: Independent approval interface on signhere.se

- ID: CEN-003
- Status: In progress
- Priority: P0
- Milestone: Independent approval beta
- Owner: Frontend/security engineering (unassigned)
- Depends on: CEN-001, CEN-002
- Related: CEN-004, CEN-008, CEN-012

## Goal

Let a participant review and explicitly approve the exact prepared PDF in an interface
delivered from a dedicated trust origin under signhere.se, outside the operator's origin.
The central service receives the document commitment and required approval context,
but never the PDF content. Independent review and confirmed email access are distinct checks.

## Scope and deliverables

- Build a top-level HTTPS approval flow on a dedicated trust origin under signhere.se;
  isolate it from marketing/admin scripts and cookies. Public site paths may redirect here.
  Prevent embedding through framing policy and do not accept approval from a host iframe.
- Specify and implement browser-only transfer of the prepared PDF, using either an explicit
  local file choice or a narrowly scoped direct request to the installation.
  The central backend must never fetch, proxy, preview, or cache the PDF.
- Treat transfer URLs, document titles, names and all installation-supplied context as
  untrusted. Do not copy bearer capabilities into queries, telemetry or referrers.
- Fetch a single bounded byte buffer, calculate its digest, and render that same immutable
  buffer using a pinned PDF renderer. Bind the submitted approval to that digest.
- Define an accepted PDF subset and reject unsupported encryption, active content,
  external resources and ambiguous features. Describe residual renderer differences.
- Display document page count and review controls, the exact consent text/version,
  the email address to be confirmed, and any sender-supplied claimed name as unverified.
- Resolve immutable transaction/participant/intent data through the CEN-001 protocol;
  reject inconsistencies between intent, received PDF and the independent challenge.
- Require explicit affirmative consent after the document loads. Email confirmation,
  navigating to a link and fetching a preview must never themselves record approval.
- Bind the UI session to CEN-004's independent email challenge and receipt state;
  show pending, expired, rejected and complete states without implying verified civil identity.
- Provide a direct download of the approved prepared PDF and participant receipt.
  Explain that the completed document may arrive later and is a separate artifact.
- Document data flows, accessibility, supported browsers and browser resource limits.
  Exclude analytics/session replay, third-party document processing and PDF crash payloads.
- Keep document buffers out of browser persistence by default; clear them on session end.
  Explain the limits of controlling memory, browser extensions and downloaded copies.

## Acceptance criteria

- [ ] The displayed document and the committed document digest always use the same captured
  bytes; changing the installation's response after loading cannot switch the approved file.
- [ ] A malicious installation supplies PDF A as a preview and PDF B for approval:
  the independent UI either displays B as the actual approval target or rejects the mismatch.
- [ ] Changes to any frozen participant, transaction, document or consent binding reject the
  session before approval, including a reused challenge from another document.
- [ ] An embedded page, forged cross-origin message, unsafe return URL and spoofed host UI
  cannot submit approval on signhere.se or read its challenge/receipt capabilities.
- [ ] A malicious PDF cannot invoke script, load remote content or send content to another
  origin. Oversized files, excessive pages and parser exhaustion fail with bounded resources.
- [ ] An instrumented browser/proxy trace confirms that PDF bytes never reach signhere.se,
  an email provider, an error collector or a third-party viewer during all flow states.
- [ ] Host unavailability during transfer reports a recoverable failure; after a successful
  capture it cannot change already captured bytes. Reloads require fresh validated state.
- [ ] Consent starts unchecked; cancel/back navigation, email scanners and stale tabs do not
  create approval. Duplicate successful submissions show the same saved receipt.
- [ ] Keyboard and screen-reader users can review the document, consent and result.
  An inaccessible PDF is identified and cannot be described as fully reviewed by the service.
- [ ] Copy consistently says email access was confirmed, with claimed names distinguished
  from independently verified facts. No badge claims that every page was read.
- [ ] A participant can save the exact prepared PDF and independent receipt even while
  self-hosted finalization remains unavailable, under the declared receipt retention policy.

## Verification evidence

- Browser-level adversarial fixtures covering display/digest mismatch, challenge swapping,
  clickjacking, return-origin abuse, concurrent tabs and expiration during review.
- Network and storage traces from supported browsers covering happy path and error paths;
  record which metadata leaves the device and prove no document-body upload.
- Accessibility review and recorded user-flow walkthroughs, including clear origin and
  trust-limit messaging. Feed the UI threat analysis into CEN-012's release review.

## Open decisions

- Choose local-file selection, direct CORS transfer, or both, including secure bootstrap and
  the allowlist/capability rules. Resolve before interface implementation begins.
- Decide PDF subset, viewer sandboxing, maximum size/pages and acceptable browser support.
- Decide session lifetime and whether the review and email confirmation share one browser;
  define cross-device behavior explicitly rather than weakening document binding.

## Exclusions

- BankID, civil-identity proofing, passkey enrollment and proof that content was understood.
- Central document storage, PDF delivery from the central server and final PDF composition.
- A claim that an independent origin protects a compromised device, mailbox or signhere.se.

## Progress (2026-09-25)

Implemented: `/bekrafta` on the service origin (`web/central/main.tsx`): capability and transfer token from the URL fragment, direct browser fetch from the installation (CORS limited to the frozen service origin) with a local-file fallback, one byte buffer hashed and rendered with pdf.js, unverified name/organisation labels, separate email and approval steps, receipt and PDF download. A Playwright flow covers both origins (`tests/browser-independent-approval.mjs`).

Still open: accepted-PDF-subset checks in the browser (active content, encryption), accessibility and supported-browser review, documented renderer residuals.
