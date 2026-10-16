# Signhere: editor drafts and private client review

Status: implementation in progress following project orientation on 2026-10-16. Draft persistence, private review and the unified client document workspace are implemented locally. Opus supplied the interactive design and handoff; verification is in progress before release.

## Immediate outcome

The owner creates a draft in Signhere's editor, shares a private link with one client, receives comments, replies and revises, then explicitly shares the next version. Signing comes after that conversation.

The owner clarified that the document sent to the client must remain the main view for both commenting and signing, using the editor's visual language. Comments belong alongside that document. A separate review destination and a visibly different signing experience are superseded by this requirement. Opus designed the shared document interface in `design/recipient-document.html`, with the handoff in `design/recipient-document.md`. Existing signing capabilities and frozen-PDF checks must remain intact as the surrounding interface is unified.

The owner confirmed that the first draft will use the Signhere editor and that the live installation is managed through Coolify with dashboard access. A Paseo profile named `Coolify Operations` is available.

The owner will handle account recovery in the Coolify app terminal; commands to list accounts and reset one exact account were supplied in the conversation. No production account was changed by the development work.

## Foundation at takeover

| Area | What exists | Consequence for this goal |
| --- | --- | --- |
| Editor | React/Tiptap block editor, stable block IDs, rich text, pricing, parties, images, themes and browser PDF export | Reuse authoring and attach initial comments to sections |
| Draft storage | `web/editor/model.ts` stores drafts and the address book in browser localStorage | A client cannot retrieve a draft; another browser cannot resume it |
| Sending | `web/editor/editor.tsx` renders a PDF, creates a signing document, then removes the local draft | Add a distinct review action and preserve the editable source |
| Backend | Express, PostgreSQL, cookie sessions and team-scoped management routes | Add team-scoped draft/review persistence to the existing app |
| Private links | Signing/copy capabilities use random tokens, stored as hashes and passed in URL fragments | Reuse the security pattern with separate review permissions |
| Signed documents | Frozen PDF input, audit events, durable finalization and sealed output | Keep mutable drafts and review discussions outside signing records |
| Recovery | Password hashing and login exist; no password reset endpoint, UI or administrator reset command | Restore owner access through a deliberate recovery operation |
| Delivery | Optional SMTP/Resend; manually copied links work without either | Manual sharing is sufficient for the first review |

Key files: `web/main.tsx` (routing), `web/documents.tsx` (document list and PDF upload), `web/editor/` (authoring), `server/app.ts` (API/auth), `server/db.ts` (schema/migrations), `server/security.ts` (password/token helpers), `docs/deployment.md` and `docker-compose.yaml` (operations).

## Proposed first client experience

1. The owner edits a draft. Autosave persists it on the server and reports saved, saving or failed accurately.
2. **Dela för granskning** publishes version 1 and creates a private client link. Publishing does not require the document to be ready for signing.
3. The client opens the link without creating an account. The page clearly says this is a draft and shows the shared version.
4. She comments on a section or on the document as a whole. The owner can reply and resolve/reopen threads. Reviewer identity is a displayed claim associated with the private link, not a verified account.
5. The owner revises privately in the editor. Autosave does not expose unfinished changes to the client.
6. **Dela ny version** publishes version 2. The same client link opens the latest published version; older discussions retain their original version and context.
7. Once the conversation is finished, the owner explicitly chooses **Skicka för signering**. The chosen content becomes a frozen signing PDF using the existing signing flow.

Keep comment threads from prior versions accessible and label them with their version. Never silently move a comment to changed text. A deleted section remains identifiable from the old snapshot. Signing readiness and review completion are different states; resolving comments is not a signature.

## Data and behavior

Use separate entities for the editable draft, published review versions, reviewer links, threads and replies. Published review versions retain an immutable content snapshot. Threads reference that version and an optional block ID. Store the resolved fields, sender details, dates, pricing and any referenced assets needed to reproduce the version; rendering must not substitute today's values later.

Draft writes should include an expected revision so two open tabs cannot silently overwrite each other. Publishing must reference an exact saved revision and return the same result on a retried request. Existing browser drafts need an explicit import into the signed-in team, with local originals retained until the server confirms persistence; localStorage is currently not scoped to a user or team.

The initial reviewer page should show the document as a read-only web view with a comment panel. Reuse the editor's presentation where practical, while exposing only the published content needed by the reviewer. Start with section comments and general comments. Exact text selections, tracked changes and simultaneous editing can follow later.

