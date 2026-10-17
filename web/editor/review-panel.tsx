import { useEffect, useRef, useState } from 'react';
import { dateTime, initials, message, request } from '../api';
import { ErrorBox } from '../ui';
import { Discussion } from '../document/discussion';
import { useBackgroundRefresh } from '../document/refresh';
import { sectionLabel } from './read-only';
import type { Draft } from './model';
import type { CommentInput, DraftDetail, ReviewLink, ReviewThread } from '../document/types';
import '../document/document.css';

export type CreatedReviewLink = { id: string; url: string; expiresAt: number; version: number; name: string; email: string; clientName: string; rotated: boolean };
export const isActiveLink = (link: ReviewLink) => !link.revokedAt && Number(link.expiresAt) > Date.now();
export function linkMatchesDraft(link: ReviewLink, draft: Draft) {
  const person = draft.company?.contacts.find(person => person.id === link.contactId);
  return link.clientId === draft.company?.id && Boolean(person && person.name.trim() === link.name && person.email.trim().toLowerCase() === link.recipientEmail);
}
export function useEditorReview(draftId: string, onSave: () => Promise<number>) {
  const [data, setData] = useState<Omit<DraftDetail, 'draft'> | null>(null), [shared, setShared] = useState<Draft | null>(null);
  const [historical, setHistorical] = useState<{ draft: Draft; version: number } | null>(null);
  const [filter, setFilter] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [commentRequest, setCommentRequest] = useState(0);
  const sequence = useRef(0), snapshotCache = useRef<{ key: string; draft: Draft } | null>(null);
  const load = async () => {
    const current = ++sequence.current;
    const result = await request<Omit<DraftDetail, 'draft'> & { draft?: null }>(`/api/drafts/${draftId}?optional=1&discussion=1`);
    const latest = result.versions?.[0], key = `${draftId}:${latest?.version ?? ''}`;
    const snapshot = latest ? snapshotCache.current?.key === key ? snapshotCache.current.draft : (await request<{ draft: Draft }>(`/api/drafts/${draftId}/versions/${latest.version}`)).draft : null;
    if (current === sequence.current) { snapshotCache.current = snapshot ? { key, draft: snapshot } : null; setData(result.draft === null ? null : result); setShared(snapshot); setRefreshError(''); }
  };
  useEffect(() => { void load().catch(error => setRefreshError(message(error))); return () => { sequence.current++; }; }, [draftId]);
  useBackgroundRefresh(load, !busy);
  const act = async <T,>(work: () => Promise<T>): Promise<T> => {
    setBusy(true); setError(''); setRefreshError('');
    try {
      const result = await work();
      // A failed metadata refresh must not discard a successfully created one-time link.
      try { await load(); } catch { setRefreshError('Ändringen är sparad, men vyn kunde inte uppdateras. Försöker igen i bakgrunden.'); }
      return result;
    }
    catch (error) { setError(message(error)); throw error; }
    finally { setBusy(false); }
  };
  const save = async () => { const revision = await onSave(); const result = await request<{ version: number }>(`/api/drafts/${draftId}/publish`, { revision }); setHistorical(null); return { ...result, revision }; };
  const post = async (input: CommentInput) => { await request(`/api/drafts/${draftId}/comments`, input); await load(); };
  const resolve = async (thread: ReviewThread) => { await request(`/api/drafts/${draftId}/threads/${thread.id}`, { resolved: !thread.resolved }); await load(); };
  const view = async (version: number) => { const result = await request<{ draft: Draft }>(`/api/drafts/${draftId}/versions/${version}`); setHistorical({ draft: result.draft, version }); };
  const comment = (blockId: string) => { setFilter(blockId); setCommentRequest(value => value + 1); };
  return { data, shared, historical, setHistorical, filter, setFilter, busy, error: error || refreshError, setError, commentRequest, comment, post, resolve, view, load,
    saveVersion: () => act(save),
    createLink: (contactId: string, days: number) => act(async () => { const { revision } = await save(); return request<CreatedReviewLink>(`/api/drafts/${draftId}/links`, { contactId, revision, days }); }),
    revoke: (id: string) => act(() => request(`/api/drafts/${draftId}/links/${id}/revoke`, {})),
  };
}
export type EditorReview = ReturnType<typeof useEditorReview>;
export function EditorReviewPanel({ review, draft, changed, onShare }: { review: EditorReview; draft: Draft; changed: boolean; onShare: (contactId?: string) => void }) {
  const [revoke, setRevoke] = useState<string | null>(null);
  const latest = review.data?.versions[0], current = review.historical?.draft ?? review.shared ?? draft;
  const version = review.historical?.version ?? latest?.version ?? null;
  const links = review.data?.links ?? [], active = links.filter(isActiveLink), old = links.filter(link => !isActiveLink(link));
  const stale = active.filter(link => !linkMatchesDraft(link, draft)), same = active.filter(link => linkMatchesDraft(link, draft));
  const names = same.map(link => link.name.split(' ')[0]).join(' och ');
  const row = (link: ReviewLink, older = false) => <div className="sh-link" key={link.id}><div className="sh-link-main"><span className="ed-avatar" aria-hidden="true">{initials(link.name)}</span><div><strong>{link.name}</strong><span>{older ? link.revokedAt ? `Återkallad ${dateTime(link.revokedAt)}` : 'Utgången' : `${link.clientName ?? 'Tidigare klient'} · ser version ${latest?.version} · till ${dateTime(new Date(Number(link.expiresAt)).toISOString())}`}</span>{!older && !linkMatchesDraft(link, draft) && <span className="stale">Slutar fungera när du sparar</span>}</div></div>
    {!older && (revoke === link.id ? <div className="sh-confirm" role="group" aria-label="Bekräfta återkallning"><p>{link.name} kan inte längre öppna utkastet. Kommentarerna finns kvar.</p><div className="ed-form-actions"><button type="button" className="ed-btn" autoFocus onClick={() => setRevoke(null)}>Avbryt</button><button type="button" className="ed-btn danger" disabled={review.busy} onClick={() => { void review.revoke(link.id).then(() => setRevoke(null)).catch(() => {}); }}>Återkalla</button></div></div> : <div className="sh-link-actions"><button type="button" className="ed-text-btn" disabled={review.busy || Boolean(review.historical) || !linkMatchesDraft(link, draft)} onClick={() => onShare(link.contactId ?? undefined)}>Ny länk</button><button type="button" className="ed-text-btn" disabled={review.busy} onClick={() => setRevoke(link.id)}>Återkalla</button></div>)}</div>;
  return <><section className="ed-card sh-review"><div className="ed-card-head"><h2>Granskning</h2><span>{latest ? `Version ${latest.version} · ${dateTime(latest.publishedAt)}` : 'Ingen version än'}</span></div>
    <p className={`sh-line${stale.length ? ' warn' : ''}`}>{stale.length ? <>Tidigare klientlänkar slutar fungera när du sparar utkastet med {draft.company?.name ?? 'en ny klient'}.</> : !active.length ? <>{latest && `Version ${latest.version} är sparad. `}Bara du ser utkastet och dess versioner. Dela med en klient för att få kommentarer.</> : changed ? <>Ändringarna syns för {names} när du sparar utkastet.</> : <>{names} ser version {latest?.version}.</>}</p>
    <ErrorBox error={review.error} />{active.length > 0 && <><p className="sh-sub">Klientlänkar</p><div className="sh-links">{active.map(link => row(link))}</div></>}
    <button type="button" className={active.length ? 'ed-text-btn' : 'ed-btn large sh-share-button'} disabled={review.busy || Boolean(review.historical)} onClick={() => onShare()}>{active.length ? '+ Dela med fler' : 'Dela med klient…'}</button>
    {old.length > 0 && <details className="sh-older"><summary>Äldre länkar ({old.length})</summary>{old.map(link => row(link, true))}</details>}
    {review.data?.signings.map(signing => <a className="ed-btn" key={signing.documentId} href={`/documents/${signing.documentId}`}>Öppna skickat signeringsdokument</a>)}
  </section>
    {latest && (active.length > 0 || Boolean(review.data?.threads.length)) && <Discussion threads={review.data?.threads ?? []} version={version} filter={review.filter} setFilter={review.setFilter} label={id => sectionLabel(current, id)} post={review.post} resolve={review.resolve} owner canPost={!review.historical} identity={`Version ${latest.version}`} closedNote={review.historical ? `Du visar version ${review.historical.version}. Återgå till ditt utkast för att svara.` : undefined} onAnchor={thread => { if (thread.version) void review.view(thread.version).then(() => { if (thread.blockId) requestAnimationFrame(() => document.querySelector(`[data-review-block="${CSS.escape(thread.blockId!)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }).catch(error => review.setError(message(error))); }} />}
  </>;
}
