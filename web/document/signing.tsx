import { useEffect, useRef, useState, type ReactNode } from 'react';
import { attachmentLabel, dateTime, download, message, request, RequestError } from '../api';
import { Avatar, ErrorBox, Loading, Signature } from '../ui';
import { PdfPreview } from '../pdf';
import { ReadOnlyDraft, sectionLabel } from '../editor/read-only';
import type { Draft } from '../editor/model';
import type { SignSession } from '../types';
import { Discussion } from './discussion';
import { useBackgroundRefresh } from './refresh';
import { Callout, DocumentShell, StatusCard } from './shell';
import type { CommentInput, ReviewThread, SigningDiscussion } from './types';

export function SigningWorkspace({ session, token, documentId, pdf, hash, ready, error, pdfError, busy, onReady, onPdfError, onSign, onRefresh, dossier, onBack }: {
  session: SignSession | null; token: string; documentId?: string; pdf: Blob | null; hash: string; ready: boolean; error: string; pdfError: string; busy: boolean;
  onReady: () => void; onPdfError: (text: string) => void; onSign: () => void; onRefresh: () => void; dossier?: ReactNode; onBack?: () => void;
}) {
  const [discussion, setDiscussion] = useState<SigningDiscussion | null>(null), [discussionError, setDiscussionError] = useState('');
  const [webView, setWebView] = useState(false), [reference, setReference] = useState<{ draft: Draft; version: number | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [commentRequest, setCommentRequest] = useState(0), [downloadError, setDownloadError] = useState('');
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width:859px)').matches);
  useEffect(() => { const query = window.matchMedia('(max-width:859px)'); const change = () => setMobile(query.matches); query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
  const target = documentId ? { token, documentId } : { token };
  const sequence = useRef(0);
  const loadDiscussion = async (background = false) => {
    const current = ++sequence.current;
    try {
      const result = await request<Partial<SigningDiscussion> | null>('/api/sign/discussion', { ...target, ...(background ? { updatesOnly: true } : {}) });
      if (current === sequence.current) { setDiscussion(previous => result ? result.source ? result as SigningDiscussion : previous ? { ...previous, ...result } : null : null); setDiscussionError(''); }
    } catch (error) {
      if (current === sequence.current && (!background || error instanceof RequestError && [401, 403, 404, 410].includes(error.status))) { setDiscussion(null); setDiscussionError(message(error)); }
    }
  };
  useEffect(() => { setDiscussion(null); if (session) void loadDiscussion(); return () => { sequence.current++; }; }, [token, documentId, Boolean(session)]);
  useBackgroundRefresh(() => loadDiscussion(true), Boolean(discussion));
  const doc = session?.document, recipient = doc?.recipients.find(item => item.id === session?.recipientId);
  const post = async (input: CommentInput) => { const { version, ...body } = input; await request('/api/sign/comments', { ...body, ...target }); await loadDiscussion(); };
  const onAnchor = async (thread: ReviewThread) => {
    try {
      if (thread.version) { const result = await request<{ draft: Draft }>('/api/sign/review-version', { ...target, version: thread.version }); setReference({ draft: result.draft, version: thread.version }); }
      else if (discussion) setReference({ draft: discussion.source, version: null });
      setSelected(thread.blockId); setWebView(true);
      if (thread.blockId) requestAnimationFrame(() => document.querySelector(`[data-review-block="${CSS.escape(thread.blockId!)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    } catch (error) { setDiscussionError(message(error)); }
  };
  const fetchCopy = async (completed: boolean) => { setDownloadError(''); try { if (doc) await download(completed ? '/api/sign/download' : '/api/sign/pdf', `${doc.title}${completed ? '_signerat' : ''}.pdf`, target); } catch (error) { setDownloadError(message(error)); } };
  if (!doc || !recipient) return <DocumentShell title="Dokument" status={error ? 'Länken kan inte öppnas' : 'Öppnar…'} canvas={<><ErrorBox error={error} />{!error && <Loading>Öppnar dokument…</Loading>}</>} />;
  const signed = Boolean(recipient.signedAt), completed = doc.status === 'completed', cancelled = doc.status === 'cancelled', canSign = !signed && doc.status === 'pending';
  const last = discussion?.versions[0], changed = Boolean(last && last.sourceRevision !== discussion?.revision);
  const status = cancelled ? 'Signeringen är avbruten' : signed ? completed ? 'Signerat av alla' : 'Du har signerat' : 'Väntar på din signatur';
  const shown = reference?.draft ?? discussion?.source;
  const historicalView = Boolean(webView && reference?.version && discussion?.versions.find(item => item.version === reference.version)?.sourceRevision !== discussion?.revision);
  const comments = discussion ? <><ErrorBox error={discussionError} /><Discussion threads={discussion.threads} version={last?.version ?? null} filter={selected} setFilter={setSelected} label={id => sectionLabel(discussion.source, id)} post={post} signing canPost={canSign && !historicalView} identity={canSign ? 'Frågor ändrar inte PDF:en.' : undefined} closedNote={signed ? 'Diskussionen ingår inte i det signerade dokumentet.' : historicalView ? 'Du visar en tidigare granskning. Återgå till PDF:en för att ställa frågor om signeringsdokumentet.' : undefined} onAnchor={thread => void onAnchor(thread)} /></> : discussionError ? <ErrorBox error={discussionError} /> : undefined;
  const canvas = webView && shown ? <><p className="rd-version-note">Webbvisningen {reference?.version ? `av version ${reference.version}` : 'av signeringsunderlaget'} hjälper dig följa diskussionen. Det är PDF:en du signerar.</p><ReadOnlyDraft key={reference?.version ?? discussion?.revision} draft={shown} threads={discussion?.threads.filter(thread => reference?.version ? thread.version === reference.version : Boolean(thread.signingDocumentId)) ?? []} selected={selected} onSelect={setSelected} onComment={id => { setSelected(id); setCommentRequest(value => value + 1); }} /></> : <div className="rd-pdf-stage"><ErrorBox error={error} /><ErrorBox error={pdfError} />{hash && <p className="rd-version-note">Exakt den PDF {signed ? 'du signerade' : 'du signerar'}. Fingeravtrycket är kontrollerat i din webbläsare.</p>}{pdf ? <PdfPreview source={pdf} zoomable onReady={onReady} onError={onPdfError} /> : !pdfError && <Loading>Kontrollerar och öppnar PDF…</Loading>}<section className="sign-signatures"><div className="eyebrow">SIGNATURER</div><p className="muted text-small">{completed ? 'Signatursidan finns i den signerade PDF:en.' : 'Signatursidan läggs till när alla har signerat.'}</p><div>{doc.recipients.map(item => <div key={item.id}><div className="signature-line"><Signature strokes={item.signature?.strokes} /></div><strong>{item.signedName || item.name}</strong><p className="muted text-small">{item.signedAt ? dateTime(item.signedAt) : 'Väntar på signatur'}</p></div>)}</div></section><details className="document-fingerprint"><summary>Dokumentets fingeravtryck (SHA-256)</summary><p className="mono hash">{doc.originalHash}</p></details></div>;
  const receipt = <section className="ed-card"><h2>{signed ? 'Kvitto' : 'Det här signerar du'}</h2>{signed && <div className="signed-receipt"><Signature strokes={recipient.signature?.strokes} /><div><strong>{recipient.signedName || recipient.name}</strong><div className="mono">{dateTime(recipient.signedAt)}</div></div></div>}<dl className="rd-facts"><div><dt>Dokument</dt><dd>PDF, {doc.pages} {doc.pages === 1 ? 'sida' : 'sidor'}</dd></div>{last && <div><dt>Granskning</dt><dd>Version {last.version}{changed ? ' med ändringar' : ''}</dd></div>}<div><dt>Fingeravtryck</dt><dd className="mono">{doc.originalHash.slice(0, 16)}…</dd></div></dl><div className="rd-parties">{doc.recipients.map(item => <div className="rd-party" key={item.id}><Avatar name={item.name} /><div><strong>{item.signedName || item.name}</strong><small>{item.signedAt ? `Signerade ${dateTime(item.signedAt)}` : 'Väntar på signatur'}</small></div></div>)}</div></section>;
  return <DocumentShell title={doc.title} brand={session!.brand} person={recipient.name} status={status} done={signed} commentRequest={commentRequest} count={discussion?.threads.length} discussion={comments}
    stagebar={<>{onBack ? <button className="ed-text-btn" onClick={onBack}>Tillbaka till huvuddokumentet</button> : <span className="ed-mono">{webView ? 'Webbvisning · referens' : `${signed ? 'PDF du signerade' : 'PDF för signering'} · ${doc.pages} ${doc.pages === 1 ? 'sida' : 'sidor'}`}</span>}{discussion && <div className="rd-render-switch" role="group" aria-label="Visning"><button type="button" aria-pressed={!webView} onClick={() => setWebView(false)}>PDF</button><button type="button" aria-pressed={webView} onClick={() => { setReference(null); setWebView(true); }}>Webbvisning</button></div>}</>}
    callout={cancelled ? <Callout title="Signeringen är avbruten" tone="warn"><p>{signed ? 'Din underskrift är sparad. Avsändaren har avbrutit den återstående signeringen.' : `Kontakta ${doc.sender.name} om du har frågor.`}</p><ErrorBox error={downloadError} /></Callout> : signed ? <Callout title="Signerat" tone="done"><p>{completed ? `Alla parter har signerat. Den ${doc.evidenceVersion === 2 ? 'förseglade' : 'signerade'} PDF-filen är klar.` : doc.status === 'finalizing' ? 'Alla underskrifter är sparade. PDF-filen färdigställs.' : 'Du har signerat. Väntar på resterande parter. Återvänd via samma länk för att hämta det färdiga dokumentet.'}</p><ErrorBox error={downloadError} />{!completed && <button type="button" className="ed-btn" disabled={busy} onClick={onRefresh}>Kontrollera status</button>}</Callout> : changed ? <Callout title={`Ändrat efter version ${last!.version}`} tone="warn"><p>PDF:en innehåller ändringar efter den senast granskade versionen.{discussion?.changedSections.length ? ` Berörda avsnitt: ${discussion.changedSections.map(section => sectionLabel(discussion.source, section.id)).join(', ')}.` : ''} Läs igenom den innan du signerar.</p></Callout> : undefined}
    canvas={<>{doc.attachmentOf && <p className="rd-version-note">{attachmentLabel(doc.attachmentOf)} till {doc.attachmentOf.title}</p>}{canvas}{mobile && signed && receipt}{mobile && dossier}</>} panel={<><StatusCard title={cancelled ? 'Signeringen är avbruten' : signed ? completed ? 'Alla parter har signerat' : 'Din signatur är sparad' : 'Redo att signera'} stage={signed ? 3 : 2}>{cancelled ? `Kontakta ${doc.sender.name} om du har frågor.` : signed ? 'Kvitto och diskussion finns kvar vid dokumentet.' : `Läs dokumentet och signera som ${recipient.name}.`}</StatusCard>{!mobile && receipt}{!mobile && dossier}</>}
    action={signed ? <button type="button" className="ed-btn primary large" onClick={() => void fetchCopy(completed)}>{completed ? 'Ladda ner signerad PDF' : 'Ladda ner PDF:en du signerade'}</button> : canSign ? <><span className="rd-action-meta">{recipient.name} · {doc.pages} {doc.pages === 1 ? 'sida' : 'sidor'}</span><button type="button" className="ed-btn primary large" disabled={!hash || !pdf || Boolean(pdfError) || !webView && !ready} onClick={() => { if (webView) { setWebView(false); window.scrollTo({ top: 0 }); } else onSign(); }}>{webView ? 'Visa PDF och signera' : 'Signera'}</button></> : undefined} />;
}
