import type { JSONContent } from '@tiptap/react';
import type { User } from '../types';

export type Align = 'left' | 'center';
export type HeaderLayout = 'plain' | 'boxed' | 'split-left' | 'cover';
export type PriceForm = 'fixed' | 'estimate' | 'hourly' | 'hourly-cap';
export type PricingMode = 'single' | 'choice' | 'multi';
export type ImageWidth = 'narrow' | 'wide' | 'full';

export type HeaderBlock = { id: string; type: 'header'; layout: HeaderLayout; eyebrow: string; title: string; showMeta: boolean; background: string; align: Align };
export type PartiesBlock = { id: string; type: 'parties' };
export type LineItem = { id: string; name: string; quantity: number; unit: string; price: number; vat: number; discount: number };
export type PricePackage = { id: string; name: string; description: string; priceForm: PriceForm; cap: number; selected: boolean; items: LineItem[] };
export type PricingBlock = { id: string; type: 'pricing'; title: string; mode: PricingMode; packages: PricePackage[]; showDiscount: boolean; vatPerRow: boolean };
export type TextBlock = { id: string; type: 'text'; title: string; content: JSONContent };
export type ImageBlock = { id: string; type: 'image'; src: string; caption: string; width: ImageWidth; ratio: string };
export type TermsBlock = { id: string; type: 'terms'; title: string; content: JSONContent };
export type BreakBlock = { id: string; type: 'break' };
export type Block = HeaderBlock | PartiesBlock | PricingBlock | TextBlock | ImageBlock | TermsBlock | BreakBlock;
export type BlockType = Block['type'];

export type Contact = { id: string; name: string; email: string; role: string };
export type Company = { id: string; name: string; orgNr: string; address: string; zip: string; city: string; contacts: Contact[] };
export type RecipientCompany = Omit<Company, 'contacts'> & { contacts: (Contact & { signs: boolean })[] };

export type DocTheme = { font: 'grotesk' | 'serif'; accent: string };
export type DocSettings = { currency: string; pricesIncludeVat: boolean; expiresInDays: number; remind: boolean; allowDecline: boolean; senderSigns: boolean };
export type FieldDef = { key: string; label: string; group: 'customer' | 'sender' | 'document' | 'custom' };
export type Draft = { id: string; version: 2; title: string; createdAt: string; updatedAt: string; blocks: Block[]; company: RecipientCompany | null; theme: DocTheme; settings: DocSettings; fields: Record<string, string>; customFields: FieldDef[] };
export type IssueTarget = { kind: 'recipients' } | { kind: 'title' } | { kind: 'block'; id: string };
export type Issue = { message: string; target?: IssueTarget };
export type Signer = { id: string; name: string; email: string; company: string };

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
export const SIGNATURE_ID = 'sig';
export const UNTITLED = 'Namnlöst dokument';

export const BUILTIN_FIELDS: FieldDef[] = [
  ['customer.name', 'Kundens namn'], ['customer.email', 'Kundens e-post'], ['customer.company', 'Kundens företag'], ['customer.orgNumber', 'Kundens org.nr'], ['customer.address', 'Kundens adress'], ['customer.zip', 'Kundens postnummer'], ['customer.city', 'Kundens ort'],
  ['sender.name', 'Avsändare'], ['sender.email', 'Avsändarens e-post'], ['sender.company', 'Vårt företag'],
  ['document.title', 'Dokumentets namn'], ['document.sentAt', 'Datum'], ['document.expiresAt', 'Giltig till'],
].map(([key, label]) => ({ key, label, group: key.split('.')[0] as FieldDef['group'] }));
export const CHIP_FIELDS = ['customer.name', 'customer.company', 'customer.orgNumber', 'sender.company', 'sender.name', 'document.expiresAt', 'document.sentAt'];
export const COMPUTED_FIELDS = new Set(['document.title', 'document.sentAt', 'document.expiresAt']);

