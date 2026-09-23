import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { ArrowDown, ArrowUp, Check, Plus, X } from 'lucide-react';
import { useEditorApi } from './context';
import { FieldToken, insertField, RichText, TokenText } from './rich-text';
import {
  backgroundCss, backgroundIsDark, BLOCK_LABELS, chargedPackages, CHIP_FIELDS, contentIsEmpty, expiryDate, fieldLabel, fieldValue, HEADER_BACKGROUNDS, HEADER_LAYOUTS, imageData, isImageBackground,
  lineAmounts, money, newItem, newPackage, PRICE_FORMS, PRICING_MODES, shortDate, shownPackages, SIGNATURE_ID, signers, SINGLE_BLOCKS, totals, UNITS, VAT_RATES,
  type Block, type HeaderBlock, type ImageBlock, type LineItem, type PriceForm, type PricePackage, type PricingBlock, type PricingMode, type TermsBlock, type TextBlock,
} from './model';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/* ---------- Options row controls ---------- */

export function Segmented<T extends string>({ label, items, value, onChange }: { label?: string; items: [T, string][]; value: T; onChange: (value: T) => void }) {
  return <div className="ed-opt">{label && <span className="ed-opt-label">{label}</span>}
    <div className="ed-seg" role="radiogroup" aria-label={label}>{items.map(([key, text]) => <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>{text}</button>)}</div>
  </div>;
}
export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="ed-opt ed-toggle"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>;
}
function OptSelect<T extends string>({ label, items, value, onChange }: { label: string; items: [T, string][]; value: T; onChange: (value: T) => void }) {
  return <label className="ed-opt"><span className="ed-opt-label">{label}</span><select className="ed-opt-select" value={value} onChange={event => onChange(event.target.value as T)}>{items.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}
function OptButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="ed-opt ed-opt-button" onClick={onClick}>{children}</button>;
}
function Options({ children }: { children: ReactNode }) {
  return <div className="ed-options">{children}</div>;
}

function useSelected(id: string) {
  const { preview, selectedId } = useEditorApi();
  return !preview && selectedId === id;
}

function NumberInput({ value, onChange, label, className = '', placeholder = '0', readOnly = false }: { value: number; onChange: (value: number) => void; label: string; className?: string; placeholder?: string; readOnly?: boolean }) {
  const [text, setText] = useState(value ? String(value) : '');
  useLayoutEffect(() => { if ((Number(text.replace(/\s/g, '').replace(',', '.')) || 0) !== value) setText(value ? String(value) : ''); }, [value]);
  return <input className={className} inputMode="decimal" aria-label={label} placeholder={placeholder} readOnly={readOnly} value={text}
    onChange={event => { const next = event.target.value.replace(/[^\d.,\s-]/g, ''); setText(next); onChange(Number(next.replace(/\s/g, '').replace(',', '.')) || 0); }} />;
}

function useImagePicker(onPick: (image: { url: string; ratio: string }) => void) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const element = <input ref={input} type="file" accept="image/*" hidden onChange={async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try { onPick(await imageData(file)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Bilden kunde inte läsas.'); } finally { setBusy(false); }
  }} />;
  return { open: () => input.current?.click(), busy, error, element };
}

function AutoTextarea({ value, onChange, className, placeholder, label }: { value: string; onChange: (value: string) => void; className: string; placeholder: string; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { paperWidth } = useEditorApi();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || CSS.supports('field-sizing', 'content')) return;
    element.style.height = 'auto'; element.style.height = `${element.scrollHeight}px`;
  }, [value, paperWidth]);
  return <textarea ref={ref} rows={1} className={className} aria-label={label} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} />;
}

/* ---------- Frame ---------- */

export function BlockFrame({ block, index, count, children }: { block: Block; index: number; count: number; children: ReactNode }) {
  const api = useEditorApi();
  const selected = !api.preview && api.selectedId === block.id;
  const label = BLOCK_LABELS[block.type];
  return <div className={`ed-block ed-block-${block.type}${selected ? ' selected' : ''}${api.fresh === block.id ? ' fresh' : ''}`} data-block={block.id} onMouseDown={() => api.select(block.id)}>
    {selected && <div className="ed-toolbar" role="toolbar" aria-label={`${label}-block`}>
      <span className="ed-toolbar-label">{label}</span>
      <button type="button" aria-label="Flytta upp" title="Flytta upp (Alt+↑)" disabled={index === 0} onClick={() => api.moveBlock(block.id, -1)}><ArrowUp size={14} /></button>
      <button type="button" aria-label="Flytta ner" title="Flytta ner (Alt+↓)" disabled={index === count - 1} onClick={() => api.moveBlock(block.id, 1)}><ArrowDown size={14} /></button>
      {!SINGLE_BLOCKS.has(block.type) && <button type="button" className="text" title={`Kopiera (${MOD}D)`} onClick={() => api.copyBlock(block.id)}>Kopiera</button>}
      <button type="button" className="text danger" title="Ta bort (Delete)" onClick={() => api.removeBlock(block.id)}>Ta bort</button>
    </div>}
    {children}
  </div>;
}

