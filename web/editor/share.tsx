import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, MessageSquare, Clock, Users, X } from 'lucide-react';
import { dateTime, initials, message } from '../api';
import { ErrorBox } from '../ui';
import { CompanyPicker, ContactForm, rememberContact } from './clients';
import { useEditorApi } from './context';
import { toRecipient, type Draft } from './model';
import { isActiveLink, linkMatchesDraft, type CreatedReviewLink, type EditorReview } from './review-panel';

function useModal(initialFocus?: string) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, node = dialog.current;
    node?.showModal();
    const frame = requestAnimationFrame(() => { if (initialFocus) node?.querySelector<HTMLElement>(initialFocus)?.focus(); });
    return () => { cancelAnimationFrame(frame); node?.close(); if (opener?.isConnected && !opener.closest('dialog:not([open])')) opener.focus(); else document.querySelector<HTMLButtonElement>('.sh-bar button')?.focus(); };
  }, []);
  return dialog;
}

export function SaveVersionDialog({ review, draft, onClose, onSaved }: { review: EditorReview; draft: Draft; onClose: () => void; onSaved: (version: number) => void }) {
  const dialog = useModal('.sh-dialog-foot button:last-child'), [error, setError] = useState('');
  const active = review.data?.links.filter(isActiveLink) ?? [], stale = active.filter(link => !linkMatchesDraft(link, draft));
  const next = (review.data?.versions[0]?.version ?? 0) + 1;
  return <dialog ref={dialog} className="sh-dialog" aria-labelledby="save-version-title" onCancel={event => { event.preventDefault(); if (!review.busy) onClose(); }}><form onSubmit={event => { event.preventDefault(); setError(''); void review.saveVersion().then(result => onSaved(result.version)).catch(error => setError(message(error))); }}>
    <div className="sh-dialog-head"><div><h2 id="save-version-title">Spara version {next}?</h2><p>Du fortsätter redigera i ditt utkast som vanligt.</p></div></div>
    <div className="sh-dialog-body"><ul className="sh-diff">{active.map(link => <li key={link.id} className={stale.includes(link) ? 'warn' : ''}><span className="ed-avatar" aria-hidden="true">{initials(link.name)}</span><span>{stale.includes(link) ? <><strong>{link.name}s länk slutar fungera.</strong> Klienten eller kontaktpersonen har ändrats. Den nya klienten får en egen länk när du delar.</> : <><strong>{link.name}</strong> ser version {next} nästa gång länken öppnas.</>}</span></li>)}</ul><ErrorBox error={error} /></div>
    <div className="sh-dialog-foot"><button type="button" className="ed-btn" disabled={review.busy} onClick={onClose}>Avbryt</button><button className={`ed-btn ${stale.length ? 'danger' : 'primary'}`} autoFocus disabled={review.busy}>{review.busy ? 'Sparar…' : stale.length ? 'Spara och återkalla länken' : `Spara version ${next}`}</button></div>
  </form></dialog>;
}

