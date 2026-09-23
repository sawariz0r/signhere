import { useEffect, useState, type FormEvent } from 'react';
import { dateTime, message, request } from './api';
import type { Team as TeamData, User } from './types';
import { Avatar, CopyLink, Dropzone, ErrorBox, Field, Loading } from './ui';

export function Verify() {
  const [result, setResult] = useState<{ match: boolean; hash: string; fileName: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const verify = async (file: File) => {
    setError(''); setResult(null); setBusy(file.name);
    try {
      if (!/\.pdf$/i.test(file.name)) throw new Error('Välj den signerade PDF-filen.');
      if (file.size > 50 * 1024 * 1024) throw new Error('Filen får vara högst 50 MB.');
      if (!crypto.subtle) throw new Error('Verifiering kräver en säker anslutning. Öppna signhere via HTTPS eller localhost.');
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
      const response = await request<{ match: boolean }>('/api/verify', { sha256: hash });
      setResult({ ...response, hash, fileName: file.name });
    } catch (error) { setError(message(error)); } finally { setBusy(''); }
  };
  return <div className="verify-screen"><h1>Verifiera dokument</h1><p className="intro">Kontrollera att en signerad PDF matchar den slutförda filen på denna signhere-server. Du behöver inget konto.</p><ErrorBox error={error} />
    {busy ? <div className="card"><Loading>Kontrollerar {busy}…</Loading></div> : result ? <section className="card verify-result"><div className={`verify-band ${result.match ? 'valid' : 'invalid'}`}><span className="circle medium">{result.match ? '✓' : '!'}</span><div><h2>{result.match ? 'Oförändrad signerad PDF' : 'Kunde inte verifieras'}</h2><p>{result.match ? 'Filen matchar en slutförd PDF hos denna signhere-server.' : 'Filen matchar ingen slutförd PDF hos denna server. Kontrollera att du har rätt fil och server.'}</p></div></div><div className="verify-facts"><p>{result.fileName}</p><div className="muted text-small">SHA-256</div><p className="mono hash">{result.hash}</p></div><div className="actions end"><button className="button secondary" onClick={() => setResult(null)}>{result.match ? 'Kontrollera en till' : 'Försök igen'}</button></div></section> : <Dropzone onFile={file => void verify(file)} title="Släpp den signerade PDF:en här" subtitle="Filen lämnar aldrig din enhet – bara dess fingeravtryck jämförs." verify />}
  </div>;
}

export function Team({ user, onRename, onLogout }: { user: User; onRename: (name: string) => void; onLogout: () => void }) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [name, setName] = useState(user.teamName);
  const [email, setEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = user.role === 'owner' || team?.members.find(member => member.id === user.id)?.role === 'owner';
  const load = async () => { const result = await request<TeamData>('/api/team'); setTeam(result); setName(result.name); };
  useEffect(() => { void load().catch(error => setError(message(error))); }, []);
  const rename = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try { await request('/api/team', { name: name.trim() }, 'PATCH'); onRename(name.trim()); setNotice('Teamnamnet sparades.'); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const invite = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setInviteLink('');
    try { const result = await request<{ url: string }>('/api/team/invitations', { email: email.trim() }); setInviteLink(result.url); setEmail(''); await load(); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const logout = async () => { setBusy(true); setError(''); try { await request('/api/logout', {}); onLogout(); } catch (error) { setError(message(error)); setBusy(false); } };
  return <div className="narrow team-screen"><h1>Team</h1><ErrorBox error={error} />{notice && <div className="notice" role="status">{notice}</div>}{!team && !error && <Loading />}
    <section className="card team-name"><form onSubmit={rename}><Field label="Teamnamn" value={name} onChange={e => setName(e.target.value)} required maxLength={160} disabled={!owner || busy} />{owner && <div className="actions end"><button className="button secondary small" disabled={busy || name.trim() === user.teamName}>Spara</button></div>}</form></section>
    {team && <section className="card team-members"><div className="team-invite"><h2>Medlemmar</h2>{owner && <form className="invite-form" onSubmit={invite}><input aria-label="E-post till ny medlem" type="email" placeholder="kollega@foretag.se" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254} /><button className="button" disabled={busy}>Bjud in</button></form>}{inviteLink && <div className="invitation-link"><p className="muted text-small">Dela den här länken med din kollega. Ingen e-post skickas automatiskt.</p><CopyLink url={inviteLink} /></div>}</div>{team.members.map(member => <div className="member" key={member.id}><Avatar name={member.name} dark={member.role === 'owner'} /><div className="grow"><strong>{member.name}</strong><p>{member.email}</p></div><span className="badge">{member.role === 'owner' ? 'Ägare' : 'Medlem'}</span></div>)}{team.invitations.map(invitation => <div className="member" key={invitation.id}><Avatar name={invitation.email} /><div className="grow"><strong>{invitation.email}</strong><p>Giltig till {dateTime(invitation.expiresAt)}</p></div><span className="badge">Inbjuden</span></div>)}</section>}
    <div className="team-logout"><button className="text-button underlined" disabled={busy} onClick={() => void logout()}>Logga ut</button></div>
  </div>;
}
