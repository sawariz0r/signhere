import type { JSONContent } from '@tiptap/react';
import type { User } from '../types';

export type Align = 'left' | 'center' | 'right';
export type HeaderLayout = 'split-left' | 'split-right' | 'image-top' | 'cover' | 'boxed' | 'plain';
export type PriceForm = 'fixed' | 'estimate' | 'hourly' | 'hourly-cap';
export type PricingMode = 'single' | 'choice' | 'multi';

export type HeaderBlock = { id: string; type: 'header'; layout: HeaderLayout; eyebrow: string; title: string; showMeta: boolean; background: string; backgroundColor: string; textColor: string; overlay: number; align: Align; logo: string };
export type PartiesBlock = { id: string; type: 'parties'; title: string };
export type LineItem = { id: string; name: string; quantity: number; unit: string; price: number; vat: number; discount: number };
export type PricePackage = { id: string; name: string; description: string; priceForm: PriceForm; cap: number; selected: boolean; items: LineItem[] };
export type PricingBlock = { id: string; type: 'pricing'; title: string; mode: PricingMode | null; packages: PricePackage[]; hideSummary: boolean };
export type TextBlock = { id: string; type: 'text'; content: JSONContent };
export type ImageBlock = { id: string; type: 'image'; src: string; caption: string; width: 'full' | 'wide' | 'narrow' };
export type TermsBlock = { id: string; type: 'terms'; title: string; content: JSONContent };
export type SignatureBlock = { id: string; type: 'signature'; title: string; allowDecline: boolean; senderSigns: boolean };
export type BreakBlock = { id: string; type: 'break' };
export type Block = HeaderBlock | PartiesBlock | PricingBlock | TextBlock | ImageBlock | TermsBlock | SignatureBlock | BreakBlock;
export type BlockType = Block['type'];

export type DocTheme = { font: 'grotesk' | 'serif' | 'system'; accent: string; pageColor: string; scale: 'compact' | 'normal' | 'large' };
export type DocSettings = { currency: string; pricesIncludeVat: boolean; rounding: boolean; expiresInDays: number };
export type FieldDef = { key: string; label: string; group: 'customer' | 'sender' | 'document' | 'custom' };
export type Draft = { id: string; version: 1; title: string; createdAt: string; updatedAt: string; blocks: Block[]; theme: DocTheme; settings: DocSettings; fields: Record<string, string>; customFields: FieldDef[] };
export type Issue = { level: 'error' | 'warning'; message: string; blockId?: string; fix?: 'add-signature' | 'add-customer' };

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export const BUILTIN_FIELDS: FieldDef[] = [
  ['customer.name', 'Kundens namn'], ['customer.email', 'Kundens e-post'], ['customer.phone', 'Kundens telefon'], ['customer.company', 'Kundens företag'], ['customer.address', 'Kundens adress'], ['customer.zip', 'Kundens postnummer'], ['customer.city', 'Kundens stad'], ['customer.personalNumber', 'Kundens personnummer'], ['customer.orgNumber', 'Kundens organisationsnummer'],
  ['sender.name', 'Avsändarens namn'], ['sender.email', 'Avsändarens e-post'], ['sender.phone', 'Avsändarens telefon'], ['sender.company', 'Avsändarens företag'], ['sender.orgNumber', 'Avsändarens organisationsnummer'], ['sender.address', 'Avsändarens adress'], ['sender.zip', 'Avsändarens postnummer'], ['sender.city', 'Avsändarens stad'],
  ['document.title', 'Dokumentets namn'], ['document.sentAt', 'Dokumentets sändningsdatum'], ['document.expiresAt', 'Dokumentets utgångsdatum'],
].map(([key, label]) => ({ key, label, group: key.split('.')[0] as FieldDef['group'] }));
export const COMPUTED_FIELDS = new Set(['document.title', 'document.sentAt', 'document.expiresAt']);

