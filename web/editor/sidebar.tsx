import { useState, type ComponentType } from 'react';
import { AlignCenter, AlignLeft, AlignRight, AtSign, ChevronDown, FileSignature, Image, LayoutTemplate, Plus, Receipt, ScrollText, Search, SeparatorHorizontal, Type, UsersRound, X, type LucideProps } from 'lucide-react';
import { useEditorApi } from './context';
import { insertField } from './rich-text';
import {
  ACCENTS, allFields, BLOCK_LABELS, COMPUTED_FIELDS, CURRENCIES, fieldValue, HEADER_BACKGROUNDS, imageDataUrl, PAGE_COLORS, SINGLE_BLOCKS, usedFields,
  type BlockType, type DocTheme, type FieldDef, type HeaderBlock, type HeaderLayout,
} from './model';

export const BLOCK_ICONS: Record<BlockType, ComponentType<LucideProps>> = { header: LayoutTemplate, parties: UsersRound, pricing: Receipt, text: Type, image: Image, terms: ScrollText, signature: FileSignature, break: SeparatorHorizontal };
const BLOCK_HINTS: Record<BlockType, string> = { header: 'Omslag med bild och titel', parties: 'Beställare och utställare', pricing: 'Paket, rader och moms', text: 'Rubriker, listor, tabeller', image: 'Bild med bildtext', terms: 'Villkor som godkänns', signature: 'Signera eller neka', break: 'Ny sida i PDF:en' };
const PALETTE: BlockType[][] = [['header', 'parties', 'pricing', 'text', 'signature'], ['image', 'terms', 'break']];
export const DRAG_TYPE = 'application/x-signhere-block';

export function BlockPalette({ onPick }: { onPick?: () => void }) {
  const { draft, addBlock } = useEditorApi();
  return <div className="ed-palette">{PALETTE.map((group, index) => <div key={index} className="ed-palette-group">{group.map(type => {
    const Icon = BLOCK_ICONS[type];
    const used = SINGLE_BLOCKS.has(type) && draft.blocks.some(block => block.type === type);
    return <button key={type} type="button" className="ed-palette-item" disabled={used} draggable={!used} title={used ? 'Finns redan i dokumentet' : 'Klicka eller dra in i dokumentet'}
      onDragStart={event => { event.dataTransfer.setData(DRAG_TYPE, type); event.dataTransfer.effectAllowed = 'copy'; }}
      onClick={() => { addBlock(type); onPick?.(); }}>
      <span className="ed-palette-icon"><Icon size={16} /></span><span className="ed-palette-text"><strong>{BLOCK_LABELS[type]}</strong><span>{used ? 'Tillagd' : BLOCK_HINTS[type]}</span></span>
    </button>;
  })}</div>)}</div>;
}

const FONTS: { key: DocTheme['font']; label: string; sample: string }[] = [{ key: 'grotesk', label: 'Grotesk', sample: 'var(--ed-font-grotesk)' }, { key: 'serif', label: 'Serif', sample: 'var(--ed-font-serif)' }, { key: 'system', label: 'System', sample: 'var(--ed-font-system)' }];
const SCALES: { key: DocTheme['scale']; label: string }[] = [{ key: 'compact', label: 'Kompakt' }, { key: 'normal', label: 'Normal' }, { key: 'large', label: 'Stor' }];
const TYPE_SCALE: [string, string, number][] = [['Titel', 'title', 56], ['Rubrik 1', 'h1', 40], ['Rubrik 2', 'h2', 28], ['Rubrik 3', 'h3', 21], ['Citat', 'quote', 18], ['Text', 'body', 16]];

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (color: string) => void; label: string }) {
  return <div className="ed-swatches" role="radiogroup" aria-label={label}>{colors.map(color => <button key={color} type="button" role="radio" aria-checked={value === color} aria-label={color} className={value === color ? 'active' : ''} style={{ background: color }} onClick={() => onChange(color)} />)}
    <label className="ed-swatch-custom" title="Egen färg"><input type="color" value={value.startsWith('#') ? value : '#0e1116'} onChange={event => onChange(event.target.value)} aria-label={`${label}, egen färg`} /><Plus size={12} /></label></div>;
}