const LEGACY_LABELS: Record<string, string> = { 'customer.phone': 'Kundens telefon', 'customer.personalNumber': 'Kundens personnummer', 'sender.phone': 'Avsändarens telefon', 'sender.orgNumber': 'Vårt org.nr', 'sender.address': 'Vår adress', 'sender.zip': 'Vårt postnummer', 'sender.city': 'Vår ort' };
export const allFields = (draft: Draft) => [...BUILTIN_FIELDS, ...draft.customFields];
export const fieldLabel = (draft: Draft, key: string) => allFields(draft).find(field => field.key === key)?.label ?? LEGACY_LABELS[key] ?? key;
export const expiryDate = (draft: Draft, from = new Date()) => new Date(from.getTime() + draft.settings.expiresInDays * 86_400_000);
export const shortDate = (value: Date) => value.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });

export const signingContacts = (draft: Draft) => draft.company?.contacts.filter(contact => contact.signs) ?? [];
function customerValue(draft: Draft, key: string) {
  const company = draft.company;
  if (!company) return '';
  const first = signingContacts(draft)[0];
  switch (key) {
    case 'customer.name': return first?.name ?? '';
    case 'customer.email': return first?.email ?? '';
    case 'customer.company': return company.name;
    case 'customer.orgNumber': return company.orgNr;
    case 'customer.address': return company.address;
    case 'customer.zip': return company.zip;
    case 'customer.city': return company.city;
    default: return '';
  }
}
export function fieldValue(draft: Draft, key: string) {
  if (key === 'document.title') return draft.title;
  if (key === 'document.sentAt') return shortDate(new Date());
  if (key === 'document.expiresAt') return shortDate(expiryDate(draft));
  if (key.startsWith('customer.')) return (customerValue(draft, key) || draft.fields[key] || '').trim();
  return draft.fields[key]?.trim() ?? '';
}

export const TOKEN = /\{\{([\w.-]+)\}\}/g;
export const tokenKeys = (value: string) => [...value.matchAll(TOKEN)].map(match => match[1]);
export const resolveTokens = (draft: Draft, value: string) => value.replace(TOKEN, (_, key: string) => fieldValue(draft, key) || fieldLabel(draft, key));

export const BLOCK_LABELS: Record<BlockType, string> = { header: 'Omslag', parties: 'Parter', pricing: 'Priser', text: 'Text', image: 'Bild', terms: 'Villkor', break: 'Sidbrytning' };
export const TRAY_ORDER: BlockType[] = ['text', 'pricing', 'image', 'terms', 'parties', 'header', 'break'];
export const SINGLE_BLOCKS = new Set<BlockType>(['header', 'parties', 'terms']);

export const HEADER_LAYOUTS: [HeaderLayout, string][] = [['plain', 'Enkel'], ['boxed', 'Band'], ['split-left', 'Bild'], ['cover', 'Helbild']];
export const HEADER_BACKGROUNDS = [
  { key: 'ink', label: 'Mörk', css: '#0e1116', dark: true },
  { key: 'lines', label: 'Linjer', css: 'repeating-linear-gradient(120deg,#ffffff14 0 2px,transparent 2px 22px),linear-gradient(135deg,#1b2330,#0e1116)', dark: true },
  { key: 'forest', label: 'Skog', css: 'linear-gradient(160deg,oklch(0.46 0.08 160),oklch(0.3 0.05 170))', dark: true },
  { key: 'sky', label: 'Himmel', css: 'linear-gradient(180deg,oklch(0.94 0.03 230),oklch(0.8 0.07 240))', dark: false },
  { key: 'paper', label: 'Papper', css: 'radial-gradient(circle at 1px 1px,#0e11161f 1px,transparent 0) 0 0/18px 18px,linear-gradient(180deg,#faf8f3,#efebe1)', dark: false },
];
export const isImageBackground = (value: string) => value.startsWith('data:');
export const backgroundCss = (value: string, overlay = false) => isImageBackground(value)
  ? `${overlay ? 'linear-gradient(rgba(14,17,22,.42),rgba(14,17,22,.42)), ' : ''}url("${value}") center / cover no-repeat`
  : (HEADER_BACKGROUNDS.find(item => item.key === value) ?? HEADER_BACKGROUNDS[0]).css;
export const backgroundIsDark = (value: string) => isImageBackground(value) || (HEADER_BACKGROUNDS.find(item => item.key === value) ?? HEADER_BACKGROUNDS[0]).dark;

