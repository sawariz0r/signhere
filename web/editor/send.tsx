import { useState } from 'react';
import { CircleAlert, CircleCheck, Plus, Send, TriangleAlert, X } from 'lucide-react';
import { useEditorApi } from './context';
import { expiryDate, fieldValue, validate, type Draft } from './model';
import type { User } from '../types';

export type SendRequest = { draft: Draft; recipients: { name: string; email: string }[]; expiresAt: string; saveAsTemplate: boolean };

export function SendDrawer({ user, onClose, onSend, onFix }: { user: User; onClose: () => void; onSend?: (request: SendRequest) => Promise<void>; onFix: (fix: 'add-signature' | 'add-customer') => void }) {
  const { draft, update, setField } = useEditorApi();
  const [extra, setExtra] = useState<{ name: string; email: string }[]>([]);
  const [expires, setExpires] = useState(() => expiryDate(draft).toISOString().slice(0, 10));
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const issues = validate(draft);
  const blocking = issues.filter(issue => issue.level === 'error');
  const recipients = [{ name: fieldValue(draft, 'customer.name'), email: fieldValue(draft, 'customer.email') }, ...extra].filter(item => item.name || item.email);
  const invalid = recipients.some(item => !item.name.trim() || !/^\S+@\S+\.\S+$/.test(item.email.trim()));
  const send = async () => {
    if (!onSend) return;
    setBusy(true); setError('');
    try { await onSend({ draft, recipients, expiresAt: expires, saveAsTemplate }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Något gick fel.'); }
    finally { setBusy(false); }
  };
  return <><div className="ed-scrim" onClick={onClose} /><aside className="ed-drawer ed-send" role="dialog" aria-modal="true" aria-labelledby="ed-send-title">
    <div className="ed-drawer-head"><h2 id="ed-send-title">Granska & skicka</h2><button type="button" className="ed-icon-ghost" aria-label="Stäng" onClick={onClose}><X size={18} /></button></div>
    <div className="ed-panel-body">
      <label className="ed-send-field"><span>Dokumentnamn</span><input value={draft.title} onChange={event => update(value => ({ ...value, title: event.target.value }))} /></label>
      <div className="ed-send-field"><span>Från</span><div className="ed-person"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><span>{user.email}</span></div></div></div>
      <div className="ed-send-field"><span>Till</span>
        <div className="ed-recipient">
          <input aria-label="Kundens namn" placeholder="Namn" value={draft.fields['customer.name'] ?? ''} onChange={event => setField('customer.name', event.target.value)} />
          <input aria-label="Kundens e-post" placeholder="E-post" type="email" value={draft.fields['customer.email'] ?? ''} onChange={event => setField('customer.email', event.target.value)} />
        </div>
        {extra.map((item, index) => <div className="ed-recipient" key={index}>
          <input aria-label={`Mottagare ${index + 2}, namn`} placeholder="Namn" value={item.name} onChange={event => setExtra(list => list.map((row, i) => i === index ? { ...row, name: event.target.value } : row))} />
          <input aria-label={`Mottagare ${index + 2}, e-post`} placeholder="E-post" type="email" value={item.email} onChange={event => setExtra(list => list.map((row, i) => i === index ? { ...row, email: event.target.value } : row))} />
          <button type="button" className="ed-icon-ghost" aria-label="Ta bort mottagare" onClick={() => setExtra(list => list.filter((_, i) => i !== index))}><X size={15} /></button>
        </div>)}
        <button type="button" className="ed-add-row" onClick={() => setExtra(list => [...list, { name: '', email: '' }])}><Plus size={14} />Fler mottagare</button>
      </div>
      <div className="ed-checklist">
        {issues.length ? issues.map((issue, index) => <div key={index} className={`ed-issue ${issue.level}`}>{issue.level === 'error' ? <CircleAlert size={16} /> : <TriangleAlert size={16} />}<span>{issue.message}</span>{issue.fix === 'add-signature' && <button type="button" className="button small" onClick={() => onFix('add-signature')}>Lägg till</button>}</div>)
          : <div className="ed-issue ok"><CircleCheck size={16} /><span>Allt ser bra ut. Dokumentet är redo att skickas.</span></div>}
      </div>
      <div className="ed-send-row">
        <label className="ed-send-field"><span>Giltig till</span><input type="date" value={expires} min={new Date().toISOString().slice(0, 10)} onChange={event => setExpires(event.target.value)} /></label>
      </div>
      <label className="ed-check"><input type="checkbox" checked={saveAsTemplate} onChange={event => setSaveAsTemplate(event.target.checked)} />Spara även som mall</label>
      {error && <div className="error" role="alert">{error}</div>}
    </div>
    <div className="ed-drawer-foot">
      <button type="button" className="button ed-send-button" disabled={!onSend || busy || blocking.length > 0 || invalid} onClick={send}><Send size={16} />{busy ? 'Skickar…' : 'Skicka för signering'}</button>
      {!onSend && <p className="ed-panel-hint">Utskick från editorn kopplas på när servern kan rendera blocken till PDF. Utkastet sparas under tiden.</p>}
    </div>
  </aside></>;
}
