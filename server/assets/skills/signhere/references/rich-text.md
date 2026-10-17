# Supported editor rich text

`text.content` and `terms.content` are Tiptap JSON objects rooted at `doc`. They are not HTML, Markdown strings or arrays of strings. Native blocks and field resolution are documented in [draft-format.md](draft-format.md). These examples are schema-validated; the [agreement fixture](../examples/service-agreement.json) is also exercised through MCP and the actual editor.

## Paragraphs, headings, emphasis, lists, links and fields

This complete `content` value demonstrates supported structures, including A/B alternatives in separate paragraphs with bold labels, parallel cost bullets and a numbered sequence:

```json
{
  "type": "doc",
  "content": [
    { "type": "heading", "attrs": { "level": 3, "textAlign": "left" }, "content": [ { "type": "text", "text": "Arbetssätt" } ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "Uppdraget utförs för " },
      { "type": "field", "attrs": { "key": "customer.company" } },
      { "type": "text", "text": ". " },
      { "type": "text", "text": "Omfattningen bekräftas före start.", "marks": [ { "type": "italic" } ] }
    ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "Alternativ A: ", "marks": [ { "type": "bold" } ] },
      { "type": "text", "text": "Löpande stöd efter godkänd beställning." }
    ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "Alternativ B: ", "marks": [ { "type": "bold" } ] },
      { "type": "text", "text": "En separat avgränsad leverans enligt skriftlig överenskommelse." }
    ] },
    { "type": "bulletList", "content": [
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [
        { "type": "text", "text": "Timpris: ", "marks": [ { "type": "bold" } ] },
        { "type": "field", "attrs": { "key": "custom.hourlyRate" } },
        { "type": "text", "text": " SEK exkl. moms." }
      ] } ] },
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [
        { "type": "text", "text": "Resekostnad: ", "marks": [ { "type": "bold" } ] },
        { "type": "field", "attrs": { "key": "custom.travelCost" } }
      ] } ] }
    ] },
    { "type": "orderedList", "attrs": { "start": 1 }, "content": [
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Bekräfta omfattning och pris." } ] } ] },
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Planera uppstart." } ] } ] }
    ] },
    { "type": "paragraph", "content": [
      { "type": "text", "text": "Projektbeskrivning: https://example.com/project", "marks": [ { "type": "link", "attrs": { "href": "https://example.com/project" } } ] },
      { "type": "text", "text": " före beställning." }
    ] }
  ]
}
```

A heading uses `attrs.level` 1, 2 or 3. Within a titled text/terms block prefer level 3 for subheadings; the block title already renders as the main heading. A paragraph or heading can mix `text` and inline `field` nodes. Marks belong on text nodes, e.g. `marks: [{"type":"bold"}, {"type":"italic"}]` for both. Use a new paragraph for each alternative or contractual point. An empty paragraph can be `{ "type": "paragraph" }`; do not emit an empty `text` node. Lists contain `listItem` nodes whose content starts with a paragraph. Numbered lists use `orderedList` and optional integer `attrs.start`.

Links use a `link` mark; `attrs.href` must start with `https:`, `http:`, `mailto:` or `tel:`. Prefer full HTTPS URLs for web links. Do not put Markdown syntax (`**bold**`, `- item`, `[label](url)`) into text and expect formatting. A line break within a paragraph is `{ "type": "hardBreak" }`; distinct contractual points should be paragraphs instead.

## Alignment and tables

Alignment is supported on **paragraphs and headings only**, with `attrs.textAlign` of `left`, `center`, `right` or `justify` (the toolbar offers the first three). It is not a mark or a property of the whole `doc`. A native header separately supports only `left` or `center`. Tables are Tiptap nodes inside a text/terms block, not a native `table` block. Cells contain paragraphs; use `tableHeader` for header cells and `tableCell` for body cells. A valid example:

```json
{
  "type": "doc",
  "content": [
    { "type": "paragraph", "attrs": { "textAlign": "center" }, "content": [ { "type": "text", "text": "Planerad uppstart", "marks": [ { "type": "bold" } ] } ] },
    { "type": "table", "content": [
      { "type": "tableRow", "content": [
        { "type": "tableHeader", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Steg" } ] } ] },
        { "type": "tableHeader", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Ansvarig" } ] } ] }
      ] },
      { "type": "tableRow", "content": [
        { "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Uppstart" } ] } ] },
        { "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [ { "type": "paragraph", "content": [ { "type": "field", "attrs": { "key": "sender.name" } } ] } ] }
      ] }
    ] },
    { "type": "paragraph" }
  ]
}
```

Prefer simple rectangular tables for genuinely tabular information, bullets for parallel costs and native pricing for calculated charges. `colwidth` may be null or an array of numeric widths; the editor disables drag resizing. Preserve existing spans/widths on unrelated edits. The editor supports these table/alignment structures; PDF export simplifies rich-text tables and does not reproduce all rich-text layout/marks. See the signing-PDF limitations below when exact table layout or alignment matters.

## Signing PDF fidelity

The signing flow exports a static PDF rather than a browser screenshot. Paragraph/heading alignment (`left`, `center`, `right`), headings, lists, inline field values, bold, italic, underline and strike are rendered. `justify` renders as left-aligned. Text color and highlight marks are not reproduced. Links are underlined text without clickable annotations or an automatically printed destination; include the URL in visible text when the destination must be part of the agreement.

The PDF simplifies rich-text tables to equal-width columns; it does not reproduce merged cells, custom column widths or cell paragraph alignment. Keep cell content to simple paragraphs: lists lose their markers, and cell images are omitted. It embeds PNG/JPEG images, but currently skips WebP images, and does not reproduce native image cropping/aspect-ratio settings; `wide` and `full` images export at the same width. Non-plain headers become solid panels: patterns/background artwork and the `split-left` image column are not reproduced. Use PNG/JPEG for images that must reach the signing PDF. Native pricing exports numeric rows and totals but omits `priceForm` / `cap` labels: put hourly, estimated-price and maximum-price obligations explicitly in accompanying text/terms. The PDF always labels its sum “Totalt”, even for hourly/estimated packages, and rounds displayed prices/totals to whole currency units. Choice/multi PDFs list all packages, including unselected ones, and mark selected packages “· valt”; they do not create a choice for the signer. Do not rely on visual color, a package flag or a hidden URL to carry contractual meaning. The editor’s **Förhandsgranska** is an HTML preview, not a PDF preview, and the draft MCP tools do not export PDFs. Explain relevant limitations to the user before they send; do not initiate sending just to obtain a PDF preview.

## Other supported formats and limits

The editor also supports `blockquote` containing paragraphs, `horizontalRule`, block-level `image` nodes with embedded PNG/JPEG/WebP data URLs, and `strike`, `underline`, `textStyle` (color), `highlight` (color) marks. Preserve these when present. Use the dedicated native image block when an illustration needs width, aspect ratio or a caption. Rich-text image nodes belong directly in a `doc` (or another valid block container), not inside a paragraph; use `attrs.src` for the data URL and optional `attrs.alt` / `attrs.title`. Code/codeBlock nodes and arbitrary HTML/CSS are not supported. Prefer body/heading structure and selective bold/italic to decorative formatting.

The API validates allowed node/mark names, links, images and size limits, but does not prove every ProseMirror parent-child relationship. Follow the tested shapes above instead of relying on API acceptance alone. Rich text is limited to depth 30, 10,000 nodes and 1,000 children per node; text strings are limited to 100,000 characters. Preserve existing formatting and field nodes by editing the smallest applicable JSON subtree.
