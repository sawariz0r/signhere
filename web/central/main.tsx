import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/schibsted-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '../styles.css';
import './central.css';
import { PdfPreview } from '../pdf';
import { Brand, ErrorBox, Loading } from '../ui';
import { CENTRAL_CONSENT, hex, sha256, verifyReceipt, verifyTrustBundle, type ReceiptVerification } from '../../server/central/protocol';

type Session = {
  approvalId: string; status: 'pending' | 'email_confirmed' | 'approved' | 'cancelled' | 'expired'; expiresAt: string;
  title: string; claimedName: string; email: string; preparedSha256: string; preparedSize: number; documentUrl: string;
  installation: { name: string; origin: string; verifiedOrganisation: false };
  consent: { version: string; text: string }; code?: { sentAt: string; expiresAt: string; resendAfter: string }; receipt?: string; confirmedBrowserKeySha256?: string;
};
const message = (error: unknown) => error instanceof Error ? error.message : 'Något gick fel. Försök igen.';
const MAX_PDF = 64 * 1024 * 1024;

function saveFile(name: string, bytes: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
async function readLimited(response: Response, limit: number) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > limit) throw new Error('Dokumentet är större än väntat.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('Dokumentet är större än väntat.');
  return bytes;
}

/**
 * A secret that exists only in this browser tab. The code is bound to it and approval requires it,
 * so the sender's installation, which knows the link, cannot confirm or approve on the participant's behalf.
 */
function browserKeyFor(approvalId: string) {
  const name = 'signhere-browser-key:' + approvalId;
  try { const stored = sessionStorage.getItem(name); if (stored && /^[A-Za-z0-9_-]{43}$/.test(stored)) return stored; } catch { /* storage unavailable */ }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try { sessionStorage.setItem(name, key); } catch { /* the key then lives until reload */ }
  return key;
}

/** Capability and transfer token come from the URL fragment, never from a query string or cookie. */
function useFragment() {
  return useMemo(() => {
    const [approvalId = '', capability = '', transfer = ''] = location.hash.slice(1).split('.');
    return /^apr_[A-Za-z0-9_-]{22}$/.test(approvalId) && /^[A-Za-z0-9_-]{43}$/.test(capability) ? { approvalId, capability, transfer: /^[A-Za-z0-9_-]{43}$/.test(transfer) ? transfer : '' } : null;
  }, []);
}