export const ACCENTS: [string, string][] = [['Svart', '#0e1116'], ['Grön', 'oklch(0.56 0.13 155)'], ['Blå', 'oklch(0.55 0.15 250)'], ['Röd', 'oklch(0.58 0.17 20)']];
export const FONTS: [DocTheme['font'], string, string][] = [['grotesk', 'Grotesk', "'Schibsted Grotesk Variable','Schibsted Grotesk',system-ui,sans-serif"], ['serif', 'Serif', "'Source Serif 4 Variable','Source Serif 4',Georgia,serif"]];
export const UNITS = ['st', 'tim', 'dag', 'mån', 'år', 'km', 'kg', 'm²', 'paket'];
export const VAT_RATES = [25, 12, 6, 0];
export const PRICE_FORMS: [PriceForm, string][] = [['fixed', 'Fast pris'], ['estimate', 'Ungefärligt pris'], ['hourly', 'Löpande räkning'], ['hourly-cap', 'Löpande med maxpris']];
export const PRICING_MODES: [PricingMode, string][] = [['single', 'Ett paket'], ['choice', 'Kunden väljer ett'], ['multi', 'Kunden väljer flera']];
export const CURRENCIES = ['SEK', 'EUR', 'NOK', 'DKK'];
export const EXPIRY_DAYS = [7, 14, 30, 90];

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const paragraph = (...content: JSONContent[]): JSONContent => content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
const text = (value: string): JSONContent => ({ type: 'text', text: value });
const field = (key: string): JSONContent => ({ type: 'field', attrs: { key } });

export const newItem = (name = '', quantity = 1, unit = 'st', price = 0): LineItem => ({ id: uid(), name, quantity, unit, price, vat: 25, discount: 0 });
export const newPackage = (name = '', selected = true): PricePackage => ({ id: uid(), name, description: '', priceForm: 'fixed', cap: 0, selected, items: [newItem()] });

export function createBlock(type: BlockType): Block {
  const id = uid();
  switch (type) {
    case 'header': return { id, type, layout: 'plain', eyebrow: 'Offert', title: '', showMeta: true, background: 'ink', align: 'left' };
    case 'parties': return { id, type };
    case 'pricing': return { id, type, title: 'Pris', mode: 'single', packages: [newPackage()], showDiscount: false, vatPerRow: false };
    case 'text': return { id, type, title: '', content: doc(paragraph()) };
    case 'image': return { id, type, src: '', caption: '', width: 'wide', ratio: '' };
    case 'terms': return { id, type, title: 'Villkor', content: doc(paragraph(text('Betalning sker mot faktura, 30 dagar netto. Offerten gäller till och med '), field('document.expiresAt'), text('.'))) };
    case 'break': return { id, type };
  }
}

export const TEMPLATES = [
  { key: 'quote', label: 'Offert', description: 'Omslag, parter, hälsning, pris och villkor.' },
  { key: 'agreement', label: 'Avtal', description: 'Omslag, parter, numrerade avsnitt och villkor.' },
  { key: 'blank', label: 'Tomt dokument', description: 'Börja med ett textblock och bygg vidare.' },
] as const;
export type TemplateKey = typeof TEMPLATES[number]['key'];

const textBlock = (title: string, ...paragraphs: JSONContent[][]): TextBlock => ({ ...(createBlock('text') as TextBlock), title, content: doc(...paragraphs.map(parts => paragraph(...parts))) });

export function templateBlocks(key: TemplateKey): Block[] {
  if (key === 'blank') return [createBlock('text')];
  if (key === 'quote') {
    const pricing = createBlock('pricing') as PricingBlock;
    return [
      { ...(createBlock('header') as HeaderBlock), eyebrow: 'Offert', title: 'Offert', layout: 'boxed', background: 'lines' },
      createBlock('parties'),
      textBlock('Hej {{customer.name}}!', [text('Tack för att vi fick möjligheten att lämna en offert till '), field('customer.company'), text('. Nedan hittar du vårt förslag på upplägg och pris.')], [text('Offerten gäller till och med '), field('document.expiresAt'), text('.')]),
      pricing,
      createBlock('terms'),
    ];
  }
  return [
    { ...(createBlock('header') as HeaderBlock), eyebrow: 'Avtal', title: 'Avtal' },
    createBlock('parties'),
    textBlock('1. Bakgrund', [field('sender.company'), text(' och '), field('customer.company'), text(' ('), field('customer.orgNumber'), text(') ingår detta avtal om …')]),
    textBlock('2. Uppdraget', []),
    textBlock('3. Ersättning', []),
    { ...(createBlock('terms') as TermsBlock), title: 'Allmänna villkor', content: doc(paragraph(text('Avtalet gäller från signering. Uppsägningstiden är en månad för båda parter.'))) },
  ];
}

