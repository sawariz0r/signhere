import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/schibsted-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { Auth } from './auth';
import { Certificate, DocumentDetail, Documents, NewAttachment, NewDocument } from './documents';
import { handOff } from './handoff';
import { Settings, settingsTabs, Verify, type SettingsTab } from './settings';
import { Sign, CompletedCopy } from './sign';
import { Brand, BrandLockup, ErrorBox, Loading, ProfileMenu } from './ui';
import { message, request } from './api';
import type { Bootstrap, Brand as BrandData, SigningDocument, User } from './types';
import { EditorSent, type Created } from './created';

const DocumentEditor = lazy(() => import('./editor/editor').then(module => ({ default: module.DocumentEditor })));
const draftId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

type Route = { path: string; fragment: string; query: URLSearchParams };
// Old and bare settings addresses open a settings tab.
const aliases: Record<string, string> = { '/team': '/settings/team', '/settings': '/settings/brand' };
const route = (): Route => {
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (aliases[path]) history.replaceState(history.state, '', aliases[path] + location.search + location.hash);
  return { path: aliases[path] ?? path, fragment: location.hash.slice(1), query: new URLSearchParams(location.search) };
};

function App() {
  const [current, setCurrent] = useState(route);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [certificate, setCertificate] = useState<SigningDocument | null>(null);
  // A document just sent from the editor, shown at its own URL until the next navigation.
  const [sent, setSent] = useState<Created | null>(null);
  const publicVerify = current.path === '/verify' || current.path === '/verifiera';
  const standalone = publicVerify || current.path === '/sign' || current.path === '/copy';
  useEffect(() => { const changed = () => { setCurrent(route()); setCertificate(null); setSent(null); }; window.addEventListener('popstate', changed); window.addEventListener('hashchange', changed); return () => { window.removeEventListener('popstate', changed); window.removeEventListener('hashchange', changed); }; }, []);
  const navigate = (path: string) => { history.pushState({}, '', path); setCurrent(route()); setCertificate(null); setSent(null); window.scrollTo(0, 0); };
  const load = () => { setError(''); void request<Bootstrap>('/api/bootstrap').then(setBootstrap).catch(error => setError(message(error))); };
  useEffect(() => { if (!standalone) load(); }, [standalone]);
  useEffect(() => { if (current.path.startsWith('/editor/')) return; document.title = `${sent ? 'Skickat' : current.path === '/sign' ? 'Signera' : current.path === '/verify' || current.path === '/verifiera' ? 'Verifiera dokument' : current.path.startsWith('/settings/') ? 'Inställningar' : current.path === '/new' ? 'Nytt dokument' : current.path.endsWith('/bilaga') ? 'Ny bilaga' : 'Dokument'} · signhere`; }, [current.path, sent]);
  if (current.path === '/copy') return <CompletedCopy key={current.fragment} token={current.fragment} />;
  if (current.path === '/sign') return <Sign key={current.fragment} token={current.fragment} />;
  if (publicVerify) return <><header className="app-header public-header"><div className="header-inner"><Brand publicBrand /><a className="button secondary small" href="/">Till signhere</a></div></header><main className="main" id="main-content"><Verify /></main></>;
  if (!bootstrap) return <div><header className="auth-header"><Brand /></header><main className="main"><ErrorBox error={error} />{error ? <button className="button secondary" onClick={load}>Försök igen</button> : <Loading />}</main></div>;
  const user = bootstrap.user;
  const loggedIn = (user: User) => { setBootstrap({ ...bootstrap, setupRequired: false, user }); navigate('/'); };
  if (current.path === '/join' || current.path === '/invite' || current.path === '/invitations/accept') return <Auth key="invite" setup={false} invitationToken={current.fragment} onLogin={loggedIn} onVerify={() => navigate('/verify')} />;
  if (!user) return <Auth key={bootstrap.setupRequired ? 'setup' : 'login'} setup={bootstrap.setupRequired} onLogin={loggedIn} onVerify={() => navigate('/verify')} />;
  if (current.path.startsWith('/editor/')) {
    const id = current.path.split('/')[2];
    // A bilaga continues as a PDF in the bilaga flow of its main document.
    const query = current.query.get('bilaga');
    const parentId = query && /^[0-9a-f-]{36}$/.test(query) ? query : null;
    const attachment = parentId ? { onUse: (file: File) => { handOff(parentId, { file, draftId: id }); navigate(`/documents/${parentId}/bilaga`); } } : undefined;
    // A sent document replaces the editor's history entry, so Back skips the deleted draft and a refresh opens the document.
    const onSent = (result: Created) => { history.replaceState({}, '', `/documents/${result.created.document.id}`); setCurrent(route()); setSent(result); window.scrollTo(0, 0); };
    return <Suspense fallback={<main className="main"><Loading>Öppnar editorn…</Loading></main>}><DocumentEditor key={id} draftId={id} user={user} attachment={attachment} emailEnabled={Boolean(bootstrap.delivery?.email)} onSent={onSent} onClose={() => navigate(parentId ? `/documents/${parentId}/bilaga` : '/')} /></Suspense>;
  }
  const brand: BrandData = bootstrap.brand ?? { name: user.teamName, logoUrl: null, showName: true, accent: 'ink' };
  const onBrand = (brand: BrandData) => setBootstrap({ ...bootstrap, brand, user: { ...user, teamName: brand.name } });
  const loggedOut = () => { setBootstrap({ ...bootstrap, user: null, brand: undefined }); navigate('/'); };
  const tabs = settingsTabs(user);
  const settingsTab = current.path.startsWith('/settings/') ? tabs.find(([key]) => key === current.path.split('/')[2])?.[0] ?? 'brand' : null;
  const openSettings = (tab: SettingsTab) => navigate(`/settings/${tab}`);
  const documentId = current.path.startsWith('/documents/') ? current.path.split('/')[2] : null;
  const newAttachment = documentId && current.path.split('/')[3] === 'bilaga';
  return <><header className="app-header no-print"><div className="header-inner"><a className="brand-home" href="/" aria-label={`${brand.name.trim() || 'Ditt företag'} – Dokument`} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; event.preventDefault(); navigate('/'); }}><BrandLockup brand={brand} /></a><ProfileMenu user={user} settings={tabs.map(([key, label]) => ({ key, label, active: settingsTab === key, onSelect: () => openSettings(key) }))} onVerify={() => navigate('/verify')} onLogout={() => void request('/api/logout', {}).then(loggedOut).catch(error => window.alert(message(error)))} /></div></header><main className="main" id="main-content">
    {sent && documentId === sent.created.document.id ? <EditorSent key={documentId} result={sent} onOpen={id => navigate(`/documents/${id}`)} /> : settingsTab ? <Settings key={settingsTab} tab={settingsTab} user={user} brand={brand} onTab={openSettings} onBrand={onBrand} onLogout={loggedOut} /> : current.path === '/new' ? <NewDocument user={user} onCancel={() => navigate('/')} onOpen={id => navigate(`/documents/${id}`)} /> : documentId && newAttachment ? <NewAttachment key={documentId} parentId={documentId} user={user} onCancel={() => navigate(`/documents/${documentId}`)} onOpen={id => navigate(`/documents/${id}`)} onEditor={parent => navigate(`/editor/${draftId()}?bilaga=${parent.id}`)} /> : documentId ? certificate ? <Certificate doc={certificate} brand={brand} onBack={() => setCertificate(null)} onVerify={() => navigate('/verify')} /> : <DocumentDetail key={documentId} id={documentId} user={user} onBack={() => navigate('/')} onOpen={id => navigate(`/documents/${id}`)} onAddAttachment={() => navigate(`/documents/${documentId}/bilaga`)} onCertificate={doc => { setCertificate(doc); window.scrollTo(0, 0); }} /> : <Documents onOpen={id => navigate(`/documents/${id}`)} onNew={() => navigate('/new')} onCreate={() => navigate(`/editor/${draftId()}`)} onDraft={id => navigate(`/editor/${id}`)} />}
  </main></>;
}

createRoot(document.getElementById('root')!).render(<App />);
