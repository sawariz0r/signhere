import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, Ellipsis, GripVertical, ImagePlus, Plus, Settings2, Trash2, UserRound, X } from 'lucide-react';
import { useEditorApi } from './context';
import { FieldToken, RichText } from './rich-text';
import {
  backgroundCss, BLOCK_LABELS, chargedPackages, fieldValue, imageDataUrl, lineAmounts, money, newItem, newPackage, PRICE_FORMS, totals, UNITS, VAT_RATES,
  type Block, type HeaderBlock, type ImageBlock, type LineItem, type PartiesBlock, type PriceForm, type PricePackage, type PricingBlock, type PricingMode, type SignatureBlock, type TermsBlock, type TextBlock,
} from './model';

export function InlineText({ value, onChange, placeholder, className = '', multiline = false, label }: { value: string; onChange: (value: string) => void; placeholder: string; className?: string; multiline?: boolean; label: string }) {
  const { preview } = useEditorApi();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const element = ref.current; if (element && element.innerText !== value && document.activeElement !== element) element.innerText = value; }, [value, preview]);
  if (preview) return value ? <div className={className}>{value}</div> : null;
  return <div ref={ref} role="textbox" aria-label={label} aria-multiline={multiline} tabIndex={0} contentEditable suppressContentEditableWarning className={`ed-inline ${className}`} data-placeholder={placeholder}
    onInput={event => onChange(event.currentTarget.innerText.replace(/\n$/, ''))}
    onKeyDown={event => { if (event.key === 'Enter' && !multiline) { event.preventDefault(); event.currentTarget.blur(); } }}
    onPaste={event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); }} />;
}

function ImagePick({ onPick, children, className }: { onPick: (dataUrl: string) => void; children: ReactNode; className: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return <><button type="button" className={className} disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Laddar bild…' : children}</button>
    <input ref={input} type="file" accept="image/*" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      setBusy(true);
      try { onPick(await imageDataUrl(file)); } finally { setBusy(false); }
    }} /></>;
}

export function BlockFrame({ block, index, count, children, onDragStart }: { block: Block; index: number; count: number; children: ReactNode; onDragStart: (event: React.DragEvent) => void }) {
  const api = useEditorApi();
  const selected = api.selectedId === block.id;
  if (api.preview) return <div className={`ed-block ed-block-${block.type}`}>{children}</div>;
  const move = (offset: number) => api.update(draft => {
    const blocks = [...draft.blocks];
    const [item] = blocks.splice(index, 1);
    blocks.splice(index + offset, 0, item);
    return { ...draft, blocks };
  }, { structural: true });
  const duplicate = () => api.update(draft => {
    const copy = { ...structuredClone(block), id: crypto.randomUUID().replace(/-/g, '').slice(0, 12) };
    const blocks = [...draft.blocks]; blocks.splice(index + 1, 0, copy);
    return { ...draft, blocks };
  }, { structural: true });
  const remove = () => { api.update(draft => ({ ...draft, blocks: draft.blocks.filter(item => item.id !== block.id) }), { structural: true }); api.select(null); };
  return <div className={`ed-block ed-block-${block.type}${selected ? ' selected' : ''}`} data-block-id={block.id} onMouseDownCapture={() => { if (!selected) api.select(block.id); }}>
    <button type="button" className="ed-grip" draggable onDragStart={onDragStart} aria-label={`Flytta ${BLOCK_LABELS[block.type]}`} title="Dra för att flytta"><GripVertical size={16} /></button>
    <div className="ed-block-tag">{BLOCK_LABELS[block.type]}</div>
    <div className="ed-block-rail" role="toolbar" aria-label={`${BLOCK_LABELS[block.type]}-block`}>
      {block.type === 'header' && <button type="button" className="ed-rail-wide" onClick={() => api.openSettings(block.id)}><Settings2 size={14} />Redigera</button>}
      <button type="button" aria-label="Flytta upp" title="Flytta upp" disabled={index === 0} onClick={() => move(-1)}><ArrowUp size={14} /></button>
      <button type="button" aria-label="Flytta ned" title="Flytta ned" disabled={index === count - 1} onClick={() => move(1)}><ArrowDown size={14} /></button>
      {block.type !== 'parties' && block.type !== 'signature' && block.type !== 'terms' && <button type="button" aria-label="Duplicera" title="Duplicera" onClick={duplicate}><Copy size={14} /></button>}
      <button type="button" aria-label="Ta bort block" title="Ta bort" className="danger" onClick={remove}><Trash2 size={14} /></button>
    </div>
    {children}
  </div>;
}