export function createDraft(id: string, user: User): Draft {
  const now = new Date().toISOString();
  return {
    id, version: 2, title: UNTITLED, createdAt: now, updatedAt: now, blocks: [], company: null,
    theme: { font: 'grotesk', accent: '#0e1116' },
    settings: { currency: 'SEK', pricesIncludeVat: false, expiresInDays: 30, remind: true, allowDecline: true, senderSigns: false },
    fields: { 'sender.name': user.name, 'sender.email': user.email, 'sender.company': user.teamName }, customFields: [],
  };
}

export function signers(draft: Draft, user: User): Signer[] {
  const company = draft.company;
  return [
    ...signingContacts(draft).map(contact => ({ id: contact.id, name: contact.name, email: contact.email, company: company?.name ?? '' })),
    ...(draft.settings.senderSigns ? [{ id: 'sender', name: fieldValue(draft, 'sender.name') || user.name, email: fieldValue(draft, 'sender.email') || user.email, company: fieldValue(draft, 'sender.company') || user.teamName }] : []),
  ];
}

export function lineAmounts(item: LineItem, includeVat: boolean, vatPerRow: boolean) {
  const gross = (Number(item.quantity) || 0) * (Number(item.price) || 0) * (1 - Math.min(Math.max(Number(item.discount) || 0, 0), 100) / 100);
  const rate = vatPerRow ? item.vat : 25;
  const net = includeVat ? gross / (1 + rate / 100) : gross;
  return { gross, net, vat: includeVat ? gross - net : net * rate / 100 };
}
export function totals(block: PricingBlock, packages: PricePackage[], settings: DocSettings) {
  let net = 0, vat = 0;
  for (const pkg of packages) for (const item of pkg.items) { const amount = lineAmounts(item, settings.pricesIncludeVat, block.vatPerRow); net += amount.net; vat += amount.vat; }
  return { net, vat, total: net + vat };
}
export const shownPackages = (block: PricingBlock) => block.mode === 'single' ? block.packages.slice(0, 1) : block.packages;
export const chargedPackages = (block: PricingBlock) => block.mode === 'single' ? block.packages.slice(0, 1) : block.packages.filter(pkg => pkg.selected);
export const money = (value: number, currency: string) => new Intl.NumberFormat('sv-SE', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(value || 0));

export function contentFields(content: JSONContent | undefined, into = new Set<string>()) {
  if (!content) return into;
  if (content.type === 'field' && typeof content.attrs?.key === 'string') into.add(content.attrs.key);
  content.content?.forEach(child => contentFields(child, into));
  return into;
}
export function contentIsEmpty(content: JSONContent | undefined): boolean {
  if (!content) return true;
  if (content.type === 'text') return !content.text?.trim();
  if (content.type && !['doc', 'paragraph'].includes(content.type)) return false;
  return (content.content ?? []).every(contentIsEmpty);
}
export function blockFields(block: Block) {
  const keys = new Set<string>();
  if (block.type === 'text' || block.type === 'terms') { contentFields(block.content, keys); tokenKeys(block.title).forEach(key => keys.add(key)); }
  if (block.type === 'header') tokenKeys(`${block.eyebrow} ${block.title}`).forEach(key => keys.add(key));
  return keys;
}

// Same rule as the upload flow; the server validates again.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validEmail = (value: string) => EMAIL.test(value.trim());

