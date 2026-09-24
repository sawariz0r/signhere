import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { useEditorApi } from './context';
import {
  ACCENTS, BLOCK_LABELS, companyInitials, CURRENCIES, EXPIRY_DAYS, FONTS, initials, loadBook, normalizeOrgNumber, ORG_NUMBER, resolveTokens, saveBook, signers, SIGNATURE_ID, toRecipient, uid, validEmail,
  type Block, type Company, type DocSettings, type Draft, type Issue, type RecipientCompany,
} from './model';

/** With `attachment`, signers come from the main document, so sending and signer options are hidden. */
export function SidePanel({ issues, flash, onIssue, attachment = false }: { issues: Issue[]; flash: boolean; onIssue: (issue: Issue) => void; attachment?: boolean }) {
  return <aside className="ed-panel" aria-label="Utskick och inställningar">
    <StatusCard issues={issues} flash={flash} onIssue={onIssue} attachment={attachment} />
    <RecipientsCard attachment={attachment} />
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

type CompanyForm = { name: string; orgNr: string; address: string; zip: string; city: string; contactName: string; contactEmail: string; contactRole: string; save: boolean };
const emptyForm = (name = ''): CompanyForm => ({ name, orgNr: '', address: '', zip: '', city: '', contactName: '', contactEmail: '', contactRole: '', save: true });

function RecipientsCard({ attachment }: { attachment: boolean }) {
  const { draft, update } = useEditorApi();
  const [book, setBook] = useState<Company[]>(loadBook);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'new' | 'edit' | null>(null);
  const [form, setForm] = useState<CompanyForm>(emptyForm);
  const [formError, setFormError] = useState('');
  const [contactOpen, setContactOpen] = useState(false);
  const [contact, setContact] = useState({ name: '', email: '', role: '' });
  const [contactError, setContactError] = useState('');
  const company = draft.company;
  useEffect(() => saveBook(book), [book]);

  const setCompany = (change: (company: RecipientCompany | null) => RecipientCompany | null) => update(current => ({ ...current, company: change(current.company) }));
  const choose = (entry: Company) => { setCompany(() => toRecipient(entry)); setBook(list => [entry, ...list.filter(item => item.id !== entry.id)]); setQuery(''); };
  const q = query.trim().toLowerCase();
  const haystack = (entry: Company) => [entry.name, entry.orgNr, entry.city, ...entry.contacts.map(person => `${person.name} ${person.email}`)].join(' ').toLowerCase();
  const hits = book.filter(entry => !q || haystack(entry).includes(q)).slice(0, 5);

  const field = (key: keyof CompanyForm) => (event: React.ChangeEvent<HTMLInputElement>) => { const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value; setForm(current => ({ ...current, [key]: value })); setFormError(''); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const orgNr = form.orgNr.trim();
    if (!form.name.trim()) return setFormError('Ange företagets namn.');
    if (orgNr && !ORG_NUMBER.test(orgNr)) return setFormError('Org.nr skrivs som 556123-4567.');
    const details = { name: form.name.trim(), orgNr: normalizeOrgNumber(orgNr), address: form.address.trim(), zip: form.zip.trim(), city: form.city.trim() };
    if (mode === 'edit' && company) {
      setCompany(current => current && { ...current, ...details });
      setBook(list => list.map(entry => entry.id === company.id ? { ...entry, ...details } : entry));
      return setMode(null);
    }
    if (!form.contactName.trim()) return setFormError('Ange kontaktpersonens namn.');
    if (!validEmail(form.contactEmail)) return setFormError('Ange en giltig e-postadress.');
    const entry: Company = { id: uid(), ...details, contacts: [{ id: uid(), name: form.contactName.trim(), email: form.contactEmail.trim(), role: form.contactRole.trim() }] };
    setCompany(() => toRecipient(entry));
    if (form.save) setBook(list => [entry, ...list]);
    setMode(null); setQuery('');
  };
  const addContact = (event: FormEvent) => {
    event.preventDefault();
    if (!company) return;
    if (!contact.name.trim()) return setContactError('Ange ett namn.');
    if (!validEmail(contact.email)) return setContactError('Ange en giltig e-postadress.');
    const person = { id: uid(), name: contact.name.trim(), email: contact.email.trim(), role: contact.role.trim() };
    setCompany(current => current && { ...current, contacts: [...current.contacts, { ...person, signs: true }] });
    setBook(list => list.some(entry => entry.id === company.id) ? list.map(entry => entry.id === company.id ? { ...entry, contacts: [...entry.contacts, person] } : entry) : list);
    setContactOpen(false);
  };
  const toggleSigner = (id: string) => setCompany(current => current && { ...current, contacts: current.contacts.map(person => person.id === id ? { ...person, signs: !person.signs } : person) });

  return <section className="ed-card ed-recipients" data-rec-card>
    <div className="ed-card-head"><h2>Mottagare</h2><span>{attachment ? 'Används i kundfälten' : 'Blir parter och signerare'}</span></div>

    {mode ? <form className="ed-form" onSubmit={submit} noValidate>
      <strong>{mode === 'edit' ? 'Ändra företag' : 'Nytt företag'}</strong>
      <label><span>Företagsnamn</span><input className="ed-input" value={form.name} placeholder="Företag AB" onChange={field('name')} autoFocus /></label>
      <label><span>Organisationsnummer <em>valfritt</em></span><input className="ed-input tabular" inputMode="numeric" value={form.orgNr} placeholder="556123-4567" onChange={field('orgNr')} /></label>
      <label><span>Adress <em>valfritt</em></span><input className="ed-input" value={form.address} placeholder="Gatuadress" onChange={field('address')} /></label>
      <div className="ed-zip-row"><input className="ed-input" aria-label="Postnummer" value={form.zip} placeholder="Postnr" onChange={field('zip')} /><input className="ed-input" aria-label="Ort" value={form.city} placeholder="Ort" onChange={field('city')} /></div>
      {mode === 'new' && <div className="ed-form-section">
        <span className="ed-form-label">Kontaktperson som signerar</span>
        <input className="ed-input" aria-label="Kontaktpersonens namn" value={form.contactName} placeholder="För- och efternamn" onChange={field('contactName')} />
        <input className="ed-input" aria-label="Kontaktpersonens e-post" type="email" value={form.contactEmail} placeholder="E-post" onChange={field('contactEmail')} />
        <input className="ed-input" aria-label="Kontaktpersonens roll" value={form.contactRole} placeholder="Roll, t.ex. VD (valfritt)" onChange={field('contactRole')} />
        <label className="ed-check"><input type="checkbox" checked={form.save} onChange={field('save')} />Spara i kontakter</label>
      </div>}
      {formError && <span className="ed-error" role="alert">{formError}</span>}
      <div className="ed-form-actions"><button type="button" className="ed-btn" onClick={() => { setMode(null); setFormError(''); }}>Avbryt</button><button type="submit" className="ed-btn primary">{mode === 'edit' ? 'Spara' : 'Lägg till'}</button></div>
    </form>

    : !company ? <div className="ed-pick-company">
      <input className="ed-input tall" aria-label="Sök mottagare" value={query} placeholder="Sök företag, org.nr eller kontakt" onChange={event => setQuery(event.target.value)} />
      <div className="ed-mono muted">{q ? 'Träffar' : 'Senaste'}</div>
      <div className="ed-hits">
        {hits.map(entry => <button key={entry.id} type="button" onClick={() => choose(entry)}>
          <span className="ed-tile">{companyInitials(entry.name)}</span>
          <span className="ed-hit-text"><strong>{entry.name}</strong><span>{[entry.orgNr, entry.contacts.length === 1 ? entry.contacts[0].name : `${entry.contacts.length} kontakter`].filter(Boolean).join(' · ')}</span></span>
        </button>)}
        {!hits.length && <p className="ed-hits-empty">Inga träffar i kontakter.</p>}
      </div>
      <button type="button" className="ed-dashed" onClick={() => { setForm(emptyForm(query.trim())); setFormError(''); setMode('new'); }}>{q ? `+ Nytt företag "${query.trim()}"` : '+ Nytt företag'}</button>
    </div>

    : <div className="ed-chosen">
      <div className="ed-company">
        <div className="ed-company-main"><span className="ed-tile dark">{companyInitials(company.name)}</span><div><strong>{company.name}</strong><span>{[company.orgNr ? `Org.nr ${company.orgNr}` : 'Org.nr saknas', company.city].filter(Boolean).join(' · ')}</span></div></div>
        <div className="ed-company-actions">
          <button type="button" className="ed-text-btn" onClick={() => { setForm({ ...emptyForm(company.name), orgNr: company.orgNr, address: company.address, zip: company.zip, city: company.city }); setFormError(''); setMode('edit'); }}>Ändra uppgifter</button>
          <button type="button" className="ed-text-btn" onClick={() => { setCompany(() => null); setContactOpen(false); }}>Byt mottagare</button>
        </div>
      </div>
      <div className="ed-contacts">
        <div className="ed-contacts-head"><span>Kontaktpersoner</span><span>Signerar</span></div>
        {company.contacts.map(person => <label key={person.id} className="ed-contact">
          <span className="ed-avatar">{initials(person.name)}</span>
          <span className="ed-contact-text"><strong>{person.name}</strong><span>{[person.role, person.email].filter(Boolean).join(' · ')}</span></span>
          <input type="checkbox" checked={person.signs} aria-label={`${person.name} signerar`} onChange={() => toggleSigner(person.id)} />
        </label>)}
      </div>
      {contactOpen ? <form className="ed-form dashed" onSubmit={addContact} noValidate>
        <input className="ed-input" aria-label="Namn" value={contact.name} placeholder="För- och efternamn" autoFocus onChange={event => { setContact(value => ({ ...value, name: event.target.value })); setContactError(''); }} />
        <input className="ed-input" aria-label="E-post" type="email" value={contact.email} placeholder="E-post" onChange={event => { setContact(value => ({ ...value, email: event.target.value })); setContactError(''); }} />
        <input className="ed-input" aria-label="Roll" value={contact.role} placeholder="Roll (valfritt)" onChange={event => setContact(value => ({ ...value, role: event.target.value }))} />
        {contactError && <span className="ed-error" role="alert">{contactError}</span>}
        <div className="ed-form-actions"><button type="button" className="ed-btn" onClick={() => setContactOpen(false)}>Avbryt</button><button type="submit" className="ed-btn primary">Lägg till</button></div>
      </form> : <button type="button" className="ed-text-btn start" onClick={() => { setContact({ name: '', email: '', role: '' }); setContactError(''); setContactOpen(true); }}>+ Kontaktperson</button>}
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

