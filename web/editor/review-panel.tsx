import { useEffect, useRef, useState } from 'react';
import { dateTime, message, request } from '../api';
import { CopyLink, ErrorBox } from '../ui';
import { Discussion } from '../document/discussion';
import { sectionLabel } from './read-only';
import type { Draft } from './model';
import type { CommentInput, DraftDetail, ReviewThread } from '../document/types';
import '../document/document.css';

export function useEditorReview(draftId: string, onSave: () => Promise<number>) {
  const [data, setData] = useState<DraftDetail | null>(null), [shared, setShared] = useState<Draft | null>(null);
  const [historical, setHistorical] = useState<{ draft: Draft; version: number } | null>(null);
  const [filter, setFilter] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [url, setUrl] = useState(''), [name, setName] = useState(''), [commentRequest, setCommentRequest] = useState(0);
  const sequence = useRef(0);
  const load = async () => {
    const current = ++sequence.current;
    const result = await request<DraftDetail>(`/api/drafts/${draftId}?optional=1`);
    const latest = result.versions?.[0];
    const snapshot = latest ? (await request<{ draft: Draft }>(`/api/drafts/${draftId}/versions/${latest.version}`)).draft : null;
    if (current === sequence.current) { setData(result.draft ? result : null); setShared(snapshot); }
  };
  useEffect(() => { void load().catch(error => setError(message(error))); return () => { sequence.current++; }; }, [draftId]);
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); await load(); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const publish = () => act(async () => { const revision = await onSave(); await request(`/api/drafts/${draftId}/publish`, { revision }); setHistorical(null); });
  const post = async (input: CommentInput) => { await request(`/api/drafts/${draftId}/comments`, input); await load(); };
  const resolve = async (thread: ReviewThread) => { await request(`/api/drafts/${draftId}/threads/${thread.id}`, { resolved: !thread.resolved }); await load(); };
  const view = async (version: number) => { const result = await request<{ draft: Draft }>(`/api/drafts/${draftId}/versions/${version}`); setHistorical({ draft: result.draft, version }); };
  const comment = (blockId: string) => { setFilter(blockId); setCommentRequest(value => value + 1); };
  return { data, shared, historical, setHistorical, filter, setFilter, busy, error, setError, url, name, setName, commentRequest, comment, publish, post, resolve, view, load, act,
    createLink: () => act(async () => { const result = await request<{ url: string }>(`/api/drafts/${draftId}/links`, { name }); setUrl(result.url); }),
    revoke: (id: string) => act(async () => { await request(`/api/drafts/${draftId}/links/${id}/revoke`, {}); setUrl(''); }),
  };
}
export type EditorReview = ReturnType<typeof useEditorReview>;
export function EditorReviewPanel({ review, draft, revision }: { review: EditorReview; draft: Draft; revision: number }) {
  const latest = review.data?.versions[0], current = review.historical?.draft ?? review.shared ?? draft;
  const version = review.historical?.version ?? latest?.version ?? null;
  return <><section className="ed-card"><h2>{latest ? 'Delad för granskning' : 'Dela för granskning'}</h2><p className="ed-card-text">{latest ? `Version ${latest.version} är delad. ${latest.sourceRevision !== revision ? 'Dina ändringar är privata tills du delar en ny version.' : 'Klienten ser den delade versionen.'}` : 'Dela ett privat dokument där klienten kan läsa och kommentera.'}</p><div className="rd-share-tools"><ErrorBox error={review.error} /><button type="button" className="ed-btn primary large" disabled={review.busy} onClick={() => void review.publish()}>{review.busy ? 'Arbetar…' : latest ? 'Dela ny version' : 'Dela första versionen'}</button>
    {latest && <><form onSubmit={event => { event.preventDefault(); void review.createLink(); }}><label>Klientens namn<input value={review.name} onChange={event => review.setName(event.target.value)} maxLength={80} required /></label><button className="ed-btn" disabled={review.busy}>Skapa privat länk</button></form>{review.url && <div className="rd-share-link"><CopyLink url={review.url} /><p>Spara länken nu. Den gäller i 30 dagar. Alla med länken kan läsa och kommentera.</p></div>}{review.data?.links.map(link => <div className="rd-share-row" key={link.id}><span>{link.name}<small className="muted"> · {link.revokedAt ? 'Återkallad' : Number(link.expiresAt) <= Date.now() ? 'Utgången' : `till ${dateTime(new Date(Number(link.expiresAt)).toISOString())}`}</small></span>{!link.revokedAt && <button type="button" className="ed-text-btn" disabled={review.busy} onClick={() => void review.revoke(link.id)}>Återkalla</button>}</div>)}</>}
    {review.data?.signings.map(signing => <a className="ed-btn" key={signing.documentId} href={`/documents/${signing.documentId}`}>Öppna skickat signeringsdokument</a>)}
    </div></section>
    {latest && <Discussion threads={review.data?.threads ?? []} version={version} filter={review.filter} setFilter={review.setFilter} label={id => sectionLabel(current, id)} post={review.post} resolve={review.resolve} owner canPost={!review.historical} identity={`Delad version ${latest.version}`} closedNote={review.historical ? `Du visar version ${review.historical.version}. Återgå till ditt utkast för att svara.` : undefined} onRefresh={() => void review.act(review.load)} onAnchor={thread => { if (thread.version) void review.view(thread.version).then(() => { if (thread.blockId) requestAnimationFrame(() => document.querySelector(`[data-review-block="${CSS.escape(thread.blockId!)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }).catch(error => review.setError(message(error))); }} />}
  </>;
}
