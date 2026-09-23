import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/schibsted-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { Auth } from './auth';
import { Certificate, DocumentDetail, Documents, NewDocument } from './documents';
import { Team, Verify } from './settings';
import { Sign, CompletedCopy } from './sign';
import { Avatar, Brand, ErrorBox, Loading } from './ui';
import { message, request } from './api';
import type { Bootstrap, SigningDocument, User } from './types';

const DocumentEditor = lazy(() => import('./editor/editor').then(module => ({ default: module.DocumentEditor })));
const draftId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

type Route = { path: string; fragment: string };
const route = (): Route => ({ path: location.pathname.replace(/\/$/, '') || '/', fragment: location.hash.slice(1) });

function App() {
  const [current, setCurrent] = useState(route);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [certificate, setCertificate] = useState<SigningDocument | null>(null);
  const publicVerify = current.path === '/verify' || current.path === '/verifiera';
  const standalone = publicVerify || current.path === '/sign' || current.path === '/copy';
  useEffect(() => { const changed = () => { setCurrent(route()); setCertificate(null); }; window.addEventListener('popstate', changed); window.addEventListener('hashchange', changed); return () => { window.removeEventListener('popstate', changed); window.removeEventListener('hashchange', changed); }; }, []);
  const navigate = (path: string) => { history.pushState({}, '', path); setCurrent(route()); setCertificate(null); window.scrollTo(0, 0); };
  const load = () => { setError(''); void request<Bootstrap>('/api/bootstrap').then(setBootstrap).catch(error => setError(message(error))); };
  useEffect(() => { if (!standalone) load(); }, [standalone]);
  useEffect(() => { if (current.path.startsWith('/editor/')) return; document.title = `${current.path === '/sign' ? 'Signera' : current.path === '/verify' || current.path === '/verifiera' ? 'Verifiera dokument' : current.path === '/team' ? 'Team' : current.path === '/new' ? 'Nytt dokument' : 'Dokument'} · signhere`; }, [current.path]);
  if (current.path === '/copy') return <CompletedCopy key={current.fragment} token={current.fragment} />;
  if (current.path === '/sign') return <Sign key={current.fragment} token={current.fragment} />;
  if (publicVerify) return <><header className="app-header public-header"><div className="header-inner"><Brand publicBrand /><a className="button secondary small" href="/">Till signhere</a></div></header><main className="main" id="main-content"><Verify /></main></>;
  if (!bootstrap) return <div><header className="auth-header"><Brand /></header><main className="main"><ErrorBox error={error} />{error ? <button className="button secondary" onClick={load}>Försök igen</button> : <Loading />}</main></div>;
  const user = bootstrap.user;
  const loggedIn = (user: User) => { setBootstrap({ ...bootstrap, setupRequired: false, user }); navigate('/'); };
  if (current.path === '/join' || current.path === '/invite' || current.path === '/invitations/accept') return <Auth key="invite" setup={false} invitationToken={current.fragment} onLogin={loggedIn} onVerify={() => navigate('/verify')} />;
  if (!user) return <Auth key={bootstrap.setupRequired ? 'setup' : 'login'} setup={bootstrap.setupRequired} onLogin={loggedIn} onVerify={() => navigate('/verify')} />;
  if (current.path.startsWith('/editor/')) { const id = current.path.split('/')[2]; return <Suspense fallback={<main className="main"><Loading>Öppnar editorn…</Loading></main>}><DocumentEditor key={id} draftId={id} user={user} onClose={() => navigate('/')} /></Suspense>; }
  const activeNav = current.path === '/team' ? 'team' : 'docs';
  const documentId = current.path.startsWith('/documents/') ? current.path.split('/')[2] : null;
  return <><header className="app-header no-print"><div className="header-inner"><Brand publicBrand={!user} />{user ? <><nav aria-label="Huvudmeny">{[['docs', 'Dokument', '/'], ['team', 'Team', '/team'], ['verify', 'Verifiera', '/verify']].map(([key, label, path]) => <button key={key} className={activeNav === key ? 'active' : ''} aria-current={activeNav === key ? 'page' : undefined} onClick={() => navigate(path)}>{label}</button>)}</nav><button className="header-account" onClick={() => navigate('/team')} aria-label={`${user.name}, ${user.teamName}`}><span>{user.teamName}</span><Avatar name={user.name} dark /></button></> : <button className="button secondary small" onClick={() => navigate('/')}>{bootstrap.setupRequired ? 'Skapa konto' : 'Logga in'}</button>}</div></header><main className="main" id="main-content">
    {user && current.path === '/team' ? <Team user={user} onRename={teamName => setBootstrap({ ...bootstrap, user: { ...user, teamName } })} onLogout={() => { setBootstrap({ ...bootstrap, user: null }); navigate('/'); }} /> : user && current.path === '/new' ? <NewDocument user={user} onCancel={() => navigate('/')} onOpen={id => navigate(`/documents/${id}`)} /> : documentId ? certificate ? <Certificate doc={certificate} onBack={() => setCertificate(null)} onVerify={() => navigate('/verify')} /> : <DocumentDetail key={documentId} id={documentId} user={user} onBack={() => navigate('/')} onCertificate={doc => { setCertificate(doc); window.scrollTo(0, 0); }} /> : <Documents onOpen={id => navigate(`/documents/${id}`)} onNew={() => navigate('/new')} onCreate={() => navigate(`/editor/${draftId()}`)} onDraft={id => navigate(`/editor/${id}`)} />}
  </main></>;
}

createRoot(document.getElementById('root')!).render(<App />);
