import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { Sign } from './sign';
import { Avatar, CopyLink, ErrorBox } from './ui';
import type { CreatedDocument, SigningDocument, User } from './types';

type Party = { name: string; email: string };
/** A created document, and whether the sender's own signing should open next. */
export type Created = { created: CreatedDocument; senderSigning: boolean; creationError: string };

export function hasExpectedSenderAssignment(result: CreatedDocument, user: User, selected: Party[]) {
  const normalizeEmail = (email: string) => email.trim().toLowerCase();
  try {
    const { document, senderRecipientId, links } = result;
    const assigned = document.recipients;
    if (!senderRecipientId || document.senderRecipientId !== senderRecipientId || document.status !== 'pending'
      || assigned.length !== selected.length + 1 || new Set(assigned.map(recipient => recipient.id)).size !== assigned.length
      || assigned.some(recipient => recipient.signedAt) || links.filter(link => link.recipientId === senderRecipientId).length !== 1) return false;
    const sender = assigned.find(recipient => recipient.id === senderRecipientId);
    if (!sender || sender.name !== user.name || !sender.email || normalizeEmail(sender.email) !== normalizeEmail(user.email)) return false;
    const parties = assigned.filter(recipient => recipient.id !== senderRecipientId);
    return parties.every((recipient, index) => recipient.name === selected[index].name
      && Boolean(recipient.email) && normalizeEmail(recipient.email!) === normalizeEmail(selected[index].email));
  } catch {
    return false;
  }
}

export const SENDER_UNCONFIRMED = 'Det gick inte att bekräfta dig som separat undertecknare. Dokumentet är skapat, men ingen signering har öppnats. Öppna dokumentet för att kontrollera parterna.';

/** Creates a main document. The sender's signing only opens when the server confirms the exact assignment. */
export async function createDocument(fields: { title: string; fileName: string; pdfBase64: string; recipients: Party[]; includeSender: boolean; independentApproval?: boolean }, user: User): Promise<Created> {
  const created = await request<CreatedDocument>('/api/documents', { ...fields, methodId: 'draw' });
  const valid = !fields.includeSender || hasExpectedSenderAssignment(created, user, fields.recipients);
  return { created, senderSigning: fields.includeSender && valid, creationError: valid ? '' : SENDER_UNCONFIRMED };
}

/** Keeps the details only the creation response has (such as e-mail addresses) after the sender signs. */
export function withSignedDocument(created: CreatedDocument, document: SigningDocument): CreatedDocument {
  return { ...created, document: { ...document, recipients: document.recipients.map(recipient => ({ ...created.document.recipients.find(original => original.id === recipient.id), ...recipient })) } };
}

export function senderState(created: CreatedDocument | null) {
  const senderRecipient = created?.document.recipients.find(recipient => recipient.id === created.senderRecipientId);
  const senderLink = created?.links.find(link => link.recipientId === created.senderRecipientId);
  return {
    senderRecipient, senderLink,
    senderPending: Boolean(senderRecipient && !senderRecipient.signedAt && created?.document.status === 'pending'),
    sharingLinks: created?.links.filter(link => link.recipientId !== created.senderRecipientId) ?? [],
  };
}

/** The sender's own signing step, embedded right after creation. */
export function SenderSigning({ created, onBack, onSigned }: { created: CreatedDocument; onBack: () => void; onSigned: (created: CreatedDocument) => void }) {
  const { senderLink } = senderState(created);
  if (!senderLink) return null;
  return <Sign token={new URL(senderLink.url).hash.slice(1)} embedded autoOpen onBack={() => { onBack(); window.scrollTo(0, 0); }} onSigned={document => onSigned(withSignedDocument(created, document))} />;
}

/** What happens after creation: sign now, or share the links (or say they were e-mailed). */
export function CreatedSummary({ created, creationError, attachment = false, onOpen, onSign }: { created: CreatedDocument; creationError: string; attachment?: boolean; onOpen: (id: string) => void; onSign: () => void }) {
  const { senderRecipient, senderPending, sharingLinks } = senderState(created);
  if (creationError) return <div className="stack">
    <h2>Signeringen kunde inte öppnas</h2><ErrorBox error={creationError} />
    <div className="actions end"><button className="button" onClick={() => onOpen(created.document.id)}>Öppna dokumentet</button></div>
  </div>;
  if (senderPending) return <div className="stack">
    <div><h2>Nu är det din tur att signera</h2><p className="muted text-small">Dokumentet är skapat och väntar på din signatur.</p></div>
    <div className="actions end"><button className="button" onClick={onSign}>Signera dokumentet</button></div>
  </div>;
  return <div className="stack">
    <div className="inline"><span className="circle medium">✓</span><div><h2>{created.document.status === 'completed' ? 'Dokumentet är färdigsignerat' : senderRecipient?.signedAt ? 'Din signatur är klar' : 'Redo att signeras'}</h2><p className="muted text-small">{created.document.status === 'completed' ? 'Alla parter har signerat. Den signerade PDF-filen finns på dokumentsidan.' : created.document.status === 'finalizing' ? 'Alla underskrifter är sparade. PDF-filen färdigställs på dokumentsidan.' : 'Dela den personliga länken med varje mottagare.'}</p></div></div>
    {senderRecipient?.signedAt && created.document.status === 'pending' && <p className="text-small" role="status">{created.document.recipients.filter(recipient => recipient.signedAt).length} av {created.document.recipients.length} signerat</p>}
    {sharingLinks.length > 0 && <><div className="stack small-gap">{sharingLinks.map(link => <div className="share-card" key={link.recipientId}><div className="inline"><Avatar name={link.name} /><div><strong>{link.name}</strong><p className="muted text-small">{created.document.recipients.find(r => r.id === link.recipientId)?.email}</p></div></div><CopyLink url={link.url} /></div>)}</div><p className="muted text-small">{created.notified ? 'Länkarna har skickats via e-post till varje mottagare. Du kan också kopiera dem här.' : 'Spara länkarna nu. Varje länk ger tillgång till en mottagares signering. Inga e-postmeddelanden skickas automatiskt.'}{attachment ? ' Parterna ser även bilagan när de öppnar sin länk till huvuddokumentet.' : ''}</p></>}
    <div className="actions end divider"><button className="button" onClick={() => onOpen(created.document.id)}>Till dokumentet</button></div>
  </div>;
}

/** The page after sending from the editor: the sender's signing first when they sign, then the summary. */
export function EditorSent({ result, onOpen }: { result: Created; onOpen: (id: string) => void }) {
  const [created, setCreated] = useState(result.created);
  const [signing, setSigning] = useState(result.senderSigning);
  const heading = useRef<HTMLHeadingElement>(null);
  // Announce the outcome: move focus to the heading whenever the summary appears.
  useEffect(() => { if (!signing) { window.scrollTo(0, 0); heading.current?.focus(); } }, [signing]);
  if (signing && senderState(created).senderLink) return <SenderSigning created={created} onBack={() => setSigning(false)} onSigned={next => { setCreated(next); setSigning(false); }} />;
  return <div className="narrow"><div className="page-heading new-heading"><div><h1 ref={heading} tabIndex={-1}>Skickat</h1><p className="muted text-small">{created.document.title}</p></div><button className="text-button" onClick={() => onOpen(created.document.id)}>Stäng</button></div>
    <section className="card new-card"><CreatedSummary created={created} creationError={result.creationError} onOpen={onOpen} onSign={() => setSigning(true)} /></section>
  </div>;
}