export function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'header': return <HeaderView block={block} />;
    case 'parties': return <PartiesView block={block} />;
    case 'pricing': return <PricingView block={block} />;
    case 'text': return <TextView block={block} />;
    case 'image': return <ImageView block={block} />;
    case 'terms': return <TermsView block={block} />;
    case 'signature': return <SignatureView block={block} />;
    case 'break': return <div className="ed-break"><span>Sidbrytning</span></div>;
  }
}

function HeaderView({ block }: { block: HeaderBlock }) {
  const { updateBlock, preview } = useEditorApi();
  const set = (patch: Partial<HeaderBlock>) => updateBlock<HeaderBlock>(block.id, patch);
  const style = { '--hdr-bg': block.backgroundColor, '--hdr-fg': block.textColor, '--hdr-overlay': block.overlay, '--hdr-art': backgroundCss(block.background), textAlign: block.align } as CSSProperties;
  return <div className={`ed-hdr ed-hdr-${block.layout} align-${block.align}`} style={style}>
    {block.layout !== 'plain' && <div className="ed-hdr-art" aria-hidden="true" />}
    <div className="ed-hdr-panel">
      <div className="ed-hdr-logo">{block.logo ? <span className="ed-hdr-logo-img"><img src={block.logo} alt="Logotyp" />{!preview && <button type="button" aria-label="Ta bort logotyp" onClick={() => set({ logo: '' })}><X size={12} /></button>}</span> : !preview && <ImagePick className="ed-logo-slot" onPick={logo => set({ logo })}>Logotyp</ImagePick>}</div>
      <div className="ed-hdr-main">
        <InlineText className="ed-hdr-eyebrow" label="Överrubrik" placeholder="Överrubrik (valfri)" value={block.eyebrow} onChange={eyebrow => set({ eyebrow })} />
        <InlineText className="ed-hdr-title" label="Titel" placeholder="Titel" value={block.title} onChange={title => set({ title })} multiline />
      </div>
      {block.showMeta && <div className="ed-hdr-meta"><div>Avsedd för <FieldToken fieldKey="customer.name" /></div><div>Av <FieldToken fieldKey="sender.name" /></div></div>}
    </div>
  </div>;
}

const CUSTOMER_FIELDS: [string, string, string?][] = [['customer.name', 'Namn'], ['customer.email', 'E-post', 'email'], ['customer.phone', 'Telefon', 'tel'], ['customer.company', 'Företag'], ['customer.orgNumber', 'Org-nr'], ['customer.personalNumber', 'Personnummer'], ['customer.address', 'Adress'], ['customer.zip', 'Postnummer'], ['customer.city', 'Stad']];
const SENDER_FIELDS: [string, string, string?][] = [['sender.company', 'Företag'], ['sender.orgNumber', 'Org-nr'], ['sender.name', 'Referens'], ['sender.email', 'E-post', 'email'], ['sender.phone', 'Telefon', 'tel'], ['sender.address', 'Adress'], ['sender.zip', 'Postnummer'], ['sender.city', 'Stad']];

function PartyCard({ number, title, fields, emptyTitle, emptyText }: { number: string; title: string; fields: [string, string, string?][]; emptyTitle: string; emptyText: string }) {
  const { draft, setField, preview } = useEditorApi();
  const [editing, setEditing] = useState(false);
  const filled = fields.filter(([key]) => fieldValue(draft, key));
  const empty = !fieldValue(draft, fields[0][0]) && filled.length < 2;
  return <div className="ed-party">
    <div className="ed-party-head"><span className="ed-party-no">{number}</span><i /><strong>{title}</strong>{!preview && !empty && <button type="button" className="ed-chip-button" onClick={() => setEditing(value => !value)}>{editing ? <><Check size={13} />Klar</> : 'Redigera'}</button>}</div>
    {editing ? <div className="ed-party-form">{fields.map(([key, label, type]) => <label key={key}><span>{label}</span><input type={type ?? 'text'} value={draft.fields[key] ?? ''} onChange={event => setField(key, event.target.value)} /></label>)}</div>
      : empty ? (preview ? <div className="ed-party-empty muted">Uppgifterna fylls i innan utskick.</div> : <div className="ed-party-empty"><span className="ed-party-avatar"><UserRound size={18} /></span><div><strong>{emptyTitle}</strong><span>{emptyText}</span></div><button type="button" className="button small" onClick={() => setEditing(true)}><Plus size={14} />Lägg till</button></div>)
      : <dl className="ed-party-grid">{filled.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{fieldValue(draft, key)}</dd></div>)}</dl>}
  </div>;
}

