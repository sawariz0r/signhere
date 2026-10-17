import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { useEditorApi } from './context';
import { CompanyFields, CompanyPicker, ContactForm, emptyCompany, rememberContact, type CompanyDetails } from './clients';
import {
  ACCENTS, BLOCK_LABELS, companyInitials, CURRENCIES, EXPIRY_DAYS, FONTS, initials, loadBook, normalizeOrgNumber, ORG_NUMBER, resolveTokens, saveBook, signers, SIGNATURE_ID, toRecipient,
  type Block, type Company, type DocSettings, type Draft, type Issue, type RecipientCompany,
} from './model';

/** With `attachment`, signers come from the main document, so sending and signer options are hidden. */
export function SidePanel({ issues, flash, onIssue, attachment = false, review, activeClientNames }: { issues: Issue[]; flash: boolean; onIssue: (issue: Issue) => void; attachment?: boolean; review?: ReactNode; activeClientNames?: string[] }) {
  return <aside className="ed-panel" aria-label="Utskick och inställningar">
    <StatusCard issues={issues} flash={flash} onIssue={onIssue} attachment={attachment} />
    {review}
    <RecipientsCard attachment={attachment} activeClientNames={activeClientNames} />
    <OutlineCard attachment={attachment} />
    {!attachment && <SendingCard />}
    <AppearanceCard />
  </aside>;
}

function StatusCard({ issues, flash, onIssue, attachment }: { issues: Issue[]; flash: boolean; onIssue: (issue: Issue) => void; attachment: boolean }) {
  const title = !issues.length ? (attachment ? 'Klar att använda' : 'Klart att skicka') : issues.length === 1 ? '1 sak kvar' : `${issues.length} saker kvar`;
  return <section className={`ed-card ed-status${flash ? ' flash' : ''}${issues.length ? '' : ' done'}`} data-status aria-live="polite">
    <h2><span className="ed-dot" aria-hidden="true" />{title}</h2>
    {issues.length ? <div className="ed-issues">{issues.map(issue => <button key={issue.message} type="button" onClick={() => onIssue(issue)}><span>{issue.message}</span><ArrowRight size={15} aria-hidden="true" /></button>)}</div>
      : <p className="ed-card-text">{attachment ? 'Fält och priser är ifyllda.' : 'Mottagare, fält och priser är ifyllda.'}</p>}
  </section>;
}

/* ---------- Mottagare ---------- */

export function RecipientsCard({ attachment = false, activeClientNames = [] }: { attachment?: boolean; activeClientNames?: string[] }) {
  const { draft, update } = useEditorApi();
  const [editing, setEditing] = useState(false), [details, setDetails] = useState<CompanyDetails>(emptyCompany), [error, setError] = useState('');
  const [contactOpen, setContactOpen] = useState(false), [switching, setSwitching] = useState(false);
  const company = draft.company;
  const setCompany = (change: (company: RecipientCompany | null) => RecipientCompany | null) => update(current => ({ ...current, company: change(current.company) }));
  const choose = (entry: Company) => { setCompany(() => toRecipient(entry)); setSwitching(false); };
  const saveDetails = (event: FormEvent) => {
    event.preventDefault(); if (!company) return;
    if (!details.name.trim()) return setError('Ange företagets namn.');
    if (details.orgNr.trim() && !ORG_NUMBER.test(details.orgNr.trim())) return setError('Org.nr skrivs som 556123-4567.');
    const value = { ...details, name: details.name.trim(), orgNr: normalizeOrgNumber(details.orgNr.trim()) };
    setCompany(current => current && { ...current, ...value });
    saveBook(loadBook().map(entry => entry.id === company.id ? { ...entry, ...value } : entry)); setEditing(false);
  };
  return <section className="ed-card ed-recipients" data-rec-card><div className="ed-card-head"><h2>Mottagare</h2><span>{attachment ? 'Används i kundfälten' : 'Blir parter och signerare'}</span></div>
    {editing ? <form className="ed-form" onSubmit={saveDetails} noValidate><strong>Ändra företag</strong><CompanyFields value={details} onChange={value => { setDetails(value); setError(''); }} />{error && <span className="ed-error" role="alert">{error}</span>}<div className="ed-form-actions"><button type="button" className="ed-btn" onClick={() => setEditing(false)}>Avbryt</button><button className="ed-btn primary">Spara</button></div></form>
    : !company ? <CompanyPicker onChoose={choose} />
    : <div className="ed-chosen"><div className="ed-company"><div className="ed-company-main"><span className="ed-tile dark">{companyInitials(company.name)}</span><div><strong>{company.name}</strong><span>{[company.orgNr ? `Org.nr ${company.orgNr}` : 'Org.nr saknas', company.city].filter(Boolean).join(' · ')}</span></div></div><div className="ed-company-actions"><button type="button" className="ed-text-btn" onClick={() => { setDetails(company); setError(''); setEditing(true); }}>Ändra uppgifter</button><button type="button" className="ed-text-btn" onClick={() => { if (activeClientNames.length) setSwitching(true); else { setCompany(() => null); setContactOpen(false); } }}>Byt mottagare</button></div></div>
      {switching && <div className="sh-confirm" role="group" aria-label="Byt mottagare"><p>{activeClientNames.join(' och ')} har en aktiv länk. Den slutar fungera när du sparar utkastet med en ny mottagare. Den nya mottagaren får en egen länk när du delar.</p><div className="ed-form-actions"><button type="button" className="ed-btn" autoFocus onClick={() => setSwitching(false)}>Avbryt</button><button type="button" className="ed-btn" onClick={() => { setCompany(() => null); setContactOpen(false); setSwitching(false); }}>Välj ny mottagare</button></div></div>}
      <div className="ed-contacts"><div className="ed-contacts-head"><span>Kontaktpersoner</span><span>Signerar</span></div>{company.contacts.map(person => <label key={person.id} className="ed-contact"><span className="ed-avatar">{initials(person.name)}</span><span className="ed-contact-text"><strong>{person.name}</strong><span>{[person.role, person.email].filter(Boolean).join(' · ')}</span></span><input type="checkbox" checked={person.signs} aria-label={`${person.name} signerar`} onChange={() => setCompany(current => current && { ...current, contacts: current.contacts.map(item => item.id === person.id ? { ...item, signs: !item.signs } : item) })} /></label>)}</div>
      {contactOpen ? <ContactForm onCancel={() => setContactOpen(false)} onAdd={person => { setCompany(current => current && { ...current, contacts: [...current.contacts, { ...person, signs: true }] }); rememberContact(company.id, person); setContactOpen(false); }} /> : <button type="button" className="ed-text-btn start" onClick={() => setContactOpen(true)}>+ Kontaktperson</button>}
    </div>}
    {!attachment && <label className="ed-check ed-me"><input type="checkbox" checked={draft.settings.senderSigns} onChange={event => update(current => ({ ...current, settings: { ...current.settings, senderSigns: event.target.checked } }))} />Jag signerar också</label>}
  </section>;
}

