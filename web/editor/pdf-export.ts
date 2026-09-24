import { PDFDocument, rgb, degrees, popGraphicsState, pushGraphicsState, setLineWidth, setStrokingColor, setTextRenderingMode, TextRenderingMode, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { JSONContent } from '@tiptap/react';
import fontUrl from '../../server/assets/NotoSans-Regular.ttf?url';
import {
  ACCENTS, backgroundIsDark, chargedPackages, expiryDate, fieldLabel, fieldValue, isImageBackground, lineAmounts, money, resolveTokens, shortDate, shownPackages, totals,
  type Block, type Draft, type HeaderBlock, type PricingBlock,
} from './model';

/*
 * Renders a draft to a static PDF in the browser. The result goes through the same server-side
 * preparation as an uploaded PDF, so the editor never produces anything the server trusts blindly.
 * The signing appendix is added by the server, not here.
 */
const PAGE: [number, number] = [595.28, 841.89];
const MARGIN = 56, BOTTOM = 64;
const WIDTH = PAGE[0] - MARGIN * 2;
const INK = rgb(0.055, 0.067, 0.086), MUTED = rgb(0.42, 0.45, 0.5), RULE = rgb(0.86, 0.87, 0.89), WHITE = rgb(1, 1, 1);
const ACCENT_RGB: Record<string, RGB> = { [ACCENTS[0][1]]: INK, [ACCENTS[1][1]]: rgb(0.2, 0.52, 0.34), [ACCENTS[2][1]]: rgb(0.2, 0.42, 0.75), [ACCENTS[3][1]]: rgb(0.78, 0.29, 0.31) };

type Style = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; size: number; color?: RGB };
type Run = { text: string; style: Style };

// Intl formats with no-break spaces; the embedded font subset handles plain spaces best.
const clean = (value: string) => value.replace(/[   ]/g, ' ').replace(/[\t\r]/g, ' ');

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(readonly pdf: PDFDocument, readonly font: PDFFont) { this.addPage(); }
  addPage() { this.page = this.pdf.addPage(PAGE); this.y = PAGE[1] - MARGIN; }
  ensure(height: number) { if (this.y - height < BOTTOM) this.addPage(); }
  width(text: string, size: number) { return this.font.widthOfTextAtSize(clean(text), size); }
  draw(text: string, x: number, y: number, style: Style) {
    const value = clean(text);
    if (!value) return;
    const options = { x, y, size: style.size, font: this.font, color: style.color ?? INK, ...(style.italic ? { ySkew: degrees(10) } : {}) };
    // Only a regular face is bundled, so bold is filled and outlined. The text stays selectable once.
    if (style.bold) this.page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(style.size * 0.03), setStrokingColor(style.color ?? INK));
    this.page.drawText(value, options);
    if (style.bold) this.page.pushOperators(popGraphicsState());
    const width = this.width(value, style.size);
    if (style.underline) this.page.drawLine({ start: { x, y: y - 1.5 }, end: { x: x + width, y: y - 1.5 }, thickness: 0.6, color: style.color ?? INK });
    if (style.strike) this.page.drawLine({ start: { x, y: y + style.size * 0.3 }, end: { x: x + width, y: y + style.size * 0.3 }, thickness: 0.6, color: style.color ?? INK });
  }
  /** Wraps styled runs into lines within [x, x + width]. Long words are split by character. */
  lines(runs: Run[], width: number) {
    const words: Run[] = [];
    for (const run of runs) for (const part of run.text.split(/(\n| +)/)) if (part) words.push({ text: part, style: run.style });
    const lines: Run[][] = [[]];
    let used = 0;
    for (const word of words) {
      if (word.text === '\n') { lines.push([]); used = 0; continue; }
      let text = word.text;
      const space = /^ +$/.test(text);
      if (space && !lines.at(-1)!.length) continue;
      while (text) {
        const size = this.width(text, word.style.size);
        if (used + size <= width || space) { lines.at(-1)!.push({ text, style: word.style }); used += size; break; }
        if (used > 0) { lines.push([]); used = 0; if (space) break; continue; }
        let cut = text.length;
        while (cut > 1 && this.width(text.slice(0, cut), word.style.size) > width) cut--;
        lines.at(-1)!.push({ text: text.slice(0, cut), style: word.style }); lines.push([]); used = 0;
        text = text.slice(cut);
      }
    }
    return lines.map(line => { while (line.length && /^ +$/.test(line.at(-1)!.text)) line.pop(); return line; });
  }
  paragraph(runs: Run[], options: { x?: number; width?: number; align?: string; after?: number; lineHeight?: number } = {}) {
    const x = options.x ?? MARGIN, width = options.width ?? WIDTH;
    for (const line of this.lines(runs, width)) {
      const size = Math.max(10, ...line.map(run => run.style.size));
      const height = size * (options.lineHeight ?? 1.45);
      this.ensure(height);
      this.y -= size;
      const total = line.reduce((sum, run) => sum + this.width(run.text, run.style.size), 0);
      let cursor = x + (options.align === 'center' ? (width - total) / 2 : options.align === 'right' ? width - total : 0);
      for (const run of line) { this.draw(run.text, cursor, this.y, run.style); cursor += this.width(run.text, run.style.size); }
      this.y -= height - size;
    }
    this.y -= options.after ?? 6;
  }
  text(text: string, style: Style, options: Parameters<Writer['paragraph']>[1] = {}) { this.paragraph([{ text, style }], options); }
  rule(color = RULE) { this.ensure(12); this.y -= 6; this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + WIDTH, y: this.y }, thickness: 0.6, color }); this.y -= 10; }
}

