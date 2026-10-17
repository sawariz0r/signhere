# Editor draft format (API v1)

Contents: source envelope; native blocks; party data; reusable fields; pricing and signing; safe editing. For Tiptap content, read [rich-text.md](rich-text.md). A complete synthetic fixture is in [service-agreement.json](../examples/service-agreement.json); its example sender and prices are test data, never facts to copy into a real agreement.

`signhere_create_draft` and `signhere_update_draft` accept a complete `draft` object. On update start from the returned source and preserve fields you are not changing. JSON is validated strictly; invented properties are rejected.

## Source envelope

Minimal valid source (replace the example ID and timestamps when creating a draft):

```json
{
  "id": "proposal_example",
  "version": 2,
  "title": "Service proposal",
  "createdAt": "2026-10-16T12:00:00.000Z",
  "updatedAt": "2026-10-16T12:00:00.000Z",
  "blocks": [
    { "id": "scope", "type": "text", "title": "Scope", "content": {
      "type": "doc", "content": [
        { "type": "paragraph", "content": [ { "type": "text", "text": "Describe the agreed work." } ] }
      ]
    } }
  ],
  "company": null,
  "theme": { "font": "grotesk", "accent": "#0e1116" },
  "settings": { "currency": "SEK", "pricesIncludeVat": false, "expiresInDays": 30, "remind": false, "allowDecline": true, "senderSigns": false },
  "fields": {},
  "customFields": []
}
```

Draft IDs are 8–64 letters, numbers, `_` or `-`; generate a fresh UUID for new drafts. Section IDs are stable, unique nonempty strings up to 80 characters. `version: 2` is the source schema version, independent of the server's editable `revision` and immutable saved version number. Keep original `createdAt`; set `updatedAt` to the edit time. There are at most 150 sections. Read-only saved snapshots can contain `frozenAt`; do not add it to editable source.

Supported currencies: `SEK`, `EUR`, `NOK`, `DKK`. Fonts: `grotesk`, `serif`. Accents: `#0e1116`, `oklch(0.56 0.13 155)`, `oklch(0.55 0.15 250)`, `oklch(0.58 0.17 20)`.

## Native blocks

Use blocks to express the document's structure instead of importing everything into one text section. All properties in the examples are required. Use distinct IDs; omit blocks that the agreement does not need. Prefer one titled `text` block per main clause and one `terms` block for general conditions: review comments and change markers attach to block IDs. Use level-3 rich-text headings for subheadings within a titled block; its section title already supplies the main heading. The editor's add-block tray offers only one each of `header`, `parties` and `terms`, although the API schema does not enforce that count.

| Type / editor label | Use for | Properties beyond `id`, `type` |
| --- | --- | --- |
| `header` / Omslag | Cover, document title and optional metadata | `layout`, `eyebrow`, `title`, `showMeta`, `background`, `align` |
| `parties` / Parter | Sender and customer identity from document data | None; do not embed party text in this block |
| `pricing` / Priser | Calculated rows, VAT and packages with known numeric prices | `title`, `mode`, `packages`, `showDiscount`, `vatPerRow` |
| `text` / Text | Scope, alternatives, explanations, field-based costs | `title`, `content` (Tiptap `doc`) |
| `terms` / Villkor | Contractual conditions in short paragraphs | Same shape as `text`; separate semantic section |
| `image` / Bild | Supplied illustration, diagram or logo with caption | `src`, `caption`, `width`, `ratio` |
| `break` / Sidbrytning | Explicit page break for print/PDF | None |

Valid blocks, ready to place in `blocks`:

