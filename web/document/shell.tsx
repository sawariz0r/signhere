import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { initials } from '../api';
import { Brand, BrandLockup } from '../ui';
import type { Brand as BrandData } from '../types';
import { accentStyle } from '../brand';
import '../editor/editor.css';
import './document.css';

export function StagePill({ children, done = false }: { children: ReactNode; done?: boolean }) {
  return <span className="rd-pill"><i className={`ed-dot${done ? ' done' : ''}`} aria-hidden="true" />{children}</span>;
}
export function StatusCard({ title, children, stage }: { title: string; children: ReactNode; stage: number }) {
  return <section className="ed-card rd-status" aria-live="polite"><h2><i className={`ed-dot${stage === 3 ? ' done' : ''}`} aria-hidden="true" />{title}</h2><p className="ed-card-text">{children}</p><ol className="rd-steps" aria-label="Dokumentets steg">{['Granskning', 'Signering', 'Signerat'].map((label, index) => <li className={index + 1 === stage ? 'active' : index + 1 < stage ? 'done' : ''} aria-current={index + 1 === stage ? 'step' : undefined} key={label}><span>{index + 1}</span>{label}</li>)}</ol></section>;
}
export function Callout({ title, children, tone = 'neutral' }: { title: string; children: ReactNode; tone?: 'neutral' | 'warn' | 'done' }) {
  return <section className={`rd-callout ${tone}`} role={tone === 'done' ? 'status' : undefined}><span className="rd-callout-icon" aria-hidden="true">{tone === 'done' ? '✓' : tone === 'warn' ? '!' : 'i'}</span><div><h2>{title}</h2>{children}</div></section>;
}

export function DocumentShell({ title, brand, person, status, done, stagebar, callout, canvas, panel, discussion, count = 0, action, commentRequest = 0, onComment }: {
  title: string; brand?: BrandData | null; person?: string; status: string; done?: boolean; stagebar?: ReactNode; callout?: ReactNode;
  canvas: ReactNode; panel?: ReactNode; discussion?: ReactNode; count?: number; action?: ReactNode; commentRequest?: number; onComment?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width:859px)').matches);
  useEffect(() => { const query = window.matchMedia('(max-width:859px)'); const change = () => setMobile(query.matches); query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
  const open = () => { if (mobile) dialog.current?.showModal(); else document.querySelector('.rd-panel .rd-discussion')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  const close = () => { dialog.current?.close(); opener.current?.focus(); };
  useEffect(() => { if (commentRequest) { open(); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(mobile ? '.rd-sheet textarea' : '.rd-panel textarea')?.focus(), 0); } }, [commentRequest]);
  return <div className="ed rd-workspace" style={accentStyle(brand)}>
    <header className="ed-topbar"><div className="ed-topbar-inner">{brand ? <BrandLockup brand={brand} fallback="signhere" /> : <Brand publicBrand />}<span className="ed-slash" aria-hidden="true">/</span><h1 className="ed-title" title={title}>{title}</h1><StagePill done={done}>{status}</StagePill>{person && <span className="rd-who"><span className="ed-avatar" aria-hidden="true">{initials(person)}</span><span>{person}</span></span>}</div></header>
    <div className="ed-main"><main className="ed-canvas" aria-label={title}><div className="rd-mstatus">{status}</div>{callout}<div className="rd-stagebar">{stagebar}</div>{canvas}</main><aside className="ed-panel rd-panel" aria-label="Dokument och diskussion">{panel}{!mobile && discussion}</aside></div>
    {(discussion || action) && <footer className={`rd-bar${!action ? ' review-only' : ''}`}><div className="rd-bar-in">{discussion && <button ref={opener} type="button" className="ed-btn large rd-comments-btn" aria-haspopup={mobile ? 'dialog' : undefined} onClick={open}><MessageSquare size={16} aria-hidden="true" />Kommentarer<span className="ed-count">{count}</span></button>}{onComment && <button type="button" className="ed-btn primary large rd-mobile-comment" onClick={onComment}>Kommentera</button>}{action && <div className="rd-primary-action">{action}</div>}</div></footer>}
    {mobile && discussion && <dialog ref={dialog} className="rd-sheet" aria-labelledby="discussion-sheet-title" onClick={event => { if (event.target === event.currentTarget) close(); }} onCancel={() => opener.current?.focus()}><header><h2 id="discussion-sheet-title">Kommentarer</h2><button type="button" className="ed-btn" aria-label="Stäng kommentarer" onClick={close}><X size={18} /></button></header><div className="rd-sheet-body">{discussion}</div></dialog>}
  </div>;
}
