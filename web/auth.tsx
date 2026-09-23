import { useState, type FormEvent } from 'react';
import { message, request } from './api';
import type { User } from './types';
import { Brand, ErrorBox, Field } from './ui';

export function Auth({ setup, invitationToken, onLogin, onVerify }: { setup: boolean; invitationToken?: string; onLogin: (user: User) => void; onVerify: () => void }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [teamName, setTeamName] = useState('');
  const [setupToken, setSetupToken] = useState(() => decodeURIComponent(location.hash.slice(1)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const invitation = Boolean(invitationToken);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (setup && !invitation && step === 1) { setStep(2); return; }
    setBusy(true);
    try {
      const result = invitation
        ? await request<{ user: User }>('/api/invitations/accept', { token: invitationToken, name, password })
        : setup
          ? await request<{ user: User }>('/api/setup', { setupToken, name, email, password, teamName })
          : await request<{ user: User }>('/api/login', { email, password });
      setPassword(''); setSetupToken(''); history.replaceState({}, '', '/'); onLogin(result.user);
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  return <div className="auth-screen"><header className="auth-header"><Brand publicBrand /><button className="text-button underlined" onClick={onVerify}>Verifiera ett dokument</button></header><main className="auth-body"><form className="auth-form" onSubmit={submit}>
    {setup && !invitation && <div className="eyebrow">Steg {step} av 2</div>}
    <div className="auth-title"><h1>{invitation ? 'Gå med i teamet' : setup ? step === 1 ? 'Skapa konto' : 'Ditt team' : 'Välkommen tillbaka'}</h1><p>{invitation ? 'Skapa ditt konto för att börja samarbeta.' : setup ? step === 1 ? 'Skicka ditt första avtal för signering på en minut.' : 'Vad heter företaget eller teamet?' : 'Logga in för att hantera dina dokument.'}</p></div>
    {step === 1 ? <>
      {(setup || invitation) && <Field label="Namn" value={name} onChange={e => setName(e.target.value)} placeholder="För- och efternamn" autoComplete="name" required maxLength={160} />}
      {!invitation && <Field label="E-post" value={email} onChange={e => setEmail(e.target.value)} placeholder="namn@foretag.se" type="email" autoComplete="email" required maxLength={254} />}
      <Field label="Lösenord" value={password} onChange={e => setPassword(e.target.value)} placeholder={setup || invitation ? 'Minst 12 tecken' : 'Ditt lösenord'} type="password" autoComplete={setup || invitation ? 'new-password' : 'current-password'} minLength={setup || invitation ? 12 : 1} maxLength={128} required />
    </> : <>
      <Field label="Teamnamn" value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="t.ex. Lind & Co AB" autoComplete="organization" required maxLength={160} />
      {!location.hash && <><Field label="Installationsnyckel" value={setupToken} onChange={e => setSetupToken(e.target.value)} type="password" autoComplete="off" required /><p className="muted text-small">Använd installationsnyckeln från din server.</p></>}
    </>}
    <ErrorBox error={error} />
    <button className="button auth-submit" disabled={busy}>{busy ? 'Vänta…' : invitation ? 'Gå med i teamet' : setup ? step === 1 ? 'Fortsätt' : 'Skapa team' : 'Logga in'}</button>
    {step === 2 && <button className="text-button" type="button" disabled={busy} onClick={() => { setStep(1); setError(''); }}>Tillbaka</button>}
  </form></main></div>;
}