export function validate(draft: Draft): Issue[] {
  const issues: Issue[] = [];
  const recipients: IssueTarget = { kind: 'recipients' };
  if (!draft.blocks.length) issues.push({ message: 'Dokumentet är tomt' });
  const title = draft.title.trim();
  if (!title || title === UNTITLED) issues.push({ message: 'Ge dokumentet ett namn', target: { kind: 'title' } });
  const signing = signingContacts(draft);
  if (!draft.company) issues.push({ message: 'Välj eller lägg till en mottagare', target: recipients });
  else if (!signing.length) issues.push({ message: 'Välj minst en kontaktperson som signerar', target: recipients });
  else if (signing.some(contact => !validEmail(contact.email))) issues.push({ message: 'En signerare saknar giltig e-post', target: recipients });
  else if (new Set(signing.map(contact => contact.email.trim().toLowerCase())).size !== signing.length) issues.push({ message: 'Två signerare har samma e-post', target: recipients });
  const empty = new Map<string, string>();
  for (const block of draft.blocks) for (const key of blockFields(block)) if (!fieldValue(draft, key) && !empty.has(key)) empty.set(key, block.id);
  if (empty.size) {
    const keys = [...empty.keys()];
    issues.push({ message: `Tomt fält: ${keys.map(key => fieldLabel(draft, key)).join(', ')}`, target: keys.every(key => key.startsWith('customer.')) ? recipients : { kind: 'block', id: empty.get(keys[0])! } });
  }
  const pricing = draft.blocks.find(block => block.type === 'pricing' && shownPackages(block).some(pkg => pkg.items.some(item => !item.name.trim())));
  if (pricing) issues.push({ message: 'En prisrad saknar beskrivning', target: { kind: 'block', id: pricing.id } });
  const image = draft.blocks.find(block => block.type === 'image' && !block.src);
  if (image) issues.push({ message: 'Ett bildblock saknar bild', target: { kind: 'block', id: image.id } });
  return issues;
}

export function duplicateBlock(block: Block): Block {
  const copy = { ...structuredClone(block), id: uid() };
  if (copy.type === 'pricing') copy.packages = copy.packages.map(pkg => ({ ...pkg, id: uid(), items: pkg.items.map(item => ({ ...item, id: uid() })) }));
  return copy;
}

/* Older drafts (version 1) used a signature block, per-field customer data and a wider set of cover layouts. */
type LegacyDraft = Omit<Draft, 'version' | 'blocks' | 'company' | 'settings' | 'theme'> & { version?: number; blocks: Record<string, unknown>[]; company?: RecipientCompany | null; settings: Partial<DocSettings>; theme: Partial<DocTheme> & { font?: string } };
const LEGACY_LAYOUTS: Record<string, HeaderLayout> = { 'split-right': 'split-left', 'image-top': 'split-left' };
const LEGACY_BACKGROUNDS: Record<string, string> = { aurora: 'lines', meadow: 'forest', dusk: 'ink' };

