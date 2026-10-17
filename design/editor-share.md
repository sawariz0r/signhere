# Editor: save a version, choose a client, share a private link

Prototype: `design/editor-share.html`. Open it directly in a browser. The dashed bar switches between four scenarios (`#shared`, `#synced`, `#first`, `#switched`) and can simulate a comment arriving in the background.
Screenshots: `.test-artifacts/editor-share/01–22`. They were taken with Playwright Chromium at 1440×960 and 390×844, with no console or page errors.

**Design skill used:** `/home/prpl/projects/shukudai-monorepo/claude-design/DESIGN_SKILL.md`. No frontend-design skill was available in this session, and Signhere has no design skill or `AGENTS.md` of its own. I applied only the file's repo-independent rules:
- reuse existing components, and don't invent tokens;
- one primary action per view;
- sentence-case copy where button labels are verbs;
- no decorative motion;
- every interactive element has focus, hover and disabled states.

The visual language is Signhere's own: `web/editor/editor.css` and `web/document/document.css` (copied into the prototype). New rules are prefixed `sh-`.

## The model, in plain words

| Thing | What the sender sees | Who can see it |
| --- | --- | --- |
| **Utkast** (autosaved draft) | Chip: `● Ändringar sparade för dig` / `Utkast sparat för dig` | Only the sender's team |
| **Version N** (from **Spara utkast**) | Chip: `✓ Version N sparad` | Private until a client link exists. Active links for the *same client* see it as soon as it is saved |
| **Klientlänk** (private link to one named contact) | Row under Granskning: `Anna Lindqvist · Bageri Lindqvist AB · ser version 3 · till 15 nov` | Whoever holds the link: read and comment on the version it was created at **and later saved versions**. Never earlier versions, never signing |

Copy rules:
- Avoid *publicera*, *revision*, *token*, *dela version*.
- The only verbs are **Spara utkast**, **Dela med klient**, **Ny länk**, **Återkalla** and **Skicka** (signing, unchanged).
- Use the contact's first name in sentences ("Anna ser version 3"), never a pronoun.

## 1. Topbar

`[logo] / [title] [status chip] … [Förhandsgranska] [Spara utkast] [Skicka n]`

- **Status chip** (replaces `ed-save`). It is a button with a tooltip; tapping it shows a toast: "Bara du ser utkastet. Klienter med länk ser den senast sparade versionen."
  - `Sparar…`: pulse, during autosave.
  - `● Ändringar sparade för dig` (amber dot): autosaved, newer than the last version. With no version yet: `Utkast sparat för dig`.
  - `✓ Version 3 sparad`: the draft equals the last version.
  - `Kunde inte spara` (red): the existing `rd-save-error` banner and retry stay.
  - On mobile: the dot plus `Sparat`, or the check plus `v3`.
- **Spara utkast** is a secondary `ed-btn large`.
  - When there is something to save it shows a small amber dot, and its `aria-label` is "Spara utkast. Spara utkastet som version 4".
  - With no changes it is disabled, with the tooltip "Inga ändringar sedan version 3".
  - It is the **only** save or share-version control. Remove "Dela för granskning", "Dela version X", "Dela ny version", "Dela första versionen" and "Uppdatera kommentarer".
  - ⌘/Ctrl+S keeps doing a private autosave flush. It does not create a version.
- `Skicka` (primary) is unchanged.

## 2. Pressing Spara utkast

| Situation | What happens |
| --- | --- |
| No active link | Save immediately: persist the draft, then create version N. Toast: **"Version N sparad. Bara du ser den."** with a `Dela med klient` action. No dialog. |
| Active link(s) for the current client | Small dialog **"Spara version N?"**: "Versionen kan inte ändras i efterhand. Du fortsätter redigera i ditt utkast som vanligt." Rows: `Ändrat sedan version N-1: 2. Pris` and `Anna Lindqvist ser version N nästa gång länken öppnas.` Buttons `Avbryt` / **`Spara version N`** (primary, initial focus). Toast: "Version N sparad. Anna ser den nu." |
| Active link(s) for a *previous* client (Mottagare changed) | The same dialog with a warning row: **"Anna Lindqvists länk slutar fungera.** Bageri Lindqvist AB är inte längre mottagare. Fjällbagarna AB får ingen länk förrän du delar." Primary button **`Spara och återkalla länken`** (red). The save and the revocation happen in one server transaction. |

"Ändrat sedan" lists sections by label: compare blocks by id, plus `company` as "Parter". The editor's existing `review.changed` set already computes this.

## 3. Granskning card (first card after Status in `SidePanel`; replaces the share part of `EditorReviewPanel`)

