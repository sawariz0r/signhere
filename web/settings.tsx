import { useEffect, useRef, useState, type FormEvent } from 'react';
import { date, dateTime, message, request } from './api';
import { accentStyle, brandName, logoPng } from './brand';
import type { Brand, Instance, SigningDocument, Team as TeamData, User } from './types';
import { Avatar, BrandLockup, CopyLink, Dropzone, ErrorBox, Field, Loading, Swatches, useToast } from './ui';

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
    {busy ? <div className="card"><Loading>Kontrollerar {busy}…</Loading></div> : result ? <section className="card verify-result"><div className={`verify-band ${result.match ? 'valid' : 'invalid'}`}><span className="circle medium">{result.match ? '✓' : '!'}</span><div><h2>{result.match ? 'Filen matchar serverns kopia' : 'Ingen matchning på denna server'}</h2><p>{result.match ? 'Filen matchar en slutförd PDF hos denna signhere-server.' : 'Filen matchar ingen slutförd PDF hos denna server. Kontrollera att du har rätt fil och server.'}</p></div></div><div className="verify-facts"><p>{result.fileName}</p><div className="muted text-small">SHA-256</div><p className="mono hash">{result.hash}</p></div><div className="actions end"><button className="button secondary" onClick={() => setResult(null)}>{result.match ? 'Kontrollera en till' : 'Försök igen'}</button></div></section> : <Dropzone onFile={file => void verify(file)} title="Släpp den signerade PDF:en här" subtitle="Filen lämnar aldrig din enhet – bara dess fingeravtryck jämförs." verify />}
    <details className="document-fingerprint"><summary>Verifiera utan denna server</summary><p className="text-small">Be avsändaren om verifieringspaketet. Det innehåller PDF, bevisdata och en fristående kontroll av den kryptografiska förseglingen. Servermatchningen ovan kontrollerar endast filens fingeravtryck.</p><p className="text-small">En försegling visar om de skyddade PDF-delarna har ändrats. Certifikatets avsändare behöver betros separat; ritad signatur och lokal servertid verifierar inte identitet eller betrodd tid.</p></details>
  </div>;
}


export type SettingsTab = 'brand' | 'team' | 'instance';
/** Settings tabs in order. Signing methods get their own tab once teams can choose them. */
export const settingsTabs = (user: User): [SettingsTab, string][] => [['brand', 'Varumärke'], ['team', 'Team'], ...(user.role === 'owner' ? [['instance', 'Instans'] as [SettingsTab, string]] : [])];

export function Settings({ tab, user, brand, onTab, onBrand, onLogout }: { tab: SettingsTab; user: User; brand: Brand; onTab: (tab: SettingsTab) => void; onBrand: (brand: Brand) => void; onLogout: () => void }) {
  return <div className="settings-screen"><h1>Inställningar</h1>
    <nav className="settings-tabs" aria-label="Inställningar">{settingsTabs(user).map(([key, label]) => <a key={key} href={`/settings/${key}`} aria-current={tab === key ? 'page' : undefined} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; event.preventDefault(); onTab(key); }}>{label}</a>)}</nav>
    {tab === 'team' ? <Team user={user} onLogout={onLogout} /> : tab === 'instance' ? <InstanceSettings /> : <BrandSettings user={user} brand={brand} onBrand={onBrand} />}
  </div>;
}

