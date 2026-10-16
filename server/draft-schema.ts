import { z } from 'zod';

const text = z.string().max(100_000);
const short = z.string().max(200);
export const draftIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
const image = z.string().max(3_000_000).refine(value => !value || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value), 'Bilder måste vara inbäddade PNG-, JPEG- eller WebP-filer.');
const attrs = z.record(z.string().max(80), z.union([z.string().max(3_000_000), z.number().finite(), z.boolean(), z.null(), z.array(z.number().finite()).max(100)]));
const rich: z.ZodType<any> = z.lazy(() => z.object({
  type: z.enum(['doc', 'paragraph', 'heading', 'text', 'hardBreak', 'horizontalRule', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image', 'field']),
  text: text.optional(), attrs: attrs.optional(),
  marks: z.array(z.object({ type: z.enum(['bold', 'italic', 'strike', 'underline', 'link', 'textStyle', 'highlight']), attrs: attrs.optional() }).strict()).max(10).optional(),
  content: z.array(rich).max(1000).optional(),
}).strict().superRefine((node, ctx) => {
  if (node.type === 'image' && !image.safeParse(node.attrs?.src).success) ctx.addIssue({ code: 'custom', message: 'Ogiltig bild.' });
  for (const mark of node.marks ?? []) if (mark.type === 'link' && !/^(https?:|mailto:|tel:)/i.test(String(mark.attrs?.href ?? ''))) ctx.addIssue({ code: 'custom', message: 'Ogiltig länk.' });
}));
const content = z.unknown().superRefine((value, ctx) => {
  let count = 0;
  function walk(node: any, depth: number): boolean {
    if (++count > 10_000 || depth > 30) return false;
    return !node || typeof node !== 'object' || !Array.isArray(node.content) || node.content.every((child: unknown) => walk(child, depth + 1));
  }
  if (!walk(value, 0)) ctx.addIssue({ code: 'custom', message: 'Texten är för stor eller för djupt nästlad.' });
}).pipe(rich).refine(node => node.type === 'doc', 'Textinnehåll måste vara ett dokument.');
const blockId = z.string().min(1).max(80);
const contact = z.object({ id: blockId, name: short, email: short, role: short, signs: z.boolean() }).strict();
const item = z.object({ id: blockId, name: short, quantity: z.number().finite().min(0).max(1e9), unit: short, price: z.number().finite().min(0).max(1e12), vat: z.number().finite().min(0).max(100), discount: z.number().finite().min(0).max(100) }).strict();
const block = z.discriminatedUnion('type', [
  z.object({ id: blockId, type: z.literal('header'), layout: z.enum(['plain', 'boxed', 'split-left', 'cover']), eyebrow: short, title: text, showMeta: z.boolean(), background: z.union([z.enum(['ink', 'lines', 'forest', 'sky', 'paper']), image]), align: z.enum(['left', 'center']) }).strict(),
  z.object({ id: blockId, type: z.literal('parties') }).strict(),
  z.object({ id: blockId, type: z.literal('pricing'), title: text, mode: z.enum(['single', 'choice', 'multi']), packages: z.array(z.object({ id: blockId, name: short, description: text, priceForm: z.enum(['fixed', 'estimate', 'hourly', 'hourly-cap']), cap: z.number().finite().min(0).max(1e12), selected: z.boolean(), items: z.array(item).max(200) }).strict()).max(20), showDiscount: z.boolean(), vatPerRow: z.boolean() }).strict(),
  z.object({ id: blockId, type: z.literal('text'), title: text, content }).strict(),
  z.object({ id: blockId, type: z.literal('terms'), title: text, content }).strict(),
  z.object({ id: blockId, type: z.literal('image'), src: image, caption: text, width: z.enum(['narrow', 'wide', 'full']), ratio: z.string().regex(/^(?:|auto|[0-9.]+\s*\/\s*[0-9.]+)$/) }).strict(),
  z.object({ id: blockId, type: z.literal('break') }).strict(),
]);
export const draftSchema = z.object({
  id: draftIdSchema, version: z.literal(2), title: z.string().max(160), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  blocks: z.array(block).max(150).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length, 'Avsnitten måste ha unika ID:n.'),
  company: z.object({ id: blockId, name: short, orgNr: short, address: short, zip: short, city: short, contacts: z.array(contact).max(50) }).strict().nullable(),
  theme: z.object({ font: z.enum(['grotesk', 'serif']), accent: z.enum(['#0e1116', 'oklch(0.56 0.13 155)', 'oklch(0.55 0.15 250)', 'oklch(0.58 0.17 20)']) }).strict(),
  settings: z.object({ currency: z.enum(['SEK', 'EUR', 'NOK', 'DKK']), pricesIncludeVat: z.boolean(), expiresInDays: z.number().int().min(1).max(365), remind: z.boolean(), allowDecline: z.boolean(), senderSigns: z.boolean() }).strict(),
  fields: z.record(z.string().max(100), z.string().max(10_000)).refine(fields => Object.keys(fields).length <= 200),
  customFields: z.array(z.object({ key: short, label: short, group: z.enum(['customer', 'sender', 'document', 'custom']) }).strict()).max(200),
}).strict();
export type StoredDraft = z.infer<typeof draftSchema>;