- **Header:** `Granskning`; on the right, `Version 3 · 16 okt 15:38` or `Ingen version än`.
- **One line**, chosen by state:
  - No link: "[Version 3 är sparad.] Bara du ser utkastet och dess versioner. Dela med en klient för att få kommentarer."
  - Link + private changes: `●` "Ändringar i 2. Pris syns för Anna när du sparar utkastet."
  - Link, in sync: green `●` "Anna ser version 3."
  - Client changed (amber `sh-line warn`): "Mottagaren är nu **Fjällbagarna AB**. Annas länk slutar fungera när du sparar utkastet."
- **Klientlänkar:** one row per active link: `[AL] Anna Lindqvist` and `Bageri Lindqvist AB · ser version 3 · till 13 nov`, with text buttons `Ny länk` and `Återkalla`.
  - A stale-client link gets a red sub line: "Slutar fungera när du sparar".
  - **Återkalla** expands an inline confirmation: "Anna kan inte längre öppna utkastet. Kommentarerna finns kvar." `Avbryt` (focused) / `Återkalla` (red). Toast: "Annas länk är återkallad."
  - **Ny länk** revokes the old link, creates a new one from the current saved version with the same contact and default expiry, and opens the dialog straight at step 4 ("Ny länk till Anna Lindqvist är klar … Den gamla länken fungerar inte längre.").
- **Share button:** `Dela med klient…` (full-width secondary with link icon) when there are no links; `+ Dela med fler` (text button) when links exist.
- `<details>Äldre länkar (n)</details>` holds revoked and expired links.
- The **Kommentarer** card follows. `Discussion` drops `onRefresh` and the button.

## 4. "Dela med klient" dialog

Native `<dialog>` with `showModal()`, 500px wide. On mobile (<860px) it is a bottom sheet (92dvh, sticky footer, full-width buttons). It has a close ✕ in the header. Esc closes, **except** in step 4 before the link is copied (see below). Focus returns to the opener on close.

**Step 1 – Klient** (only when `draft.company` is empty, or after `Byt`):
- Title "Dela med klient"; sub line "Välj vilket företag som ska granska. Det blir också mottagare i dokumentet."
- Search field (autofocus), address-book hits and `+ Nytt företag "query"`. Extract this from `RecipientsCard` as **`CompanyPicker`**; the Mottagare card uses the same component.
- `+ Nytt företag` uses the same fields as today's "Nytt företag" form: Företagsnamn; Org.nr *valfritt*; **Kontaktperson som får länken**: Namn, E-post, Roll *valfritt*. Validation copy is reused ("Ange företagets namn.", "Ange kontaktpersonens namn.", "Ange en giltig e-postadress.").
- Choosing or creating a company sets `draft.company` through `toRecipient`, saves it to the address book, and autosaves privately.

**Step 2 – Vem, hur länge, vilken version** (the start step when Mottagare is set):
- Sub line: "Klienten kan läsa och kommentera. Inte signera."
- **KLIENT:** compact company row with `Byt`.
- **VEM FÅR LÄNKEN?** Radio list (fieldset + legend) of the company's contacts: avatar, name, `role · email`.
  - The default is the first contact without an active link.
  - A contact with an active link gets the tag `Har en länk`; choosing them shows "Annas nuvarande länk slutar fungera när du skapar en ny."
  - `+ Ny kontaktperson` opens the inline form (name, e-post, roll) reused from `RecipientsCard`'s contact form. The new contact is added to `draft.company` and the address book and selected.
- **GILTIG I:** `ed-seg` with 7 / 30 / 90 dagar (default 30), and the line "Till 15 november 2026. Du kan återkalla länken när som helst."
- **KLIENTEN SER** (`sh-sees`, eye icon, informational, no choice):
  - No version yet: "Utkastet sparas som **version 1** när du skapar länken."
  - Private changes: "Dina ändringar sparas som **version 4**. Länken visar version 4 och de versioner du sparar senare, inte tidigare versioner."
  - In sync: "**Version 3** och de versioner du sparar senare. Tidigare versioner visas inte."
- **Footer:** `Avbryt` / primary **`Skapa privat länk`**, or **`Spara version N och skapa länk`** when saving first. It is disabled until a contact is selected.

**Step 3 – Create** (one request, or two idempotent ones):
1. persist the draft;
2. publish version N if needed, revoking stale-client links in the same transaction;
3. revoke any existing active link for the same contact;
4. create the link with `fromVersion = N`, `contactId`, contact name, email and company, and `days`.