export function DesignPanel() {
  const { draft, update } = useEditorApi();
  const setTheme = (patch: Partial<DocTheme>) => update(value => ({ ...value, theme: { ...value.theme, ...patch } }));
  const factor = draft.theme.scale === 'compact' ? 0.9 : draft.theme.scale === 'large' ? 1.1 : 1;
  const family = FONTS.find(font => font.key === draft.theme.font)?.sample;
  return <div className="ed-panel-body">
    <section className="ed-panel-section"><h3>Typsnitt</h3><div className="ed-font-grid">{FONTS.map(font => <button key={font.key} type="button" className={draft.theme.font === font.key ? 'active' : ''} aria-pressed={draft.theme.font === font.key} onClick={() => setTheme({ font: font.key })}><span style={{ fontFamily: font.sample }}>Aa</span>{font.label}</button>)}</div></section>
    <section className="ed-panel-section"><h3>Textstorlek</h3><div className="ed-segment">{SCALES.map(scale => <button key={scale.key} type="button" className={draft.theme.scale === scale.key ? 'active' : ''} aria-pressed={draft.theme.scale === scale.key} onClick={() => setTheme({ scale: scale.key })}>{scale.label}</button>)}</div>
      <div className="ed-type-scale" style={{ fontFamily: family }}>{TYPE_SCALE.map(([label, key, size]) => <div key={key} className={`ed-type-${key}`}><span style={{ fontSize: Math.min(size * factor, 30), color: key === 'h3' ? draft.theme.accent : undefined }}>{label}</span><small>{Math.round(size * factor)} px</small></div>)}</div></section>
    <section className="ed-panel-section"><h3>Accentfärg</h3><p className="ed-panel-hint">Används för siffror, summor, citat och länkar.</p><Swatches label="Accentfärg" colors={ACCENTS} value={draft.theme.accent} onChange={accent => setTheme({ accent })} /></section>
    <section className="ed-panel-section"><h3>Sidfärg</h3><Swatches label="Sidfärg" colors={PAGE_COLORS} value={draft.theme.pageColor} onChange={pageColor => setTheme({ pageColor })} /></section>
  </div>;
}

export function FieldsPanel() {
  const { draft, setField, update, activeEditor, preview } = useEditorApi();
  const [query, setQuery] = useState('');
  const [showUnused, setShowUnused] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const used = usedFields(draft);
  const match = (field: FieldDef) => field.label.toLowerCase().includes(query.trim().toLowerCase());
  const fields = allFields(draft).filter(match);
  const addField = () => {
    const label = name.trim();
    if (!label) return;
    const key = `custom.${label.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'falt'}-${draft.customFields.length + 1}`;
    update(value => ({ ...value, customFields: [...value.customFields, { key, label, group: 'custom' }] }));
    setName(''); setAdding(false);
  };
  const row = (field: FieldDef) => <div key={field.key} className="ed-field-row">
    <label><span>{field.label}</span>{COMPUTED_FIELDS.has(field.key) ? <input value={fieldValue(draft, field.key)} readOnly title="Beräknas automatiskt" /> : <input value={draft.fields[field.key] ?? ''} placeholder="Tomt" onChange={event => setField(field.key, event.target.value)} />}</label>
    {!preview && <button type="button" className="ed-icon-ghost" aria-label={`Infoga ${field.label}`} title="Infoga i markerad text" disabled={!activeEditor.current} onMouseDown={event => event.preventDefault()} onClick={() => { if (activeEditor.current && !activeEditor.current.isDestroyed) insertField(activeEditor.current, field.key); }}><AtSign size={14} /></button>}
    {field.group === 'custom' && !used.has(field.key) && <button type="button" className="ed-icon-ghost" aria-label={`Ta bort ${field.label}`} onClick={() => update(value => ({ ...value, customFields: value.customFields.filter(item => item.key !== field.key) }))}><X size={14} /></button>}
  </div>;
  const usedList = fields.filter(field => used.has(field.key));
  const unusedList = fields.filter(field => !used.has(field.key));
  return <div className="ed-panel-body">
    <section className="ed-panel-section"><h3>Dynamiska fält</h3><p className="ed-panel-hint">Fält fylls i automatiskt där de används. Skriv <kbd>@</kbd> i en text för att infoga ett.</p>
      <div className="ed-field-tools"><label className="ed-search"><Search size={14} aria-hidden="true" /><input value={query} placeholder="Sök fält" onChange={event => setQuery(event.target.value)} /></label><button type="button" className="button secondary small" onClick={() => setAdding(value => !value)}><Plus size={14} />Nytt</button></div>
      {adding && <form className="ed-add-field" onSubmit={event => { event.preventDefault(); addField(); }}><input autoFocus value={name} placeholder="Fältets namn, t.ex. Projektnummer" onChange={event => setName(event.target.value)} /><button className="button small" disabled={!name.trim()}>Lägg till</button></form>}
    </section>
    <section className="ed-panel-section"><h3>Använda fält <span className="ed-count">{usedList.length}</span></h3><div className="ed-field-rows">{usedList.map(row)}{!usedList.length && <p className="ed-panel-hint">Inga fält används ännu.</p>}</div></section>
    <section className="ed-panel-section"><button type="button" className="ed-collapse" aria-expanded={showUnused} onClick={() => setShowUnused(value => !value)}><h3>Oanvända fält <span className="ed-count">{unusedList.length}</span></h3><ChevronDown size={15} /></button>{showUnused && <div className="ed-field-rows">{unusedList.map(row)}</div>}</section>
  </div>;
}

