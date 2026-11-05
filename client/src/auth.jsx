import React, { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api';
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, generation: 0, error: '' });
  async function restore() {
    setState((value) => ({ ...value, loading: true, error: '' }));
    try {
      const user = await api.session();
      setState((value) => ({ ...value, user, loading: false }));
    } catch {
      setState((value) => ({
        ...value,
        user: null,
        loading: false,
        error: 'We could not check your session. Please retry.',
      }));
    }
  }
  useEffect(() => {
    const unsubscribe = api.subscribe((value) => setState({ ...value, loading: false, error: '' }));
    restore();
    return unsubscribe;
  }, []);
  return <AuthContext.Provider value={{ ...state, restore }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
export function RequireAuth({ children, admin = false }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) {
    return <p role="status">Checking your session…</p>;
  }
  if (auth.error) {
    return (
      <div className="notice error" role="alert">
        {auth.error} <button onClick={auth.restore}>Retry session</button>
      </div>
    );
  }
  if (!auth.user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (admin && auth.user.role !== 'admin') {
    return (
      <section className="empty">
        <h1>Access restricted</h1>
        <p>This area is for campus moderators.</p>
      </section>
    );
  }
  return <React.Fragment key={`${auth.user.id}:${auth.generation}`}>{children}</React.Fragment>;
}
