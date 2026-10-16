import { useState, type FormEvent } from 'react';
import { companyInitials, loadBook, saveBook, normalizeOrgNumber, ORG_NUMBER, uid, validEmail, type Company, type Contact } from './model';

export type CompanyDetails = Pick<Company, 'name' | 'orgNr' | 'address' | 'zip' | 'city'>;
export const emptyCompany = (name = ''): CompanyDetails => ({ name, orgNr: '', address: '', zip: '', city: '' });
export function rememberCompany(entry: Company) { saveBook([entry, ...loadBook().filter(item => item.id !== entry.id)]); }
export function rememberContact(companyId: string, contact: Contact) { saveBook(loadBook().map(entry => entry.id === companyId ? { ...entry, contacts: [...entry.contacts.filter(item => item.id !== contact.id), contact] } : entry)); }

export function CompanyFields({ value, onChange }: { value: CompanyDetails; onChange: (value: CompanyDetails) => void }) {
  const field = (key: keyof CompanyDetails) => (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: event.target.value });
  return <><label><span>Företagsnamn</span><input className="ed-input" value={value.name} placeholder="Företag AB" onChange={field('name')} autoFocus /></label>
    <label><span>Organisationsnummer <em>valfritt</em></span><input className="ed-input tabular" inputMode="numeric" value={value.orgNr} placeholder="556123-4567" onChange={field('orgNr')} /></label>
    <label><span>Adress <em>valfritt</em></span><input className="ed-input" value={value.address} placeholder="Gatuadress" onChange={field('address')} /></label>
    <div className="ed-zip-row"><input className="ed-input" aria-label="Postnummer" value={value.zip} placeholder="Postnr" onChange={field('zip')} /><input className="ed-input" aria-label="Ort" value={value.city} placeholder="Ort" onChange={field('city')} /></div></>;
}

export function CompanyPicker({ onChoose, review = false }: { onChoose: (company: Company) => void; review?: boolean }) {
  const [book] = useState(loadBook), [query, setQuery] = useState(''), [adding, setAdding] = useState(false);
  const [details, setDetails] = useState<CompanyDetails>(emptyCompany), [contact, setContact] = useState({ name: '', email: '', role: '' });
  const [remember, setRemember] = useState(true), [error, setError] = useState('');
  const q = query.trim().toLowerCase();
  const hits = book.filter(entry => !q || [entry.name, entry.orgNr, entry.city, ...entry.contacts.map(person => `${person.name} ${person.email}`)].join(' ').toLowerCase().includes(q)).slice(0, 5);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!details.name.trim()) return setError('Ange företagets namn.');
    if (details.orgNr.trim() && !ORG_NUMBER.test(details.orgNr.trim())) return setError('Org.nr skrivs som 556123-4567.');
    if (!contact.name.trim()) return setError('Ange kontaktpersonens namn.');
    if (!validEmail(contact.email)) return setError('Ange en giltig e-postadress.');
    const entry: Company = { id: uid(), ...Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value.trim()])) as CompanyDetails, orgNr: normalizeOrgNumber(details.orgNr.trim()), contacts: [{ id: uid(), name: contact.name.trim(), email: contact.email.trim(), role: contact.role.trim() }] };
    if (remember) rememberCompany(entry);
    onChoose(entry);
  };
  if (adding) return <form className="ed-form" onSubmit={submit} noValidate><strong>Nytt företag</strong><CompanyFields value={details} onChange={value => { setDetails(value); setError(''); }} />
    <div className="ed-form-section"><span className="ed-form-label">{review ? 'Kontaktperson som får länken' : 'Kontaktperson som signerar'}</span>
      <input className="ed-input" aria-label="Kontaktpersonens namn" value={contact.name} placeholder="För- och efternamn" onChange={event => { setContact({ ...contact, name: event.target.value }); setError(''); }} />
      <input className="ed-input" aria-label="Kontaktpersonens e-post" type="email" value={contact.email} placeholder="E-post" onChange={event => { setContact({ ...contact, email: event.target.value }); setError(''); }} />
      <input className="ed-input" aria-label="Kontaktpersonens roll" value={contact.role} placeholder="Roll (valfritt)" onChange={event => setContact({ ...contact, role: event.target.value })} />
      <label className="ed-check"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />Spara i kontakter</label></div>
    {error && <span className="ed-error" role="alert">{error}</span>}<div className="ed-form-actions"><button type="button" className="ed-btn" onClick={() => { setAdding(false); setError(''); }}>Avbryt</button><button className="ed-btn primary">{review ? 'Lägg till klient' : 'Lägg till'}</button></div></form>;
  return <div className="ed-pick-company"><input className="ed-input tall" aria-label={review ? 'Sök klient' : 'Sök mottagare'} value={query} placeholder="Sök företag, org.nr eller kontakt" onChange={event => setQuery(event.target.value)} />
    <div className="ed-mono muted">{q ? 'Träffar' : 'Senaste'}</div><div className="ed-hits">{hits.map(entry => <button key={entry.id} type="button" onClick={() => { rememberCompany(entry); onChoose(entry); }}><span className="ed-tile">{companyInitials(entry.name)}</span><span className="ed-hit-text"><strong>{entry.name}</strong><span>{[entry.orgNr, entry.contacts.length === 1 ? entry.contacts[0].name : `${entry.contacts.length} kontakter`].filter(Boolean).join(' · ')}</span></span></button>)}{!hits.length && <p className="ed-hits-empty">Inga träffar i kontakter.</p>}</div>
    <button type="button" className="ed-dashed" onClick={() => { setDetails(emptyCompany(query.trim())); setAdding(true); }}>{q ? `+ Nytt företag "${query.trim()}"` : '+ Nytt företag'}</button></div>;
}

export function ContactForm({ onAdd, onCancel }: { onAdd: (person: Contact) => void; onCancel: () => void }) {
  const [contact, setContact] = useState({ name: '', email: '', role: '' }), [error, setError] = useState('');
  return <form className="ed-form dashed" onSubmit={event => {
    event.preventDefault();
    if (!contact.name.trim()) return setError('Ange ett namn.');
    if (!validEmail(contact.email)) return setError('Ange en giltig e-postadress.');
    onAdd({ id: uid(), name: contact.name.trim(), email: contact.email.trim(), role: contact.role.trim() });
  }} noValidate><input className="ed-input" aria-label="Namn" placeholder="För- och efternamn" autoFocus value={contact.name} onChange={event => { setContact({ ...contact, name: event.target.value }); setError(''); }} />
    <input className="ed-input" aria-label="E-post" type="email" placeholder="E-post" value={contact.email} onChange={event => { setContact({ ...contact, email: event.target.value }); setError(''); }} />
    <input className="ed-input" aria-label="Roll" placeholder="Roll (valfritt)" value={contact.role} onChange={event => setContact({ ...contact, role: event.target.value })} />
    {error && <span className="ed-error" role="alert">{error}</span>}<div className="ed-form-actions"><button type="button" className="ed-btn" onClick={onCancel}>Avbryt</button><button className="ed-btn primary">Lägg till</button></div></form>;
}
