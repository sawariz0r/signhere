import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type FormEvent } from 'react';
import { dateTime, download, fetchPdf, message, pages, request } from './api';
import { PdfPreview } from './pdf';
import type { SignSession, SigningDocument, Strokes } from './types';
import { Brand, ErrorBox, Field, Loading, Signature } from './ui';

function DrawSignature({ onChange }: { onChange: (strokes: Strokes) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Strokes>([]);
  const drawing = useRef<number | null>(null);
  const cursor = useRef([0.2, 0.5]);
  const keyboardDrawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [warning, setWarning] = useState('');
  const repaint = () => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const rect = element.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    element.width = Math.round(rect.width * dpr); element.height = Math.round(rect.height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.strokeStyle = '#0e1116'; context.lineWidth = 2.6; context.lineCap = 'round'; context.lineJoin = 'round';
    for (const stroke of strokes.current) {
      context.beginPath(); stroke.forEach(([x, y], index) => { if (index) context.lineTo(x * rect.width, y * rect.height); else context.moveTo(x * rect.width, y * rect.height); }); context.stroke();
    }
    if (document.activeElement === element) { context.strokeStyle = '#9aa1ab'; context.lineWidth = 1; context.strokeRect(cursor.current[0] * rect.width - 3, cursor.current[1] * rect.height - 3, 6, 6); }
  };
  useEffect(() => { const observer = new ResizeObserver(repaint); if (canvas.current) observer.observe(canvas.current); return () => observer.disconnect(); }, []);
  const update = () => { setHasInk(strokes.current.some(stroke => stroke.length >= 2)); onChange(strokes.current.filter(stroke => stroke.length >= 2).map(stroke => stroke.map(point => [...point]))); repaint(); };
  const begin = (point: number[]) => {
    if (strokes.current.length >= 100) { setWarning('Signaturen har många streck. Rensa och försök med en enklare signatur.'); return false; }
    strokes.current.push([point]); return true;
  };
  const add = (point: number[]) => {
    const stroke = strokes.current.at(-1);
    if (!stroke || stroke.length >= 2000 || strokes.current.reduce((n, s) => n + s.length, 0) >= 12000) { setWarning('Signaturen har nått maximal storlek. Rensa om du vill rita om.'); return; }
    stroke.push(point); update();
  };
  const point = (event: PointerEvent<HTMLCanvasElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))]; };
  const keyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === ' ') { event.preventDefault(); setKeyboard(true); keyboardDrawing.current = !keyboardDrawing.current; if (keyboardDrawing.current) begin([...cursor.current]); update(); return; }
    if (event.key === 'Escape') { keyboardDrawing.current = false; update(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); setKeyboard(true); const increment = event.shiftKey ? 0.025 : 0.01;
      const [x, y] = cursor.current; cursor.current = [Math.max(0, Math.min(1, x + (event.key === 'ArrowRight' ? increment : event.key === 'ArrowLeft' ? -increment : 0))), Math.max(0, Math.min(1, y + (event.key === 'ArrowDown' ? increment : event.key === 'ArrowUp' ? -increment : 0)))];
      if (keyboardDrawing.current) add([...cursor.current]); else repaint();
    }
  };
  return <div><div className="draw-label"><span>Rita din signatur</span><button type="button" className="text-button underlined text-small" onClick={() => { strokes.current = []; drawing.current = null; keyboardDrawing.current = false; setWarning(''); update(); }}>Rensa</button></div><div className="draw-area"><canvas ref={canvas} tabIndex={0} aria-label="Rita din signatur med mus eller finger. Med tangentbord: pilar flyttar pennan, mellanslag börjar eller avslutar ett streck." onKeyDown={keyDown} onFocus={repaint} onBlur={() => { keyboardDrawing.current = false; repaint(); }} onPointerDown={event => { if (drawing.current !== null) return; const p = point(event); if (!begin(p)) return; drawing.current = event.pointerId; cursor.current = p; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={event => { if (drawing.current === event.pointerId) { cursor.current = point(event); add(cursor.current); } }} onPointerUp={event => { if (drawing.current === event.pointerId) { add(point(event)); drawing.current = null; update(); } }} onPointerCancel={() => { drawing.current = null; update(); }} /><div className="signature-baseline" /><span className="signature-cross">×</span>{!hasInk && <span className="draw-placeholder">Rita med mus eller finger</span>}</div>{keyboard && <p className="text-tiny muted">Piltangenter: flytta pennan. Mellanslag: börja eller avsluta ett streck.</p>}<ErrorBox error={warning} /></div>;
}

function SignatureModal({ session, token, hash, onClose, onComplete }: { session: SignSession; token: string; hash: string; onClose: () => void; onComplete: (doc: SigningDocument) => void }) {
  const modal = useRef<HTMLDialogElement>(null);
  const recipient = session.document.recipients.find(r => r.id === session.recipientId);
  const [name, setName] = useState(recipient?.name ?? '');
  const [strokes, setStrokes] = useState<Strokes>([]);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { modal.current?.showModal(); return () => modal.current?.close(); }, []);
  const length = strokes.reduce((sum, stroke) => sum + stroke.reduce((n, p, i) => n + (i ? Math.hypot(p[0] - stroke[i - 1][0], p[1] - stroke[i - 1][1]) : 0), 0), 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !accepted || length < 0.15 || !name.trim()) return;
    setBusy(true); setError('');
    try { const result = await request<{ document: SigningDocument }>('/api/sign/complete', { token, documentHash: hash, consentVersion: session.consent.version, ...(session.signingIntentHash ? { signingIntentHash: session.signingIntentHash } : {}), accepted: true, name: name.trim(), payload: { strokes } }); onComplete(result.document); }
    catch (error) { setError(message(error)); setBusy(false); }
  };
  return <dialog ref={modal} className="signature-modal" aria-labelledby="sign-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><form onSubmit={submit} className="stack"><div className="actions between"><h2 id="sign-title">Signera</h2><button type="button" className="text-button" disabled={busy} onClick={onClose}>Avbryt</button></div><Field label="Ditt fullständiga namn" autoComplete="name" value={name} onChange={event => setName(event.target.value)} required maxLength={160} disabled={busy} /><DrawSignature onChange={setStrokes} /><label className="checkbox consent"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={busy} />{session.consent.text}</label><ErrorBox error={error} /><button className="button sign-submit" disabled={busy || !accepted || length < 0.15 || !name.trim()}>{busy ? 'Signerar…' : 'Signera dokumentet'}</button><p className="muted text-tiny center">Tidpunkt, IP-adress och enhet sparas som bevis för din signatur.</p></form></dialog>;
}