function Approve() {
  const link = useFragment();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState(link ? '' : 'Länken är ofullständig. Öppna den igen från dokumentet du ska signera.');
  const [pdf, setPdf] = useState<{ bytes: Uint8Array; blob: Blob; source: 'installation-transfer' | 'local-file' } | null>(null);
  const [pdfError, setPdfError] = useState('');
  const [rendered, setRendered] = useState(false);
  const [code, setCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState('');
  const browserKey = useMemo(() => link ? browserKeyFor(link.approvalId) : '', [link]);
  const [browserKeyHash, setBrowserKeyHash] = useState('');
  useEffect(() => { if (browserKey) void sha256(new TextEncoder().encode(browserKey)).then(digest => setBrowserKeyHash(hex(digest))); }, [browserKey]);
  const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, { method, credentials: 'omit', headers: { authorization: 'Capability ' + link!.approvalId + '.' + link!.capability, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Förfrågan misslyckades (' + response.status + ').');
    return data as T;
  };
  const act = async (name: string, work: () => Promise<void>) => { setBusy(name); setError(''); try { await work(); } catch (error) { setError(message(error)); } finally { setBusy(''); } };

  /** The same immutable byte buffer is hashed and rendered. */
  const accept = async (bytes: Uint8Array, source: 'installation-transfer' | 'local-file', expected: Session) => {
    const digest = hex(await sha256(bytes));
    if (digest !== expected.preparedSha256 || bytes.length !== expected.preparedSize) throw new Error('PDF-filen är inte det dokument som ska godkännas (kontrollsumman stämmer inte).');
    const copy = bytes.slice();
    setRendered(false); setPdfError('');
    setPdf({ bytes: copy, blob: new Blob([copy], { type: 'application/pdf' }), source });
  };
  useEffect(() => {
    if (!link) return;
    let active = true;
    void (async () => {
      try {
        const loaded = await api<Session>('GET', '/v1/participant/session');
        if (!active) return;
        setSession(loaded);
        if (loaded.status !== 'pending' && loaded.status !== 'email_confirmed') return;
        if (!link.transfer) { setPdfError('Välj PDF-filen som du laddade ner från avsändarens signeringssida.'); return; }
        try {
          // Fetched directly from the installation: the service never sees the document.
          const response = await fetch(loaded.documentUrl, { headers: { authorization: 'Bearer ' + link.transfer }, credentials: 'omit', redirect: 'error', cache: 'no-store' });
          if (!response.ok) throw new Error('Dokumentet kunde inte hämtas från avsändarens installation (' + response.status + ').');
          await accept(await readLimited(response, Math.min(loaded.preparedSize, MAX_PDF)), 'installation-transfer', loaded);
        } catch (error) { if (active) setPdfError(message(error) + ' Du kan i stället välja PDF-filen från signeringssidan.'); }
      } catch (error) { if (active) setError(message(error)); }
    })();
    return () => { active = false; };
  }, []);

  if (!session) return <main className="sign-main"><ErrorBox error={error} />{!error && <Loading>Öppnar bekräftelsen…</Loading>}</main>;
  const expired = session.status === 'expired' || session.status === 'cancelled';
  if (session.status === 'approved' && session.receipt) return <Approved session={session} pdf={pdf?.bytes} />;
  const confirmedElsewhere = session.status === 'email_confirmed' && Boolean(browserKeyHash) && session.confirmedBrowserKeySha256 !== browserKeyHash;
  const confirmed = session.status === 'email_confirmed' && !confirmedElsewhere && Boolean(browserKeyHash);
  const resendAfter = session.code ? Date.parse(session.code.resendAfter) : 0;
  const sendCode = () => act('code', async () => { setSession(await api<Session>('POST', '/v1/participant/code', { browserKeySha256: browserKeyHash })); setCode(''); });
  const confirm = (event: FormEvent) => { event.preventDefault(); void act('confirm', async () => { setSession(await api<Session>('POST', '/v1/participant/confirm', { code: code.replace(/\s/g, ''), browserKey })); }); };
  const approve = () => act('approve', async () => {
    const result = await api<Session>('POST', '/v1/participant/approve', { preparedSha256: session.preparedSha256, consentVersion: CENTRAL_CONSENT.version, accepted: true, documentSource: pdf!.source, browserKey });
    setSession(result);
  });
  return <main className="sign-main central-main">
    <p className="muted sender-line">Skickat via {session.installation.name} · <span className="mono">{new URL(session.installation.origin).host}</span></p>
    <h1>{session.title}</h1>
    <p className="sign-intro">Du bekräftar här, hos en tjänst som är fristående från avsändarens installation, att du har tillgång till din e-post och att du godkänner exakt det här dokumentet.</p>
    <dl className="central-facts">
      <div><dt>E-postadress som bekräftas</dt><dd>{session.email}</dd></div>
      <div><dt>Namn enligt avsändaren</dt><dd>{session.claimedName} <span className="muted">(inte kontrollerat)</span></dd></div>
      <div><dt>Dokumentets kontrollsumma (SHA-256)</dt><dd className="mono hash">{session.preparedSha256}</dd></div>
    </dl>
    <ErrorBox error={error} />
    {expired ? <ErrorBox error={session.status === 'expired' ? 'Bekräftelsen har gått ut. Be avsändaren om en ny länk.' : 'Avsändaren har avbrutit signeringen.'} /> : <>
      <ErrorBox error={pdfError} />
      {!pdf && pdfError && <label className="button secondary central-file">Välj PDF-fil<input type="file" accept="application/pdf,.pdf" className="visually-hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void act('file', async () => { if (file.size > MAX_PDF) throw new Error('Filen är för stor.'); await accept(new Uint8Array(await file.arrayBuffer()), 'local-file', session); }); }} /></label>}
      {pdf ? <><p className="muted text-small">{pdf.source === 'local-file' ? 'Vald fil' : 'Hämtad direkt från avsändarens installation till din webbläsare'} – kontrollsumman stämmer. Läs hela dokumentet.</p><PdfPreview source={pdf.blob} onReady={() => setRendered(true)} onError={text => { setRendered(false); setPdfError(text); }} /></> : !pdfError && <Loading>Hämtar och kontrollerar dokumentet…</Loading>}
      <section className="central-steps">
        <div className={`central-step${confirmed ? ' done' : ''}`}>
          <h2><span className="step-number">1</span>Bekräfta din e-postadress</h2>
          {confirmed ? <p>✓ {session.email} är bekräftad.</p> : <>
            {confirmedElsewhere && <p className="text-small">E-postadressen bekräftades i en annan webbläsare. Begär en ny kod för att fortsätta här.</p>}
            <p className="muted text-small">Vi skickar en kod till {session.email}. Koden visar bara att du har tillgång till e-posten – den godkänner inte dokumentet.</p>
            <button className="button secondary" disabled={Boolean(busy) || !browserKeyHash || (session.code && Date.now() < resendAfter)} onClick={() => void sendCode()}>{busy === 'code' ? 'Skickar…' : session.code ? 'Skicka en ny kod' : 'Skicka kod'}</button>
            {session.code && <form className="central-code" onSubmit={confirm}><label className="field"><span>Kod från e-postmeddelandet</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={9} value={code} onChange={event => setCode(event.target.value)} placeholder="1234 5678" /></label><button className="button" disabled={Boolean(busy) || code.replace(/\s/g, '').length !== 8}>{busy === 'confirm' ? 'Kontrollerar…' : 'Bekräfta'}</button></form>}
          </>}
        </div>
        <div className={`central-step${confirmed ? '' : ' disabled'}`}>
          <h2><span className="step-number">2</span>Godkänn dokumentet</h2>
          <label className="checkbox consent"><input type="checkbox" checked={accepted} disabled={!confirmed || !pdf || !rendered} onChange={event => setAccepted(event.target.checked)} />{session.consent.text}</label>
          <button className="button" disabled={Boolean(busy) || !confirmed || !pdf || !rendered || !accepted} onClick={() => void approve()}>{busy === 'approve' ? 'Godkänner…' : 'Godkänn dokumentet'}</button>
          <p className="muted text-tiny">Tjänsten sparar din e-postadress, dokumentets kontrollsumma och tidpunkten i ett signerat kvitto. Dokumentet skickas aldrig hit.</p>
        </div>
      </section>
    </>}
  </main>;
}

function Approved({ session, pdf }: { session: Session; pdf?: Uint8Array }) {
  return <main className="sign-done central-done">
    <span className="circle large">✓</span>
    <h1>Godkänt</h1>
    <p>Du har bekräftat {session.email} och godkänt <strong>{session.title}</strong>.</p>
    <p className="muted text-small">Gå tillbaka till fliken med dokumentet för att slutföra signeringen där. Spara gärna kvittot och dokumentet – de är ditt eget bevis och kan kontrolleras utan avsändaren.</p>
    <div className="stack small-gap">
      <button className="button" onClick={() => saveFile('signhere-kvitto-' + session.approvalId + '.jws', session.receipt!, 'application/jose')}>Spara kvitto</button>
      {pdf && <button className="button secondary" onClick={() => saveFile(session.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80) + '.pdf', pdf.slice().buffer as ArrayBuffer, 'application/pdf')}>Spara dokumentet du godkände</button>}
      <a className="text-button" href="/verifiera">Kontrollera ett kvitto</a>
    </div>
    <p className="muted text-tiny">Kvittot intygar e-postbekräftelse och godkännande av exakt detta dokument, inte vem du är. Tidpunkten är tjänstens egen, inte en betrodd tidsstämpel.</p>
  </main>;
}

type Check = { label: string; state: 'ok' | 'bad' | 'info'; text: string };
function VerifyReceipt() {
  const [root, setRoot] = useState('');
  const [published, setPublished] = useState<{ bundle: string; rootPublicKey: string } | null>(null);
  const [receipt, setReceipt] = useState('');
  const [bundleText, setBundleText] = useState('');
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState('');
  const loadPublished = async () => {
    try { const data = await (await fetch('/.well-known/signhere-trust.json', { credentials: 'omit' })).json(); setPublished(data); if (!root) setRoot(data.rootPublicKey); }
    catch { setError('Tjänstens förtroendelista kunde inte hämtas. Välj en sparad trust bundle-fil.'); }
  };
  const readText = (file: File, set: (value: string) => void) => void file.text().then(text => set(text.trim()));
  const run = async () => {
    setError(''); setChecks(null);
    try {
      const bundleJws = bundleText || published?.bundle;
      if (!bundleJws) throw new Error('Förtroendelista saknas.');
      const bundle = await verifyTrustBundle(bundleJws, root.trim());
      const result: ReceiptVerification = await verifyReceipt(receipt, bundle);
      const r = result.receipt;
      const list: Check[] = [
        { label: 'Signatur och nyckel', state: result.keyTrust === 'trusted' ? 'ok' : 'bad', text: result.keyTrust === 'trusted' ? 'Kvittot är signerat av ' + r.service + ' med en betrodd nyckel.' : 'Kvittot är inte betrott (' + result.keyTrust + ').' },
        { label: 'E-post', state: 'info', text: r.service + ' bekräftade tillgång till ' + r.email.address + ' (' + new Date(r.email.confirmedAt).toLocaleString('sv-SE') + ').' },
        { label: 'Godkännande', state: 'info', text: 'Godkänt ' + new Date(r.approval.approvedAt).toLocaleString('sv-SE') + ' enligt tjänstens klocka (ingen betrodd tidsstämpel).' },
        { label: 'Namn', state: 'info', text: '"' + r.claims.name + '" kommer från avsändaren och är inte kontrollerat. Identiteten är inte verifierad.' },
        pdf ? (hex(await sha256(pdf)) === r.document.preparedSha256
          ? { label: 'Dokument', state: 'ok', text: 'Den valda PDF-filen är exakt det dokument som godkändes.' }
          : { label: 'Dokument', state: 'bad', text: 'Den valda PDF-filen är INTE det godkända dokumentet. En färdigsignerad PDF är en annan fil – välj originalet.' })
          : { label: 'Dokument', state: 'info', text: 'Välj PDF-filen för att kontrollera att den är det godkända dokumentet (' + r.document.preparedSha256.slice(0, 16) + '…).' },
        { label: 'Färdigt dokument', state: 'info', text: 'Kvittot gäller det förberedda originalet. Att ett färdigsignerat dokument visar samma innehåll kontrolleras inte här.' },
      ];
      // Claims in an untrusted receipt are unauthenticated; do not present them as facts.
      setChecks(result.keyTrust === 'trusted' ? list : [list[0], { label: 'Innehåll', state: 'info', text: 'Uppgifterna i kvittot visas inte eftersom kvittot inte kunde verifieras med rotnyckeln.' }]);
    } catch (error) { setError('Kontrollen misslyckades: ' + message(error)); }
  };
  useEffect(() => { void loadPublished(); }, []);
  return <main className="main central-verify">
    <h1>Kontrollera ett kvitto</h1>
    <p className="muted">Allt kontrolleras här i din webbläsare. Varken kvittot eller dokumentet skickas någonstans.</p>
    <div className="stack">
      <label className="field"><span>Kvitto (.jws)</span><input type="file" accept=".jws,.txt,application/jose" onChange={event => { const file = event.target.files?.[0]; if (file) readText(file, setReceipt); }} /></label>
      <label className="field"><span>Dokumentet du godkände (PDF, valfritt)</span><input type="file" accept="application/pdf,.pdf" onChange={event => { const file = event.target.files?.[0]; if (file) void file.arrayBuffer().then(buffer => setPdf(new Uint8Array(buffer))); }} /></label>
      <label className="field"><span>Förtroendelista (valfri fil; annars tjänstens publicerade)</span><input type="file" accept=".jws,.txt" onChange={event => { const file = event.target.files?.[0]; if (file) readText(file, setBundleText); }} /></label>
      <label className="field"><span>Rotnyckel (trust root)</span><input className="mono" value={root} onChange={event => setRoot(event.target.value)} spellCheck={false} /></label>
      <p className="muted text-tiny">Jämför rotnyckeln med en källa du litar på, till exempel projektets källkod eller en kopia du sparat tidigare. En nyckel som bara hämtats från den här sidan kan inte ensam bevisa att sidan är äkta.</p>
      <button className="button" disabled={!receipt || !root} onClick={() => void run()}>Kontrollera</button>
      <ErrorBox error={error} />
      {checks && <ul className="central-checks">{checks.map(check => <li key={check.label} className={check.state}><strong>{check.label}</strong><span>{check.text}</span></li>)}</ul>}
    </div>
  </main>;
}

function Landing() {
  return <main className="main central-landing">
    <h1>Oberoende bekräftelse för signhere</h1>
    <p>Den här tjänsten är ett valfritt tillägg för självhostade signhere-installationer. Deltagare som saknar BankID kan här bekräfta sin e-postadress och godkänna exakt det dokument de läst – hos en part som är fristående från avsändarens server. Resultatet är ett signerat kvitto som går att kontrollera utan nätverk.</p>
    <p>Tjänsten tar aldrig emot dokumentet. Din webbläsare hämtar PDF-filen direkt från avsändaren och skickar bara dess kontrollsumma hit.</p>
    <p>Installationer som använder BankID, eller som inte vill använda tjänsten, behöver den inte.</p>
    <p><a className="button secondary" href="/verifiera">Kontrollera ett kvitto</a></p>
  </main>;
}

function App() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  useEffect(() => { document.title = (path === '/bekrafta' ? 'Bekräfta dokument' : path === '/verifiera' ? 'Kontrollera kvitto' : 'Oberoende bekräftelse') + ' · signhere'; }, [path]);
  return <div className="sign-screen"><header className="sign-header"><div><a href="/" className="central-home"><Brand publicBrand /></a></div></header>{path === '/bekrafta' ? <Approve /> : path === '/verifiera' ? <VerifyReceipt /> : <Landing />}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