function BrandSettings({ user, brand, onBrand }: { user: User; brand: Brand; onBrand: (brand: Brand) => void }) {
  const owner = user.role === 'owner';
  const [name, setName] = useState(brand.name);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [logoError, setLogoError] = useState('');
  const [drag, setDrag] = useState(false);
  const [title, setTitle] = useState('');
  const [toast, showToast] = useToast();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void request<{ documents: SigningDocument[] }>('/api/documents').then(result => setTitle(result.documents[0]?.title ?? '')).catch(() => {}); }, []);
  const save = async (key: string, run: () => Promise<{ brand: Brand }>, done?: string) => {
    setBusy(key); setError('');
    try { const result = await run(); onBrand(result.brand); if (done) showToast(done); }
    catch (error) { setError(message(error)); } finally { setBusy(''); }
  };
  const rename = (event: FormEvent) => { event.preventDefault(); void save('name', () => request('/api/team', { name: name.trim() }, 'PATCH'), 'Företagsnamnet är sparat'); };
  const upload = async (file: File) => {
    if (!owner || busy) return;
    setLogoError('');
    let pngBase64: string;
    try { pngBase64 = await logoPng(file); } catch (error) { setLogoError(message(error)); return; }
    await save('logo', () => request('/api/team/logo', { pngBase64 }, 'PUT'), 'Logotypen är uppdaterad');
  };
  // The preview follows the name while typing; everything else is saved on change.
  const preview = { ...brand, name: name.trim() || brand.name };
  return <div className="brand-settings">{toast}
    <div className="stack">
      <ErrorBox error={error} />
      {!owner && <p className="settings-help">Endast teamägaren kan ändra varumärket.</p>}
      <section className="card settings-card"><form onSubmit={rename}><Field label="Företagsnamn" placeholder="t.ex. Lind & Co AB" value={name} onChange={event => setName(event.target.value)} required maxLength={160} disabled={!owner || Boolean(busy)} /><p className="settings-help">Visas i appen, för mottagare och på verifikatet.</p>{owner && name.trim() !== brand.name && <div className="actions end"><button className="button secondary small" disabled={Boolean(busy) || !name.trim()}>{busy === 'name' ? 'Sparar…' : 'Spara'}</button></div>}</form></section>
      <section className="card settings-card"><div className="settings-card-heading"><h2>Logotyp</h2>{owner && brand.logoUrl && <button type="button" className="text-button underlined text-small" disabled={Boolean(busy)} onClick={() => void save('logo', () => request('/api/team/logo', {}, 'DELETE'), 'Logotypen är borttagen')}>Ta bort</button>}</div>
        <input ref={input} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ''; }} />
        <button type="button" className={`logo-drop${drag ? ' dragging' : ''}`} disabled={!owner || Boolean(busy)} aria-describedby="logo-error" onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={event => { event.preventDefault(); setDrag(false); const file = event.dataTransfer.files[0]; if (file) void upload(file); }}>
          {busy === 'logo' ? <span className="settings-help">Laddar upp…</span> : brand.logoUrl ? <><img src={brand.logoUrl} alt="Nuvarande logotyp" /><span className="settings-help small">Klicka eller släpp en ny fil för att byta</span></> : <><strong>Ladda upp logotyp</strong><span className="settings-help">PNG eller SVG med transparent bakgrund · max 500 kB</span></>}
        </button>
        {logoError && <p id="logo-error" className="field-error" role="alert">{logoError}</p>}
        {brand.logoUrl && <label className="checkbox"><input type="checkbox" checked={brand.showName} disabled={!owner || Boolean(busy)} onChange={event => void save('showName', () => request('/api/team', { logoShowName: event.target.checked }, 'PATCH'))} />Visa företagsnamnet bredvid logotypen</label>}
      </section>
      <section className="card settings-card"><h2>Accentfärg</h2><p className="settings-help">Används på knappar och detaljer som mottagaren ser.</p><Swatches value={brand.accent} disabled={!owner || Boolean(busy)} onChange={accent => { if (accent !== brand.accent) void save('accent', () => request('/api/team', { accent }, 'PATCH')); }} /></section>
    </div>
    <div className="brand-preview"><div className="settings-help strong">Så ser det ut för mottagaren</div>
      <div className="brand-preview-card" aria-hidden="true" style={accentStyle(preview)}>
        <div className="brand-preview-header"><BrandLockup brand={preview} /></div>
        <div className="brand-preview-body"><div className="settings-help small">{user.name} · {brandName(preview)}</div><strong>{title || 'Hyresavtal – kontor Södermalm'}</strong><div className="brand-preview-page"><i /><i /><i /><i /><i /></div></div>
        <div className="brand-preview-footer"><strong>Hampus Linde</strong><span>Avböj</span><span className="accent">Signera</span></div>
      </div>
    </div>
  </div>;
}

