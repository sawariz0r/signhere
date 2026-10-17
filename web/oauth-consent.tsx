import { useEffect, useState, type FormEvent } from 'react';
import { message, request } from './api';
import { Brand, ErrorBox, Loading } from './ui';
import { agentPermissions } from './agent-settings';
import './agent-settings.css';

type Authorization = { client: { name: string }; user: { name: string }; workspace: { name: string }; scopes: string[]; expiresInMinutes: number };

/** Login can only resume this exact local screen, never a caller-provided destination. */
export function consentReturnPath(path: string, query: URLSearchParams): string | undefined {
  if (path !== '/oauth/consent' || !/^[A-Za-z0-9_-]{8,256}$/.test(query.get('request') ?? '')) return undefined;
  return '/oauth/consent?' + new URLSearchParams({ request: query.get('request')! }).toString();
}

export function OAuthConsent({ authorizationRequest }: { authorizationRequest: string }) {
  const [data, setData] = useState<Authorization | null>(null);
  const [minutes, setMinutes] = useState('129600');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = /^[A-Za-z0-9_-]{8,256}$/.test(authorizationRequest);
  useEffect(() => {
    if (!valid) { setError('Anslutningsförfrågan är ogiltig. Starta om anslutningen i din agent.'); return; }
    let active = true;
    void request<Authorization>('/api/oauth/authorization/' + encodeURIComponent(authorizationRequest)).then(result => {
      if (!active) return;
      setData(result); setMinutes(['1440', '10080', '43200', '129600', '525600'].includes(String(result.expiresInMinutes)) ? String(result.expiresInMinutes) : '129600');
    }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [authorizationRequest, valid]);
  const decide = async (approved: boolean) => {
    setBusy(true); setError('');
    try {
      const result = await request<{ redirectUrl: string }>('/api/oauth/authorization/' + encodeURIComponent(authorizationRequest), { approved, expiresInMinutes: Number(minutes) });
      const redirect = new URL(result.redirectUrl);
      if (redirect.origin !== 'https://chatgpt.com' || redirect.username || redirect.password) throw new Error('Kunde inte återvända till agenten. Starta om anslutningen därifrån.');
      window.location.assign(redirect.href);
    } catch (error) { setError(message(error)); setBusy(false); }
  };
  return <div className="auth-screen"><header className="auth-header"><Brand publicBrand /><a className="text-button underlined" href="/settings/agents">Dina anslutningar</a></header><main className="oauth-consent main">
    <section className="card settings-card stack" aria-labelledby="oauth-consent-title">
      <div><div className="eyebrow">Anslut en agent</div><h1 id="oauth-consent-title">{data ? `Ge ${data.client.name} åtkomst?` : 'Godkänn anslutning'}</h1></div>
      <ErrorBox error={error} />
      {!data && !error && <Loading />}
      {data && <form className="stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void decide(true); }}>
        <p>Du är inloggad som <strong>{data.user.name}</strong>. Anslutningen får följande åtkomst till teamet <strong>{data.workspace.name}</strong>.</p>
        <ul className="oauth-permission-list">{data.scopes.map(scope => {
          const permission = agentPermissions.find(permission => permission.scope === scope);
          return <li key={scope}><strong>{permission?.title ?? scope}</strong>{permission && <span className="settings-help">{permission.description}</span>}</li>;
        })}</ul>
        <label className="field"><span>Åtkomstens giltighet</span><select value={minutes} onChange={event => setMinutes(event.target.value)} disabled={busy}><option value="1440">24 timmar</option><option value="10080">7 dagar</option><option value="43200">30 dagar</option><option value="129600">90 dagar</option><option value="525600">1 år</option></select></label>
        <p className="settings-help">Åtkomsten gäller hela teamet inom dessa behörigheter. Den förnyas inte automatiskt. Du kan återkalla den under Inställningar → Agenter. Ditt lösenord lämnas aldrig till agenten.</p>
        <div className="actions end oauth-consent-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void decide(false)}>Avböj</button><button className="button" disabled={busy}>{busy ? 'Återvänder till agenten…' : 'Godkänn åtkomst'}</button></div>
      </form>}
      {!data && error && <a className="button secondary" href="/settings/agents">Till dina anslutningar</a>}
    </section>
  </main></div>;
}