export const allFields = (draft: Draft) => [...BUILTIN_FIELDS, ...draft.customFields];
export const fieldLabel = (draft: Draft, key: string) => allFields(draft).find(field => field.key === key)?.label ?? key;
export const expiryDate = (draft: Draft, from = new Date()) => new Date(from.getTime() + draft.settings.expiresInDays * 86_400_000);
const shortDate = (value: Date) => value.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });
export function fieldValue(draft: Draft, key: string) {
  if (key === 'document.title') return draft.title;
  if (key === 'document.sentAt') return shortDate(new Date());
  if (key === 'document.expiresAt') return shortDate(expiryDate(draft));
  return draft.fields[key]?.trim() ?? '';
}

export const BLOCK_LABELS: Record<BlockType, string> = { header: 'Omslag', parties: 'Parter', pricing: 'Priser & paket', text: 'Text', image: 'Bild', terms: 'Villkor', signature: 'Signatur', break: 'Sidbrytning' };
export const SINGLE_BLOCKS = new Set<BlockType>(['parties', 'terms', 'signature']);

export const HEADER_BACKGROUNDS = [
  { key: 'aurora', label: 'Norrsken', css: 'radial-gradient(120% 90% at 10% 10%, oklch(0.78 0.12 165) 0%, transparent 55%), radial-gradient(90% 80% at 90% 30%, oklch(0.62 0.13 230) 0%, transparent 60%), radial-gradient(100% 100% at 50% 100%, oklch(0.36 0.08 250) 0%, oklch(0.24 0.04 250) 100%)' },
  { key: 'meadow', label: 'Äng', css: 'linear-gradient(160deg, oklch(0.9 0.06 150) 0%, oklch(0.66 0.13 155) 55%, oklch(0.4 0.09 160) 100%)' },
  { key: 'dusk', label: 'Skymning', css: 'linear-gradient(200deg, oklch(0.83 0.08 60) 0%, oklch(0.62 0.14 20) 45%, oklch(0.3 0.08 300) 100%)' },
  { key: 'paper', label: 'Papper', css: 'radial-gradient(circle at 1px 1px, #0e11161f 1px, transparent 0) 0 0 / 18px 18px, linear-gradient(180deg, #faf8f3, #efebe1)' },
  { key: 'lines', label: 'Linjer', css: 'repeating-linear-gradient(120deg, #ffffff14 0 2px, transparent 2px 22px), linear-gradient(135deg, #1b2330, #0e1116)' },
  { key: 'sky', label: 'Himmel', css: 'linear-gradient(180deg, oklch(0.93 0.03 230) 0%, oklch(0.78 0.08 240) 100%)' },
];
export const backgroundCss = (value: string) => value.startsWith('data:') ? `center / cover no-repeat url("${value}")` : HEADER_BACKGROUNDS.find(item => item.key === value)?.css ?? HEADER_BACKGROUNDS[0].css;

export const ACCENTS = ['#0e1116', 'oklch(0.56 0.13 155)', 'oklch(0.55 0.15 250)', 'oklch(0.52 0.17 290)', 'oklch(0.58 0.17 20)', 'oklch(0.66 0.14 65)'];
export const PAGE_COLORS = ['#ffffff', '#fbfaf7', '#f7f9fb', '#f6f8f5'];
export const UNITS = ['st', 'tim', 'dag', 'mån', 'år', 'km', 'kg', 'm²', 'paket'];
export const VAT_RATES = [25, 12, 6, 0];
export const PRICE_FORMS: Record<PriceForm, string> = { fixed: 'Fast pris', estimate: 'Ungefärligt pris', hourly: 'Löpande räkning', 'hourly-cap': 'Löpande räkning med maxpris' };
export const CURRENCIES = ['SEK', 'EUR', 'NOK', 'DKK', 'USD'];

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const heading = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const paragraph = (...content: JSONContent[]): JSONContent => content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
const text = (value: string): JSONContent => ({ type: 'text', text: value });
const field = (key: string): JSONContent => ({ type: 'field', attrs: { key } });