export function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'header': return <HeaderView block={block} />;
    case 'parties': return <PartiesView />;
    case 'pricing': return <PricingView block={block} />;
    case 'text': return <RichBlock block={block} />;
    case 'terms': return <RichBlock block={block} />;
    case 'image': return <ImageView block={block} />;
    case 'break': return <div className="ed-break"><span>Ny sida</span></div>;
  }
}

/* ---------- Omslag ---------- */

function HeaderView({ block }: { block: HeaderBlock }) {
  const { draft, updateBlock, preview } = useEditorApi();
  const selected = useSelected(block.id);
  const set = (patch: Partial<HeaderBlock>) => updateBlock<HeaderBlock>(block.id, patch);
  const picker = useImagePicker(({ url }) => set({ background: url }));
  const panel = block.layout === 'boxed' || block.layout === 'cover';
  const dark = panel && backgroundIsDark(block.background);
  const uploaded = isImageBackground(block.background);
  const meta: [string, string][] = [['Till', draft.company?.name || '—'], ['Från', fieldValue(draft, 'sender.company')], ['Datum', shortDate(new Date())], ['Giltig till', shortDate(expiryDate(draft))]];
  return <>
    {selected && <Options>
      <Segmented label="Layout" items={HEADER_LAYOUTS} value={block.layout} onChange={layout => set({ layout })} />
      {block.layout !== 'plain' && <div className="ed-opt"><span className="ed-opt-label">Bakgrund</span><div className="ed-bg-swatches">
        {HEADER_BACKGROUNDS.map(background => <button key={background.key} type="button" title={background.label} aria-label={background.label} aria-pressed={block.background === background.key} className={block.background === background.key ? 'active' : ''} style={{ background: background.css }} onClick={() => set({ background: background.key })} />)}
        <button type="button" title="Ladda upp bild" aria-label="Ladda upp bild" aria-pressed={uploaded} className={`upload${uploaded ? ' active' : ''}`} style={uploaded ? { background: backgroundCss(block.background) } : undefined} disabled={picker.busy} onClick={picker.open}>{!uploaded && <Plus size={12} />}</button>
        {picker.element}
      </div></div>}
      <Segmented label="Justering" items={[['left', 'Vänster'], ['center', 'Mitten']]} value={block.align} onChange={align => set({ align })} />
      <Toggle label="Visa uppgifter" checked={block.showMeta} onChange={showMeta => set({ showMeta })} />
      {picker.error && <span className="ed-opt-error">{picker.error}</span>}
    </Options>}
    <div className={`ed-cover ed-cover-${block.layout}${panel ? ' panel' : ''}${dark ? ' dark' : ''}`} style={{ textAlign: block.align }}>
      {block.layout === 'split-left' && <div className="ed-cover-art" style={{ background: backgroundCss(block.background) }} />}
      <div className="ed-cover-body" style={panel ? { background: backgroundCss(block.background, true) } : undefined}>
        {preview ? block.eyebrow && <div className="ed-cover-eyebrow"><TokenText value={block.eyebrow} /></div>
          : <input className="ed-bare ed-cover-eyebrow" aria-label="Typ av dokument" placeholder="Typ av dokument" value={block.eyebrow} onChange={event => set({ eyebrow: event.target.value })} />}
        {preview ? <h1 className="ed-cover-title"><TokenText value={block.title} /></h1>
          : <AutoTextarea className="ed-bare ed-cover-title" label="Titel" placeholder="Titel" value={block.title} onChange={title => set({ title })} />}
        {block.showMeta && <dl className="ed-cover-meta">{meta.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      </div>
    </div>
  </>;
}

/* ---------- Parter ---------- */

function PartiesView() {
  const { draft } = useEditorApi();
  const company = draft.company;
  const address = company ? [company.address, [company.zip, company.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  return <div className="ed-parties">
    <div className="ed-party">
      <div className="ed-mono">Från</div>
      <strong>{fieldValue(draft, 'sender.company')}</strong>
      <span className="secondary">{fieldValue(draft, 'sender.name')}</span>
      <span>{fieldValue(draft, 'sender.email')}</span>
    </div>
    <div className="ed-party">
      <div className="ed-mono">Till</div>
      {company ? <>
        <strong>{company.name}</strong>
        {company.orgNr && <span className="small">Org.nr {company.orgNr}</span>}
        {address && <span className="small">{address}</span>}
        {company.contacts.filter(contact => contact.signs).map(contact => <div key={contact.id} className="ed-party-contact"><span className="secondary">{contact.name}{contact.role && `, ${contact.role}`}</span><span>{contact.email}</span></div>)}
      </> : <div className="ed-party-empty">Fylls i från mottagarlistan</div>}
    </div>
  </div>;
}

/* ---------- Text & Villkor ---------- */

function RichBlock({ block }: { block: TextBlock | TermsBlock }) {
  const { draft, updateBlock, preview } = useEditorApi();
  const selected = useSelected(block.id);
  const editor = useRef<Editor | null>(null);
  const heading = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<TextBlock | TermsBlock>) => updateBlock<TextBlock | TermsBlock>(block.id, patch);
  const empty = contentIsEmpty(block.content) && !block.title.trim();
  const placeholder = !preview && !selected && empty;
  useEffect(() => { if (selected && empty) requestAnimationFrame(() => editor.current?.commands.focus('end')); }, [selected]);
  const insert = (key: string) => {
    const input = heading.current;
    if (input && document.activeElement === input) {
      const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start, token = `{{${key}}}`;
      set({ title: block.title.slice(0, start) + token + block.title.slice(end) });
      requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + token.length, start + token.length); });
    } else if (editor.current && !editor.current.isDestroyed) insertField(editor.current, key);
  };
  return <>
    {selected ? <input ref={heading} className="ed-bare ed-heading" aria-label="Rubrik" placeholder="Rubrik (valfri)" value={block.title} onChange={event => set({ title: event.target.value })} />
      : block.title.trim() && <h2 className="ed-heading"><TokenText value={block.title} /></h2>}
    {placeholder && <p className="ed-text-empty">Tom text – klicka för att skriva.</p>}
    <div className="ed-body" hidden={placeholder}><RichText editorRef={editor} content={block.content} onChange={content => set({ content })} /></div>
    {selected && <div className="ed-chips"><span>Infoga fält</span>{CHIP_FIELDS.map(key => <button key={key} type="button" onMouseDown={event => { event.preventDefault(); insert(key); }}>{fieldLabel(draft, key)}</button>)}</div>}
    {block.type === 'terms' && <div className="ed-terms-note"><span aria-hidden="true" />Mottagaren godkänner villkoren när dokumentet signeras.</div>}
  </>;
}

