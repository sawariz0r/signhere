import { useRef, useState, type FormEvent } from 'react';
import { Check, X } from 'lucide-react';
import { dateTime, initials, message } from '../api';
import { ErrorBox } from '../ui';
import type { CommentInput, ReviewThread } from './types';

function Composer({ label, send, identity }: { label: string; send: (body: string, requestId: string) => Promise<void>; identity?: string }) {
  const [body, setBody] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempt = useRef<{ body: string; id: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !body.trim()) return;
    setBusy(true); setError('');
    if (attempt.current?.body !== body.trim()) attempt.current = { body: body.trim(), id: crypto.randomUUID() };
    try { await send(attempt.current.body, attempt.current.id); setBody(''); attempt.current = null; }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  return <form className="rd-composer" onSubmit={event => void submit(event)}><label><span className="sr-only">{label}</span><textarea className="ed-input" aria-label={label} placeholder={label} value={body} onChange={event => setBody(event.target.value)} maxLength={5000} required rows={3} disabled={busy} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') event.currentTarget.form?.requestSubmit(); }} /></label><ErrorBox error={error} /><div className="rd-composer-foot"><span>{identity}</span><button className="ed-btn primary" disabled={busy || !body.trim()}>{busy ? 'Sparar…' : 'Skicka kommentar'}</button></div></form>;
}

export function Discussion({ threads, version, filter, setFilter, label, post, resolve, owner = false, signing = false, canPost = true, identity, closedNote, onAnchor }: {
  threads: ReviewThread[]; version: number | null; filter: string | null; setFilter: (id: string | null) => void; label: (id: string | null) => string;
  post: (input: CommentInput) => Promise<void>; resolve?: (thread: ReviewThread) => Promise<void>; owner?: boolean; signing?: boolean; canPost?: boolean;
  identity?: string; closedNote?: string; onAnchor?: (thread: ReviewThread) => void;
}) {
  const [reply, setReply] = useState<string | null>(null), [error, setError] = useState('');
  const current = threads.filter(thread => signing ? thread.signingDocumentId || thread.version === version : thread.version === version && !thread.signingDocumentId);
  const older = threads.filter(thread => !current.includes(thread) && (owner || signing || thread.version !== null && version !== null && thread.version < version));
  const visible = current.filter(thread => !filter || thread.blockId === filter);
  const renderThread = (thread: ReviewThread, old = false) => <article key={thread.id} className={`rd-thread${thread.resolved ? ' resolved' : ''}`} aria-label={`Kommentar om ${label(thread.blockId)}`}>
    <div className="rd-thread-head"><button type="button" className="rd-anchor" onClick={() => onAnchor?.(thread)}>{label(thread.blockId)}{(old || signing && !thread.signingDocumentId) && <span> · {thread.signingDocumentId ? 'under signering' : `v${thread.version}`}</span>}</button><span className={`rd-state${thread.resolved ? ' resolved' : ''}`}>{thread.resolved && <Check size={12} aria-hidden="true" />}{thread.resolved ? 'Löst' : 'Öppen'}</span></div>
    {thread.comments.map(comment => <div className="rd-comment" key={comment.id}><span className="ed-avatar" aria-hidden="true">{initials(comment.authorName)}</span><div className="rd-comment-meta"><strong>{comment.authorName}</strong><time>{dateTime(comment.createdAt)}</time></div><p>{comment.body}</p></div>)}
    <div className="rd-thread-actions">{canPost && !thread.resolved && (!old || owner) && <button type="button" className="ed-text-btn" onClick={() => setReply(reply === thread.id ? null : thread.id)}>Svara</button>}{resolve && <button type="button" className="ed-text-btn" onClick={() => { setError(''); void resolve(thread).catch(error => setError(message(error))); }}>{thread.resolved ? 'Öppna igen' : 'Markera som löst'}</button>}</div>
    {reply === thread.id && canPost && !thread.resolved && <Composer label="Svara" send={async (body, requestId) => { await post({ version: thread.version ?? 0, threadId: thread.id, body, requestId }); setReply(null); }} />}
  </article>;
  return <section className="ed-card rd-discussion" aria-label="Kommentarer"><div className="ed-card-head"><h2>{signing ? 'Diskussion' : 'Kommentarer'}</h2><span>{current.filter(thread => !thread.resolved).length} öppna</span></div>
    {filter && <div className="rd-filter"><span className="rd-chip">{label(filter)}<button type="button" aria-label="Visa alla kommentarer" onClick={() => setFilter(null)}><X size={12} /></button></span></div>}
    {canPost && <Composer key={`${version}:${filter ?? ''}`} label={filter ? `Kommentera ${label(filter)}` : signing ? 'Fråga om dokumentet' : 'Din kommentar'} identity={identity} send={(body, requestId) => post({ version: version ?? 0, blockId: filter, body, requestId })} />}
    {closedNote && <p className="rd-closed">{closedNote}</p>}<ErrorBox error={error} />
    <div className="rd-threads">{visible.map(thread => renderThread(thread))}</div>{!visible.length && <p className="rd-empty">Inga kommentarer {filter ? 'här ' : ''}ännu.</p>}
    {older.length > 0 && <details className="rd-older"><summary>Tidigare versioner och signering ({older.length})</summary><div className="rd-threads">{older.map(thread => renderThread(thread, true))}</div></details>}
  </section>;
}