export const newItem = (): LineItem => ({ id: uid(), name: '', quantity: 1, unit: 'st', price: 0, vat: 25, discount: 0 });
export const newPackage = (index = 0): PricePackage => ({ id: uid(), name: index ? `Paket ${index + 1}` : '', description: '', priceForm: 'fixed', cap: 0, selected: index === 0, items: [newItem()] });

export function createBlock(type: BlockType): Block {
  const id = uid();
  switch (type) {
    case 'header': return { id, type, layout: 'split-left', eyebrow: '', title: 'Offert', showMeta: true, background: 'aurora', backgroundColor: '#1b2330', textColor: '#ffffff', overlay: 0.35, align: 'left', logo: '' };
    case 'parties': return { id, type, title: 'Parter' };
    case 'pricing': return { id, type, title: 'Omfattning', mode: null, packages: [newPackage()], hideSummary: false };
    case 'text': return { id, type, content: doc(paragraph()) };
    case 'image': return { id, type, src: '', caption: '', width: 'wide' };
    case 'terms': return { id, type, title: 'Allmänna villkor', content: doc(paragraph(text('Beskriv betalningsvillkor, leveransvillkor och giltighet här.'))) };
    case 'signature': return { id, type, title: 'Signering', allowDecline: true, senderSigns: false };
    case 'break': return { id, type };
  }
}

export const TEMPLATES = [
  { key: 'quote', label: 'Offert', description: 'Omslag, parter, prisförslag och signering.' },
  { key: 'agreement', label: 'Avtal', description: 'Parter, avtalstext, villkor och signering.' },
  { key: 'blank', label: 'Tomt dokument', description: 'Börja från noll med egna block.' },
] as const;
export type TemplateKey = typeof TEMPLATES[number]['key'];

export function templateBlocks(key: TemplateKey): Block[] {
  if (key === 'blank') return [];
  if (key === 'quote') {
    const intro = createBlock('text') as TextBlock;
    intro.content = doc(heading(2, 'Hej!'), paragraph(text('Tack för att vi fick möjligheten att lämna en offert till '), field('customer.company'), text('. Nedan hittar du vårt förslag. Offerten gäller till och med '), field('document.expiresAt'), text('.')));
    const pricing = createBlock('pricing') as PricingBlock;
    pricing.mode = 'single';
    return [createBlock('header'), createBlock('parties'), intro, pricing, createBlock('terms'), createBlock('signature')];
  }
  const header = createBlock('header') as HeaderBlock;
  Object.assign(header, { title: 'Avtal', layout: 'plain', backgroundColor: '#f1f3f5', textColor: '#0e1116' });
  const body = createBlock('text') as TextBlock;
  body.content = doc(heading(2, '1. Bakgrund'), paragraph(field('sender.company'), text(' och '), field('customer.company'), text(' ingår detta avtal om …')), heading(2, '2. Uppdraget'), paragraph(), heading(2, '3. Ersättning'), paragraph());
  return [header, createBlock('parties'), body, createBlock('terms'), createBlock('signature')];
}

export function createDraft(id: string, user: User, template: TemplateKey = 'blank'): Draft {
  const now = new Date().toISOString();
  return {
    id, version: 1, title: template === 'agreement' ? 'Avtal' : template === 'quote' ? 'Offert' : 'Namnlöst dokument', createdAt: now, updatedAt: now, blocks: templateBlocks(template),
    theme: { font: 'grotesk', accent: 'oklch(0.56 0.13 155)', pageColor: '#ffffff', scale: 'normal' },
    settings: { currency: 'SEK', pricesIncludeVat: false, rounding: true, expiresInDays: 30 },
    fields: { 'sender.name': user.name, 'sender.email': user.email, 'sender.company': user.teamName }, customFields: [],
  };
}