export function Sign({ token, embedded = false, autoOpen = false, onBack, onSigned }: {
  token: string;
  embedded?: boolean;
  autoOpen?: boolean;
  onBack?: () => void;
  onSigned?: (document: SigningDocument) => void;
}) {
  const [session, setSession] = useState<SignSession | null>(null);
  const autoOpened = useRef(false);
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [hash, setHash] = useState('');
  const [pdfReady, setPdfReady] = useState(false);
  const [error, setError] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadSession = async () => { const result = await request<SignSession>('/api/sign/session', { token }); setSession(result); return result; };
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!token) throw new Error('Signeringslänken saknar en nyckel. Använd hela länken från avsändaren.');
        const result = await request<SignSession>('/api/sign/session', { token });
        if (!active) return; setSession(result);
        if (result.document.status === 'cancelled' || result.document.recipients.find(r => r.id === result.recipientId)?.signedAt) return;
        try {
          const blob = await fetchPdf('/api/sign/pdf', { token });
          if (!crypto.subtle) throw new Error('Öppna signhere via HTTPS eller localhost för att kontrollera och signera dokumentet.');
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
          if (digest !== result.document.originalHash) throw new Error('PDF-filens fingeravtryck stämmer inte med dokumentet. Kontakta avsändaren.');
          if (active) { setPdf(blob); setHash(digest); }
        } catch (error) { if (active) setPdfError(message(error)); }
      } catch (error) { if (active) setError(message(error)); }
    })();
    return () => { active = false; };
  }, [token]);
  const recipient = session?.document.recipients.find(r => r.id === session.recipientId);
  const doc = session?.document;
  useEffect(() => {
    if (autoOpen && !autoOpened.current && doc?.status === 'pending' && recipient && !recipient.signedAt && hash && pdf && pdfReady && !pdfError) {
      autoOpened.current = true;
      setSheet(true);
    }
  }, [autoOpen, doc?.status, recipient, hash, pdf, pdfReady, pdfError]);
  useEffect(() => {
    if (doc?.status !== 'finalizing') return;
    const timer = setInterval(() => { void loadSession().catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [doc?.status, token]);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  return <div className={`sign-screen${embedded ? ' sign-embedded' : ''}`}>{embedded ? <div className="sign-back"><button className="text-button" onClick={onBack}>← Tillbaka</button></div> : <header className="sign-header"><div><Brand /></div></header>}{!doc || !recipient ? <main className="sign-main"><ErrorBox error={error} />{!error && <Loading>Öppnar dokument…</Loading>}</main> : doc.status === 'cancelled' && !recipient.signedAt ? <div className="sign-done"><h1>Signeringen är avbruten</h1><p>Kontakta {doc.sender.name} om du har frågor.</p></div> : recipient.signedAt ? <div className="sign-done"><span className="circle large">✓</span><h1>Signerat</h1><p>Du har signerat <strong>{doc.title}</strong>.</p><p className="muted text-small">{doc.status === 'completed' ? `Alla parter har signerat. Du kan ladda ner den signerade PDF-filen.${session?.emailCopy ? ' En kopia skickas också till din e-post.' : ''}` : doc.status === 'finalizing' ? `Alla parter har signerat. PDF-filen färdigställs – din underskrift är sparad.${session?.emailCopy ? ' Den signerade PDF-filen skickas till din e-post när den är klar.' : ''}` : doc.status === 'cancelled' ? 'Avsändaren har avbrutit den återstående signeringen.' : session?.emailCopy ? 'Väntar på resterande parter. Den signerade PDF-filen skickas till din e-post när alla har signerat.' : 'Väntar på resterande parter. Återvänd till den här länken för att hämta dokumentet när alla har signerat.'}</p><div className="signed-receipt"><Signature strokes={recipient.signature?.strokes} /><div><strong>{recipient.signedName || recipient.name}</strong><div className="mono">{dateTime(recipient.signedAt)}</div><div className="mono">{doc.id}</div></div></div><ErrorBox error={error} />{doc.status === 'completed' ? <div className="stack"><button className="button" disabled={busy} onClick={() => void action(() => download('/api/sign/download', `${doc.title}_signerat.pdf`, { token }))}>Ladda ner signerad PDF</button></div> : doc.status !== 'cancelled' && <div className="stack small-gap"><button className="button secondary" disabled={busy} onClick={() => void action(() => download('/api/sign/pdf', `${doc.title}.pdf`, { token }))}>Ladda ner dokumentet du signerade</button>{doc.status === 'pending' && <button className="button secondary" disabled={busy} onClick={() => void action(loadSession)}>{busy ? 'Kontrollerar…' : 'Kontrollera status'}</button>}<p className="muted text-tiny">Samma PDF som du läste och signerade. Kontrollsumma {doc.originalHash.slice(0, 16)}…</p></div>}</div> : <><main className="sign-main"><p className="muted sender-line">{doc.sender.name} · {doc.sender.teamName}</p><h1>{doc.title}</h1><p className="sign-intro">Hej {recipient.name.split(' ')[0]}, läs igenom dokumentet och signera längst ned.</p><ErrorBox error={error} /><ErrorBox error={pdfError} />{pdf ? <PdfPreview source={pdf} onReady={() => setPdfReady(true)} onError={text => { setPdfReady(false); setPdfError(text); }} /> : !pdfError && <Loading>Kontrollerar och öppnar PDF…</Loading>}<section className="sign-signatures"><div className="eyebrow">SIGNATURER</div><div>{doc.recipients.map(r => <div key={r.id}><div className="signature-line"><Signature strokes={r.signature?.strokes} /></div><strong>{r.signedName || r.name}</strong><p className="muted text-small">{r.signedAt ? dateTime(r.signedAt) : 'Väntar på signatur'}</p></div>)}</div></section><details className="document-fingerprint"><summary>Dokumentets fingeravtryck (SHA-256)</summary><p className="mono hash">{doc.originalHash}</p></details></main><footer className="sign-footer"><div><div className="grow"><strong>{recipient.name}</strong><p>{pages(doc.pages)}</p></div><button className="button" disabled={!hash || !pdf || !pdfReady || Boolean(pdfError)} onClick={() => setSheet(true)}>Signera</button></div></footer>{sheet && session && <SignatureModal session={session} token={token} hash={hash} onClose={() => setSheet(false)} onComplete={document => { setSession({ ...session, document }); setSheet(false); window.scrollTo(0, 0); onSigned?.(document); }} />}</>}</div>;
}

export function CompletedCopy({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="sign-screen"><header className="sign-header"><Brand /></header><main className="sign-done"><h1>Ditt signerade dokument</h1><p>Ladda ner din signerade PDF-fil.</p><ErrorBox error={error} /><button className="button" disabled={busy || !token} onClick={async () => { setBusy(true); setError(''); try { await download('/api/copy/download', 'signhere_signerat.pdf', { token }); } catch (error) { setError(message(error)); } finally { setBusy(false); } }}>{busy ? 'Hämtar…' : 'Ladda ner signerad PDF'}</button></main></div>;
}