Create separate review capabilities rather than extending signing tokens. Use the existing hashed-token/fragment pattern, configurable expiry, revocation, request limits and no-referrer/no-store responses. A reviewer link grants access only to that review and its shared history, with no team/account/private signing evidence access. All private-link API operations should enforce the same scope, including content/assets and comment writes. Forwarding a link grants its review access.

When sending for signing, retain the draft and link its exact source revision to the created signing document. Clearly show when current edits differ from the latest shared version. If the owner wants to sign unshared changes, require an explicit content choice. Editing afterward cannot change an existing signing transaction. Keep the current PDF validation and immutable signing boundaries intact.

## Delivery order

### 0. Restore owner access

Identify the exact Coolify resource for `sign.prpl.se` and its deployed revision. The application password is separate from the database passwords and installation token. The installation token cannot reopen setup after an owner exists.

Prepare an administrator recovery command that selects one exact account, hashes a new password with the existing scrypt implementation, and updates that account and invalidates its sessions in one database transaction. Accept the password through a hidden prompt or protected input rather than an argument/log. Execute through the existing app container's runtime database access; do not recreate users, clear volumes or rerun setup. Verify a normal login afterward. No account has been changed during this orientation.

### 1. Persist editor drafts

Add draft schema validation and team-scoped CRUD, server autosave with conflict handling, a draft list, and safe import of existing browser drafts. Preserve editable source after sending.

Done when a draft survives reload and another browser/device, other teams are denied, failed saves remain visible and stale writes cannot silently overwrite changes.

### 2. Publish a private review and discuss it

Add immutable published versions, reviewer links, the public review route and section/general threads with replies and resolution. Put review discussions beside the owner editor. Let the owner copy, revoke and replace the client link.

Done when the owner can share a draft with an unauthenticated client, receive and answer a comment, and deny access after revocation or expiry. Test that a client cannot access another draft or any unshared changes.

### 3. Complete the revision loop and signing handoff

Publish a second version through the same review link, retain earlier context, and bind the selected saved source to signing. Verify the complete workflow in two separate browser sessions, including mobile reading/commenting and publish/send retries.

The first release is complete when the owner and client can finish two review rounds and then sign the intended final content without losing source or discussion history.

Later candidates: email notifications once mail is configured, precise text anchors, change comparisons, PDF-upload review, multiple independent reviewers and review-completion acknowledgements. They are outside the first client milestone.

## Orientation evidence (initial snapshot)

- Repository inspected at `f1141a1`; the working tree was initially clean.
- Live `/` returned HTTP 200. `/api/bootstrap` returned `setupRequired: false`, `user: null` for the unauthenticated request, and `delivery.email: false`.
- The local production build, including both TypeScript checks, passed. Vite reports large-bundle warnings.
- At initial orientation, integration/browser signing tests had not run: this checkout has no configured disposable PostgreSQL database or Python sealing environment. Existing CI defines those checks; its current result was not inspected.
- Coolify resource identity, deployed backend revision, account details, backups and authenticated application behavior have not yet been inspected. The profile is listed in Paseo, but this session has no directly exposed Coolify MCP tools.
- No production settings, credentials, accounts or documents were modified during orientation. Implementation and validation are recorded below.


## Delivered locally

- Server-saved drafts with revision checks, explicit legacy import and retained signing source.
- Immutable published review versions, expiring/revocable private links, section/general comments, replies and resolution.
- Opus's document-first workspace: the same canvas and panel layout for review, the exact signing PDF and the signed receipt. Mobile comments use a sheet and PDF pages can be enlarged.
- Comments beside the sender's editor, with original-version context and private-change markers. The separate owner review modal has been removed.
- Signing handoff state on review links; review-only credentials never gain signing authority. Personal signing links show prior discussion limited to their source revision, and new questions are attached to that signing copy. Signer discussion closes after acceptance.
- Explicit sender choice for unreviewed changes, a notice that signers see earlier discussion, and source ID/revision/hash in the signing creation event.

Validation: the production build and both TypeScript checks pass. The complete server suite passes (92 tests), including tenant/capability denials, version boundaries, comment retries, link expiry/revocation and production-style database permissions. All four browser workflows pass: signing/evidence, attachments, editor sending and the new document workspace. The new journey covers two review rounds, inline sender replies, mobile comments/PDF enlargement, a signing-copy question, the exact PDF's text and a signed receipt that keeps the document visible. Saved desktop/mobile screenshots were inspected; the mobile receipt remains visible below the document. Vite still reports large-bundle warnings.

The application is not deployed by this work. Optional email redelivery, precise text-range/PDF-page anchors, notifications and a document diff remain outside this milestone. The original takeover notes above describe the earlier repository state.