export function lineAmounts(item: LineItem, includeVat: boolean) {
  const gross = (Number(item.quantity) || 0) * (Number(item.price) || 0) * (1 - Math.min(Math.max(Number(item.discount) || 0, 0), 100) / 100);
  const net = includeVat ? gross / (1 + item.vat / 100) : gross;
  return { net, vat: includeVat ? gross - net : net * item.vat / 100 };
}
export function totals(packages: PricePackage[], settings: DocSettings) {
  let net = 0, vat = 0;
  for (const pkg of packages) for (const item of pkg.items) { const amount = lineAmounts(item, settings.pricesIncludeVat); net += amount.net; vat += amount.vat; }
  const raw = net + vat;
  const total = settings.rounding ? Math.round(raw) : Math.round(raw * 100) / 100;
  return { net, vat, rounding: total - raw, total };
}
export const chargedPackages = (block: PricingBlock) => block.mode === 'single' ? block.packages.slice(0, 1) : block.packages.filter(pkg => pkg.selected);
export const money = (value: number, currency: string) => new Intl.NumberFormat('sv-SE', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);

export function contentFields(content: JSONContent | undefined, into = new Set<string>()) {
  if (!content) return into;
  if (content.type === 'field' && typeof content.attrs?.key === 'string') into.add(content.attrs.key);
  content.content?.forEach(child => contentFields(child, into));
  return into;
}
export function usedFields(draft: Draft) {
  const used = new Set<string>();
  for (const block of draft.blocks) {
    if (block.type === 'header' && block.showMeta) { used.add('customer.name'); used.add('sender.name'); }
    if (block.type === 'parties') ['customer.name', 'customer.email', 'sender.company', 'sender.name', 'sender.email'].forEach(key => used.add(key));
    if (block.type === 'text' || block.type === 'terms') contentFields(block.content, used);
  }
  return used;
}

export function validate(draft: Draft): Issue[] {
  const issues: Issue[] = [];
  if (!draft.blocks.length) issues.push({ level: 'error', message: 'Dokumentet är tomt. Lägg till minst ett block.' });
  if (!draft.blocks.some(block => block.type === 'signature')) issues.push({ level: 'error', message: 'Signaturblock saknas. Lägg till ett om mottagaren ska kunna signera.', fix: 'add-signature' });
  if (!fieldValue(draft, 'customer.name') || !fieldValue(draft, 'customer.email')) issues.push({ level: 'error', message: 'Kunden saknar namn eller e-post.', fix: 'add-customer' });
  const missing = [...usedFields(draft)].filter(key => !fieldValue(draft, key) && key !== 'customer.name' && key !== 'customer.email');
  if (missing.length) issues.push({ level: 'warning', message: `Tomma fält: ${missing.map(key => fieldLabel(draft, key)).join(', ')}.` });
  for (const block of draft.blocks) if (block.type === 'pricing') {
    if (!block.mode) issues.push({ level: 'warning', message: 'Välj ett prisupplägg i prisblocket.', blockId: block.id });
    else if (block.packages.some(pkg => pkg.items.some(item => !item.name.trim()))) issues.push({ level: 'warning', message: 'Prisblocket har rader utan namn.', blockId: block.id });
  }
  return issues;
}

const KEY = 'signhere.drafts.v1';
export function listDrafts(): Pick<Draft, 'id' | 'title' | 'updatedAt'>[] {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Pick<Draft, 'id' | 'title' | 'updatedAt'>[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); } catch { return []; }
}
export function loadDraft(id: string): Draft | null {
  try { const raw = localStorage.getItem(`${KEY}.${id}`); return raw ? JSON.parse(raw) as Draft : null; } catch { return null; }
}
export function saveDraft(draft: Draft) {
  localStorage.setItem(`${KEY}.${draft.id}`, JSON.stringify(draft));
  localStorage.setItem(KEY, JSON.stringify([{ id: draft.id, title: draft.title, updatedAt: draft.updatedAt }, ...listDrafts().filter(item => item.id !== draft.id)]));
}
export function deleteDraft(id: string) {
  try { localStorage.removeItem(`${KEY}.${id}`); localStorage.setItem(KEY, JSON.stringify(listDrafts().filter(item => item.id !== id))); } catch { /* storage unavailable */ }
}

export async function imageDataUrl(file: File, maxSize = 1600): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Välj en bildfil.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.84);
}
