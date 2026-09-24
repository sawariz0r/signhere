import { useEffect, useRef, type FormEvent } from 'react';
import { useEditorApi } from './context';
import { initials, signingContacts } from './model';

export type SendPhase = 'idle' | 'rendering' | 'creating';

/**
 * Confirms sending a main document. Signers were chosen in the editor, so this only
 * summarises them; it also shows progress and any error without leaving the editor.
 */
export function SendSheet({ emailEnabled, phase, error, onConfirm, onClose }: { emailEnabled: boolean; phase: SendPhase; error: string; onConfirm: () => void; onClose: () => void }) {
  const { draft, user } = useEditorApi();
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = phase !== 'idle';
  const contacts = signingContacts(draft);
  const senderSigns = draft.settings.senderSigns;
  const sharesSenderEmail = senderSigns && contacts.some(contact => contact.email.trim().toLowerCase() === user.email.toLowerCase());
  // A native modal dialog traps focus and returns it to the Skicka button when closed.
  useEffect(() => { dialog.current?.showModal(); dialog.current?.focus(); return () => dialog.current?.close(); }, []);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy) onConfirm(); };
  const primary = phase === 'rendering' ? 'Skapar PDF…' : phase === 'creating' ? 'Skickar…' : error ? 'Försök igen' : senderSigns ? 'Skicka och signera' : 'Skicka för signering';

  return <dialog ref={dialog} className="ed-dialog" aria-labelledby="ed-send-title" tabIndex={-1} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit} aria-busy={busy}>
      <div><h2 id="ed-send-title">Skicka för signering</h2><p className="ed-dialog-sub">{draft.title.trim()}</p></div>
      <div>
        <p className="ed-mono" id="ed-send-signers">Signerar</p>
        <ul className="ed-send-list" aria-labelledby="ed-send-signers">
          {contacts.map(contact => <li key={contact.id}>
            <span className="ed-avatar" aria-hidden="true">{initials(contact.name)}</span>
            <div><strong>{contact.name}</strong><span>{[contact.role, contact.email].filter(Boolean).join(' · ')}</span></div>
          </li>)}
          {senderSigns && <li>
            <span className="ed-avatar" aria-hidden="true">{initials(user.name)}</span>
            <div><strong>{user.name} (du)</strong><span>Du signerar i nästa steg</span></div>
          </li>}
        </ul>
      </div>
      <p className="ed-dialog-note">{emailEnabled ? 'Varje mottagare får sin personliga länk via e-post.' : 'Inga e-postmeddelanden skickas. Du får en personlig länk per mottagare att dela.'} En signatursida läggs till automatiskt sist i dokumentet.</p>
      {sharesSenderEmail && <p className="ed-dialog-note">Du och mottagaren signerar var för sig, även när ni använder samma e-postadress.</p>}
      {busy && <p className="ed-dialog-note" role="status">{phase === 'rendering' ? 'Skapar PDF av dokumentet…' : 'Skickar dokumentet…'}</p>}
      {error && <p className="ed-error" role="alert">{error}</p>}
      <div className="ed-dialog-actions">
        <button type="button" className="ed-btn large" disabled={busy} onClick={onClose}>Avbryt</button>
        <button className="ed-btn primary large" disabled={busy}>{busy && <span className="ed-pulse" aria-hidden="true" />}{primary}</button>
      </div>
    </form>
  </dialog>;
}