function Team({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [email, setEmail] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = user.role === 'owner' || team?.members.find(member => member.id === user.id)?.role === 'owner';
  const load = async () => setTeam(await request<TeamData>('/api/team'));
  useEffect(() => { void load().catch(error => setError(message(error))); }, []);
  const invite = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setInviteLink('');
    try { const result = await request<{ url: string }>('/api/team/invitations', { email: email.trim() }); setInviteLink(result.url); setEmail(''); await load(); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const logout = async () => { setBusy(true); setError(''); try { await request('/api/logout', {}); onLogout(); } catch (error) { setError(message(error)); setBusy(false); } };
  return <div className="team-screen"><ErrorBox error={error} />{!team && !error && <Loading />}
    {team && <section className="card team-members"><div className="team-invite"><h2>Medlemmar</h2>{owner && <form className="invite-form" onSubmit={invite}><input aria-label="E-post till ny medlem" type="email" placeholder="kollega@foretag.se" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254} /><button className="button" disabled={busy}>Bjud in</button></form>}{inviteLink && <div className="invitation-link"><p className="muted text-small">Dela den här länken med din kollega. Ingen e-post skickas automatiskt.</p><CopyLink url={inviteLink} /></div>}</div>{team.members.map(member => <div className="member" key={member.id}><Avatar name={member.name} dark={member.role === 'owner'} /><div className="grow"><strong>{member.name}</strong><p>{member.email}</p></div><span className="badge">{member.role === 'owner' ? 'Ägare' : 'Medlem'}</span></div>)}{team.invitations.map(invitation => <div className="member" key={invitation.id}><Avatar name={invitation.email} /><div className="grow"><strong>{invitation.email}</strong><p>Giltig till {dateTime(invitation.expiresAt)}</p></div><span className="badge">Inbjuden</span></div>)}</section>}
    <div className="team-logout"><button className="text-button underlined" disabled={busy} onClick={() => void logout()}>Logga ut</button></div>
  </div>;
}

function InstanceSettings() {
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void request<Instance>('/api/instance').then(setInstance).catch(error => setError(message(error))); }, []);
  const sealing = instance?.sealing;
  // E-mail and sealing come from the server environment (docs/deployment.md); this tab only reports them.
  const rows: [string, string, 'ok' | 'off' | 'warn'][] = instance ? [
    ['E-post', instance.email ? `${instance.email.host ?? 'Resend'} · ${instance.email.provider === 'smtp' ? 'SMTP' : instance.email.provider === 'resend' ? 'API' : instance.email.provider}` : 'Inte konfigurerad · länkar delas manuellt', instance.email ? 'ok' : 'off'],
    ['Signeringscertifikat', sealing ? `${sealing.source === 'p12' ? 'Eget certifikat' : 'Självsignerat'}${sealing.notAfter ? ` · giltigt till ${date(sealing.notAfter)}` : ''}${sealing.ready ? '' : ' · inte redo'}` : 'Inte tillgängligt', sealing?.ready ? 'ok' : 'warn'],
    ['Version', `signhere ${instance.version}`, 'ok'],
  ] : [];
  return <div className="instance-settings"><ErrorBox error={error} />{!instance && !error && <Loading />}
    {instance && <section className="card"><div className="settings-card-heading instance-heading"><h2>Instans</h2><span className="settings-help">Endast administratörer</span></div>{rows.map(([label, value, state]) => <div className="instance-row" key={label}><i className={`instance-dot ${state}`} /><div className="grow"><strong>{label}</strong><p title={value}>{value}</p></div></div>)}</section>}
    <p className="settings-help">E-post och signeringscertifikat ställs in med serverns miljövariabler.</p>
  </div>;
}