**Step 4 – Link created, shown once** (the same dialog's content is replaced; focus moves to `Kopiera länk`):
- ✓ (green circle) **"Länken till Anna Lindqvist är klar"**, then "Kopiera den nu. Den visas bara den här gången."
- A read-only mono URL field (selects all on focus) and primary **`Kopiera länk`**.
  - The button becomes `✓ Kopierad`, and the hidden live region announces "Länken är kopierad".
  - If clipboard access fails, it selects the field and says "Markera länken och kopiera den."
- Secondary `Skicka i e-post…`: a `mailto:` to the contact's address with subject "Utkast att granska: <titel>" and a short body. Nothing is sent by the server.
- Facts list:
  - "Visar version 3 och de versioner du sparar senare."
  - "Kan läsa och kommentera. Kan inte signera."
  - "Gäller till 15 november 2026. Du kan återkalla den under Granskning."
  - "Alla som har länken kan öppna den. Skicka den bara till Anna."
- Footer: `Klar`.
  - If the link was never copied, `Klar`, Esc and ✕ all replace the footer with "**Du har inte kopierat länken. Den går inte att visa igen.**" plus `Stäng ändå` / `Kopiera länk` (focused).
  - After closing, the raw link is discarded from state.

## 5. Changing the client

In the Mottagare card, `Byt mottagare` with an active link for the current company shows an inline note first:

> "Anna har en aktiv länk. Den slutar fungera när du sparar utkastet med en ny mottagare. Den nya mottagaren får en egen länk när du delar."

Buttons: `Avbryt` / `Välj ny mottagare`.

Choosing a new company is a private edit; nothing is revoked yet. The Granskning card turns to the warning state. The next **Spara utkast** (or "Spara version N och skapa länk" for the new client) asks for confirmation and revokes the old client's links atomically. The old client never sees a version naming the new client.

## 6. Comments refresh (root is implementing)

- No visible refresh control.
- Poll every 20–30 s while `document.visibilityState === 'visible'`, and immediately on `visibilitychange`/`focus`. Back off on errors.
- Merge new threads without re-mounting open composers.
- New comments from others raise a toast, "Ny kommentar från Anna Lindqvist", with a `Visa` action that filters to the section (on mobile it opens the sheet). Counts and markers update quietly.
- After repeated failures, the card shows the muted line "Kunde inte hämta nya kommentarer. Försöker igen…".

## 7. Mobile (<860px)

- Topbar: `[logo] [title…] [chip] [Skicka]`.
- Bottom bar: `[💬 Granskning n]` and primary **`Spara utkast`**. On mobile it is the only primary in view; `Skicka` stays in the topbar.
- `Granskning` opens the sheet "Granskning och kommentarer" with the Granskning, Kommentarer and Mottagare cards.
- The share and save dialogs become bottom sheets with full-width footer buttons and a sticky footer.

## 8. Accessibility checklist

- All dialogs are native modal `<dialog>`: focus is trapped, the initial focus is set as described in sections 2 and 4, and focus returns to the opener.
- The radio group has a `legend`. The expiry choice uses `role=radiogroup` with `aria-checked`.
- The disabled Spara utkast button explains itself in its title and `aria-label`.
- Status chip and toasts are `role=status`. The copy result goes to an `aria-live` region. Revocation confirmations are inline groups that receive focus.
- No meaning by colour alone: every dot sits next to text.
- Touch targets in the bar and dialog footers are at least 44px.
- Reduced motion disables the sheet slide and dialog rise.

## 9. Implementation map

| Change | Where |
| --- | --- |
| `SaveStatus` chip, `Spara utkast` button, remove `Dela …` from topbar | `web/editor/editor.tsx` topbar |
| `SaveVersionDialog` (section 2) | new, `web/editor/share.tsx` |
| `ReviewCard` (section 3) replaces the share part of `EditorReviewPanel`; `useEditorReview.publish` becomes `saveVersion({ revokeStale })` | `web/editor/review-panel.tsx` |
| `ShareDialog` (section 4) | new, `web/editor/share.tsx` |
| Extract `CompanyPicker`, `CompanyForm`, `ContactForm` from `RecipientsCard`; add the switch-client note | `web/editor/sidebar.tsx` |
| Drop `onRefresh` and the button; background merge | `web/document/discussion.tsx` |
| `sh-*` styles (about 90 lines in the prototype) | `web/document/document.css` or `editor.css` |

Backend assumptions (root):
- Links store `contactId`, a snapshot of the contact name, email and company id/name, `fromVersion`, `expiresAt` and `revokedAt`.
- The review session only returns versions with `version >= fromVersion`.
- Publishing a version whose `company.id` differs from an active link's company revokes that link in the same transaction.
- Link creation accepts `{ contactId, days }` and, optionally, a draft revision to publish first. It is idempotent per request id.
- The raw URL is returned only in the create response.

## 10. Edge cases

- **Save fails:** the dialog stays open and shows `ErrorBox` (for example a conflict from another tab); the chip shows `Kunde inte spara`.
- **Empty document or no title:** Spara utkast still works for a private version. The share dialog shows the server's "Lägg till en titel och minst ett avsnitt." inline.
- **Expired link:** it moves to Äldre länkar. A contact whose link expired has no "Har en länk" tag, so sharing with them again is the normal path.
- **Historical version view:** keep the editor's existing "Du visar delad version N" mode. Spara utkast and Dela are disabled while viewing it.
- **Sending for signing:** unchanged. SendSheet keeps its "unshared changes" confirmation, worded as "ändringar som inte är sparade som version".