export function ShareDialog({ review, changed, contactId, onClose }: { review: EditorReview; changed: boolean; contactId?: string; onClose: () => void }) {
  const { draft, update } = useEditorApi();
  const dialog = useModal('input[aria-label="Sök klient"], input[type="radio"]:checked'), urlInput = useRef<HTMLInputElement>(null), copyButton = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState(contactId ?? ''), [days, setDays] = useState(30), [adding, setAdding] = useState(false);
  const [result, setResult] = useState<CreatedReviewLink | null>(null), [copied, setCopied] = useState(false), [guard, setGuard] = useState(false), [error, setError] = useState('');
  const company = draft.company, active = review.data?.links.filter(isActiveLink) ?? [];
  useEffect(() => {
    if (!company) { setSelected(''); return; }
    if (!company.contacts.some(person => person.id === selected)) setSelected(company.contacts.find(person => !active.some(link => link.clientId === company.id && link.contactId === person.id))?.id ?? company.contacts[0]?.id ?? '');
  }, [company?.id, company?.contacts, selected]);
  useEffect(() => { if (result) copyButton.current?.focus(); }, [result]);
  useEffect(() => { if (!result && selected) dialog.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus(); }, [selected, company?.id]);
  const person = company?.contacts.find(person => person.id === selected);
  const previous = active.find(link => link.clientId === company?.id && link.contactId === selected);
  const latest = review.data?.versions[0], next = (latest?.version ?? 0) + 1;
  const close = () => { if (review.busy) return; if (result && !copied) { setGuard(true); copyButton.current?.focus(); } else onClose(); };
  const copy = async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.url); setCopied(true); setGuard(false); setError(''); }
    catch { urlInput.current?.focus(); urlInput.current?.select(); setError('Markera länken och kopiera den.'); }
  };
  const create = () => { if (!person) return; setError(''); void review.createLink(person.id, days).then(setResult).catch(error => setError(message(error))); };
  const changeClient = () => { update(current => ({ ...current, company: null })); setSelected(''); setAdding(false); };
  return <dialog ref={dialog} className="sh-dialog" aria-labelledby="share-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="sh-dialog-head">{result && <span className="sh-done" aria-hidden="true"><Check size={20} /></span>}<div><h2 id="share-title">{result ? `${result.rotated ? 'Ny länk till' : 'Länken till'} ${result.name} är klar` : 'Dela med klient'}</h2><p>{result ? `Kopiera den nu. Den visas bara den här gången.${result.rotated ? ' Den gamla länken fungerar inte längre.' : ''}` : company ? 'Klienten kan läsa och kommentera. Inte signera.' : 'Välj vilket företag som ska granska. Det blir också mottagare i dokumentet.'}</p></div><button type="button" className="ed-btn sh-x" aria-label="Stäng delning" disabled={review.busy} onClick={close}><X size={18} /></button></div>
    <div className="sh-dialog-body">
      {result ? <><div className="sh-url"><input ref={urlInput} readOnly value={result.url} aria-label={`Privat länk till ${result.name}`} onFocus={event => event.target.select()} onCopy={() => { setCopied(true); setGuard(false); }} /><button ref={copyButton} type="button" className="ed-btn primary" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Kopierad' : 'Kopiera länk'}</button></div><span className="sr-only" aria-live="polite">{copied ? 'Länken är kopierad' : ''}</span>
        <a className="ed-btn" href={`mailto:${encodeURIComponent(result.email)}?subject=${encodeURIComponent('Utkast att granska: ' + draft.title)}&body=${encodeURIComponent(`Hej ${result.name.split(' ')[0]}!\n\nHär är utkastet att läsa och kommentera:\n${result.url}`)}`}>Skicka i e-post…</a><ul className="sh-facts"><li><Eye size={15} /><span>Visar version {result.version} och de versioner du sparar senare. Tidigare versioner visas inte.</span></li><li><MessageSquare size={15} /><span>Kan läsa och kommentera. Kan inte signera.</span></li><li><Clock size={15} /><span>Gäller till {dateTime(new Date(result.expiresAt).toISOString())}. Du kan återkalla länken under Granskning.</span></li><li><Users size={15} /><span>Alla som har länken kan öppna den. Skicka den bara till {result.name.split(' ')[0]}.</span></li></ul></>
      : !company ? <CompanyPicker review onChoose={entry => update(current => ({ ...current, company: toRecipient(entry) }))} />
      : <><div><span className="sh-field-label">Klient</span><div className="ed-company"><div><strong>{company.name}</strong><span>{company.orgNr || 'Org.nr saknas'}</span></div><button type="button" className="ed-text-btn" disabled={review.busy} onClick={changeClient}>Byt</button></div></div>
        <fieldset><legend className="sh-field-label">Vem får länken?</legend><div className="sh-contacts">{company.contacts.map(contact => <label key={contact.id} className="sh-contact"><input type="radio" name="review-contact" value={contact.id} checked={selected === contact.id} disabled={review.busy} onChange={() => setSelected(contact.id)} /><span className="ed-avatar" aria-hidden="true">{initials(contact.name)}</span><div><strong>{contact.name}{active.some(link => link.clientId === company.id && link.contactId === contact.id) && <span className="tag">Har en länk</span>}</strong><span>{[contact.role, contact.email].filter(Boolean).join(' · ')}</span></div></label>)}</div>{previous && <p className="sh-note">{previous.name}s nuvarande länk slutar fungera när du skapar en ny.</p>}</fieldset>
        {adding ? <ContactForm onCancel={() => setAdding(false)} onAdd={contact => { rememberContact(company.id, contact); update(current => ({ ...current, company: current.company && { ...current.company, contacts: [...current.company.contacts, { ...contact, signs: false }] } })); setSelected(contact.id); setAdding(false); }} /> : <button type="button" className="ed-text-btn" disabled={review.busy} onClick={() => setAdding(true)}>+ Ny kontaktperson</button>}
        <div><span className="sh-field-label" id="review-expiry">Giltig i</span><div className="ed-seg" role="radiogroup" aria-labelledby="review-expiry">{[7, 30, 90].map(value => <button key={value} type="button" role="radio" aria-checked={days === value} disabled={review.busy} onClick={() => setDays(value)}>{value} dagar</button>)}</div></div>
        <div><span className="sh-field-label">Klienten ser</span><p className="sh-sees"><Eye size={15} /><span>{changed ? <>Dina ändringar sparas som <strong>version {next}</strong>. </> : <><strong>Version {latest?.version}</strong>. </>}Länken visar den versionen och de versioner du sparar senare. Tidigare versioner visas inte.</span></p></div>
        {changed && active.length > 0 && <p className="sh-note">Samma klients aktiva länkar får också den sparade versionen. Tidigare klienters länkar återkallas.</p>}</>}
      <ErrorBox error={error} />
    </div>
    <div className="sh-dialog-foot">{result ? <>{guard && <><span className="sh-guard" role="alert">Du har inte kopierat länken. Den går inte att visa igen.</span><button type="button" className="ed-btn" onClick={onClose}>Stäng ändå</button><button type="button" className="ed-btn primary" onClick={() => void copy()}>Kopiera länk</button></>}{!guard && <button type="button" className="ed-btn primary" onClick={close}>Klar</button>}</> : <><button type="button" className="ed-btn" disabled={review.busy} onClick={close}>Avbryt</button>{company && <button type="button" className="ed-btn primary" disabled={review.busy || !person || adding} onClick={create}>{review.busy ? 'Skapar länk…' : changed ? `Spara version ${next} och skapa länk` : 'Skapa privat länk'}</button>}</>}</div>
  </dialog>;
}
