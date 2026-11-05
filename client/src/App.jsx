import { MfaSettings } from './pages/MfaSettings';
import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { AuthProvider, RequireAuth, useAuth } from './auth';
import { useAction, useResource } from './hooks';
import { Icon, Notice, PageTitle } from './components/ui';
import { Browse } from './pages/Browse';
import { Admin, DeleteAccount } from './pages/ModerationPages';
import { ChatPage, MatchPage } from './pages/ChatPages';
import { EmailRequest, LinkAction, Login, Register } from './pages/AuthPages';
import { MyPosts, PostDetail, PostEditor } from './pages/PostPages';
import { ClaimPage, FinderReview, MyClaims, Notifications } from './pages/ClaimPages';
function Header() {
  const auth = useAuth();
  const location = useLocation();
  const action = useAction();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  const resource = useResource(`${auth.user?.id}:${auth.generation}`, (signal) =>
    auth.user
      ? api.get('/api/notifications?unread=true&limit=1', { auth: true, signal })
      : Promise.resolve(null)
  );
  const latest = useRef(resource.reload);
  latest.current = resource.reload;
  useEffect(() => {
    const timer = setInterval(() => {
      if (auth.user && document.visibilityState === 'visible') {
        latest.current();
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [auth.user?.id]);
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" to="/" aria-label="UCF Lost and Found home">
          <span className="brand-mark">
            <Icon name="search" width="26" height="26" />
          </span>
          <span>
            <strong>UCF</strong> Lost &amp; Found<small>GOOD THINGS FIND THEIR WAY BACK.</small>
          </span>
        </Link>
        <button
          className="menu-button"
          aria-expanded={open}
          aria-controls="site-navigation"
          onClick={() => setOpen((value) => !value)}
        >
          Menu
        </button>
        <nav id="site-navigation" className={open ? 'open' : ''} aria-label="Main navigation">
          <NavLink to="/" end>
            Browse
          </NavLink>
          {auth.user ? (
            <>
              <NavLink to="/my-posts">My Posts</NavLink>
              <NavLink to="/my-claims">My Claims</NavLink>
              <NavLink to="/chat">Chat</NavLink>
              <NavLink to="/notifications" className="notification-link" aria-label="Notifications">
                <Icon name="bell" />
                <span>Notifications</span>
                {resource.data?.pagination.total > 0 && (
                  <b aria-label={`${resource.data.pagination.total} unread notifications`}>
                    {Math.min(resource.data.pagination.total, 99)}
                  </b>
                )}
              </NavLink>
              <NavLink to="/settings">Settings</NavLink>
              {auth.user.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
              <button
                className="header-signout"
                disabled={action.pending}
                onClick={() => action.run(() => api.logout())}
              >
                {action.pending ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login">Sign in</NavLink>
              <Link className="button small-button" to="/register">
                Join the community
              </Link>
            </>
          )}
        </nav>
      </div>
      {action.error && (
        <div className="container">
          <Notice error>{action.error}</Notice>
        </div>
      )}
    </header>
  );
}
function Settings() {
  const auth = useAuth();
  return (
    <div className="narrow">
      <PageTitle eyebrow="YOUR CAMPUS ACCOUNT">Settings</PageTitle>
      <section className="surface editor">
        <h2>{auth.user.displayName}</h2>
        <p>Your verified account keeps contact details off the public board.</p>
        <Link className="button secondary" to="/forgot-password">
          Change your password
        </Link>
        <hr />
        <MfaSettings />
        <hr />
        <DeleteAccount />
      </section>
    </div>
  );
}
class ErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="container">
        <PageTitle>We hit a snag.</PageTitle>
        <p>Reload the page to try again.</p>
        <button className="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
function Shell({ actionLink }) {
  const location = useLocation();
  const previous = useRef(location.pathname);
  useEffect(() => {
    if (previous.current !== location.pathname) {
      window.scrollTo(0, 0);
      document.querySelector('main h1')?.focus({ preventScroll: true });
    }
    previous.current = location.pathname;
  }, [location.pathname]);
  const protect = (element, admin = false) => <RequireAuth admin={admin}>{element}</RequireAuth>;
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Header />
      <main className="container" id="main-content">
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<EmailRequest />} />
          <Route path="/resend-verification" element={<EmailRequest verification />} />
          <Route path="/verify-email" element={<LinkAction actionLink={actionLink} />} />
          <Route
            path="/reset-password"
            element={<LinkAction key="reset" reset actionLink={actionLink} />}
          />
          <Route path="/posts/:id" element={<PostDetail />} />
          <Route path="/found/new" element={protect(<PostEditor type="found" />)} />
          <Route path="/lost/new" element={protect(<PostEditor type="lost" />)} />
          <Route path="/posts/:id/edit" element={protect(<PostEditor />)} />
          <Route path="/posts/:id/claim" element={protect(<ClaimPage />)} />
          <Route path="/posts/:id/review" element={protect(<FinderReview />)} />
          <Route path="/my-posts" element={protect(<MyPosts />)} />
          <Route path="/my-claims" element={protect(<MyClaims />)} />
          <Route path="/notifications" element={protect(<Notifications />)} />
          <Route path="/settings" element={protect(<Settings />)} />
          <Route path="/chat" element={protect(<ChatPage />)} />
          <Route path="/chat/:conversationId" element={protect(<ChatPage />)} />
          <Route path="/posts/:id/match" element={protect(<MatchPage />)} />
          <Route path="/admin" element={protect(<Admin />, true)} />
          <Route
            path="*"
            element={
              <>
                <PageTitle>That page wandered off.</PageTitle>
                <p>
                  <Link to="/">Back to the campus board</Link>
                </p>
              </>
            }
          />
        </Routes>
      </main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <p>
            <strong>UCF Lost &amp; Found</strong>
            <br />
            <span>Knights looking out for Knights.</span>
          </p>
          <p>
            Independent student project.
            <br />
            Not an official UCF service.
          </p>
          <Link to="/">Back to the board ↑</Link>
        </div>
      </footer>
    </>
  );
}
export default function App({ actionLink = { token: null } }) {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Shell actionLink={actionLink} />
      </AuthProvider>
    </ErrorBoundary>
  );
}