async function embedImage(pdf: PDFDocument, source: string): Promise<PDFImage | null> {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(source);
  if (!match) return null;
  const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
  try { return match[1] === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes); } catch { return null; }
}

function inlineRuns(draft: Draft, nodes: JSONContent[] | undefined, size: number, base: Partial<Style> = {}): Run[] {
  const runs: Run[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') runs.push({ text: '\n', style: { size } });
    else if (node.type === 'field') { const key = String(node.attrs?.key ?? ''); runs.push({ text: fieldValue(draft, key) || fieldLabel(draft, key), style: { size, ...base } }); }
    else if (node.type === 'text') {
      const marks = new Set(node.marks?.map(mark => mark.type));
      runs.push({ text: node.text ?? '', style: { size, ...base, bold: base.bold || marks.has('bold'), italic: marks.has('italic'), underline: marks.has('underline') || marks.has('link'), strike: marks.has('strike') } });
    } else if (node.content) runs.push(...inlineRuns(draft, node.content, size, base));
  }
  return runs;
}

async function richContent(writer: Writer, draft: Draft, nodes: JSONContent[] | undefined, indent = 0) {
  for (const node of nodes ?? []) {
    const x = MARGIN + indent, width = WIDTH - indent;
    const align = typeof node.attrs?.textAlign === 'string' ? node.attrs.textAlign : undefined;
    switch (node.type) {
      case 'paragraph': writer.paragraph(inlineRuns(draft, node.content, 10.5), { x, width, align, after: 7 }); break;
      case 'heading': {
        const size = [18, 15, 13][Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 3) - 1];
        writer.y -= 4; writer.ensure(size * 3);
        writer.paragraph(inlineRuns(draft, node.content, size, { bold: true }), { x, width, align, after: 6 }); break;
      }
      case 'bulletList': case 'orderedList': {
        let number = Number(node.attrs?.start ?? 1);
        for (const item of node.content ?? []) {
          writer.ensure(16);
          const marker = node.type === 'orderedList' ? `${number++}.` : '•';
          writer.draw(marker, x, writer.y - 10.5, { size: 10.5 });
          await richContent(writer, draft, item.content, indent + 18);
        }
        break;
      }
      case 'blockquote': {
        const top = writer.y, page = writer.page;
        await richContent(writer, draft, node.content, indent + 14);
        if (writer.page === page) page.drawLine({ start: { x: x + 3, y: top }, end: { x: x + 3, y: writer.y + 6 }, thickness: 2, color: RULE });
        break;
      }
      case 'horizontalRule': writer.rule(); break;
      case 'image': await image(writer, String(node.attrs?.src ?? ''), width, x); break;
      case 'table': table(writer, (node.content ?? []).map(row => (row.content ?? []).map(cell => ({ header: cell.type === 'tableHeader', runs: (cell.content ?? []).flatMap((child, index) => [...(index ? [{ text: '\n', style: { size: 9.5 } }] : []), ...inlineRuns(draft, child.content, 9.5, cell.type === 'tableHeader' ? { bold: true } : {})]) })))); break;
      default: if (node.content) await richContent(writer, draft, node.content, indent);
    }
  }
}

async function image(writer: Writer, source: string, width: number, x = MARGIN, caption = '') {
  const embedded = await embedImage(writer.pdf, source);
  if (!embedded) return;
  const scale = Math.min(width / embedded.width, (PAGE[1] - MARGIN - BOTTOM) / embedded.height, 1.5);
  const w = embedded.width * scale, h = embedded.height * scale;
  writer.ensure(h + 8);
  writer.y -= h;
  writer.page.drawImage(embedded, { x: x + (width - w) / 2, y: writer.y, width: w, height: h });
  writer.y -= 8;
  if (caption) writer.text(caption, { size: 9, color: MUTED }, { align: 'center' });
}