/* ---------- Bild ---------- */

function ImageView({ block }: { block: ImageBlock }) {
  const { updateBlock, preview } = useEditorApi();
  const selected = useSelected(block.id);
  const set = (patch: Partial<ImageBlock>) => updateBlock<ImageBlock>(block.id, patch);
  const picker = useImagePicker(({ url, ratio }) => set({ src: url, ratio }));
  return <>
    {selected && <Options>
      <Segmented label="Bredd" items={[['narrow', 'Smal'], ['wide', 'Bred'], ['full', 'Full']]} value={block.width} onChange={width => set({ width })} />
      {block.src && <><OptButton onClick={picker.open}>Byt bild</OptButton><OptButton onClick={() => set({ src: '', ratio: '' })}>Ta bort bild</OptButton></>}
      {picker.error && <span className="ed-opt-error">{picker.error}</span>}
    </Options>}
    {picker.element}
    <figure className={`ed-figure ${block.width}`}>
      {block.src ? <img src={block.src} alt={block.caption || 'Bild'} style={{ aspectRatio: block.ratio || undefined }} />
        : !preview && <button type="button" className="ed-image-empty" disabled={picker.busy} onClick={picker.open}>{picker.busy ? 'laddar bild…' : 'bild · klicka för att välja fil'}</button>}
      {selected && block.src ? <input className="ed-bare ed-caption" aria-label="Bildtext" placeholder="Bildtext (valfri)" value={block.caption} onChange={event => set({ caption: event.target.value })} />
        : block.src && block.caption.trim() && <figcaption className="ed-caption">{block.caption}</figcaption>}
    </figure>
  </>;
}

