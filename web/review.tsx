import { useEffect, useRef, useState } from 'react';
import { message, request, RequestError } from './api';
import { ErrorBox, Loading } from './ui';
import { ReadOnlyDraft, sectionLabel } from './editor/read-only';
import { Discussion } from './document/discussion';
import { useBackgroundRefresh } from './document/refresh';
import { Callout, DocumentShell, StatusCard } from './document/shell';
import type { CommentInput, ReviewData } from './document/types';
import '@fontsource-variable/source-serif-4';

export function Review({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData | null>(null), [version, setVersion] = useState<number | undefined>();
  const [selected, setSelected] = useState<string | null>(null), [commentRequest, setCommentRequest] = useState(0), [error, setError] = useState('');
  const generation = useRef(0);
  const load = async (background = false) => {
    const current = ++generation.current;
    try {
      const result = await request<Omit<ReviewData, 'draft'> & { draft?: ReviewData['draft'] }>('/api/review/session', { token, ...(version ? { version } : {}), ...(background && data ? { knownVersion: data.version } : {}) });
      const draft = result.draft ?? (data?.version === result.version ? data.draft : undefined);
      if (!draft) throw new Error('Dokumentet kunde inte hämtas.');
      if (current === generation.current) { setData({ ...result, draft }); setError(''); }
    } catch (error) {
      if (current === generation.current && (!background || error instanceof RequestError && [400, 401, 403, 404, 410].includes(error.status))) { setData(null); setError(message(error)); }
    }
  };
  useEffect(() => { setData(null); setSelected(null); void load(); return () => { generation.current++; }; }, [token, version]);
  useBackgroundRefresh(() => load(true), Boolean(data));
  useEffect(() => { document.title = data ? `${data.draft.title} · signhere` : 'Dokument · signhere'; }, [data?.draft.title]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, []);
  const post = async (input: CommentInput) => { await request('/api/review/comments', { ...input, token }); await load(); };
  const comment = (id: string | null) => { setSelected(id); setCommentRequest(value => value + 1); };
  if (!data) return <DocumentShell title="Dokument" status={error ? 'Länken kan inte öppnas' : 'Öppnar…'} canvas={<><ErrorBox error={error} />{error ? <button className="ed-btn" onClick={() => void load()}>Försök igen</button> : <Loading>Öppnar dokument…</Loading>}</>} />;
  const latest = data.versions[0].version, old = data.version !== latest, signing = Boolean(data.signing);
  const status = signing ? data.signing?.state === 'completed' ? 'Signerat' : 'Klar för signering' : 'Utkast för granskning';
  const threads = data.threads.filter(thread => thread.version === data.version);
  const discussion = <Discussion threads={data.threads} version={data.version} filter={selected} setFilter={setSelected} label={id => sectionLabel(data.draft, id)} post={post} canPost={!old && !signing} identity={`Du kommenterar som ${data.reviewerName}`} closedNote={signing ? 'Avtalet har skickats för signering. Ställ frågor via din personliga signeringslänk.' : old ? 'Du visar en tidigare version. Kommentera den senaste delade versionen.' : undefined} onAnchor={thread => { if (thread.version && thread.version !== data.version) setVersion(thread.version); setSelected(thread.blockId); if (thread.blockId) requestAnimationFrame(() => document.querySelector(`[data-review-block="${CSS.escape(thread.blockId!)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }} />;
  return <DocumentShell title={data.draft.title} brand={data.brand} person={data.reviewerName} status={status} done={data.signing?.state === 'completed'} commentRequest={commentRequest} onComment={!old && !signing ? () => comment(null) : undefined} count={threads.length} discussion={discussion}
    stagebar={<><span className="ed-mono">{signing ? 'Skickad för signering' : 'Utkast'}</span><select aria-label="Delad version" value={version ?? ''} onChange={event => setVersion(event.target.value ? Number(event.target.value) : undefined)}><option value="">Version {latest} (senaste)</option>{data.versions.map(item => <option value={item.version} key={item.version}>Version {item.version}</option>)}</select></>}
    callout={signing ? <Callout title={data.signing?.state === 'completed' ? 'Avtalet är signerat' : 'Avtalet är klart för signering'}><p>Avsändaren har skickat avtalet för signering. Din personliga signeringslänk öppnar samma dokumentvy med diskussionen kvar.</p><p>Avsändaren delar länken med dig direkt. Använd den för att signera och hämta ditt kvitto.</p></Callout> : old ? <p className="rd-version-note">Du tittar på version {data.version}.<button className="text-button underlined" onClick={() => setVersion(undefined)}>Visa version {latest}</button></p> : undefined}
    canvas={<ReadOnlyDraft key={data.version} draft={data.draft} threads={threads} selected={selected} onSelect={setSelected} onComment={id => comment(id)} />}
    panel={<StatusCard title={status} stage={signing ? data.signing?.state === 'completed' ? 3 : 2 : 1}>Version {data.version} är delad med dig. {signing ? 'Öppna din personliga signeringslänk för signeringen.' : 'Kommentera ett avsnitt eller hela dokumentet. Inget signeras här.'}</StatusCard>} />;
}