/* ---------- Innehåll ---------- */

function outlineText(draft: Draft, block: Block) {
  if (block.type === 'image') return block.caption || (block.src ? '' : 'Ingen bild vald');
  if (block.type === 'header' || block.type === 'text' || block.type === 'terms' || block.type === 'pricing') return resolveTokens(draft, block.title);
  return '';
}

function OutlineCard({ attachment }: { attachment: boolean }) {
  const { draft, user, selectedId, jump } = useEditorApi();
  const count = signers(draft, user).length;
  return <section className="ed-card ed-outline">
    <h2>Innehåll</h2>
    {draft.blocks.map((block, index) => <button key={block.id} type="button" className={selectedId === block.id ? 'active' : ''} onClick={() => jump(block.id)}>
      <span className="ed-outline-n">{String(index + 1).padStart(2, '0')}</span><strong>{BLOCK_LABELS[block.type]}</strong><span className="ed-outline-sub">{outlineText(draft, block)}</span>
    </button>)}
    {!attachment && <button type="button" className={selectedId === SIGNATURE_ID ? 'active' : ''} onClick={() => jump(SIGNATURE_ID)}>
      <span className="ed-outline-n">—</span><strong>Signaturer</strong><span className="ed-outline-sub">{count === 1 ? '1 person' : `${count} personer`}</span>
    </button>}
  </section>;
}

/* ---------- Utskick ---------- */

function useSettings() {
  const { draft, update } = useEditorApi();
  return [draft.settings, (patch: Partial<DocSettings>) => update(current => ({ ...current, settings: { ...current.settings, ...patch } }))] as const;
}

function SendingCard() {
  const [settings, set] = useSettings();
  const days = EXPIRY_DAYS.includes(settings.expiresInDays) ? EXPIRY_DAYS : [...EXPIRY_DAYS, settings.expiresInDays].sort((a, b) => a - b);
  const currencies = CURRENCIES.includes(settings.currency) ? CURRENCIES : [...CURRENCIES, settings.currency];
  return <section className="ed-card ed-settings">
    <h2>Utskick</h2>
    <label className="ed-setting">Signera inom<select className="ed-select" value={settings.expiresInDays} onChange={event => set({ expiresInDays: Number(event.target.value) })}>{days.map(value => <option key={value} value={value}>{value} dagar</option>)}</select></label>
    <label className="ed-check"><input type="checkbox" checked={settings.remind} onChange={event => set({ remind: event.target.checked })} />Påminn automatiskt var 3:e dag</label>
    <div className="ed-setting ruled">Priser anges
      <div className="ed-seg large" role="radiogroup" aria-label="Priser anges">{([[false, 'exkl. moms'], [true, 'inkl. moms']] as const).map(([value, label]) => <button key={label} type="button" role="radio" aria-checked={settings.pricesIncludeVat === value} className={settings.pricesIncludeVat === value ? 'active' : ''} onClick={() => set({ pricesIncludeVat: value })}>{label}</button>)}</div>
    </div>
    <label className="ed-setting">Valuta<select className="ed-select" value={settings.currency} onChange={event => set({ currency: event.target.value })}>{currencies.map(currency => <option key={currency}>{currency}</option>)}</select></label>
  </section>;
}

/* ---------- Utseende ---------- */

function AppearanceCard() {
  const { draft, update } = useEditorApi();
  const setTheme = (patch: Partial<Draft['theme']>) => update(current => ({ ...current, theme: { ...current.theme, ...patch } }));
  return <section className="ed-card ed-settings">
    <h2>Utseende</h2>
    <div className="ed-fonts" role="radiogroup" aria-label="Typsnitt">{FONTS.map(([key, label, family]) => <button key={key} type="button" role="radio" aria-checked={draft.theme.font === key} className={draft.theme.font === key ? 'active' : ''} onClick={() => setTheme({ font: key })}><span style={{ fontFamily: family }}>Aa</span>{label}</button>)}</div>
    <div className="ed-setting">Accent
      <div className="ed-accents" role="radiogroup" aria-label="Accentfärg">{ACCENTS.map(([label, color]) => <button key={label} type="button" role="radio" aria-checked={draft.theme.accent === color} aria-label={label} title={label} className={draft.theme.accent === color ? 'active' : ''} style={{ background: color }} onClick={() => setTheme({ accent: color })} />)}</div>
    </div>
  </section>;
}
