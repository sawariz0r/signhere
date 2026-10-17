import { useEffect, useState, type FormEvent } from 'react';
import { dateTime, message, request } from './api';
import { ErrorBox, Field, Loading, useToast } from './ui';
import './agent-settings.css';

type Scope = 'drafts:read' | 'drafts:write' | 'discussion:read' | 'discussion:write' | 'reviews:share';
type AgentKey = { id: string; name: string; prefix: string; scopes: Scope[]; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null };
type KeyList = { keys: AgentKey[]; scopes: Scope[]; mcpUrl: string; apiUrl: string };
type CreatedKey = { key: AgentKey; token: string; mcpUrl: string; apiUrl: string };
type OAuthConnection = { id: string; clientName: string; scopes: string[]; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null };
type OAuthConnections = { enabled?: boolean; mcpUrl: string; connections: OAuthConnection[] };
export const agentPermissions: { scope: Scope; title: string; description: string }[] = [
  { scope: 'drafts:read', title: 'Läsa utkast', description: 'Se teamets utkast och deras innehåll.' },
  { scope: 'drafts:write', title: 'Skapa och redigera utkast', description: 'Ändra innehåll och spara privata versioner.' },
  { scope: 'discussion:read', title: 'Läsa kommentarer', description: 'Läsa diskussionen om ett utkast.' },
  { scope: 'discussion:write', title: 'Skriva kommentarer', description: 'Kommentera och svara som du. Kommentarer i delade diskussioner kan ses av klienten.' },
  { scope: 'reviews:share', title: 'Uppdatera delade versioner', description: 'Tillåta att en sparad version blir synlig via befintliga klientlänkar. Agenten måste uttryckligen välja det vid varje sådan sparning.' },
];
const permissions = agentPermissions;