function PartiesView({ block }: { block: PartiesBlock }) {
  const { updateBlock } = useEditorApi();
  return <section className="ed-section">
    <InlineText className="ed-h2" label="Rubrik" placeholder="Parter" value={block.title} onChange={title => updateBlock<PartiesBlock>(block.id, { title })} />
    <div className="ed-parties">
      <PartyCard number="01" title="Beställare" fields={CUSTOMER_FIELDS} emptyTitle="Vem är din kund?" emptyText="Kunden blir mottagare och signerar dokumentet." />
      <PartyCard number="02" title="Utställare" fields={SENDER_FIELDS} emptyTitle="Dina uppgifter" emptyText="Lägg till företagsuppgifter för avsändaren." />
    </div>
  </section>;
}

const MODES: { mode: PricingMode; title: string; text: string }[] = [
  { mode: 'single', title: 'Ett alternativ', text: 'Erbjud ett paket med fast innehåll.' },
  { mode: 'choice', title: 'Paket', text: 'Erbjud flera paket – kunden väljer ett.' },
  { mode: 'multi', title: 'Flera val', text: 'Erbjud tillval – kunden väljer flera.' },
];

function ModeChooser({ onPick }: { onPick: (mode: PricingMode) => void }) {
  return <div className="ed-modes"><p className="ed-modes-q">Hur vill du presentera priset?</p><div className="ed-modes-grid">{MODES.map(({ mode, title, text }) => <button key={mode} type="button" className={`ed-mode ed-mode-${mode}`} onClick={() => onPick(mode)}>
    <span className="ed-mode-art" aria-hidden="true">{(mode === 'single' ? [0] : [0, 1, 2]).map(i => <span key={i} className={mode === 'choice' && i === 1 ? 'on' : mode === 'multi' && i < 2 ? 'on' : ''}><i /><b /><b /></span>)}</span>
    <strong>{title}</strong><span>{text}</span>
  </button>)}</div></div>;
}

function NumberInput({ value, onChange, label, step = 1, className = '' }: { value: number; onChange: (value: number) => void; label: string; step?: number; className?: string }) {
  const [text, setText] = useState(String(value || ''));
  useLayoutEffect(() => { if (Number(text.replace(',', '.')) !== value) setText(value ? String(value) : ''); }, [value]);
  return <input className={`ed-num ${className}`} inputMode="decimal" aria-label={label} placeholder="0" step={step} value={text} onChange={event => { const next = event.target.value.replace(/[^\d.,-]/g, ''); setText(next); onChange(Number(next.replace(',', '.')) || 0); }} />;
}

function ItemRow({ item, onChange, onRemove, currency, includeVat, canRemove }: { item: LineItem; onChange: (patch: Partial<LineItem>) => void; onRemove: () => void; currency: string; includeVat: boolean; canRemove: boolean }) {
  const { preview } = useEditorApi();
  const [open, setOpen] = useState(false);
  const amount = lineAmounts(item, includeVat);
  const sum = includeVat ? amount.net + amount.vat : amount.net;
  if (preview) return <div className="ed-item-view"><span className="ed-item-name">{item.name || '—'}{item.discount > 0 && <em>−{item.discount} %</em>}</span><span className="muted">{item.quantity} {item.unit} × {money(item.price, currency)}</span><strong>{money(sum, currency)}</strong></div>;
  return <div className={`ed-item${open ? ' open' : ''}`}>
    <input className="ed-item-name-input" aria-label="Vara eller tjänst" placeholder="T.ex. arbete & material" value={item.name} onChange={event => onChange({ name: event.target.value })} />
    <NumberInput label="Antal" value={item.quantity} onChange={quantity => onChange({ quantity })} className="qty" />
    <select aria-label="Enhet" value={item.unit} onChange={event => onChange({ unit: event.target.value })}>{UNITS.map(unit => <option key={unit}>{unit}</option>)}</select>
    <NumberInput label="À-pris" value={item.price} onChange={price => onChange({ price })} className="price" />
    <select aria-label="Moms" value={item.vat} onChange={event => onChange({ vat: Number(event.target.value) })}>{VAT_RATES.map(rate => <option key={rate} value={rate}>{rate} %</option>)}</select>
    <span className="ed-item-sum">{money(sum, currency)}</span>
    <span className="ed-item-actions">
      <button type="button" aria-label="Fler inställningar" title="Rabatt" aria-expanded={open} className={item.discount ? 'on' : ''} onClick={() => setOpen(value => !value)}><Ellipsis size={15} /></button>
      <button type="button" aria-label="Ta bort rad" title="Ta bort rad" disabled={!canRemove} onClick={onRemove}><X size={15} /></button>
    </span>
    {open && <div className="ed-item-more"><label>Rabatt<NumberInput label="Rabatt i procent" value={item.discount} onChange={discount => onChange({ discount: Math.min(100, Math.max(0, discount)) })} /><span>%</span></label></div>}
  </div>;
}