```json
[
  { "id": "cover", "type": "header", "layout": "boxed", "eyebrow": "Avtal", "title": "Serviceavtal – {{customer.company}}", "showMeta": true, "background": "lines", "align": "left" },
  { "id": "parties", "type": "parties" },
  { "id": "scope", "type": "text", "title": "Uppdrag", "content": { "type": "doc", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Beskriv uppdraget här." } ] } ] } },
  { "id": "fixed-price", "type": "pricing", "title": "Avtalad uppstart", "mode": "single", "packages": [
    { "id": "startup", "name": "Uppstart", "description": "Ett avtalat startmöte", "priceForm": "fixed", "cap": 0, "selected": true, "items": [
      { "id": "meeting", "name": "Startmöte", "quantity": 1, "unit": "st", "price": 2400, "vat": 25, "discount": 0 }
    ] }
  ], "showDiscount": false, "vatPerRow": true },
  { "id": "illustration", "type": "image", "src": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4e0AAAAASUVORK5CYII=", "caption": "Exempelbild (1 pixel); ersätt med en tillhandahållen bild.", "width": "narrow", "ratio": "auto" },
  { "id": "new-page", "type": "break" },
  { "id": "conditions", "type": "terms", "title": "Villkor", "content": { "type": "doc", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Betalning sker mot faktura, 30 dagar netto." } ] } ] } }
]
```

`header.layout`: `plain`, `boxed`, `split-left`, `cover`. `align`: `left` or `center`. `background`: `ink`, `lines`, `forest`, `sky`, `paper`, or an embedded image. Header `eyebrow` / `title` and text/terms block `title` support `{{field.key}}` tokens. Treat pricing titles, package/item names and image captions as literal text: pricing-title tokens are resolved by PDF export but shown literally in the editor, so avoid them there. The header's **Till** metadata reads `company.name` directly, not a `fields` fallback. Its dates are computed from the current date (or the saved snapshot's `frozenAt`) and `expiresInDays`.