export function SettingsPanel() {
  const { draft, update } = useEditorApi();
  const setSettings = (patch: Partial<typeof draft.settings>) => update(value => ({ ...value, settings: { ...value.settings, ...patch } }));
  return <div className="ed-panel-body">
    <section className="ed-panel-section ed-settings">
      <h3>Dokument</h3>
      <label><span>Avsändare</span><input value={draft.fields['sender.name'] ?? ''} onChange={event => update(value => ({ ...value, fields: { ...value.fields, 'sender.name': event.target.value } }))} /></label>
      <label><span>Giltig i</span><span className="ed-input-suffix"><input type="number" min={1} max={365} value={draft.settings.expiresInDays} onChange={event => setSettings({ expiresInDays: Math.min(365, Math.max(1, Number(event.target.value) || 1)) })} /><em>dagar</em></span></label>
    </section>
    <section className="ed-panel-section ed-settings">
      <h3>Priser</h3>
      <label><span>Valuta</span><select value={draft.settings.currency} onChange={event => setSettings({ currency: event.target.value })}>{CURRENCIES.map(currency => <option key={currency}>{currency}</option>)}</select></label>
      <label><span>Priser anges</span><select value={draft.settings.pricesIncludeVat ? 'incl' : 'excl'} onChange={event => setSettings({ pricesIncludeVat: event.target.value === 'incl' })}><option value="excl">exkl. moms</option><option value="incl">inkl. moms</option></select></label>
      <label className="ed-switch"><input type="checkbox" checked={draft.settings.rounding} onChange={event => setSettings({ rounding: event.target.checked })} /><i />Öresavrundning</label>
    </section>
    <p className="ed-panel-hint">Utkast sparas automatiskt i den här webbläsaren.</p>
  </div>;
}

const LAYOUTS: { key: HeaderLayout; label: string }[] = [{ key: 'split-left', label: 'Bild vänster' }, { key: 'split-right', label: 'Bild höger' }, { key: 'image-top', label: 'Bild överst' }, { key: 'cover', label: 'Helbild' }, { key: 'boxed', label: 'Ruta' }, { key: 'plain', label: 'Utan bild' }];

export function HeaderSettings({ block, onClose }: { block: HeaderBlock; onClose: () => void }) {
  const { updateBlock } = useEditorApi();
  const [error, setError] = useState('');
  const set = (patch: Partial<HeaderBlock>) => updateBlock<HeaderBlock>(block.id, patch);
  return <aside className="ed-drawer" aria-label="Omslagsinställningar">
    <div className="ed-drawer-head"><h2>Omslag</h2><button type="button" className="ed-icon-ghost" aria-label="Stäng" onClick={onClose}><X size={18} /></button></div>
    <div className="ed-panel-body">
      <section className="ed-panel-section"><h3>Layout</h3><div className="ed-layouts">{LAYOUTS.map(layout => <button key={layout.key} type="button" title={layout.label} aria-label={layout.label} aria-pressed={block.layout === layout.key} className={`ed-layout ed-layout-${layout.key}${block.layout === layout.key ? ' active' : ''}`} onClick={() => set({ layout: layout.key })}><i /><b /></button>)}</div></section>
      {block.layout !== 'plain' && <section className="ed-panel-section"><h3>Bakgrund</h3>
        <div className="ed-bg-grid">{HEADER_BACKGROUNDS.map(background => <button key={background.key} type="button" title={background.label} aria-label={background.label} aria-pressed={block.background === background.key} className={block.background === background.key ? 'active' : ''} style={{ background: background.css }} onClick={() => set({ background: background.key })} />)}
          <label className={`ed-bg-upload${block.background.startsWith('data:') ? ' active' : ''}`} style={block.background.startsWith('data:') ? { background: `center / cover url("${block.background}")` } : undefined} title="Ladda upp bild"><input type="file" accept="image/*" hidden onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { setError(''); set({ background: await imageDataUrl(file) }); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Bilden kunde inte läsas.'); } }} />{!block.background.startsWith('data:') && <Plus size={16} />}</label>
        </div>{error && <p className="ed-panel-error">{error}</p>}
        {(block.layout === 'cover' || block.layout === 'boxed') && <label className="ed-range"><span>Bildfilter</span><input type="range" min={0} max={0.85} step={0.05} value={block.overlay} onChange={event => set({ overlay: Number(event.target.value) })} /><em>{Math.round(block.overlay * 100)} %</em></label>}
      </section>}
      <section className="ed-panel-section ed-color-rows">
        <label><span>Bakgrundsfärg</span><input type="color" value={block.backgroundColor} onChange={event => set({ backgroundColor: event.target.value })} /></label>
        <label><span>Textfärg</span><input type="color" value={block.textColor} onChange={event => set({ textColor: event.target.value })} /></label>
        <div className="ed-color-row"><span>Justering</span><div className="ed-segment icons">{([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([align, Icon]) => <button key={align} type="button" aria-label={align} aria-pressed={block.align === align} className={block.align === align ? 'active' : ''} onClick={() => set({ align })}><Icon size={15} /></button>)}</div></div>
        <label className="ed-switch"><input type="checkbox" checked={block.showMeta} onChange={event => set({ showMeta: event.target.checked })} /><i />Visa mottagare och avsändare</label>
      </section>
    </div>
  </aside>;
}