/* ---------- Priser ---------- */

function PricingView({ block }: { block: PricingBlock }) {
  const { draft, updateBlock, preview, paperWidth } = useEditorApi();
  const selected = useSelected(block.id);
  const { currency, pricesIncludeVat } = draft.settings;
  const set = (patch: Partial<PricingBlock> | ((block: PricingBlock) => Partial<PricingBlock>)) => updateBlock<PricingBlock>(block.id, patch);
  const setPackage = (id: string, patch: Partial<PricePackage> | ((pkg: PricePackage) => Partial<PricePackage>)) => set(current => ({ packages: current.packages.map(pkg => pkg.id === id ? { ...pkg, ...(typeof patch === 'function' ? patch(pkg) : patch) } : pkg) }));
  const setMode = (mode: PricingMode) => set(current => {
    let packages = current.packages.map((pkg, index) => ({ ...pkg, name: pkg.name || (mode === 'single' ? '' : `Paket ${index + 1}`) }));
    if (mode !== 'single' && packages.length < 2) packages = [...packages, newPackage('Paket 2', mode === 'multi')];
    if (mode === 'choice') { const chosen = Math.max(0, packages.findIndex(pkg => pkg.selected)); packages = packages.map((pkg, index) => ({ ...pkg, selected: index === chosen })); }
    return { mode, packages };
  });
  const toggle = (id: string) => set(current => ({ packages: current.packages.map(pkg => current.mode === 'choice' ? { ...pkg, selected: pkg.id === id } : pkg.id === id ? { ...pkg, selected: !pkg.selected } : pkg) }));

  const multi = block.mode !== 'single';
  const first = block.packages[0];
  const charged = chargedPackages(block);
  const sum = totals(block, charged, draft.settings);
  const extra = (block.showDiscount ? 1 : 0) + (block.vatPerRow ? 1 : 0);
  const compact = paperWidth < 600 + extra * 76 + (multi ? 34 : 0);
  const middle = compact ? `${block.showDiscount ? ' 44px' : ''}${block.vatPerRow ? ' 58px' : ''}` : `${block.showDiscount ? ' 60px' : ''}${block.vatPerRow ? ' 64px' : ''}`;
  const columns = compact ? `${extra ? '40px 40px' : '52px 52px'} minmax(48px,1fr)${middle} minmax(max-content,1fr)` : `minmax(0,1fr) 52px 52px 92px${middle} 100px 28px`;
  const table = { columns, compact, edit: !preview, showDiscount: block.showDiscount, vatPerRow: block.vatPerRow, currency, pricesIncludeVat };
  const allFixed = charged.every(pkg => pkg.priceForm === 'fixed');
  const formLabel = (form: PriceForm) => PRICE_FORMS.find(([key]) => key === form)![1];
  const note = multi ? (block.mode === 'choice' ? 'Kunden väljer ett paket när dokumentet signeras.' : 'Kunden kan välja flera paket när dokumentet signeras.')
    : first?.priceForm === 'estimate' ? 'Ungefärligt pris. Slutligt belopp kan avvika.'
    : first?.priceForm === 'hourly' ? 'Löpande räkning. Faktureras efter nedlagd tid.'
    : first?.priceForm === 'hourly-cap' ? (first.cap ? `Löpande räkning, maxpris ${money(first.cap, currency)} exkl. moms.` : 'Löpande räkning med maxpris.') : '';

  return <>
    {selected && <Options>
      <Segmented label="Upplägg" items={PRICING_MODES} value={block.mode} onChange={setMode} />
      {!multi && first && <OptSelect label="Prisform" items={PRICE_FORMS} value={first.priceForm} onChange={priceForm => setPackage(first.id, { priceForm })} />}
      {!multi && first?.priceForm === 'hourly-cap' && <label className="ed-opt"><span className="ed-opt-label">Maxpris</span><NumberInput className="ed-opt-number" label="Maxpris" value={first.cap} onChange={cap => setPackage(first.id, { cap })} /></label>}
      <Toggle label="Rabatt" checked={block.showDiscount} onChange={showDiscount => set({ showDiscount })} />
      <Toggle label="Moms per rad" checked={block.vatPerRow} onChange={vatPerRow => set({ vatPerRow })} />
    </Options>}
    {preview ? block.title && <h2 className="ed-heading spaced">{block.title}</h2>
      : <input className="ed-bare ed-heading spaced" aria-label="Rubrik" placeholder="Rubrik" value={block.title} onChange={event => set({ title: event.target.value })} />}
    {shownPackages(block).map(pkg => {
      const subtotal = totals(block, [pkg], draft.settings).net;
      return <div key={pkg.id} className={`ed-package${multi ? ' card' : ''}${multi && pkg.selected ? ' chosen' : ''}`}>
        {multi && <div className="ed-package-head">
          <button type="button" role={block.mode === 'choice' ? 'radio' : 'checkbox'} aria-checked={pkg.selected} aria-label={block.mode === 'choice' ? 'Förvalt paket' : 'Förvald'} title={block.mode === 'choice' ? 'Förvalt paket' : 'Förvald'} className={`ed-pick ${block.mode}${pkg.selected ? ' on' : ''}`} onClick={() => toggle(pkg.id)}>{pkg.selected && <Check size={13} strokeWidth={3} />}</button>
          <div className="ed-package-text">
            {preview ? <><div className="ed-package-name">{pkg.name}</div>{pkg.description && <div className="ed-package-desc">{pkg.description}</div>}</>
              : <><input className="ed-bare ed-package-name" aria-label="Paketets namn" placeholder="Paketets namn" value={pkg.name} onChange={event => setPackage(pkg.id, { name: event.target.value })} />
                <input className="ed-bare ed-package-desc" aria-label="Beskrivning" placeholder="Kort beskrivning" value={pkg.description} onChange={event => setPackage(pkg.id, { description: event.target.value })} /></>}
          </div>
          {preview ? pkg.priceForm !== 'fixed' && <span className="ed-form-chip">{formLabel(pkg.priceForm)}{pkg.priceForm === 'hourly-cap' && pkg.cap > 0 && ` · max ${money(pkg.cap, currency)}`}</span>
            : <div className="ed-package-tools">
              <select className="ed-opt-select" aria-label="Prisform" value={pkg.priceForm} onChange={event => setPackage(pkg.id, { priceForm: event.target.value as PriceForm })}>{PRICE_FORMS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select>
              {pkg.priceForm === 'hourly-cap' && <NumberInput className="ed-opt-number narrow" label="Maxpris" placeholder="Maxpris" value={pkg.cap} onChange={cap => setPackage(pkg.id, { cap })} />}
              {block.packages.length > 1 && <button type="button" className="ed-x" aria-label="Ta bort paket" title="Ta bort paket" onClick={() => set(current => ({ packages: current.packages.filter(item => item.id !== pkg.id) }))}><X size={16} /></button>}
            </div>}
        </div>}
        <PriceTable {...table} items={pkg.items}
          onChange={(id, patch) => setPackage(pkg.id, current => ({ items: current.items.map(item => item.id === id ? { ...item, ...patch } : item) }))}
          onRemove={id => setPackage(pkg.id, current => ({ items: current.items.filter(item => item.id !== id) }))} />
        {!preview && <button type="button" className="ed-add-row" onClick={() => setPackage(pkg.id, current => ({ items: [...current.items, newItem()] }))}>+ Rad</button>}
        {multi && <div className="ed-subtotal"><span>Paketpris exkl. moms</span><strong>{money(subtotal, currency)}</strong></div>}
      </div>;
    })}
    {!preview && multi && <button type="button" className="ed-add-package" onClick={() => set(current => ({ packages: [...current.packages, newPackage(`Paket ${current.packages.length + 1}`, false)] }))}>+ Paket</button>}
    <div className="ed-totals">
      <div><span>Netto</span><span>{money(sum.net, currency)}</span></div>
      <div><span>{block.vatPerRow ? 'Moms' : 'Moms 25 %'}</span><span>{money(sum.vat, currency)}</span></div>
      <div className="total"><span>{allFixed ? 'Totalt' : 'Uppskattat totalt'}</span><strong>{money(sum.total, currency)}</strong></div>
      {note && <p>{note}</p>}
    </div>
  </>;
}

type TableProps = { items: LineItem[]; columns: string; compact: boolean; edit: boolean; showDiscount: boolean; vatPerRow: boolean; currency: string; pricesIncludeVat: boolean; onChange: (id: string, patch: Partial<LineItem>) => void; onRemove: (id: string) => void };

function PriceTable({ items, columns, compact, edit, showDiscount, vatPerRow, currency, pricesIncludeVat, onChange, onRemove }: TableProps) {
  const grid = { gridTemplateColumns: columns } as CSSProperties;
  return <div className={`ed-table${compact ? ' compact' : ''}`}>
    <div className="ed-row ed-row-head" style={grid} aria-hidden="true">
      {!compact && <span>Beskrivning</span>}<span className="num">Antal</span><span>Enhet</span><span className="num">À-pris</span>
      {showDiscount && <span className="num">Rabatt %</span>}{vatPerRow && <span className="num">Moms</span>}<span className="num">Summa</span>{!compact && <span />}
    </div>
    {items.map(item => {
      const sum = lineAmounts(item, pricesIncludeVat, vatPerRow).gross;
      const set = (patch: Partial<LineItem>) => onChange(item.id, patch);
      const nameStyle = compact ? { gridColumn: edit ? '1 / -2' : '1 / -1', gridRow: 1 } : undefined;
      return <div key={item.id} className="ed-row" style={grid}>
        {edit ? <input className="ed-cell ed-cell-name" style={nameStyle} aria-label="Beskrivning" placeholder="Vad ingår?" value={item.name} onChange={event => set({ name: event.target.value })} />
          : <span className="ed-cell ed-cell-name" style={nameStyle}>{item.name || '—'}</span>}
        {edit ? <NumberInput className="ed-cell num" label="Antal" value={item.quantity} onChange={quantity => set({ quantity })} /> : <span className="ed-cell num">{item.quantity}</span>}
        {edit ? <input className="ed-cell muted" aria-label="Enhet" list="ed-units" value={item.unit} onChange={event => set({ unit: event.target.value })} /> : <span className="ed-cell muted">{item.unit}</span>}
        {edit ? <NumberInput className="ed-cell num" label="À-pris" value={item.price} onChange={price => set({ price })} /> : <span className="ed-cell num">{item.price.toLocaleString('sv-SE')}</span>}
        {showDiscount && (edit ? <NumberInput className="ed-cell num" label="Rabatt i procent" value={item.discount} onChange={discount => set({ discount: Math.min(100, Math.max(0, discount)) })} /> : <span className="ed-cell num">{item.discount}</span>)}
        {vatPerRow && (edit ? <select className="ed-cell num" aria-label="Moms" value={item.vat} onChange={event => set({ vat: Number(event.target.value) })}>{VAT_RATES.map(rate => <option key={rate} value={rate}>{rate} %</option>)}</select> : <span className="ed-cell num">{item.vat} %</span>)}
        <span className="ed-cell num ed-sum">{money(sum, currency)}</span>
        {edit && <button type="button" className="ed-x small" style={compact ? { gridColumn: '-2 / -1', gridRow: 1 } : undefined} aria-label="Ta bort rad" title="Ta bort rad" onClick={() => onRemove(item.id)}><X size={15} /></button>}
      </div>;
    })}
  </div>;
}

export const UnitList = () => <datalist id="ed-units">{UNITS.map(unit => <option key={unit} value={unit} />)}</datalist>;

/* ---------- Signaturer (always last) ---------- */

export function SignatureSection() {
  const { draft, user, preview, select, update } = useEditorApi();
  const selected = useSelected(SIGNATURE_ID);
  const list = signers(draft, user);
  const { allowDecline, senderSigns } = draft.settings;
  const setSettings = (patch: Partial<typeof draft.settings>) => update(current => ({ ...current, settings: { ...current.settings, ...patch } }));
  return <section className={`ed-block ed-signatures${selected ? ' selected' : ''}`} data-block={SIGNATURE_ID} onMouseDown={() => select(SIGNATURE_ID)} aria-label="Signaturer">
    {selected && <Options>
      <Toggle label="Mottagaren kan neka" checked={allowDecline} onChange={value => setSettings({ allowDecline: value })} />
      <Toggle label="Jag signerar också" checked={senderSigns} onChange={value => setSettings({ senderSigns: value })} />
    </Options>}
    <div className="ed-sig-head"><span className="ed-mono">Signaturer</span>{!preview && <span>Läggs alltid sist · följer mottagarlistan{allowDecline && ' · kan nekas'}</span>}</div>
    {list.length ? <div className="ed-signers">{list.map(signer => <div key={signer.id} className="ed-signer"><div className="ed-sign-line" /><strong>{signer.name || <FieldToken fieldKey="customer.name" />}</strong><span>{signer.company}</span></div>)}</div>
      : <p className="ed-muted">Inga signerare ännu.</p>}
    {preview && <div className="ed-sign-actions" aria-hidden="true"><span className="primary">Signera</span>{allowDecline && <span>Neka</span>}</div>}
  </section>;
}
