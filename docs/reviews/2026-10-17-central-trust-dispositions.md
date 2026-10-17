# Fable and Astra: central trust design dispositions

Date: 2026-10-17. These are implementation-design consultations requested by the user, not security certification or approval of a final implementation. [Fable 5.1](2026-10-17-fable-central-trust.md) and [OpenAI Astra](2026-10-17-astra-central-trust.md) independently read the app and draft PR #12. Both recommended a digest-only detached-receipt service ahead of the older email-approval design.

The [current plan](../central-service-plan.md) and [active tasks](../backlog/signhere-central/README.md) incorporate the assessed recommendations. Historical reviews remain intact and do not imply approval of the new scope.

| Recommendation | Disposition and reason |
| --- | --- |
| Both: enroll automatically after one owner action, with no account/card/manual key for trial | Accepted. Separate connection key, outbound-only service, original central-clock 336-hour trial. Signup is part of purchase. |
| Both: register final PDF hash asynchronously, retain detached signed receipt, preserve completed PDF | Accepted. Transactional outbox, exact hash verification, portable recipient-safe exports; PDF completion and registration status remain separate. |
| Both: historical verification free after expiry; prepaid yearly and lifetime options | Accepted as proposed product defaults. Actual prices, capacity, lifetime/transfer terms and provider remain undecided. No perpetual availability promise. |
| Both: defer independent email approval, full browser CMS validation, central PDF seal and transparency log | Accepted. Earlier broad design and all CEN-001–015 tasks are clearly historical/deferred. Seven new tasks avoid inheriting contradictory dependencies. |
| Astra: global hash deduplication; no public submitting-installation relation | Accepted. One retained receipt per hash; original recorded time returned to every caller. No ownership claim or unnecessary permanent account-to-document index. Temporary submission association is bounded separately. |
| Astra: HTTP Message Signatures, fresh authentication nonce separate from business idempotency | Accepted as protocol default, using maintained implementations and cross-runtime test vectors. |
| Fable: Ed25519 receipts; Astra: ES256 receipts | Ed25519 is the proposed default, subject to custody/browser/offline interoperability proof. ES256 remains the explicit alternative before CEN-016 freezes one algorithm. Receipt inputs cannot negotiate it. |
| Fable: also register manifest digest, PDF certificate fingerprint and enrollment ID | Declined for MVP. Final-file hash already binds every byte; these fields add correlation and lifecycle complexity without letting a blind service validate the manifest, seal or issuer. |
| Fable: reject another enrollment submitting a known hash | Declined. Possession/registration does not confer ownership; public lookup already permits retrieving that receipt. Return the globally deduplicated receipt. |
| Fable: hash chain / reserved chain field and daily chain-head TSA | Deferred. A database chain alone does not prevent central rewriting/backdating. Independent anchors, monitoring and preservation would need a separate tested protocol. No unused extension fields. |
| Fable: original receipt detects an operator replacing/resealing a document | Qualified. Retained copies/receipts permit comparing exact artifacts; no logical-document identity or unique legitimate version is established. Arbitrary registrations and approved-A/completed-B must retain honest labels. |
| Fable: never sees IPs; hashes imply no personal data; POST means proxies never log hashes | Corrected. Transport metadata is observable, hashes may be linkable, and any proxy/error collector can capture bodies unless configured and checked. Inventory all layers and validate canaries, including failure paths. |
| Fable: lookups free forever / receipts never deleted | Qualified. No payment gate and offline proofs have no subscription expiry. Online retention is a published operational/deletion/shutdown policy, not infinite hosting. |
| Both: key recovery separate from PDF seal rotation | Accepted. Paid-account recovery disables old credentials; original trial dates survive ordinary rotation/restore. Provider license keys/manual claims are not required in the normal connection flow. |
| Trial starts on first successful response | Tightened. Durable central enrollment starts the clock even if the response is lost; idempotent retries recover the original dates. Durable central admission before expiry can finish later; local enqueue time cannot bypass payment. |
| Both: bounded anonymous trial abuse is unavoidable | Accepted. Publish costed quotas, short-lived abuse controls and limits; no hidden fingerprinting or mandatory card/email. Advisors' different trial caps are suggestions, not decided limits. |
| Fable: specific merchant providers and SEK price suggestions | Not adopted. Provider, tax/payment obligations and actual sustainable prices require a separate owner decision before sale. This PR buys or deploys nothing. |

## Current implementation anchors

- [Finalization transaction and publication hook](../../server/finalization.ts) already persist exact completed bytes/hash atomically. Enqueue under that hook rather than relying on an after-commit notification.
- [Browser hash lookup](../../web/settings.tsx) and [instance verification endpoint](../../server/app.ts) establish the current local-only behavior; central receipt verification needs a separate result.
- [Private evidence core](../../server/evidence.ts) includes document and participant details and must never be sent centrally.
- [Verification package](../../server/verification-package.ts) is private today; a recipient-safe receipt export must not expose its full audit contents.
- [Key lifecycle](../../server/key-store.ts) and [delivery worker](../../server/delivery.ts) provide patterns, not a reason to reuse PDF keys or mail tables for unrelated credentials/work.

## Validation scope

The planning change is documentation only. Future acceptance tests are recorded in CEN-016–022. The parent checks links, task metadata/dependency graph, whitespace and the final diff against main; no runtime test, paid action, deployment or production change is claimed.