export function AgentSettings() {
  const [data, setData] = useState<KeyList | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [scopes, setScopes] = useState<Scope[]>(['drafts:read', 'drafts:write', 'discussion:read', 'discussion:write']);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState<string | null>(null);
  const [oauth, setOAuth] = useState<OAuthConnections | null>(null);
  const [oauthError, setOAuthError] = useState('');
  const [revokeOAuth, setRevokeOAuth] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  useEffect(() => { void request<KeyList>('/api/agent-keys').then(setData).catch(error => setError(message(error))); }, []);
  useEffect(() => { void request<OAuthConnections>('/api/oauth/connections').then(setOAuth).catch(error => setOAuthError(message(error))); }, []);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); showToast('Kopierat'); }
    catch { setError('Kunde inte kopiera. Markera och kopiera texten manuellt.'); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy('create'); setError('');
    try {
      const result = await request<CreatedKey>('/api/agent-keys', { name: name.trim(), scopes, expiresInMinutes: Number(minutes) });
      setCreated(result); setName('');
      setData(previous => previous ? { ...previous, keys: [result.key, ...previous.keys] } : previous);
    } catch (error) { setError(message(error)); } finally { setBusy(''); }
  };
  const revokeKey = async (key: AgentKey) => {
    setBusy(key.id); setError('');
    try {
      await request(`/api/agent-keys/${key.id}/revoke`, {});
      setData(previous => previous ? { ...previous, keys: previous.keys.map(item => item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item) } : previous);
      if (created?.key.id === key.id) setCreated(null);
      setRevoke(null); showToast('Nyckeln är återkallad');
    } catch (error) { setError(message(error)); } finally { setBusy(''); }
  };
  const revokeConnection = async (connection: OAuthConnection) => {
    setBusy('oauth:' + connection.id); setOAuthError('');
    try {
      await request(`/api/oauth/connections/${connection.id}/revoke`, {});
      setOAuth(previous => previous ? { ...previous, connections: previous.connections.map(item => item.id === connection.id ? { ...item, revokedAt: new Date().toISOString() } : item) } : previous);
      setRevokeOAuth(null); showToast('Anslutningen är återkallad');
    } catch (error) { setOAuthError(message(error)); } finally { setBusy(''); }
  };
  return <div className="agent-settings stack">{toast}
    <div><h2>Anslut din agent</h2><p className="settings-help">Välj hur din agent ansluter. ChatGPT använder ett godkännande i din webbläsare. Claude och Codex kan använda en kortlivad API-nyckel.</p></div>
    <section className="card settings-card agent-connection" aria-label="Anslut ChatGPT"><h2>ChatGPT · godkänn i webbläsaren</h2>
      <p className="settings-help">Lägg till denna MCP-adress som en egen anslutning i ChatGPT och välj OAuth. Du loggar in hos Signhere och godkänner team, behörigheter och giltighet här.</p>
      {oauth?.enabled === false ? <p className="settings-help">OAuth-anslutningar är avstängda på denna instans. Använd API-nyckel med en kompatibel agent nedan.</p> : oauth && <div className="field"><span id="agent-oauth-label">ChatGPT MCP-adress</span><div className="agent-copy-row"><input aria-labelledby="agent-oauth-label" value={oauth.mcpUrl} readOnly onFocus={event => event.target.select()} /><button type="button" className="button secondary" onClick={() => void copy(oauth.mcpUrl)}>Kopiera ChatGPT-adress</button></div></div>}
      {!oauth && !oauthError && <Loading />}
      <p className="settings-help">Inget klient-ID, ingen klienthemlighet och ingen extern inloggningstjänst behöver konfigureras. Lämna eventuella fält för klient-ID och klienthemlighet tomma. Åtkomsten löper ut utan automatisk förnyelse; anslut igen när du behöver den.</p>
      <ErrorBox error={oauthError} />
    </section>
    <ErrorBox error={error} />
    {!data && !error && <Loading />}
    {data && <>
      <section className="card settings-card agent-connection" aria-label="Anslutningsuppgifter">
        <h2>Claude eller Codex · använd API-nyckel</h2>
        <div className="field"><span id="agent-mcp-label">MCP-adress</span><div className="agent-copy-row"><input aria-labelledby="agent-mcp-label" value={data.mcpUrl} readOnly onFocus={event => event.target.select()} /><button type="button" className="button secondary" onClick={() => void copy(data.mcpUrl)}>Kopiera adress</button></div></div>
        <p className="settings-help">Nyckeln ger tillgång till ditt team och gäller tills den löper ut eller du återkallar den.</p>
        <details><summary>Så ansluter du Claude eller Codex</summary><div className="stack small-gap">
          <p><strong>Claude:</strong> Öppna Anpassa → Anslutningar och lägg till en egen anslutning med MCP-adressen ovan. Välj ingen inloggning och lägg till request-headern <code>Authorization</code> med värdet <code>Bearer DIN_API_NYCKEL</code>.</p>
          <p><strong>Claude Code:</strong> Lägg till en HTTP-server med adressen ovan och en <code>Authorization: Bearer …</code>-header. Förvara nyckeln i klientens privata konfiguration.</p>
          <p><strong>Codex:</strong> Lägg till adressen som en MCP-server och ange namnet på en miljövariabel med din nyckel i <code>bearer_token_env_var</code>.</p>
          <p className="settings-help">I detta läge använder agenten bara API-nyckeln. När nyckeln löper ut ger du agenten en ny. Konfigurera MCP-anslutningen i klienten; en nyckel i ett chattmeddelande lägger inte till verktygen automatiskt. I Claude Team och Enterprise delas en anslutnings fasta nyckel av dem som använder anslutningen.</p>
        </div></details>
      </section>
      {created ? <section className="card settings-card agent-created" aria-label="Din nya API-nyckel" role="region">
        <h2>Din nyckel till {created.key.name}</h2>
        <p className="settings-help">Kopiera nyckeln nu. Den visas bara här och går inte att hämta igen när du stänger eller lämnar sidan.</p>
        <div className="field"><span id="agent-key-label">API-nyckel</span><div className="agent-copy-row"><input aria-labelledby="agent-key-label" className="mono" autoComplete="off" spellCheck={false} value={created.token} readOnly onFocus={event => event.target.select()} /><button className="button" type="button" onClick={() => void copy(created.token)}>Kopiera nyckel</button></div></div>
        <p className="settings-help">Giltig till {dateTime(created.key.expiresAt)}. Lägg nyckeln i anslutningens inställningar, separat från skill-filen.</p>
        <div className="actions end"><button className="button secondary small" type="button" onClick={() => setCreated(null)}>Jag har sparat nyckeln</button></div>
      </section> : <section className="card settings-card"><h2>Skapa API-nyckel</h2>
        <form onSubmit={event => void create(event)} className="stack">
          <div className="agent-form-row"><Field label="Nyckelns namn" placeholder="t.ex. Offertutkast med Claude" value={name} onChange={event => setName(event.target.value)} required maxLength={80} disabled={Boolean(busy)} /><label className="field"><span>Giltighet</span><select value={minutes} onChange={event => setMinutes(event.target.value)} disabled={Boolean(busy)}><option value="15">15 minuter</option><option value="60">1 timme</option><option value="240">4 timmar</option><option value="1440">24 timmar</option></select></label></div>
          <fieldset className="agent-permissions"><legend>Vad får agenten göra?</legend>{permissions.filter(item => data.scopes.includes(item.scope)).map(item => <label className="checkbox" key={item.scope}><input type="checkbox" checked={scopes.includes(item.scope)} disabled={Boolean(busy)} onChange={event => setScopes(previous => event.target.checked ? [...previous, item.scope] : previous.filter(scope => scope !== item.scope))} /><span><strong>{item.title}</strong><span>{item.description}</span></span></label>)}</fieldset>
          <div className="actions end"><button className="button" disabled={Boolean(busy) || !name.trim() || !scopes.length}>{busy === 'create' ? 'Skapar…' : 'Skapa API-nyckel'}</button></div>
        </form>
      </section>}
      <section className="card settings-card"><h2>Ge agenten Signhere-skillen</h2><p className="settings-help">Skillen beskriver hur agenten skapar dokument, hanterar versioner och arbetar med kommentarer. Den kontrollerar ibland om en uppdatering finns och frågar innan den uppdateras.</p><div className="actions"><a className="button secondary" href="/skills/signhere/signhere.zip" download>Ladda ner skill</a><a className="text-button underlined" href="/skills/signhere/SKILL.md" target="_blank" rel="noreferrer">Läs instruktionerna</a></div><p className="settings-help">Prova sedan: ”Skapa ett offertutkast för den här klienten och ge mig länken.”</p></section>
      {oauth && <section className="card settings-card agent-key-list" aria-label="Dina OAuth-anslutningar"><h2>Dina godkända anslutningar</h2>
        {!oauth.connections.length && <p className="settings-help">Du har inga godkända anslutningar ännu. Börja med MCP-adressen i ChatGPT ovan.</p>}
        {oauth.connections.map(connection => {
          const expired = Date.parse(connection.expiresAt) <= Date.now();
          return <div className="agent-key" key={connection.id}><div className="agent-key-heading"><strong>{connection.clientName}</strong><span className="badge">{connection.revokedAt ? 'Återkallad' : expired ? 'Utgången' : 'Aktiv'}</span></div><p className="settings-help">Giltig till {dateTime(connection.expiresAt)}</p><p className="settings-help">Senast använd: {connection.lastUsedAt ? dateTime(connection.lastUsedAt) : 'Inte använd ännu'}</p><p className="settings-help">{connection.scopes.map(scope => permissions.find(permission => permission.scope === scope)?.title ?? scope).join(' · ')}</p>
            {!connection.revokedAt && !expired && (revokeOAuth === connection.id ? <div className="agent-revoke" role="group" aria-label={`Återkalla anslutning till ${connection.clientName}`}><p className="settings-help">Anslutningen förlorar åtkomsten direkt.</p><div className="actions"><button type="button" className="button danger small" disabled={Boolean(busy)} onClick={() => void revokeConnection(connection)}>Återkalla anslutning</button><button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => setRevokeOAuth(null)}>Avbryt</button></div></div> : <button className="text-button underlined" type="button" disabled={Boolean(busy)} onClick={() => setRevokeOAuth(connection.id)}>Återkalla</button>)}
          </div>;
        })}
      </section>}
      <section className="card settings-card agent-key-list" aria-label="Dina API-nycklar"><h2>Dina API-nycklar</h2>
        {!data.keys.length && <p className="settings-help">Du har inga API-nycklar ännu.</p>}
        {data.keys.map(key => {
          const expired = Date.parse(key.expiresAt) <= Date.now();
          return <div className="agent-key" key={key.id}><div className="agent-key-heading"><strong>{key.name}</strong><span className="badge">{key.revokedAt ? 'Återkallad' : expired ? 'Utgången' : 'Aktiv'}</span></div><p className="settings-help"><span className="mono">{key.prefix}…</span> · Giltig till {dateTime(key.expiresAt)}</p><p className="settings-help">Senast använd: {key.lastUsedAt ? dateTime(key.lastUsedAt) : 'Inte använd ännu'}</p><p className="settings-help">{permissions.filter(item => key.scopes.includes(item.scope)).map(item => item.title).join(' · ')}</p>
            {!key.revokedAt && !expired && (revoke === key.id ? <div className="agent-revoke" role="group" aria-label={`Återkalla ${key.name}`}><p className="settings-help">Agenten förlorar åtkomsten med denna nyckel direkt.</p><div className="actions"><button type="button" className="button danger small" disabled={Boolean(busy)} onClick={() => void revokeKey(key)}>Återkalla nyckel</button><button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => setRevoke(null)}>Avbryt</button></div></div> : <button className="text-button underlined" type="button" disabled={Boolean(busy)} onClick={() => setRevoke(key.id)}>Återkalla</button>)}
          </div>;
        })}
      </section>
    </>}
  </div>;
}
