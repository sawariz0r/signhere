# Recipient document: implementation handoff

Prototype: `design/recipient-document.html`. Open it directly in a browser. The dashed bar at the top switches between client and sender views, stage and variant. Deep links: `#client/review`, `#owner/review`, `#client/handoff`, `#client/handoff/noemail`, `#client/sign`, `#client/sign/changed`, `#client/signed/waiting`, `#client/signed/all`.
Screenshots: `.test-artifacts/recipient-design/01–22`. They were taken with Playwright Chromium at 1440×1000 and 390×844, with no console or page errors.

## Decision

**One document workspace for the whole life of the agreement.** The client never moves to a separate "review page" or "signing page". The same view holds the topbar, the document canvas, a side panel (or a sheet on mobile) and a bottom action bar. Review, handoff, signing and the signed receipt only change:

1. the **stage pill** in the topbar,
2. one **callout** above the document (handoff, changed after review, signed),
3. **what the canvas renders**: the HTML draft during review, the exact PDF during signing,
4. the **panel cards** and the **bottom bar action**.

The document stays the largest thing on screen in every state.

**Capabilities.** Review links and signing links stay separate and keep their own URLs. Both open the same workspace. A review link can never sign. After the sender sends for signing, the review link shows a handoff callout in that same view. The client never sees words like token or capability. The personal signing link opens the workspace with the earlier discussion attached. This builds on what the backend already has: `POST /api/sign/discussion` and `POST /api/sign/comments`, scoped to the exact source revision, with later draft revisions excluded.

**Exact PDF: recommended option is a PDF stage inside the same view.** During signing and after, the canvas shows `PdfPreview` canvases of `/api/sign/pdf`, and only after the existing SHA-256 check. The pages sit in the same 800px column, with the same paper shadow and the same panel. A small `PDF | Webbvisning` switch keeps the HTML rendering of the source revision available to help follow the comments. It is always labelled *"Webbvisningen … hjälper dig följa diskussionen. Det är PDF:en du signerar."* "Signera" never appears next to the HTML: pressing it in web view switches back to the PDF first.

I rejected rendering the exact document as HTML. `web/editor/pdf-export.ts` lays out text with pdf-lib, Noto Sans Regular and faux bold, with its own page breaks. The HTML can't be proven equal to the PDF, and it would invite exactly the "I signed what I saw" ambiguity we must avoid. A server-side HTML→PDF pipeline would bring the two closer, but they still wouldn't be byte-identical. That is not worth it for v1.

## Design guidance used

- **No `AGENTS.md` and no `claude-design/DESIGN_SKILL.md` exist in this repository.** A generic `DESIGN_SKILL.md` exists in `../shukudai-monorepo/claude-design/`. I applied only its repo-independent rules: use the existing tokens, reuse components, no gradients or emoji, one accent, sentence-case Swedish copy. I used none of its Shukudai tokens or components.
- Visual language comes from `web/editor/editor.css` (`.ed` tokens, `ed-topbar`, `ed-paper`, `ed-block`, `ed-toolbar`, `ed-card`, `ed-btn`, `ed-dialog`, `ed-toast`, `ed-seg`) and `web/styles.css` (`sign-footer`, `signature-modal`, `.steps`, `brand-lockup`, `verify-band.valid`). The prototype copies these rules verbatim. All new CSS is prefixed `rd-` (about 120 lines in the prototype).
- One accent: ink, or the team accent through `--accent` on recipient pages, as `sign-screen` does today. Amber means "waiting/open" and green means "signed/resolved", as in the existing status dots.

## Layout