function table(writer: Writer, rows: { header?: boolean; runs: Run[]; align?: string }[][], widths?: number[]) {
  const columns = Math.max(1, ...rows.map(row => row.length));
  const columnWidths = widths ?? Array.from({ length: columns }, () => WIDTH / columns);
  for (const [index, row] of rows.entries()) {
    const laid = row.map((cell, column) => writer.lines(cell.runs, columnWidths[column] - 10));
    const height = Math.max(18, ...laid.map(lines => lines.length * 14 + 8));
    writer.ensure(height);
    const top = writer.y;
    if (row.some(cell => cell.header)) writer.page.drawRectangle({ x: MARGIN, y: top - height, width: WIDTH, height, color: rgb(0.96, 0.965, 0.97) });
    let x = MARGIN;
    for (const [column, lines] of laid.entries()) {
      let y = top - 4;
      for (const line of lines) {
        y -= 10;
        const total = line.reduce((sum, run) => sum + writer.width(run.text, run.style.size), 0);
        let cursor = row[column].align === 'right' ? x + columnWidths[column] - 5 - total : x + 5;
        for (const run of line) { writer.draw(run.text, cursor, y, run.style); cursor += writer.width(run.text, run.style.size); }
        y -= 4;
      }
      x += columnWidths[column];
    }
    writer.y = top - height;
    writer.page.drawLine({ start: { x: MARGIN, y: writer.y }, end: { x: MARGIN + WIDTH, y: writer.y }, thickness: index === 0 ? 0.8 : 0.4, color: RULE });
  }
  writer.y -= 10;
}

function header(writer: Writer, draft: Draft, block: HeaderBlock, accent: RGB) {
  const panel = block.layout !== 'plain';
  const dark = panel && backgroundIsDark(block.background);
  const color = dark ? WHITE : INK;
  const title = resolveTokens(draft, block.title) || draft.title;
  const meta: [string, string][] = block.showMeta ? [['Till', draft.company?.name || '—'], ['Från', fieldValue(draft, 'sender.company')], ['Datum', shortDate(new Date())], ['Giltig till', shortDate(expiryDate(draft))]] : [];
  const titleLines = writer.lines([{ text: title, style: { size: 26, bold: true } }], WIDTH - (panel ? 40 : 0)).length;
  const height = 40 + titleLines * 34 + (block.eyebrow ? 20 : 0) + (meta.length ? 46 : 0);
  const top = writer.y;
  if (panel) {
    const fill = isImageBackground(block.background) || dark ? (block.background === 'forest' ? rgb(0.2, 0.4, 0.32) : accent === INK ? INK : accent) : rgb(0.94, 0.95, 0.96);
    writer.page.drawRectangle({ x: MARGIN, y: top - height, width: WIDTH, height, color: fill });
  }
  const inset = panel ? 20 : 0;
  writer.y = top - (panel ? 22 : 0);
  const align = block.align === 'center' ? 'center' : undefined;
  if (block.eyebrow) writer.text(resolveTokens(draft, block.eyebrow).toUpperCase(), { size: 9, color: dark ? WHITE : accent }, { x: MARGIN + inset, width: WIDTH - inset * 2, align, after: 4 });
  writer.text(title, { size: 26, bold: true, color }, { x: MARGIN + inset, width: WIDTH - inset * 2, align, lineHeight: 1.3, after: 8 });
  if (meta.length) {
    const column = (WIDTH - inset * 2) / meta.length;
    const y = writer.y - 10;
    meta.forEach(([label, value], index) => {
      writer.draw(label.toUpperCase(), MARGIN + inset + column * index, y, { size: 7.5, color: dark ? WHITE : MUTED });
      writer.draw(writer.lines([{ text: value, style: { size: 9.5 } }], column - 8)[0]?.map(run => run.text).join('') ?? '', MARGIN + inset + column * index, y - 14, { size: 9.5, color });
    });
    writer.y = y - 24;
  }
  writer.y = (panel ? top - height : writer.y) - 18;
}