Images (also rich-text images and header backgrounds) must use embedded PNG, JPEG or WebP base64 data URLs, at most 3,000,000 characters. No remote image URLs or SVG data URLs. `image.src` can be empty for a draft placeholder, but the editor flags it before signing. `width`: `narrow`, `wide`, `full`. `ratio`: `""`, `"auto"` or an aspect ratio such as `"16 / 9"`. The editor uses `ratio` for display cropping; use `auto` or the file’s actual aspect ratio when the editor and PDF should show the same composition. Use actual supplied images; the one-pixel example only demonstrates the schema. PNG/JPEG is the supported path for signing-PDF images; the current exporter skips WebP. See [Signing PDF fidelity](rich-text.md#signing-pdf-fidelity) for image, header, table, link and pricing limitations.

## Party data: `company`, contacts and `fields`

Prefer the native **Parter** block. It renders **Från** from `fields["sender.company"]`, `fields["sender.name"]`, `fields["sender.email"]`. The API does not automatically populate these from the authenticated account. For new drafts, use verified `signhere_workspace.user.name` for `sender.name` and `signhere_workspace.workspace.name` for `sender.company`, unless the user specifies different display values. Workspace identity does not include email: use supplied/existing `sender.email`, or leave it blank and report the missing value. Preserve existing values on unrelated edits. Parter is not included in referenced-empty-field validation, so an empty sender can otherwise pass that check.

**Till** reads `company` directly: company name, optional `orgNr`, address/zip/city and every contact whose `signs` is `true` (name, optional role, email). It does not render customer values from `fields`. With `company: null`, it shows **Fylls i från mottagarlistan**. A contact with `signs: false` stays in the source but is not shown in Parter or selected to sign. Multiple signing contacts appear there; inline `customer.name` / `customer.email` resolve only the first selected contact in array order.

`company` is either `null` or exactly `{id, name, orgNr, address, zip, city, contacts}`. Each contact is exactly `{id, name, email, role, signs}`; all strings are required even if empty, and `signs` is boolean. Example shape, using synthetic data only:

```json
{
  "id": "example-company", "name": "Exempelkund AB", "orgNr": "",
  "address": "", "zip": "", "city": "",
  "contacts": [
    { "id": "example-signer", "name": "Exempelperson", "email": "person@example.test", "role": "Kontaktperson", "signs": true },
    { "id": "example-contact", "name": "Annan kontakt", "email": "other@example.test", "role": "Ekonomi", "signs": false }
  ]
}
```

Use only supplied or existing customer information. If the customer is unknown, keep `company: null` and insert blank inline customer fields where prose needs them. `fields` can hold known customer values for prose before a recipient company is chosen; this does not populate Parter, create a customer in the address book, or establish a signing recipient. Do not invent a company/contact just to fill the layout. Empty fields intentionally remain placeholders for later completion. Field chips themselves are not text inputs: complete customer details in recipient controls, and update custom/sender values through the draft’s `fields` map. The editor flags referenced empty fields and missing recipients before sending; a private draft can still be created and saved.

Review links require a saved company and a selected real contact; create them in the Signhere interface. Saving revokes a review link if `company.id` changes, or its linked contact is removed or changes ID, name or email—even a name typo correction can affect access. Treat these as client-access changes. If that effect is not authorized, retain the private edit and explain before saving; do not infer authorization from an unrelated prose edit.

## Reusable fields

Inline Tiptap field node (place inside a paragraph, heading or list paragraph):

```json
{ "type": "field", "attrs": { "key": "custom.hourlyRate" } }
```

Use the same key at every occurrence of the same value. Update its entry in `fields` once rather than replacing occurrences with literal text. In rich-text content use field nodes; literal `{{custom.hourlyRate}}` inside a text node is not a field. Title strings use the token syntax described above.

These are all built-in keys; no registration is needed:

| Key | Meaning / resolution |
| --- | --- |
| `customer.name` | First contact with `signs: true`: `name` |
| `customer.email` | First contact with `signs: true`: `email` |
| `customer.company` | `company.name` |
| `customer.orgNumber` | `company.orgNr` (different spelling) |
| `customer.address` | `company.address` |
| `customer.zip` | `company.zip` |
| `customer.city` | `company.city` |
| `sender.name` | `fields["sender.name"]` |
| `sender.email` | `fields["sender.email"]` |
| `sender.company` | `fields["sender.company"]` |
| `document.title` | Top-level `title` |
| `document.sentAt` | Current date in an editable draft; snapshot date when frozen. Despite its name, not proof of dispatch or signature |
| `document.expiresAt` | That date plus `settings.expiresInDays`: displayed document validity, not a signature date or the server’s signing-link lifetime |

Customer keys resolve the company/first signing contact value, then `fields[key]`, then empty string. Fallback is selected before trimming: a whitespace-only company value resolves empty rather than falling back. Sender and custom values resolve `fields[key]` trimmed, then empty. Computed document keys ignore `fields` overrides; dates render in Swedish locale. In the editor, populated fields appear as chips and empty fields show their label; preview renders values or the label when empty. Unknown keys use their key as the label unless registered. Legacy keys such as `sender.orgNumber` and `customer.phone` may exist and have display labels, but are not in the built-in picker or automatically derived; preserve them and their values.

Register custom fields in `customFields` and assign values in `fields`:

```json
{
  "customFields": [
    { "key": "custom.hourlyRate", "label": "Timpris (anges senare)", "group": "custom" },
    { "key": "custom.travelCost", "label": "Resekostnad (anges senare)", "group": "custom" }
  ],
  "fields": { "custom.hourlyRate": "", "custom.travelCost": "" }
}
```

Merge these entries into existing maps/arrays. Use unique keys with a `custom.` prefix and ASCII letters, digits, `_`, `-`, `.` so both title tokens and inline nodes work. Do not register a duplicate built-in key. `group` can be `customer`, `sender`, `document` or `custom`; it controls picker grouping, not data binding or computation. Registration makes a field discoverable and gives it a label; it does not itself set a value. Set or change noncomputed values through the draft’s `fields` map; the current editor has a field insertion picker, not a general custom-field value form. Customer details can be completed in its recipient controls. There are at most 200 custom definitions and 200 values; values are strings, up to 10,000 characters each.

## Pricing and signing

Use `pricing` for known numeric amounts needing totals, VAT, discounts or package selection. `mode` is `single` (only first package is charged), `choice` (one alternative selected), or `multi` (several packages can be selected); choice/multi totals use `selected` packages. Set `selected` consistently: the API does not enforce exactly one selection for `choice`. These flags store the sender’s selection. The current signing flow offers no interactive package choice: the sender’s selected packages determine the signed totals. For priced A/B alternatives, establish the agreed selection with the user before sending, or keep the alternatives in prose and explicitly report that the decision is open. Package `priceForm` is `fixed`, `estimate`, `hourly` or `hourly-cap`; `cap` is a numeric ceiling displayed for `hourly-cap`, not a replacement for item prices. These forms describe the price: they do not calculate missing hours or rates for you. The current signing-PDF exporter omits price-form and cap labels, so state any hourly, estimate or cap obligation explicitly in ordinary text/terms as well. Quantities and prices are numeric and nonnegative, not strings, nulls or field nodes. There is no field binding in pricing rows.

A package has exactly `{id, name, description, priceForm, cap, selected, items}`. An item has exactly `{id, name, quantity, unit, price, vat, discount}`. Up to 20 packages and 200 items per package. Quantity ≤ 1e9, price/cap ≤ 1e12; VAT/discount are percentages 0–100; the editor’s VAT picker offers 25, 12, 6 and 0. `unit` is a string (e.g. `tim`, `st`). `showDiscount` controls discount display, not whether a nonzero discount affects totals. `vatPerRow: false` uses 25% VAT regardless of row VAT; `true` uses each item's `vat`. `settings.pricesIncludeVat` determines whether entered prices already include VAT. Preserve supplied commercial terms; example numbers are illustrative.

If the hourly rate is unspecified, use a `text` block with a registered, blank `custom.hourlyRate` node and an explicit label/unit, e.g. **Timpris:** [field] SEK exkl. moms. Keep related cost fields in bullets. Do not insert zero, a guessed rate, an empty pricing row or a package of empty items as a stand-in: numeric pricing can display misleading totals. Add a numeric pricing block once real figures are supplied. If there is a separate agreed fixed charge, that can use native pricing while the unknown hourly rate remains in prose. Repeated rate references remain the same field; pricing rows must be deliberately updated if later added.

Signhere generates signatures through its signing flow. Do not add manual **Underskrifter** sections, underlines, signature image placeholders or custom signature-date fields by default. `company.contacts[].signs` chooses customer signers; `settings.senderSigns` includes the authenticated user who sends from the interface; changing `fields["sender.name"]` or `fields["sender.email"]` changes displayed party information, not that signing identity. `allowDecline` and `remind` are stored editor settings; the current send payload does not carry these flags, so do not promise actual decline or automatic reminder behavior from them. None of these signs or dispatches a draft. Sending and signing happen in Signhere's interface, outside the draft tools; saving creates a version only.

## Preserve source on edits

Read the latest source, locate stable block IDs, and change only the requested nodes or values. Keep unrelated blocks, marks, field nodes, attributes, custom-field definitions, company/contact data and settings. Do not flatten rich text into strings or rebuild an unfamiliar block. Read back after updating and compare the requested change and preservation of the rest. When saving, verify the returned revision/version and visibility. Saved review snapshots freeze dates and intentionally omit unused fields and nonsigning contacts; editable source retains those values.

Writes require a UUID `requestId` (reuse exact arguments/ID on interrupted retries). Updates and saves use the latest `expectedRevision`; reconcile conflicts against fresh source, never merely substitute a revision. Required scopes: `drafts:read`, `drafts:write`, `discussion:read`, `discussion:write` for their respective operations. Saving to active client links also requires `reviews:share`, `allowSharedUpdate: true` and the user's sharing authorization. See the main skill for authentication, retry and sharing safeguards; do not bypass a forbidden operation with another credential.