| Region | Desktop (≥860px) | Mobile (<860px) |
| --- | --- | --- |
| Topbar | `ed-topbar`. Client: team brand lockup / title / stage pill / avatar. Sender: the editor's topbar unchanged, plus a stage pill. | Brand mark, truncated title, short pill ("Utkast", "Att signera", "Signerat"). |
| Status | `ed-card` at the top of the panel: title with dot, one sentence, 3-step indicator (Granskning, Signering, Signerat). | `rd-mstatus`: one-line strip above the document. |
| Callout | `rd-callout` above the document for handoff, changed after review and signed. Never replaces the document. | Same, full width. |
| Stage bar | Above the paper: what is shown (mono label), version select during review, `PDF \| Webbvisning` during signing. | Same, wraps. |
| Canvas | `ed-paper` with `ed-block` sections (review), or the PDF stage. | Same paper, tighter padding. Price table collapses to name + amount. PDF pages are tappable and open a full-screen pinch/pan viewer. |
| Panel | `ed-panel`, 340px, sticky: status, PDF/receipt card (signing), discussion. | Hidden. The discussion opens in a bottom sheet (`<dialog>`). |
| Bottom bar | Signing and signed only (= today's `sign-footer`): name, "PDF, 3 sidor · fingeravtryck kontrollerat", **Signera** or **Ladda ner**. | Always present: **Kommentarer/Diskussion [n]** + one primary action (Kommentera / Signera / Ladda ner). |

## Comments on the document

- Each section is an `ed-block` with `data-block={block.id}`.
  - When a section has threads, an `rd-marker` pill sits on its top edge, in the same position as the editor's block toolbar. It shows the thread count, filled ink if any are open, outlined if all are resolved.
  - Empty sections show a "+ Kommentera" ghost on hover and focus only. On touch devices it is hidden.
- **Selecting a section** (click or tap) gives it the editor's selection ring and shows the editor's `ed-toolbar` pill, so the editor is instantly recognisable. The pill holds `TYPE · 💬n · + Kommentera`.
- **Marker or toolbar → discussion.** On desktop, the panel filters to that section: a chip "3. Pris ×", a "1 av 3" count, and a composer whose placeholder names the section. On mobile, the sheet opens with the same content.
  - Rule: a marker on a section with threads opens them for reading. "Kommentera", or a section with no threads, focuses the composer (on mobile this brings up the keyboard).
- **Thread → document.** The thread's anchor ("3. Pris", plus "· sida 2" in PDF mode) scrolls to the block and flashes the ring once (`rdFlash`, disabled under reduced motion). In PDF mode it outlines the section region on the page; see the gap about anchor maps below.
- Threads show author avatar, name and time. Body uses `pre-wrap`. "Öppen" or "Löst ✓" is written as text, not shown by colour alone. Replies are inline, opened by "Svara".
- **Older versions.** Threads from earlier versions sit under a collapsed "Tidigare versioner (n)". Their anchor carries "· v1", and clicking it switches the canvas to that version. Viewing an older version shows a note: "Du tittar på version 1. Kommentarer görs på den senaste versionen. Visa version 2". The composer is hidden there. Never re-anchor an old thread to new text.
- **Sender view (editor).** Same markers on `BlockFrame`, so comments sit beside the text being edited. Sections that differ from the latest shared version get a mono tag: "• ÄNDRAT SEDAN VERSION 2". `SidePanel` gains, at the top:
  - **Delad för granskning:** version and date, which sections have private changes, "Dela version N", the client link row (Kopiera länk / Återkalla / Ny länk).
  - **Kommentarer:** the same Discussion component plus "Markera som löst / Öppna igen".
  - The modal `OwnerReview` dialog is deleted.

## States and transitions

| # | Link / viewer | Canvas | Panel / sheet | Bar (mobile; desktop for sign stages) | Exits |
| --- | --- | --- | --- | --- | --- |
| R1 | Review link, latest version | HTML paper, version N | Status "Utkast för granskning" (step 1); discussion with composer | Kommentarer [n] · Kommentera | Sender shares N+1 → R1 with the new version (old threads move to "Tidigare versioner"). Sender sends → R2 |
| R1o | Review link, older version | HTML paper, version k, note above | Discussion read-only for k | Kommentarer | "Visa version N" → R1 |
| R2 | Review link after signing was created | HTML paper of the last version, read-only | Status "Klar för signering" (step 2); discussion closed note | Kommentarer | Client opens their signing link → S1. If signing is cancelled → R1 |
| S1 | Signing link, pending | **PDF stage** after hash check | Status "Redo att signera" + Signera; card "Det här signerar du" (pages, source version, hash, parties); discussion up to the source revision + "Fråga Johan innan du signerar…" | Signera (disabled until `hash && pdf && pdfReady && !pdfError`) | Signera → existing `SignatureModal` → S2 |
| S1w | Same, web view | HTML of the source revision, labelled | Same | "Visa PDF och signera" (switches to S1) | → S1 |
| S1c | Signing source ≠ latest shared version | PDF stage + callout "Ändrat efter version 3" naming sections + "Visa på sida n" | Card says "Version 3 med ändring" | Signera | → S2 |
| S2 | Signed by this party, others pending | Same PDF + this party's signature in the signatures sheet | Green status; Kvitto card (signature, time, document id, hash, events); discussion read-only "ingår inte i det signerade dokumentet" | Ladda ner PDF:en du signerade | Others sign → S3 (keep the `finalizing` poll) |
| S3 | Completed | Same | "Alla parter har signerat" | Ladda ner signerad PDF | — |
| X | Cancelled / expired / invalid | Keep the shell. Callout explains, no actions. Existing error copy. | — | — | — |

Sender view: E1 is the editor with comments and private-change tags. "Dela version N" leads to E1 again. "Skicka" opens the SendSheet and then E2: the editor with the callout "Version 3 signeras nu. Ändringar här påverkar inte signeringen" and the "Kopiera Annas signeringslänk" action, using the existing `created.tsx` links.

## Capability handoff (R2)

- The review page needs to know a signing exists: `signing: { state, sentAt }`. **Gap:** `/api/review/session` doesn't return this yet. Return no tokens and no recipient emails, only state.
- Copy when mail is configured (prototype default): *"Avtalet är klart för signering. Johan har skickat version 3 för signering. Du signerar via din personliga signeringslänk. Den öppnar samma dokument, med diskussionen kvar."* Then a button **Skicka länken till min e-post** with the line *"Den går till a•••@bagerilindqvist.se, adressen Johan angav för signeringen."*
  - **Gap (optional):** `POST /api/review/signing-link {token}`. It resolves the review link to a signing recipient that the sender mapped at send time. It **re-delivers the existing personal link by email to the address on the signing recipient**. It returns only a masked address and is rate-limited. The review page never receives a signing token.
  - Without a mapping or without mail, show: *"Johan delar länken med dig direkt…"* (`#client/handoff/noemail`).
- SendSheet adds a "Granskning" row: *"Annas granskningslänk – visar att avtalet väntar på signering. Den kan inte signera."* It also adds the note *"Signerarna ser granskningens diskussion bredvid PDF:en och kan ställa frågor där."* This matches the current backend, which exposes the prior discussion to signers of a draft-sourced document. If a per-send opt-out is wanted, it needs a server flag.
- Recommendation: while a signing for the draft is pending, reject new review-link comments and show the closed note. Questions then go through `/api/sign/comments`, which ties them to the exact signing copy. Reopen if the signing is cancelled.

## Exact PDF details

- **PDF stage.** It is the existing `PdfPreview source={pdf}` in `Sign`, unchanged in data flow (fetch, SHA-256 compare against `originalHash`, `onReady`). Wrap it as `PdfStage`:
  - Stage bar label "PDF för signering · n sidor", or "PDF du signerade" after signing.
  - Green-dot note: *"Exakt den PDF du signerar[, skapad från version N]. Fingeravtrycket är kontrollerat i din webbläsare."* Show the "kontrollerat" claim only after the digest matched.
  - The signatures sheet stays HTML under the pages, as `sign-signatures` is today. Its label is *"Läggs till som sista sida när alla har signerat"*, which is truthful because sealing appends that page.
  - Fingerprint goes in `<details>`. The signing modal adds the line *"Du signerar <titel>, PDF med n sidor, fingeravtryck 3f9a61c0e2b4…"* above the name field. The consent text stays `session.consent.text`.
- **Mobile.** A full-width A4 canvas is about 6px text on a 390px phone. Pages say "1 · tryck för att förstora". Tapping opens a full-screen `<dialog>` with the page at about 820px wide, pannable and pinch-zoomable. In the product, re-render that page at a higher scale. Don't lock the viewport zoom.
- **"Changed after review" (S1c).** `signingDiscussion` already returns `revision` and the `versions` with `sourceRevision ≤ revision`. If `revision !== versions[0].sourceRevision`, show the callout.
  - **Gap:** naming the sections ("3. Pris") and the highlight on the page need `changedSections: {id,label}[]`. Compute it server-side by comparing block JSON by id between the latest published snapshot and the source revision, and return titles only.
  - Without that field, show the generic callout: *"PDF:en innehåller ändringar efter version 3 som du inte har granskat."*
- **Web view and anchor labels.** Both need the source revision's content. **Gap:** `signingDiscussion` returns threads but no content. Return a pruned snapshot of the source revision, with the same pruning as `/publish` (used fields, signing contacts only).
  - The minimum is `sections: {id,label}[]` for anchor labels. Without content, hide the web-view switch.
- **Page anchors (later).** To jump to "sida 2" and outline the region, `draftPdf()` should emit `{blockId, page, top, bottom}` while laying out. Store it with `draft_signings` as navigation-only metadata, never trusted for evidence. Until then, thread anchors in PDF mode show the section name only, and clicking switches to web view and scrolls there.
- **Uploaded-PDF documents.** No draft source means `signingDiscussion` returns `null`. The workspace renders exactly as signing does today: PDF stage, status card, PDF card. It has no discussion card, and the mobile bar shows only Signera.

## Components

Reuse as-is: `PdfPreview` (`web/pdf.tsx`); `SignatureModal`, `DrawSignature`, `Dossier`, the finalizing poll, download actions (`web/sign.tsx`); `BlockView`, `BlockFrame`, `EditorContext` and `ReadOnlyDraft` (from the interim `web/review.tsx`); `SendSheet` (extended); `SidePanel` cards; `Signature`, `BrandLockup`, `ErrorBox`, `Loading`, `CopyLink` (`web/ui.tsx`); `accentStyle`.

New, all small:

- `web/document/shell.tsx` – `DocumentShell({ topbar, status, callout, stagebar, canvas, panel, bar, sheet })`. Owns the `ed-main` and `ed-panel` layout, the bottom bar, and the mobile sheet `<dialog>` (`showModal`, Esc, backdrop click closes, focus returns to the opener).
- `StagePill`, `Steps` (based on the `.steps` pattern), `StatusCard`, `Callout` (`neutral | warn | done`).
- `ReadOnlyDraft` → move to `web/editor/read-only.tsx`. Add `SectionMarker` and `SectionToolbar` (the `.ed-toolbar` markup), and `selected`/`onSelect`/`onComment` props.
- `Discussion({ threads, versions, viewedVersion, filter, canPost, canReply, canResolve, mode: 'review'|'signing'|'closed', anchor(id) → {label, page?}, post, resolve })`. Rewrite from the interim one: no `<select>` for the target (the target comes from the selected section; "Hela dokumentet" is the default), and keep the idempotent `requestId` retry from the interim `Composer`.
- `PdfStage` (PdfPreview + note + signatures sheet + fingerprint) and `PageZoom` (mobile).
- `ReviewCard` (sender) inside `SidePanel`.

Wire-up:

- `Review` (review link): `DocumentShell` + `ReadOnlyDraft` + `Discussion` (R1/R1o/R2).
- `Sign` (signing link): keeps its data logic but renders `DocumentShell` + `PdfStage` / web view + `Discussion` (mode `signing`, posting to `/api/sign/comments` with `blockId` from the selected section, or null).
  - `Dossier` becomes a panel card when the document has bilagor.
  - The full-page `sign-done` screen is replaced by S2/S3 inside the shell.
  - `embedded` bilaga navigation keeps working through the same shell.
- `DocumentEditor`: drop `OwnerReview`, add `ReviewCard` + `Discussion` to `SidePanel`, markers and change tags in `BlockFrame`. "Dela för granskning" in the topbar becomes "Dela version N" (disabled without changes); the first share creates the link inline in `ReviewCard`.
- Delete `web/review.css` and the `.review-*` / `.review-dialog` rules once `rd-*` lands, either in `editor.css` or in a `document.css` imported by the shell.

## Accessibility

- Landmarks:
  - `main` holds the document, labelled with its title and version.
  - `aside` holds "Granskning och kommentarer" or "Signering och diskussion".
  - The status card is `aria-live="polite"`. Toasts are `role=status`.
  - Posting a comment announces "Kommentaren är skickad".
- Keyboard:
  - Every marker is a `<button>` whose label says the section, thread count and open count ("3. Pris: 1 kommentarstråd, 1 öppna").
  - The ghost "Kommentera" becomes visible on `:focus-visible`.
  - In the product, don't make whole blocks tab stops (the prototype does, for convenience). The marker button is enough.
  - Esc clears the selection. Ctrl/⌘+Enter sends a comment.
- Dialogs: the sheet, page zoom, signing and send are native `showModal()` dialogs. They trap focus, Esc closes them unless busy, and focus returns to the opener.
- State isn't conveyed by colour alone: pill text, "Öppen" / "Löst" as text, "Ändrat sedan version 2" as text.
- Touch:
  - Bar buttons are at least 44px tall.
  - Markers are 26px visually. Extend their hit area to 44px with a transparent `::after`.
  - The sheet has a 36px grab handle but closes with the ✕ button or the backdrop. Don't rely on swipe.
- PDF canvases keep `aria-label="Dokument, sida n"`. The web view is an accessible text alternative, clearly labelled as such. Long term, use the pdf.js text layer.
- `prefers-reduced-motion` disables the sheet slide, flash and toast animations, matching existing rules.

## Copy register (Swedish, sentence case, neutral)

Stage pills: Utkast för granskning · Klar för signering · Väntar på din signatur · Du har signerat · Signerat av alla. Sender: Version 2 delad · Skickat för signering.

Key lines:
- Kommentera ett avsnitt eller hela dokumentet. Inget signeras här.
- Du kommenterar som Anna Lindqvist.
- Frågor ändrar inte PDF:en.
- Diskussionen ingår inte i det signerade dokumentet.
- Exakt den PDF du signerar.
- Ändrat efter version 3.

## Out of scope / open

- Text-range anchors, tracked changes and diff view.
- Notifications.
- Multiple independent reviewers per draft. The UI shows the reviewer's name; it is not a verified identity.
- Whether the sender should also see signing-copy questions in the editor's discussion. Recommended: yes, read-only, tagged "under signering".
