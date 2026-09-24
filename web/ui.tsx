import { useEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { initials } from './api';
import { ACCENTS, accentStyle, brandName, monogram } from './brand';
import type { AccentKey, Brand as BrandData, SigningDocument, Strokes, User } from './types';

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
/** The customer's brand: logo or accent monogram, the company name and "powered by signhere". */
export function BrandLockup({ brand, fallback, className = '' }: { brand: BrandData; fallback?: string; className?: string }) {
  const name = brandName(brand, fallback);
  const showName = !brand.logoUrl || brand.showName;
  return <span className={`brand-lockup ${className}`} style={accentStyle(brand)}>{brand.logoUrl ? <img className="brand-logo" src={brand.logoUrl} alt={showName ? '' : name} /> : <span className="brand-mark" aria-hidden="true">{monogram(name)}</span>}<span className="brand-text">{showName && <strong>{name}</strong>}<small>powered by signhere</small></span></span>;
}
export function Swatches({ value, onChange, disabled = false }: { value: AccentKey; onChange: (value: AccentKey) => void; disabled?: boolean }) {
  return <div className="swatches" role="radiogroup" aria-label="Accentfärg">{ACCENTS.map(([key, label, color]) => <button key={key} type="button" role="radio" aria-checked={value === key} aria-label={label} title={label} disabled={disabled} className={value === key ? 'selected' : ''} style={{ background: color, '--swatch': color } as CSSProperties} onClick={() => onChange(key)} />)}</div>;
}
export function useToast() {
  const [text, setText] = useState('');
  useEffect(() => { if (!text) return; const timer = window.setTimeout(() => setText(''), 2600); return () => window.clearTimeout(timer); }, [text]);
  return [text ? <div className="toast" role="status">{text}</div> : null, setText] as const;
}
export type MenuItem = { key: string; label: string; active?: boolean; onSelect: () => void };
/** Avatar button with the account menu: identity, settings tabs, verify and log out. Closes on Esc and outside click. */
export function ProfileMenu({ user, settings, onVerify, onLogout }: { user: User; settings: MenuItem[]; onVerify: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (focus = false) => { setOpen(false); if (focus) button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  const select = (action: () => void) => () => { close(); action(); };
  return <div className="profile">
    <button ref={button} type="button" className={`profile-button${open ? ' open' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Konto: ${user.name}`} onClick={() => setOpen(!open)}><span className="avatar dark">{initials(user.name)}</span><i aria-hidden="true" /></button>
    {open && <><div className="profile-scrim" onClick={() => close()} /><div ref={menu} className="profile-menu" role="menu" aria-label="Konto">
      <div className="profile-identity"><strong>{user.name}</strong><span>{user.email}</span></div>
      <div className="profile-group" aria-hidden="true">Inställningar</div>
      {settings.map(item => <button key={item.key} type="button" role="menuitem" className={item.active ? 'active' : ''} onClick={select(item.onSelect)}>{item.label}</button>)}
      <hr />
      <button type="button" role="menuitem" onClick={select(onVerify)}>Verifiera ett dokument</button>
      <button type="button" role="menuitem" onClick={select(onLogout)}>Logga ut</button>
    </div></>}
  </div>;
}
