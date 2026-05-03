import { useEffect, useState } from 'react';
import { API } from './api';
import { SetupView } from './views/Setup';
import { LoginView } from './views/Login';
import { InboxView } from './views/Inbox';
import { TicketView } from './views/Ticket';
import { SettingsView } from './views/Settings';

type Route = { name: 'inbox' } | { name: 'ticket'; id: string } | { name: 'settings' };

function parseRoute(): Route {
  const path = window.location.pathname;
  if (path.startsWith('/t/')) return { name: 'ticket', id: path.slice(3) };
  if (path === '/settings') return { name: 'settings' };
  return { name: 'inbox' };
}

export function App() {
  const [stage, setStage] = useState<'loading' | 'setup' | 'login' | 'app'>('loading');
  const [me, setMe] = useState<any>(null);
  const [route, setRoute] = useState<Route>(parseRoute());

  useEffect(() => {
    (async () => {
      const status = await API.setupStatus();
      if (!status.completed) {
        setStage('setup');
        return;
      }
      const user = await API.me();
      if (!user.authenticated) {
        setStage('login');
      } else {
        setMe(user);
        setStage('app');
      }
    })().catch(() => setStage('login'));
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function navigate(path: string) {
    window.history.pushState({}, '', path);
    setRoute(parseRoute());
  }

  if (stage === 'loading') return <div className="center"><div className="muted">Loading…</div></div>;
  if (stage === 'setup') return <SetupView onDone={() => window.location.assign('/')} />;
  if (stage === 'login') return <LoginView onSuccess={() => window.location.assign('/')} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="logo">R</span> Ranse</div>
        <nav>
          <a href="/" className={route.name === 'inbox' ? 'active' : ''} onClick={(e) => { e.preventDefault(); navigate('/'); }}>
            Inbox
          </a>
          <a href="/settings" className={route.name === 'settings' ? 'active' : ''} onClick={(e) => { e.preventDefault(); navigate('/settings'); }}>
            Settings
          </a>
        </nav>
        <div style={{ marginTop: 'auto', padding: '8px 10px' }}>
          <div className="muted">{me?.user?.email}</div>
          <button style={{ marginTop: 8, width: '100%' }} onClick={async () => { await API.logout(); window.location.assign('/'); }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        {route.name === 'inbox' && <InboxView onOpen={(id) => navigate(`/t/${id}`)} />}
        {route.name === 'ticket' && <TicketView id={route.id} onBack={() => navigate('/')} />}
        {route.name === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
