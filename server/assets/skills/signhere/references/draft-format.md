# Editor draft format (API v1)

`signhere_create_draft` and `signhere_update_draft` accept a complete `draft` object. On update start from the returned source and preserve fields you are not changing. JSON is validated strictly; invented properties are rejected.

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

Draft IDs are 8–64 letters, numbers, `_` or `-`. Generate a fresh UUID for new drafts; section IDs are stable, unique nonempty strings up to 80 characters. `version: 2` is the source schema version, independent of the server's editable `revision` and immutable saved version number. Keep original `createdAt`; set `updatedAt` to the edit time. A document has at most 150 sections.

For ordinary prose, `text` and `terms` sections both have exactly `id`, `type`, `title`, `content`. Content is Tiptap JSON rooted at `doc`, containing paragraphs, headings, lists or tables. Paragraph text is a `text` node; marks such as `bold` or `italic` are arrays of `{ "type": "bold" }`. Do not insert Markdown formatting into text nodes expecting it to render. Text links use a `link` mark with `attrs.href` beginning `https:`, `http:`, `mailto:` or `tel:`. Images must be embedded PNG, JPEG or WebP data URLs; never add a remote image URL.

An optional client company has exactly `id`, `name`, `orgNr`, `address`, `zip`, `city`, `contacts`. Each contact has `id`, `name`, `email`, `role`, `signs` (boolean). Use client details supplied by the user or existing source, never invent contact information. Review links require a saved company and a selected real contact; create them in the Signhere interface. Removing or replacing the client/contact and saving can revoke existing client links.

Supported currencies: `SEK`, `EUR`, `NOK`, `DKK`. Fonts: `grotesk`, `serif`. Accents: `#0e1116`, `oklch(0.56 0.13 155)`, `oklch(0.55 0.15 250)`, `oklch(0.58 0.17 20)`. Preserve complex pricing/header/image blocks returned by the server unless changing them is part of the request; do not simplify a document by dropping unfamiliar blocks.

Required permissions: `drafts:read` for reading, `drafts:write` for edits/private saves, `discussion:read` for review history, `discussion:write` for comments. `reviews:share` is additionally required when a saved version reaches active client links. A forbidden operation needs a deliberately reconfigured key; do not bypass the scope or use another credential without authorization.