function PackageCard({ block, pkg, index }: { block: PricingBlock; pkg: PricePackage; index: number }) {
  const { draft, updateBlock, preview } = useEditorApi();
  const { currency, pricesIncludeVat } = draft.settings;
  const setPackages = (packages: PricePackage[]) => updateBlock<PricingBlock>(block.id, { packages });
  const set = (patch: Partial<PricePackage>) => setPackages(block.packages.map(item => item.id === pkg.id ? { ...item, ...patch } : item));
  const setItem = (id: string, patch: Partial<LineItem>) => set({ items: pkg.items.map(item => item.id === id ? { ...item, ...patch } : item) });
  const choose = () => setPackages(block.packages.map(item => block.mode === 'choice' ? { ...item, selected: item.id === pkg.id } : item.id === pkg.id ? { ...item, selected: !item.selected } : item));
  const sum = totals([pkg], draft.settings);
  const selectable = block.mode !== 'single';
  return <div className={`ed-package${selectable && pkg.selected ? ' chosen' : ''}${selectable ? ' selectable' : ''}`}>
    <div className="ed-package-head">
      {selectable && <button type="button" role={block.mode === 'choice' ? 'radio' : 'checkbox'} aria-checked={pkg.selected} aria-label={`Välj ${pkg.name || `paket ${index + 1}`}`} className={`ed-pick ${block.mode}`} onClick={choose}>{pkg.selected && <Check size={12} strokeWidth={3} />}</button>}
      <div className="grow">
        <InlineText className="ed-package-name" label="Paketets namn" placeholder="Paketets namn" value={pkg.name} onChange={name => set({ name })} />
        <InlineText className="ed-package-desc" label="Beskrivning" placeholder="Beskrivning av paketet" value={pkg.description} onChange={description => set({ description })} multiline />
      </div>
      {selectable && <strong className="ed-package-total">{money(sum.total, currency)}</strong>}
      {!preview && selectable && block.packages.length > (block.mode === 'multi' ? 1 : 2) && <button type="button" className="ed-icon-ghost" aria-label="Ta bort paket" title="Ta bort paket" onClick={() => setPackages(block.packages.filter(item => item.id !== pkg.id))}><Trash2 size={15} /></button>}
    </div>
    <div className="ed-price-form">
      {preview ? <span className="ed-pill">{PRICE_FORMS[pkg.priceForm]}{pkg.priceForm === 'hourly-cap' && pkg.cap > 0 && ` · max ${money(pkg.cap, currency)}`}</span> : <>
        <label className="ed-pill-select"><span>Prisform</span><select value={pkg.priceForm} onChange={event => set({ priceForm: event.target.value as PriceForm })}>{Object.entries(PRICE_FORMS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={13} /></label>
        {pkg.priceForm === 'hourly-cap' && <label className="ed-pill-select"><span>Maxpris</span><NumberInput label="Maxpris" value={pkg.cap} onChange={cap => set({ cap })} /><span>{currency}</span></label>}
        <span className="ed-vat-note">Priser anges <strong>{pricesIncludeVat ? 'inkl.' : 'exkl.'} moms</strong></span>
      </>}
    </div>
    <div className="ed-items">
      {!preview && <div className="ed-item ed-item-head" aria-hidden="true"><span>Vara / tjänst</span><span>Antal</span><span>Enhet</span><span>À-pris</span><span>Moms</span><span className="right">Summa</span><span /></div>}
      {pkg.items.map(item => <ItemRow key={item.id} item={item} currency={currency} includeVat={pricesIncludeVat} canRemove={pkg.items.length > 1} onChange={patch => setItem(item.id, patch)} onRemove={() => set({ items: pkg.items.filter(row => row.id !== item.id) })} />)}
      {!preview && <button type="button" className="ed-add-row" onClick={() => set({ items: [...pkg.items, newItem()] })}><Plus size={14} />Vara / tjänst</button>}
    </div>
  </div>;
}

function Summary({ block }: { block: PricingBlock }) {
  const { draft } = useEditorApi();
  const charged = chargedPackages(block);
  const sum = totals(charged, draft.settings);
  const { currency } = draft.settings;
  const estimate = charged.some(pkg => pkg.priceForm === 'estimate');
  const hourly = charged.some(pkg => pkg.priceForm === 'hourly' || pkg.priceForm === 'hourly-cap');
  const cap = charged.reduce((total, pkg) => total + (pkg.priceForm === 'hourly-cap' ? pkg.cap : 0), 0);
  return <div className="ed-summary">
    {block.mode !== 'single' && <div className="ed-summary-note">{charged.length ? `Valt: ${charged.map(pkg => pkg.name || 'Namnlöst').join(', ')}` : 'Inget valt ännu'}</div>}
    <dl>
      <div><dt>Netto</dt><dd>{money(sum.net, currency)}</dd></div>
      <div><dt>Moms</dt><dd>{money(sum.vat, currency)}</dd></div>
      {draft.settings.rounding && <div><dt>Öresavrundning</dt><dd>{money(sum.rounding, currency)}</dd></div>}
      <div className="total"><dt>{estimate ? 'Uppskattat totalt' : 'Totalt'} <span>inkl. moms</span></dt><dd>{estimate && 'ca '}{money(sum.total, currency)}</dd></div>
    </dl>
    {hourly && <p className="ed-summary-foot">{cap ? `Debiteras löpande, högst ${money(cap, currency)} exkl. moms.` : 'Debiteras löpande efter faktisk åtgång.'}</p>}
  </div>;
}

function PricingView({ block }: { block: PricingBlock }) {
  const { updateBlock, update, preview, draft } = useEditorApi();
  const [menu, setMenu] = useState(false);
  const set = (patch: Partial<PricingBlock>) => updateBlock<PricingBlock>(block.id, patch);
  if (!block.mode) return preview ? null : <section className="ed-section"><InlineText className="ed-h2" label="Rubrik" placeholder="Omfattning" value={block.title} onChange={title => set({ title })} /><ModeChooser onPick={mode => set({ mode, packages: mode === 'single' ? [{ ...block.packages[0], selected: true }] : block.packages.length > 1 ? block.packages : [block.packages[0], newPackage(1)] })} /></section>;
  return <section className="ed-section ed-pricing">
    <div className="ed-section-head">
      <InlineText className="ed-h2" label="Rubrik" placeholder="Omfattning" value={block.title} onChange={title => set({ title })} />
      {!preview && <div className="ed-menu-wrap"><button type="button" className="ed-icon-ghost" aria-label="Prisinställningar" aria-expanded={menu} onClick={() => setMenu(value => !value)}><Ellipsis size={16} /></button>
        {menu && <div className="ed-popover ed-menu" onMouseLeave={() => setMenu(false)}>
          <button type="button" onClick={() => { set({ mode: null }); setMenu(false); }}>Ändra prisupplägg</button>
          <label><span>Dölj summering</span><input type="checkbox" checked={block.hideSummary} onChange={event => set({ hideSummary: event.target.checked })} /></label>
          <label><span>Priser inkl. moms</span><input type="checkbox" checked={draft.settings.pricesIncludeVat} onChange={event => update(value => ({ ...value, settings: { ...value.settings, pricesIncludeVat: event.target.checked } }))} /></label>
          <label><span>Öresavrundning</span><input type="checkbox" checked={draft.settings.rounding} onChange={event => update(value => ({ ...value, settings: { ...value.settings, rounding: event.target.checked } }))} /></label>
        </div>}</div>}
    </div>
    {block.mode !== 'single' && <p className="ed-pricing-lead">{block.mode === 'choice' ? 'Välj det paket som passar dig bäst.' : 'Välj de alternativ du vill ha.'}</p>}
    <div className="ed-packages">{(block.mode === 'single' ? block.packages.slice(0, 1) : block.packages).map((pkg, index) => <PackageCard key={pkg.id} block={block} pkg={pkg} index={index} />)}</div>
    {!preview && block.mode !== 'single' && <button type="button" className="ed-add-package" onClick={() => set({ packages: [...block.packages, { ...newPackage(block.packages.length), selected: block.mode === 'multi' }] })}><Plus size={15} />Lägg till {block.mode === 'choice' ? 'paket' : 'alternativ'}</button>}
    {!block.hideSummary && <Summary block={block} />}
  </section>;
}

function TextView({ block }: { block: TextBlock }) {
  const { updateBlock } = useEditorApi();
  return <section className="ed-section"><RichText content={block.content} onChange={content => updateBlock<TextBlock>(block.id, { content })} /></section>;
}

function ImageView({ block }: { block: ImageBlock }) {
  const { updateBlock, preview } = useEditorApi();
  const set = (patch: Partial<ImageBlock>) => updateBlock<ImageBlock>(block.id, patch);
  if (!block.src) return preview ? null : <section className="ed-section"><ImagePick className="ed-image-drop" onPick={src => set({ src })}><ImagePlus size={22} /><strong>Ladda upp en bild</strong><span>PNG eller JPG. Stora bilder skalas ned automatiskt.</span></ImagePick></section>;
  return <section className={`ed-section ed-figure ${block.width}`}>
    <figure><img src={block.src} alt={block.caption || 'Bild'} />
      {!preview && <div className="ed-figure-tools">{(['narrow', 'wide', 'full'] as const).map(width => <button key={width} type="button" className={block.width === width ? 'active' : ''} onClick={() => set({ width })}>{width === 'narrow' ? 'Smal' : width === 'wide' ? 'Bred' : 'Hel'}</button>)}<button type="button" aria-label="Byt bild" onClick={() => set({ src: '' })}><X size={13} /></button></div>}
      <figcaption><InlineText label="Bildtext" placeholder="Bildtext (valfri)" value={block.caption} onChange={caption => set({ caption })} /></figcaption>
    </figure>
  </section>;
}

function TermsView({ block }: { block: TermsBlock }) {
  const { updateBlock, preview } = useEditorApi();
  const body = <RichText content={block.content} onChange={content => updateBlock<TermsBlock>(block.id, { content })} placeholder="Skriv villkoren här…" className="ed-terms-prose" />;
  if (preview) return <section className="ed-section ed-terms"><details><summary><span>{block.title || 'Villkor'}</span><ChevronDown size={16} /></summary>{body}</details></section>;
  return <section className="ed-section ed-terms"><InlineText className="ed-h3" label="Rubrik" placeholder="Allmänna villkor" value={block.title} onChange={title => updateBlock<TermsBlock>(block.id, { title })} />{body}</section>;
}

function SignatureView({ block }: { block: SignatureBlock }) {
  const { draft, updateBlock, preview } = useEditorApi();
  const set = (patch: Partial<SignatureBlock>) => updateBlock<SignatureBlock>(block.id, patch);
  const signers = [{ role: 'Beställare', key: 'customer.name' }, ...(block.senderSigns ? [{ role: 'Utställare', key: 'sender.name' }] : [])];
  const terms = draft.blocks.find(item => item.type === 'terms') as TermsBlock | undefined;
  return <section className="ed-section ed-signature">
    <InlineText className="ed-h2" label="Rubrik" placeholder="Signering" value={block.title} onChange={title => set({ title })} />
    <div className="ed-signers">{signers.map(signer => <div className="ed-signer" key={signer.key}><div className="ed-sign-line"><span>Signeras digitalt</span></div><div className="ed-signer-meta"><FieldToken fieldKey={signer.key} /><span>{signer.role} · Datum</span></div></div>)}</div>
    {!preview && <div className="ed-toggles">
      <label className="ed-switch"><input type="checkbox" checked={block.allowDecline} onChange={event => set({ allowDecline: event.target.checked })} /><i />Mottagaren kan neka</label>
      <label className="ed-switch"><input type="checkbox" checked={block.senderSigns} onChange={event => set({ senderSigns: event.target.checked })} /><i />Avsändaren signerar också</label>
    </div>}
    <div className="ed-sign-actions" aria-hidden={!preview}>
      {block.allowDecline && <button type="button" className="ed-decline" tabIndex={preview ? 0 : -1}>Neka</button>}
      <button type="button" className="ed-sign" tabIndex={preview ? 0 : -1}><Check size={17} strokeWidth={2.5} />Signera</button>
    </div>
    {terms && <p className="ed-sign-terms">Genom att signera godkänner du dokumentet och {terms.title ? terms.title.toLowerCase() : 'villkoren'}.</p>}
    {!fieldValue(draft, 'customer.name') && !preview && <p className="ed-hint">Lägg till kundens namn under Parter eller Fält så visas det här.</p>}
  </section>;
}
