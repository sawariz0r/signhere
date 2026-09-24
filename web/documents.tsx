import { useEffect, useRef, useState, type FormEvent } from 'react';
import { attachmentLabel, date, dateTime, download, fetchPdf, fileBase64, message, pages, request, size } from './api';
import { takeHandOff } from './handoff';
import { PdfPreview } from './pdf';
import { deleteDraft, listDrafts } from './editor/model';
import { Sign } from './sign';
import { CreatedSummary, hasExpectedSenderAssignment, SENDER_UNCONFIRMED, SenderSigning, senderState } from './created';
import { Avatar, CopyLink, Dropzone, ErrorBox, Field, Loading, PdfIcon, Signature, Status } from './ui';
import type { AuditEvent, Brand, CreatedDocument, Delivery, PreparedPdf, SigningDocument, User } from './types';
import { accentStyle, brandName } from './brand';

export function Documents({ onOpen, onNew, onCreate, onDraft }: { onOpen: (id: string) => void; onNew: () => void; onCreate: () => void; onDraft: (id: string) => void }) {
  const [drafts, setDrafts] = useState(listDrafts);
  const [documents, setDocuments] = useState<SigningDocument[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const load = () => { setError(''); void request<{ documents: SigningDocument[] }>('/api/documents').then(result => setDocuments(result.documents)).catch(error => setError(message(error))); };
  useEffect(load, []);
  const visible = documents?.filter(doc => filter === 'all' || (doc.status === filter || filter === 'pending' && doc.status === 'finalizing')) ?? [];
  return <div><div className="page-heading"><h1>Dokument</h1><div className="actions"><button className="button secondary" onClick={onCreate}>Skapa i editorn</button><button className="button" onClick={onNew}><span className="plus">+</span>Nytt dokument</button></div></div>
    {drafts.length > 0 && <section className="drafts" aria-label="Utkast"><h2>Utkast</h2><div className="draft-list">{drafts.slice(0, 6).map(draft => <div className="draft-card" key={draft.id}><button className="draft-open" onClick={() => onDraft(draft.id)}><strong>{draft.title || 'Namnlöst dokument'}</strong><span>Ändrat {date(draft.updatedAt)}</span></button><button className="text-button" aria-label={`Ta bort utkastet ${draft.title}`} onClick={() => { deleteDraft(draft.id); setDrafts(listDrafts()); }}>Ta bort</button></div>)}</div></section>}<ErrorBox error={error} />{error && <button className="button secondary" onClick={load}>Försök igen</button>}
    {!documents && !error && <Loading />}
    {documents && (documents.length === 0 ? <button className="empty-state" onClick={onNew}><span className="circle">+</span><strong>Skicka ditt första avtal</strong><span>Ladda upp en PDF så är du igång.</span></button> : <>
      <div className="filters" aria-label="Filtrera dokument">{[['all', 'Alla'], ['pending', 'Väntar'], ['completed', 'Signerade'], ...(documents.some(doc => doc.status === 'cancelled') ? [['cancelled', 'Avbrutna']] : [])].map(([value, label]) => <button key={value} className={`filter ${filter === value ? 'active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{documents.filter(doc => value === 'all' || doc.status === value).length}</span></button>)}</div>
      <div className="document-list">{visible.map(doc => <button className="document-row" key={doc.id} onClick={() => onOpen(doc.id)}><PdfIcon /><span className="document-name"><strong>{doc.title}</strong><span>Till {doc.recipients.map(r => r.name).join(', ')}{doc.attachmentCount ? ` · ${doc.attachmentCount} ${doc.attachmentCount === 1 ? 'bilaga' : 'bilagor'}${doc.openAttachmentCount ? ` (${doc.openAttachmentCount} väntar)` : ''}` : ''}</span></span><Status doc={doc} /><span className="document-date">{date(doc.createdAt)}</span></button>)}{!visible.length && <div className="loading">Inga dokument här.</div>}</div>
    </>)}
  </div>;
}

/** Creates a main document, or with `parent` a bilaga signed by the parties of that completed document. */
export function NewDocument({ user, onCancel, onOpen, parent, onEditor }: { user: User; onCancel: () => void; onOpen: (id: string) => void; parent?: SigningDocument; onEditor?: () => void }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<(PreparedPdf & { rawBase64: string; blob: Blob }) | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const selection = useRef(0);
  useEffect(() => () => { selection.current += 1; }, []);
  useEffect(() => {
    if (!prepared) { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(prepared.blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [prepared]);
  const [title, setTitle] = useState('');
  const [recipients, setRecipients] = useState(parent ? [] : [{ name: '', email: '' }]);
  const [includeMe, setIncludeMe] = useState(false);
  // By default a bilaga is signed by the same parties as the main document.
  const [inherited, setInherited] = useState<string[]>(() => parent?.recipients.map(recipient => recipient.id) ?? []);
  const parentSenderIsMe = Boolean(parent?.senderRecipientId && parent.sender.email.toLowerCase() === user.email.toLowerCase());
  const [created, setCreated] = useState<CreatedDocument | null>(null);
  const [senderSigning, setSenderSigning] = useState(false);
  const [creationError, setCreationError] = useState('');
  const recipientCount = recipients.filter(recipient => recipient.name.trim() || recipient.email.trim()).length;
  const coversMe = parentSenderIsMe && inherited.includes(parent!.senderRecipientId!);
  const signerCount = recipientCount + inherited.length + (includeMe && !coversMe ? 1 : 0);
  const sharesSenderEmail = includeMe && recipients.some(recipient => recipient.email.trim().toLowerCase() === user.email.toLowerCase());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clearFile = () => {
    selection.current += 1;
    setFile(null); setPrepared(null); setPreparing(false); setPreviewOpen(false); setError('');
  };
  const handleFile = async (value: File) => {
    clearFile();
    const currentSelection = selection.current;
    if (!/\.pdf$/i.test(value.name)) { setError('Välj en PDF-fil.'); return; }
    if (value.size > 10 * 1024 * 1024) { setError('PDF-filen får vara högst 10 MB.'); return; }
    if (!value.size) { setError('Filen är tom. Välj en PDF med innehåll.'); return; }
    setFile(value); setTitle(value.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ')); setPreparing(true);
    try {
      const rawBase64 = await fileBase64(value);
      if (selection.current !== currentSelection) return;
      const result = await request<PreparedPdf>('/api/documents/prepare', { pdfBase64: rawBase64 });
      if (selection.current !== currentSelection) return;
      const bytes = Uint8Array.from(atob(result.pdfBase64), character => character.charCodeAt(0));
      setPrepared({ ...result, rawBase64, blob: new Blob([bytes], { type: 'application/pdf' }) });
    } catch (error) { if (selection.current === currentSelection) setError(message(error)); }
    finally { if (selection.current === currentSelection) setPreparing(false); }
  };
  // A bilaga drafted in the editor arrives as a PDF.
  const editorDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!parent) return;
    const rendered = takeHandOff(parent.id);
    if (!rendered) return;
    editorDraft.current = rendered.draftId;
    void handleFile(rendered.file);
  }, []);
  const send = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const selected = recipients.filter(r => r.name.trim() || r.email.trim()).map(r => ({ name: r.name.trim(), email: r.email.trim() }));
    if (!selected.length && !includeMe && !inherited.length) { setError('Lägg till minst en mottagare.'); return; }
    if (selected.some(r => !r.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email))) { setError('Kontrollera namn och e-post för alla mottagare.'); return; }
    if (new Set(selected.map(r => r.email.toLowerCase())).size !== selected.length) { setError('Varje mottagare behöver en unik e-postadress.'); return; }
    if (!file || !prepared || preparing) return;
    setBusy(true);
    try {
      const fields = { title: title.trim(), fileName: file.name, pdfBase64: prepared.rawBase64, recipients: selected, includeSender: includeMe && !coversMe, methodId: 'draw' };
      const result = parent
        ? await request<CreatedDocument>(`/api/documents/${encodeURIComponent(parent.id)}/attachments`, { ...fields, parentRecipientIds: inherited })
        : await request<CreatedDocument>('/api/documents', fields);
      setCreated(result); setStep(2); clearFile();
      // The draft has become a document; keep it out of the drafts list.
      if (editorDraft.current) { deleteDraft(editorDraft.current); editorDraft.current = null; }
      const senderExpected = parent ? includeMe || coversMe : includeMe;
      const senderAssignmentValid = !senderExpected || (parent ? Boolean(result.senderRecipientId && result.links.some(link => link.recipientId === result.senderRecipientId)) : hasExpectedSenderAssignment(result, user, selected));
      setCreationError(senderAssignmentValid ? '' : SENDER_UNCONFIRMED);
      setSenderSigning(senderExpected && senderAssignmentValid); window.scrollTo(0, 0);
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const { senderLink, senderPending } = senderState(created);
  if (created && senderSigning && senderLink) return <SenderSigning created={created} onBack={() => setSenderSigning(false)} onSigned={next => { setCreated(next); setSenderSigning(false); }} />;
  return <div className="narrow"><div className="page-heading new-heading"><div><h1>{parent ? 'Ny bilaga' : 'Nytt dokument'}</h1>{parent && <p className="muted text-small">Till {parent.title}</p>}</div><button className="text-button" disabled={busy} onClick={() => created ? onOpen(created.document.id) : onCancel()}>{created ? 'Stäng' : 'Avbryt'}</button></div>
    <div className="steps" aria-label={`Steg ${step + 1} av 3`}>{[parent ? 'Bilaga' : 'Dokument', parent ? 'Parter' : 'Mottagare', senderPending ? 'Signera' : created?.document.status === 'completed' ? 'Klart' : 'Dela'].map((label, i) => <div className={`step${i <= step ? ' active' : ''}`} key={label}><span>{i < step ? '✓' : i + 1}</span><strong>{label}</strong><i /></div>)}</div>
    <section className="card new-card"><ErrorBox error={error} />
      {step === 0 && (file ? <form className="stack" onSubmit={e => { e.preventDefault(); if (prepared && !preparing) { setError(''); setStep(1); } }}>
        <div className="file-summary"><PdfIcon /><div className="grow"><strong>{file.name}</strong><p>{size(file.size)}</p></div><button type="button" className="button secondary small" onClick={() => { editorDraft.current = null; clearFile(); }}>Byt</button></div>
        <Field label="Titel" value={title} onChange={e => setTitle(e.target.value)} required maxLength={160} />
        {preparing && <div role="status"><Loading>Förbereder PDF för signering…</Loading></div>}
        {prepared && <>
          {prepared.preparation && <p className="preparation-note" role="status">PDF:en är klar för signering.{prepared.preparation.noteCount > 0 ? ' Kommentarer finns på extra sidor sist i PDF:en.' : ''}</p>}
          <p className="muted text-small">{pages(prepared.pages)} · {size(prepared.size)}</p>
          <details className="upload-preview" open={previewOpen} onToggle={event => setPreviewOpen(event.currentTarget.open)}>
            <summary className="text-button text-small">Förhandsvisa PDF</summary>
            {previewOpen && <div className="stack small-gap">
              <div className="upload-preview-heading"><strong>PDF för signering</strong><a className="text-button text-small" href={previewUrl || undefined} target="_blank" rel="noopener noreferrer">Öppna hela PDF:en</a></div>
              <div className="upload-pdf-preview" aria-label="Förhandsvisning av PDF för signering"><PdfPreview source={prepared.blob} /></div>
            </div>}
          </details>
        </>}
        <div className="muted text-small inline"><span className="mini-check">✓</span>En signatursida läggs till automatiskt sist i dokumentet.</div>
        <div className="actions end"><button className="button" disabled={preparing || !prepared}>Nästa</button></div>
      </form> : <><Dropzone onFile={value => { editorDraft.current = null; void handleFile(value); }} title="Släpp din PDF här" subtitle="eller klicka för att välja fil" /><p className="upload-note">PDF · högst 10 MB och 100 sidor</p>{parent && onEditor && <div className="attachment-source"><span className="muted text-small">eller</span><button type="button" className="button secondary" onClick={onEditor}>Skapa bilagan i editorn</button></div>}</>)}
      {step === 1 && <form className="stack" onSubmit={send}><div><h2>Vem ska signera?</h2><p className="muted text-small">{parent ? 'Parterna i huvuddokumentet är förvalda. Alla signerar samtidigt.' : 'Alla signerar samtidigt.'}</p></div>{parent && <fieldset className="stack small-gap party-choices"><legend className="eyebrow">Parter i {parent.title}</legend>{parent.recipients.map(recipient => <label className="checkbox party-choice" key={recipient.id}><input type="checkbox" checked={inherited.includes(recipient.id)} onChange={e => setInherited(current => e.target.checked ? parent.recipients.map(r => r.id).filter(id => id === recipient.id || current.includes(id)) : current.filter(id => id !== recipient.id))} /><Avatar name={recipient.signedName || recipient.name} /><span><strong>{recipient.signedName || recipient.name}{recipient.id === parent.senderRecipientId && parentSenderIsMe ? ' (du)' : ''}</strong>{recipient.email && <span className="muted text-small"> · {recipient.email}</span>}</span></label>)}{!inherited.length && <p className="muted text-small">Ingen av huvuddokumentets parter signerar bilagan.</p>}</fieldset>}<div className="stack small-gap">{recipients.map((recipient, i) => <div className="recipient-inputs" key={i}><input aria-label={`Mottagare ${i + 1}, namn`} placeholder="Namn" value={recipient.name} maxLength={160} onChange={e => setRecipients(recipients.map((r, j) => j === i ? { ...r, name: e.target.value } : r))} /><input aria-label={`Mottagare ${i + 1}, e-post`} placeholder="E-post" type="email" value={recipient.email} maxLength={254} onChange={e => setRecipients(recipients.map((r, j) => j === i ? { ...r, email: e.target.value } : r))} /><button className="icon-button" type="button" aria-label={`Ta bort mottagare ${i + 1}`} onClick={() => setRecipients(recipients.filter((_, j) => i !== j))}>×</button></div>)}</div><div className="actions between"><button type="button" className="button secondary small" disabled={recipients.length >= 20} onClick={() => setRecipients([...recipients, { name: '', email: '' }])}>{parent ? '+ Lägg till ny part' : '+ Lägg till mottagare'}</button>{!parentSenderIsMe && <label className="checkbox"><input type="checkbox" checked={includeMe} onChange={e => setIncludeMe(e.target.checked)} />Jag ska också signera</label>}</div><div className="stack small-gap" aria-live="polite"><p className="text-small">{parent ? `${signerCount} ${signerCount === 1 ? 'part' : 'parter'}` : includeMe ? `Du (${user.name})${recipientCount ? ` + ${recipientCount} mottagare` : ''}` : `${recipientCount} mottagare`} · {signerCount} {signerCount === 1 ? 'signatur' : 'signaturer'}</p>{sharesSenderEmail && <p className="muted text-small">Du och mottagaren signerar var för sig, även när ni använder samma e-postadress.</p>}</div><div className="method-note"><span className="mini-check">✓</span><span>Ritad signatur</span></div><div className="actions between divider"><button className="button secondary" type="button" disabled={busy} onClick={() => { setStep(0); setError(''); }}>Tillbaka</button><button className="button" disabled={busy || preparing || !prepared}>{busy ? (parent ? 'Skapar bilaga…' : 'Skapar dokument…') : includeMe || coversMe ? 'Skapa och signera' : 'Skicka för signering'}</button></div></form>}
      {step === 2 && created && <CreatedSummary created={created} creationError={creationError} attachment={Boolean(parent)} onOpen={onOpen} onSign={() => setSenderSigning(true)} />}
    </section>
  </div>;
}

function eventLabel(event: AuditEvent, doc: SigningDocument) {
  const label = mainEventLabel(event, doc);
  if (!doc.attachmentOf) return label;
  const prefix = `${attachmentLabel(doc.attachmentOf)} (${doc.title})`;
  if (event.type === 'document.created') return `${prefix} lades till av ${doc.sender.name}.`;
  if (event.type === 'document.completed') return `${prefix}: alla parter har signerat. Den signerade PDF-filen skapades.`;
  return `${prefix}: ${label}`;
}
function mainEventLabel(event: AuditEvent, doc: SigningDocument) {
  const recipient = doc.recipients.find(r => r.id === event.data?.recipientId);
  const name = typeof event.data?.claimedName === 'string' ? event.data.claimedName : typeof event.data?.name === 'string' ? event.data.name : recipient?.signedName || recipient?.name || 'En mottagare';
  const labels: Record<string, string> = {
    'document.created': `Dokumentet skapades av ${doc.sender.name}.`,
    'document.sent': 'Dokumentet gjordes tillgängligt för signering.',
    'recipient.viewed': `${name} öppnade dokumentet.`,
    'recipient.signed': `${name} signerade dokumentet.`,
    'document.completed': 'Alla parter har signerat. Den signerade PDF-filen skapades.',
    'document.cancelled': 'Signeringen avbröts.',
    'recipient.link_rotated': `En ny personlig länk skapades för ${name}.`,
    'link.rotated': `En ny personlig länk skapades för ${name}.`,
  };
  return labels[event.type] ?? event.type;
}

/** One timeline for a document and, on the main document, the events of its bilagor. */
export function Events({ doc, certificate = false, attachments = [] }: { doc: SigningDocument; certificate?: boolean; attachments?: SigningDocument[] }) {
  const items = [doc, ...attachments].flatMap(owner => (owner.events ?? []).map(event => ({ event, owner }))).sort((a, b) => a.event.at.localeCompare(b.event.at));
  return <div className={`timeline${certificate ? ' certificate-timeline' : ''}`}>{items.map(({ event, owner }) => <div className="event" key={`${owner.id}-${event.sequence}`}>{certificate && <div className="event-date"><strong>{date(event.at)}</strong><span className="mono muted">{new Date(event.at).toLocaleTimeString('sv-SE')}</span></div>}<div className="event-line"><i /><span /></div><div className="event-body"><p>{eventLabel(event, owner)}</p>{!certificate && <p className="event-meta mono">{dateTime(event.at)}</p>}{typeof event.data?.ip === 'string' && <p className="event-meta mono">IP {event.data.ip}</p>}{certificate && <p className="event-hash mono">{event.hash}</p>}</div></div>)}</div>;
}

export function DocumentDetail({ id, user, onBack, onCertificate, onOpen, onAddAttachment }: { id: string; user: User; onBack: () => void; onCertificate: (doc: SigningDocument) => void; onOpen: (id: string) => void; onAddAttachment: () => void }) {
  const [doc, setDoc] = useState<SigningDocument | null>(null);
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [error, setError] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [signingToken, setSigningToken] = useState('');
  const load = async () => {
    setError('');
    try { const result = await request<{ document: SigningDocument }>(`/api/documents/${encodeURIComponent(id)}`); setDoc(result.document); }
    catch (error) { setError(message(error)); }
  };
  useEffect(() => { void load(); void fetchPdf(`/api/documents/${encodeURIComponent(id)}/pdf?version=original`).then(setPdf).catch(error => setPdfError(message(error))); }, [id]);
  const action = async (key: string, fn: () => Promise<void>) => { setBusy(key); setError(''); try { await fn(); } catch (error) { setError(message(error)); } finally { setBusy(''); } };
  const delivering = doc?.deliveries?.some(delivery => ['queued', 'sending', 'retry'].includes(delivery.status));
  useEffect(() => { if (!delivering) return; const timer = setInterval(() => { void load(); }, 3000); return () => clearInterval(timer); }, [delivering, id]);
  useEffect(() => { if (doc?.status !== 'finalizing') return; const timer = setInterval(() => { void load(); }, 2000); return () => clearInterval(timer); }, [doc?.status, id]);
  const ownRecipient = doc?.sender.email.toLowerCase() === user.email.toLowerCase() ? doc.recipients.find(recipient => recipient.id === doc.senderRecipientId && !recipient.signedAt) : undefined;
  if (signingToken) return <Sign key={signingToken} token={signingToken} embedded autoOpen onBack={() => { setSigningToken(''); void load(); window.scrollTo(0, 0); }} onSigned={() => { setSigningToken(''); void load(); }} />;
  if (!doc) return <><button className="text-button" onClick={onBack}>← Dokument</button>{error ? <><ErrorBox error={error} /><button className="button secondary" onClick={() => void load()}>Försök igen</button></> : <Loading />}</>;
  return <div><button className="text-button" onClick={onBack}>← Dokument</button><div className="detail-heading"><div className="stack small-gap"><Status doc={doc} />{doc.attachmentOf && <p className="attachment-of">{attachmentLabel(doc.attachmentOf)} till <button className="inline-link" onClick={() => onOpen(doc.attachmentOf!.documentId)}>{doc.attachmentOf.title}</button></p>}<h1>{doc.title}</h1><div className="document-meta"><span className="mono">{doc.id}</span><span>·</span><span>{pages(doc.pages)}</span><span>·</span><span>Skapad {date(doc.createdAt)}</span></div></div><div className="actions">{doc.status === 'pending' && ownRecipient && <button className="button" disabled={Boolean(busy)} onClick={() => void action('sign', async () => {
    const { url } = await request<{ url: string }>(`/api/documents/${id}/recipients/${ownRecipient.id}/link`, {});
    setSigningToken(new URL(url).hash.slice(1)); window.scrollTo(0, 0);
  })}>{busy === 'sign' ? 'Öppnar signering…' : 'Signera dokumentet'}</button>}<button className="button secondary" onClick={() => onCertificate(doc)}>Verifikat</button>{doc.status === 'completed' && <button className="button" disabled={Boolean(busy)} onClick={() => void action('download', () => download(`/api/documents/${id}/pdf?version=completed`, `${doc.title}_signerat.pdf`))}>Ladda ner PDF</button>}</div></div><ErrorBox error={error} />
    {doc.status === 'finalizing' && <div className="preparation-note" role="status"><p>{doc.finalization?.state === 'action_required' ? 'Alla underskrifter är sparade. PDF-filen kunde inte färdigställas.' : 'Alla parter har signerat. PDF-filen färdigställs.'}</p>{doc.finalization?.state === 'action_required' && <button className="button secondary small" disabled={Boolean(busy)} onClick={() => void action('retry', async () => { await request(`/api/documents/${id}/retry-finalization`, {}); await load(); })}>Försök färdigställa igen</button>}</div>}
    <div className="detail-grid"><section className="card preview-card"><div className="card-heading"><h2>Förhandsvisning</h2><a href={`/api/documents/${id}/pdf?version=original`} target="_blank" rel="noopener noreferrer" className="text-button text-small">Öppna PDF för signering</a></div>{doc.preparation && <div className="preparation-note"><p>PDF:en gjordes platt före signering.</p><a href={`/api/documents/${id}/pdf?version=uploaded`} target="_blank" rel="noopener noreferrer" className="text-button text-small">Hämta uppladdad originalfil</a></div>}<ErrorBox error={pdfError} />{pdf ? <PdfPreview source={pdf} thumbnail /> : !pdfError && <Loading>Öppnar PDF…</Loading>}<div className="signature-page-preview"><div className="eyebrow">SIGNATURER</div>{doc.recipients.map(recipient => <div className="signature-preview-line" key={recipient.id}><Signature strokes={recipient.signature?.strokes} /><span>{recipient.name}</span></div>)}<p className="muted text-small">Signatursida</p></div></section>
      <div className="stack">{!doc.attachmentOf && (doc.status === 'completed' || Boolean(doc.attachments?.length)) && <section className="card attachments-card"><div className="card-heading"><h2>Bilagor</h2>{doc.status === 'completed' && <button className="button secondary small" onClick={onAddAttachment}>+ Lägg till bilaga</button>}</div>{doc.attachments?.length ? <div className="attachment-list">{doc.attachments.map(attachment => <button className="attachment-row" key={attachment.id} onClick={() => onOpen(attachment.id)}><PdfIcon /><span className="document-name"><strong>{attachment.attachmentOf ? `${attachmentLabel(attachment.attachmentOf)} · ` : ''}{attachment.title}</strong><span>{attachment.recipients.map(recipient => recipient.name).join(', ')}</span></span><Status doc={attachment} /></button>)}</div> : <p className="muted text-small">Lägg till en bilaga, till exempel en prislista eller ett tillägg. Den signeras som standard av samma parter som huvuddokumentet.</p>}</section>}<section className="card recipients-card"><div className="card-heading"><h2>Mottagare</h2><span className="muted text-small">{doc.recipients.filter(r => r.signedAt).length} av {doc.recipients.length} signerat</span></div>{doc.recipients.map(recipient => <div className="recipient-row" key={recipient.id}><div className="inline"><Avatar name={recipient.name} /><div className="grow"><strong>{recipient.signedName || recipient.name}</strong>{recipient.signedName && recipient.signedName !== recipient.name && <p className="muted text-tiny">Inbjuden som {recipient.name}</p>}<p className="muted text-small"><i className={`dot ${recipient.signedAt ? 'completed' : recipient.viewedAt ? 'pending' : ''}`} />{recipient.signedAt ? `Signerade ${dateTime(recipient.signedAt)}` : recipient.viewedAt ? `Öppnade ${dateTime(recipient.viewedAt)}` : 'Ej öppnat'}</p></div><Signature className="small-signature" strokes={recipient.signature?.strokes} /></div>{doc.status === 'completed' && (links[recipient.id] ? <CopyLink url={links[recipient.id]} /> : <button className="text-button text-small" disabled={Boolean(busy)} onClick={() => void action(recipient.id, async () => { const result = await request<{ url: string }>(`/api/documents/${id}/recipients/${recipient.id}/copy-link`, {}); setLinks(current => ({ ...current, [recipient.id]: result.url })); })}>Dela signerad kopia</button>)}{!recipient.signedAt && recipient.id !== ownRecipient?.id && doc.status === 'pending' && (links[recipient.id] ? <CopyLink url={links[recipient.id]} /> : <div className="stack small-gap"><button className="button secondary small" disabled={Boolean(busy)} onClick={() => void action(recipient.id, async () => { const result = await request<{ url: string }>(`/api/documents/${id}/recipients/${recipient.id}/link`, {}); setLinks(current => ({ ...current, [recipient.id]: result.url })); await load(); })}>{busy === recipient.id ? 'Skapar…' : 'Skapa ny personlig länk'}</button><p className="muted text-tiny">Tidigare länk slutar fungera när en ny skapas.</p></div>)}</div>)}</section>{doc.status === 'completed' && doc.deliveries && <Deliveries doc={doc} busy={busy} onAction={(key, path) => void action(key, async () => { const result = await request<{ deliveries: Delivery[] }>(path, {}); setDoc(current => current && { ...current, deliveries: result.deliveries }); })} />}<section className="card events-card"><div className="card-heading"><h2>Händelser</h2><button className="text-button text-small" disabled={Boolean(busy)} onClick={() => void action('refresh', load)}>Uppdatera</button></div><Events doc={doc} attachments={doc.attachments} /></section>{doc.status === 'pending' && <div className="cancel-document">{cancelConfirm ? <><p>Avbryta signeringen? Mottagarnas länkar slutar fungera.</p><div className="actions"><button className="button secondary small" disabled={Boolean(busy)} onClick={() => setCancelConfirm(false)}>Behåll dokumentet</button><button className="button danger small" disabled={Boolean(busy)} onClick={() => void action('cancel', async () => { const result = await request<{ document: SigningDocument }>(`/api/documents/${id}/cancel`, {}); setDoc(result.document); setCancelConfirm(false); })}>Avbryt signering</button></div></> : <button className="text-button" onClick={() => setCancelConfirm(true)}>Avbryt signering</button>}</div>}</div>
    </div>
  </div>;
}

export function Certificate({ doc, brand, onBack, onVerify }: { doc: SigningDocument; brand: Brand; onBack: () => void; onVerify: () => void }) {
  const [error, setError] = useState('');
  const facts = [['Titel', doc.title], ['Dokument-ID', doc.id], ['Omfattning', pages(doc.pages)], ['Avsändare', `${doc.sender.name} · ${doc.sender.teamName}`], ['Slutfört', dateTime(doc.completedAt)], ['SHA-256 PDF för signering', doc.originalHash], ...(doc.preparation ? [['SHA-256 uppladdad originalfil', doc.preparation.sourceHash]] : []), ['SHA-256 signerad', doc.completedHash ?? 'Inte färdigsignerat'], ...(doc.attachmentOf ? [[`${attachmentLabel(doc.attachmentOf)} till`, `${doc.attachmentOf.title} · ${doc.attachmentOf.documentId}`], ['SHA-256 signerat huvuddokument', doc.attachmentOf.completedHash]] : [])];
  return <div className="certificate-screen"><div className="actions between certificate-toolbar no-print"><button className="text-button" onClick={onBack}>← Tillbaka</button><div className="actions">{doc.status === 'completed' && <button className="button secondary small" onClick={() => { setError(''); void download(`/api/documents/${doc.id}/verification-package`, `${doc.id}_verifiering.zip`).catch(error => setError(message(error))); }}>Hämta verifieringspaket</button>}<button className="button secondary small" onClick={() => { setError(''); void download(`/api/documents/${doc.id}/evidence`, `${doc.id}_verifikat.json`).catch(error => setError(message(error))); }}>Hämta bevisdata</button><button className="button secondary small" onClick={() => window.print()}>Skriv ut / spara PDF</button></div></div><ErrorBox error={error} /><article className="certificate" style={accentStyle(brand)}><div className="certificate-rule" /><div className="certificate-title"><div><div className="certificate-brand">{brand.logoUrl && <img src={brand.logoUrl} alt={brand.showName ? '' : brandName(brand)} />}{(!brand.logoUrl || brand.showName) && <strong>{brandName(brand)}</strong>}</div><h1>Verifikat</h1></div><div className="stamp"><div><strong>SIGNHERE</strong><i /><b>{doc.status === 'completed' ? 'SLUTFÖRT' : doc.status === 'cancelled' ? 'AVBRUTET' : 'PÅGÅR'}</b><span className="mono">{doc.completedAt ? new Date(doc.completedAt).toLocaleDateString('sv-SE') : '—'}</span></div></div></div><div className="certificate-dots" />
      {doc.seal && <div className="certificate-note">PDF-filen är kryptografiskt förseglad av signhere-installationen. Avsändarens certifikat behöver betros separat. Undertecknarnas identitet är inte verifierad med e-legitimation.</div>}<h2>Dokument</h2><dl className="facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={label.startsWith('SHA') || label === 'Dokument-ID' ? 'mono' : ''}>{value}</dd></div>)}</dl>
      <h2>Signerande parter</h2><div className="certificate-signers">{doc.recipients.map(recipient => <div className="certificate-signer" key={recipient.id}><strong>{recipient.signedName || recipient.name}</strong>{recipient.signedName && recipient.signedName !== recipient.name && <p className="muted text-tiny">Inbjuden som {recipient.name}</p>}<p>Undertecknare{recipient.email && ` · ${recipient.email}`}</p><div className="certificate-signature"><Signature strokes={recipient.signature?.strokes} /></div><b>{recipient.signedAt ? 'Undertecknad med ritad signatur' : 'Väntar på signatur'}</b><p>Signerade {dateTime(recipient.signedAt)}</p>{recipient.ip && <p className="mono">IP {recipient.ip}</p>}{recipient.userAgent && <p className="device">{recipient.userAgent}</p>}{recipient.viewedAt && <p>Öppnade {dateTime(recipient.viewedAt)}</p>}</div>)}</div>
      <div className="certificate-note">Detta verifikat sammanställer registrerade signaturer och händelser. Filernas SHA-256-fingeravtryck kan jämföras på <button className="inline-link" onClick={onVerify}>verifieringssidan</button>. Ritad signatur identifierar inte undertecknaren med e-legitimation. Verifikatet är inte ett kvalificerat certifikat eller en betrodd tidsstämpel.</div>
      <h2>Händelser</h2><Events doc={doc} certificate /><footer className="certificate-footer"><span /><span className="mono">Transaktion {doc.id}</span><i /><span>Registrerat av signhere</span><span /></footer>
    </article></div>;
}

const deliveryErrors: Record<string, string> = {
  smtp_unauthorized: 'SMTP-inloggningen nekades.', smtp_rejected: 'Mottagarens server avvisade meddelandet.',
  resend_unauthorized: 'Resend-nyckeln nekades.', resend_rejected: 'Resend avvisade meddelandet.',
  attempts_exhausted: 'Gav upp efter flera försök.',
};
function deliveryStatus(delivery: Delivery) {
  if (delivery.status === 'sent') return `Skickad ${dateTime(delivery.sentAt)}`;
  if (delivery.status === 'failed') return `Misslyckades. ${deliveryErrors[delivery.error ?? ''] ?? 'Kunde inte skickas.'}`;
  if (delivery.status === 'retry') return 'Försöker igen snart';
  return delivery.status === 'sending' ? 'Skickas…' : 'I kö';
}
function Deliveries({ doc, busy, onAction }: { doc: SigningDocument; busy: string; onAction: (key: string, path: string) => void }) {
  const deliveries = doc.deliveries ?? [];
  return <section className="card recipients-card"><div className="card-heading"><h2>Kopior via e-post</h2></div>
    {deliveries.length ? deliveries.map(delivery => <div className="recipient-row" key={delivery.id}><div className="inline"><div className="grow"><strong>{delivery.name}</strong><p className="muted text-small">{delivery.email}</p><p className="muted text-small"><i className={`dot ${delivery.status === 'sent' ? 'completed' : delivery.status === 'failed' ? '' : 'pending'}`} />{deliveryStatus(delivery)}</p></div>{['sent', 'failed'].includes(delivery.status) && <button className="text-button text-small" disabled={Boolean(busy)} onClick={() => onAction('delivery-' + delivery.id, `/api/documents/${doc.id}/deliveries/${delivery.id}/resend`)}>{busy === 'delivery-' + delivery.id ? 'Skickar…' : 'Skicka igen'}</button>}</div></div>)
      : <div className="recipient-row"><p className="muted text-small">Inga kopior har skickats för det här dokumentet.</p><button className="button secondary small" disabled={Boolean(busy)} onClick={() => onAction('deliveries', `/api/documents/${doc.id}/deliveries`)}>{busy === 'deliveries' ? 'Skickar…' : 'Skicka signerade kopior via e-post'}</button></div>}
    <p className="muted text-tiny delivery-note">Den förseglade PDF-filen skickas till varje part och avsändaren.</p></section>;
}

export function NewAttachment({ parentId, user, onCancel, onOpen, onEditor }: { parentId: string; user: User; onCancel: () => void; onOpen: (id: string) => void; onEditor: (parent: SigningDocument) => void }) {
  const [parent, setParent] = useState<SigningDocument | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void request<{ document: SigningDocument }>(`/api/documents/${encodeURIComponent(parentId)}`).then(result => setParent(result.document)).catch(error => setError(message(error))); }, [parentId]);
  if (!parent) return <div className="narrow"><button className="text-button" onClick={onCancel}>← Tillbaka</button><ErrorBox error={error} />{!error && <Loading />}</div>;
  if (parent.status !== 'completed' || parent.attachmentOf) return <div className="narrow"><button className="text-button" onClick={onCancel}>← Tillbaka</button><ErrorBox error="Bilagor kan bara läggas till ett färdigsignerat huvuddokument." /></div>;
  return <NewDocument user={user} parent={parent} onCancel={onCancel} onOpen={onOpen} onEditor={() => onEditor(parent)} />;
}
