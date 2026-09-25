import { useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { initials } from './api';
import type { Central, SigningDocument, Strokes } from './types';

export function Brand({ publicBrand = false }: { publicBrand?: boolean }) {
  return <div className="brand" aria-label="signhere"><span className="brand-icon"><i /></span><span>signhere{publicBrand && <span className="brand-suffix">.se</span>}</span></div>;
}
export function ErrorBox({ error }: { error: string }) { return error ? <div className="error" role="alert">{error}</div> : null; }
export function Loading({ children = 'Hämtar…' }: { children?: ReactNode }) { return <div className="loading" role="status">{children}</div>; }
export function Field({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) { return <label className="field"><span>{label}</span><input {...props} /></label>; }
export function Avatar({ name, dark = false }: { name: string; dark?: boolean }) { return <span className={`avatar${dark ? ' dark' : ''}`}>{initials(name)}</span>; }
export function PdfIcon() { return <span className="pdf-icon" aria-hidden="true">PDF</span>; }
export function Status({ doc }: { doc: SigningDocument }) {
  return <span className="status"><i className={`dot ${doc.status}`} />{doc.status === 'completed' ? 'Signerat' : doc.status === 'cancelled' ? 'Avbrutet' : doc.status === 'finalizing' ? 'Färdigställs' : `Väntar · ${doc.recipients.filter(r => r.signedAt).length}/${doc.recipients.length}`}</span>;
}
export function Signature({ strokes, className = '' }: { strokes?: Strokes; className?: string }) {
  return strokes?.length ? <svg className={`signature ${className}`} viewBox="0 0 500 190" role="img" aria-label="Ritad signatur">{strokes.map((stroke, i) => <polyline key={i} points={stroke.map(([x, y]) => `${x * 500},${y * 190}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />)}</svg> : null;
}
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setError(''); window.setTimeout(() => setCopied(false), 1800); }
    catch { setError('Kopiering är inte tillgänglig. Markera och kopiera länken ovan.'); }
  };
  return <div className="stack small-gap"><div className="share-row"><input className="share-url mono" value={url} readOnly aria-label="Personlig länk" onFocus={e => e.target.select()} /><button className="button small" onClick={copy}>{copied ? 'Kopierad ✓' : 'Kopiera'}</button><a className="button secondary small" href={url} target="_blank" rel="noopener noreferrer">Öppna</a></div><ErrorBox error={error} /></div>;
}
export function Dropzone({ onFile, title, subtitle, verify = false, disabled = false }: { onFile: (file: File) => void; title: string; subtitle: string; verify?: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return <><input ref={input} type="file" accept="application/pdf,.pdf" className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={e => { const file = e.target.files?.[0]; if (file) onFile(file); e.target.value = ''; }} /><button type="button" disabled={disabled} className={`dropzone${drag ? ' dragging' : ''}`} onClick={() => input.current?.click()} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); const file = e.dataTransfer.files[0]; if (file && !disabled) onFile(file); }}><span className={`circle${verify ? ' outlined' : ''}`}>{verify ? '↑' : '+'}</span><strong>{title}</strong><span>{subtitle}</span></button></>;
}
/** Opt-in per document; only rendered when the installation has a central service configured. */
export function IndependentApprovalOption({ central, checked, onChange, disabled = false }: { central?: Central; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  if (!central?.independentApproval) return null;
  const host = new URL(central.service).host;
  return <label className="checkbox independent-option"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span><strong>Kräv oberoende bekräftelse via {host}</strong><span className="muted text-small"> Varje mottagare bekräftar sin e-postadress och godkänner dokumentet hos {host}, fristående från den här servern. Dokumentet skickas aldrig dit. Bekräftar inte identitet.</span></span></label>;
}