function parties(writer: Writer, draft: Draft) {
  const company = draft.company;
  const address = company ? [company.address, [company.zip, company.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  const from = [fieldValue(draft, 'sender.company'), fieldValue(draft, 'sender.name'), fieldValue(draft, 'sender.email')].filter(Boolean);
  const to = company ? [company.name, company.orgNr && `Org.nr ${company.orgNr}`, address, ...company.contacts.filter(contact => contact.signs).map(contact => `${contact.name}${contact.role ? `, ${contact.role}` : ''} · ${contact.email}`)].filter(Boolean) as string[] : [];
  const top = writer.y;
  const column = (lines: string[], label: string, x: number) => {
    writer.y = top;
    writer.text(label.toUpperCase(), { size: 8, color: MUTED }, { x, width: WIDTH / 2 - 12, after: 2 });
    lines.forEach((line, index) => writer.text(line, { size: index ? 9.5 : 11, bold: index === 0 }, { x, width: WIDTH / 2 - 12, after: 1 }));
    return writer.y;
  };
  const left = column(from, 'Från', MARGIN);
  const right = to.length ? column(to, 'Till', MARGIN + WIDTH / 2) : top;
  writer.y = Math.min(left, right) - 14;
}

function pricing(writer: Writer, draft: Draft, block: PricingBlock) {
  const { currency } = draft.settings;
  if (block.title) writer.text(resolveTokens(draft, block.title), { size: 15, bold: true }, { after: 8 });
  const cell = (text: string, style: Partial<Style> = {}, align?: string) => ({ runs: [{ text, style: { size: 9.5, ...style } }], align });
  const multi = block.mode !== 'single';
  const charged = new Set(chargedPackages(block).map(pkg => pkg.id));
  for (const pkg of shownPackages(block)) {
    if (multi || pkg.name) writer.text(`${pkg.name || 'Paket'}${multi && charged.has(pkg.id) ? ' · valt' : ''}`, { size: 11.5, bold: true }, { after: 2 });
    if (pkg.description) writer.text(pkg.description, { size: 9.5, color: MUTED }, { after: 4 });
    const head = ['Beskrivning', 'Antal', 'À-pris', ...(block.showDiscount ? ['Rabatt'] : []), ...(block.vatPerRow ? ['Moms'] : []), 'Summa'];
    const narrow = 62;
    const widths = [WIDTH - narrow * (head.length - 1), ...head.slice(1).map(() => narrow)];
    table(writer, [
      head.map((label, index) => ({ header: true, ...cell(label, { bold: true }, index ? 'right' : undefined) })),
      ...pkg.items.map(item => {
        const amount = lineAmounts(item, draft.settings.pricesIncludeVat, block.vatPerRow);
        return [cell(item.name), cell(`${item.quantity} ${item.unit}`, {}, 'right'), cell(money(item.price, currency), {}, 'right'),
          ...(block.showDiscount ? [cell(item.discount ? `${item.discount} %` : '–', {}, 'right')] : []), ...(block.vatPerRow ? [cell(`${item.vat} %`, {}, 'right')] : []),
          cell(money(amount.gross, currency), {}, 'right')];
      }),
    ], widths);
  }
  const sum = totals(block, chargedPackages(block), draft.settings);
  for (const [label, value, strong] of [['Summa exkl. moms', sum.net, false], ['Moms', sum.vat, false], ['Totalt', sum.total, true]] as const) {
    writer.ensure(16);
    writer.y -= 11;
    const text = money(value, currency);
    writer.draw(label, MARGIN + WIDTH - 220, writer.y, { size: strong ? 11 : 9.5, bold: strong, color: strong ? INK : MUTED });
    writer.draw(text, MARGIN + WIDTH - writer.width(text, strong ? 11 : 9.5), writer.y, { size: strong ? 11 : 9.5, bold: strong });
    writer.y -= 5;
  }
  writer.y -= 12;
}

async function block(writer: Writer, draft: Draft, item: Block, accent: RGB) {
  switch (item.type) {
    case 'header': header(writer, draft, item, accent); break;
    case 'parties': parties(writer, draft); break;
    case 'pricing': pricing(writer, draft, item); break;
    case 'text': case 'terms':
      if (item.title) { writer.y -= 4; writer.ensure(40); writer.text(resolveTokens(draft, item.title), { size: 15, bold: true }, { after: 6 }); }
      await richContent(writer, draft, item.content.content);
      writer.y -= 8; break;
    case 'image': await image(writer, item.src, item.width === 'narrow' ? WIDTH * 0.6 : WIDTH, MARGIN + (item.width === 'narrow' ? WIDTH * 0.2 : 0), item.caption); break;
    case 'break': writer.addPage(); break;
  }
}

export async function draftPdf(draft: Draft): Promise<Blob> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(draft.title || 'Bilaga');
  pdf.setCreator('signhere');
  const font = await pdf.embedFont(await (await fetch(fontUrl)).arrayBuffer(), { subset: true });
  const writer = new Writer(pdf, font);
  const accent = ACCENT_RGB[draft.theme.accent] ?? INK;
  for (const item of draft.blocks) await block(writer, draft, item, accent);
  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    const label = `${clean(draft.title || '')} · Sida ${index + 1} av ${pages.length}`;
    page.drawText(label, { x: MARGIN, y: 32, size: 8, font, color: MUTED });
  });
  const bytes = await pdf.save({ useObjectStreams: true });
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