export function migrateDraft(raw: LegacyDraft): Draft {
  if (raw.version === 2) return raw as unknown as Draft;
  const settings: DocSettings = { currency: raw.settings.currency ?? 'SEK', pricesIncludeVat: raw.settings.pricesIncludeVat ?? false, expiresInDays: raw.settings.expiresInDays ?? 30, remind: true, allowDecline: true, senderSigns: false };
  const blocks: Block[] = [];
  for (const block of raw.blocks) {
    const type = block.type as string;
    if (type === 'signature') { settings.allowDecline = block.allowDecline !== false; settings.senderSigns = block.senderSigns === true; continue; }
    if (type === 'header') {
      const layout = LEGACY_LAYOUTS[block.layout as string] ?? block.layout as HeaderLayout;
      const background = String(block.background ?? 'ink');
      blocks.push({ id: String(block.id), type, layout: HEADER_LAYOUTS.some(([key]) => key === layout) ? layout : 'plain', eyebrow: String(block.eyebrow ?? ''), title: String(block.title ?? ''), showMeta: block.showMeta !== false, background: LEGACY_BACKGROUNDS[background] ?? background, align: block.align === 'center' ? 'center' : 'left' });
    } else if (type === 'pricing') {
      const packages = (block.packages as PricePackage[]) ?? [newPackage()];
      const items = packages.flatMap(pkg => pkg.items);
      blocks.push({ id: String(block.id), type, title: String(block.title ?? 'Pris'), mode: (block.mode as PricingMode | null) ?? 'single', packages, showDiscount: items.some(item => item.discount > 0), vatPerRow: items.some(item => item.vat !== 25) });
    } else if (type === 'text') blocks.push({ id: String(block.id), type, title: String(block.title ?? ''), content: block.content as JSONContent });
    else if (type === 'image') blocks.push({ id: String(block.id), type, src: String(block.src ?? ''), caption: String(block.caption ?? ''), width: (block.width as ImageWidth) ?? 'wide', ratio: String(block.ratio ?? '') });
    else if (type === 'parties' || type === 'break') blocks.push({ id: String(block.id), type });
    else if (type === 'terms') blocks.push({ id: String(block.id), type, title: String(block.title ?? 'Villkor'), content: block.content as JSONContent });
  }
  const fields = raw.fields ?? {};
  const contactName = fields['customer.name']?.trim() ?? '';
  const companyName = fields['customer.company']?.trim() || contactName;
  const company: RecipientCompany | null = raw.company ?? (companyName ? {
    id: uid(), name: companyName, orgNr: fields['customer.orgNumber'] ?? '', address: fields['customer.address'] ?? '', zip: fields['customer.zip'] ?? '', city: fields['customer.city'] ?? '',
    contacts: contactName ? [{ id: uid(), name: contactName, email: fields['customer.email'] ?? '', role: '', signs: true }] : [],
  } : null);
  return {
    id: raw.id, version: 2, title: raw.title, createdAt: raw.createdAt, updatedAt: raw.updatedAt, blocks, company, settings, fields, customFields: raw.customFields ?? [],
    theme: { font: raw.theme.font === 'serif' ? 'serif' : 'grotesk', accent: raw.theme.accent ?? '#0e1116' },
  };
}

const KEY = 'signhere.drafts.v1';
export function listDrafts(): Pick<Draft, 'id' | 'title' | 'updatedAt'>[] {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Pick<Draft, 'id' | 'title' | 'updatedAt'>[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); } catch { return []; }
}
export function loadDraft(id: string): Draft | null {
  try { const raw = localStorage.getItem(`${KEY}.${id}`); return raw ? migrateDraft(JSON.parse(raw) as LegacyDraft) : null; } catch { return null; }
}
export function saveDraft(draft: Draft) {
  localStorage.setItem(`${KEY}.${draft.id}`, JSON.stringify(draft));
  localStorage.setItem(KEY, JSON.stringify([{ id: draft.id, title: draft.title, updatedAt: draft.updatedAt }, ...listDrafts().filter(item => item.id !== draft.id)]));
}
export function deleteDraft(id: string) {
  try { localStorage.removeItem(`${KEY}.${id}`); localStorage.setItem(KEY, JSON.stringify(listDrafts().filter(item => item.id !== id))); } catch { /* storage unavailable */ }
}

/* Address book. Kept in this browser alongside the drafts until the server has a customer store. */
const BOOK_KEY = 'signhere.contacts.v1';
export function loadBook(): Company[] {
  try { return JSON.parse(localStorage.getItem(BOOK_KEY) ?? '[]') as Company[]; } catch { return []; }
}
export function saveBook(book: Company[]) {
  try { localStorage.setItem(BOOK_KEY, JSON.stringify(book.slice(0, 200))); } catch { /* storage unavailable */ }
}
export const toRecipient = (company: Company): RecipientCompany => ({ ...company, contacts: company.contacts.map((contact, index) => ({ ...contact, signs: index === 0 })) });

export const initials = (name: string) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('');
export const companyInitials = (name: string) => initials((name || '?').replace(/\b(AB|HB|KB)\b/g, '').replace(/&/g, ' '));
export const ORG_NUMBER = /^\d{6}-?\d{4}$/;
export const normalizeOrgNumber = (value: string) => value.trim().replace(/^(\d{6})(\d{4})$/, '$1-$2');

export async function imageData(file: File, maxSize = 1600): Promise<{ url: string; ratio: string }> {
  if (!file.type.startsWith('image/')) throw new Error('Välj en bildfil.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { url: canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.84), ratio: `${canvas.width} / ${canvas.height}` };
}
export const imageDataUrl = async (file: File, maxSize = 1600) => (await imageData(file, maxSize)).url;
