import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useEditorApi } from './context';
import { expiryDate, initials, signers, type Draft } from './model';
import type { ShareLink } from '../types';

export type SendRequest = { draft: Draft; recipients: { name: string; email: string }[]; expiresAt: string; remind: boolean; allowDecline: boolean };

export function SendDialog({ onClose, onSend }: { onClose: () => void; onSend?: (request: SendRequest) => Promise<ShareLink[]> }) {
  const { draft, user } = useEditorApi();
  const [sending, setSending] = useState(false);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  const card = useRef<HTMLDivElement>(null);
  const list = signers(draft, user);
  const { expiresInDays, remind, allowDecline } = draft.settings;
  const copyTimer = useRef(0);
  useEffect(() => { card.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [links]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const send = async () => {
    if (!onSend || sending) return;
    setSending(true); setError('');
    try { setLinks(await onSend({ draft, recipients: list.map(({ name, email }) => ({ name, email })), expiresAt: expiryDate(draft).toISOString().slice(0, 10), remind, allowDecline })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Något gick fel.'); }
    finally { setSending(false); }
  };
  const copy = (link: ShareLink) => {
    void navigator.clipboard?.writeText(link.url).catch(() => undefined);
    setCopied(link.recipientId);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1400);
  };

  return <div className="ed-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !sending) onClose(); }}>
    <div ref={card} className="ed-dialog" role="dialog" aria-modal="true" aria-labelledby="ed-send-title">
      {links ? <>
        <div className="ed-sent-head">
          <span className="ed-sent-mark" aria-hidden="true"><Check size={22} strokeWidth={2.5} /></span>
          <div><h2 id="ed-send-title">Skickat</h2><p>Varje mottagare får sin personliga länk via e-post.</p></div>
        </div>
        {links.length > 0 && <div className="ed-links">{links.map(link => <div key={link.recipientId} className="ed-link">
          <div><strong>{link.name}</strong><code>{link.url}</code></div>
          <button type="button" className="ed-btn" onClick={() => copy(link)}>{copied === link.recipientId ? 'Kopierad' : 'Kopiera'}</button>
        </div>)}</div>}
        <div className="ed-dialog-actions"><button type="button" className="ed-btn primary large" onClick={onClose}>Klar</button></div>
      </> : <>
        <div><h2 id="ed-send-title">Skicka för signering</h2><p className="ed-dialog-sub">{draft.title || 'Namnlöst dokument'}</p></div>
        <div className="ed-send-list">{list.map(signer => <div key={signer.id}>
          <span className="ed-avatar large">{initials(signer.name)}</span>
          <div><strong>{signer.name}</strong><span>{signer.email}</span></div>
        </div>)}</div>
        <p className="ed-dialog-note">Signera inom {expiresInDays} dagar{remind && ' · påminnelse var 3:e dag'}{allowDecline && ' · kan nekas'}</p>
        {!onSend && <p className="ed-dialog-note">Utskick från editorn kopplas på när servern kan rendera blocken till PDF. Utkastet sparas under tiden.</p>}
        {error && <p className="ed-error" role="alert">{error}</p>}
        <div className="ed-dialog-actions">
          <button type="button" className="ed-btn large" onClick={onClose} disabled={sending}>Avbryt</button>
          <button type="button" className="ed-btn primary large send" disabled={!onSend || sending} onClick={send}>{sending && <span className="ed-pulse" aria-hidden="true" />}{sending ? 'Skickar' : 'Skicka'}</button>
        </div>
      </>}
    </div>
  </div>;
}
