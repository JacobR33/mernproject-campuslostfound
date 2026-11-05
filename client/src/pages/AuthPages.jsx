import React, { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction } from '../hooks';
import { Field, Notice, PageTitle, Icon } from '../components/ui';
import { passwordError, safeNext } from '../lib/forms';
import { FactorField } from './MfaSettings';
function AuthFrame({ title, description, children }) {
  return (
    <div className="auth-layout">
      <aside className="auth-aside">
        <Icon name="shield" width="48" height="48" />
        <p className="eyebrow">A LITTLE CARE GOES A LONG WAY</p>
        <h2>Good things find their way back.</h2>
        <p>
          Your campus email proves you belong here. Private verification helps belongings get back
          to the right Knight.
        </p>
        <span className="aside-rule" />
        <p>
          Keep your contact details private. Use campus messaging after a claim or request is
          approved.
        </p>
      </aside>
      <section className="surface auth-form">
        <PageTitle description={description}>{title}</PageTitle>
        {children}
      </section>
    </div>
  );
}
const emailProps = {
  type: 'email',
  name: 'email',
  required: true,
  maxLength: 254,
  autoComplete: 'email',
  pattern: '[^\\s@]+@[uU][cC][fF]\\.[eE][dD][uU]',
};
export function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const action = useAction();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const next = safeNext(location.state?.from);
  if (auth.user) {
    return <Navigate to={next} replace />;
  }
  function submit(event) {
    event.preventDefault();
    action.run(async (signal) => {
      try {
        await api.login(
          {
            email: email.trim().toLowerCase(),
            password,
            ...(code.trim() ? { code: code.trim() } : {}),
          },
          signal
        );
        navigate(next, { replace: true });
      } catch (error) {
        if (error.status === 401) {
          throw new Error(
            'Sign-in failed. Check your details, email verification, and two-step code if enabled, or try again later.'
          );
        }
        throw error;
      } finally {
        setPassword('');
        setCode('');
      }
    });
  }
  return (
    <AuthFrame
      title="Welcome back, Knight."
      description="Sign in to post, verify an item, or check your claims."
    >
      <form onSubmit={submit}>
        <Notice error>{action.error}</Notice>
        <Field
          label="UCF email"
          hint="Use your @ucf.edu address."
          {...emailProps}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          maxLength={72}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FactorField value={code} onChange={(event) => setCode(event.target.value)} />
        <Link className="small-link" to="/forgot-password">
          Forgot your password?
        </Link>
        <button className="button wide" disabled={action.pending}>
          {action.pending ? 'Signing in…' : 'Sign in'}
          <Icon name="arrow" />
        </button>
      </form>
      <p>
        New here? <Link to="/register">Create an account</Link>
      </p>
      <p className="small">
        <Link to="/resend-verification">Resend verification email</Link>
      </p>
    </AuthFrame>
  );
}
export function Register() {
  const action = useAction();
  const [message, setMessage] = useState('');
  const [password, setPassword] = useState('');
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    action.run(async (signal) => {
      const error = passwordError(password);
      if (error) {
        throw new Error(error);
      }
      try {
        const result = await api.post(
          '/api/auth/register',
          {
            email: form.get('email').trim().toLowerCase(),
            displayName: form.get('displayName').trim(),
            password,
          },
          { signal }
        );
        setMessage(result.message);
      } finally {
        setPassword('');
      }
    });
  }
  return (
    <AuthFrame
      title="Join your campus community."
      description="One campus. A little more looking out for each other."
    >
      {message ? (
        <>
          <Notice>{message}</Notice>
          <p>Check your inbox and verify your email before signing in.</p>
          <Link className="button" to="/login">
            Go to sign in
          </Link>
        </>
      ) : (
        <form onSubmit={submit}>
          <Notice error>{action.error}</Notice>
          <Field
            label="Display name"
            name="displayName"
            autoComplete="nickname"
            required
            minLength={1}
            maxLength={80}
            hint="Public on your posts. Do not use your email or phone number."
          />
          <Field label="UCF email" {...emailProps} hint="Only @ucf.edu addresses are accepted." />
          <Field
            label="Choose a password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={72}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 12 characters. Use a unique passphrase and avoid common passwords."
          />
          <button className="button wide" disabled={action.pending}>
            {action.pending ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      )}
      <p>
        Already a member? <Link to="/login">Sign in</Link>
      </p>
    </AuthFrame>
  );
}
export function EmailRequest({ verification = false }) {
  const action = useAction();
  const [message, setMessage] = useState('');
  function submit(event) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get('email').trim().toLowerCase();
    action.run(async (signal) => {
      const data = await api.post(
        `/api/auth/${verification ? 'resend-verification' : 'forgot-password'}`,
        { email },
        { signal }
      );
      setMessage(data.message);
    });
  }
  return (
    <AuthFrame
      title={verification ? 'Verify your campus email.' : 'Let’s get you back in.'}
      description={
        verification ? 'Request a new verification link.' : 'Request a one-use password reset link.'
      }
    >
      <form onSubmit={submit}>
        <Notice>{message}</Notice>
        <Notice error>{action.error}</Notice>
        <Field label="UCF email" {...emailProps} />
        <button className="button wide" disabled={action.pending}>
          {action.pending
            ? 'Sending request…'
            : verification
              ? 'Send verification link'
              : 'Send reset link'}
        </button>
      </form>
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </AuthFrame>
  );
}
export function LinkAction({ reset = false, actionLink }) {
  const action = useAction();
  const [done, setDone] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState(actionLink.token);
  function submit(event) {
    event.preventDefault();
    action.run(async (signal) => {
      if (!token) {
        throw new Error('Request a new email link.');
      }
      if (reset) {
        const error = passwordError(password);
        if (error) {
          throw new Error(error);
        }
        if (password !== confirm) {
          throw new Error('Your passwords do not match.');
        }
      }
      try {
        if (reset) {
          await api.resetPassword({ token, password }, signal);
        } else {
          await api.post('/api/auth/verify-email', { token }, { signal });
        }
        actionLink.token = null;
        setToken(null);
        setDone(true);
      } catch (error) {
        if (error.status === 400) {
          throw new Error('This link is invalid, expired, or already used. Request a new link.');
        }
        throw error;
      } finally {
        setPassword('');
        setConfirm('');
      }
    });
  }
  return (
    <AuthFrame
      title={reset ? 'Choose a fresh start.' : 'You’re almost home.'}
      description={
        reset
          ? 'Set a new password for your account.'
          : 'Confirm that this campus email belongs to you.'
      }
    >
      {done ? (
        <>
          <Notice>
            {reset
              ? 'Your password was reset. Sign in again.'
              : 'Your email is verified. You can now sign in.'}
          </Notice>
          <Link className="button" to="/login">
            Sign in
          </Link>
        </>
      ) : !token ? (
        <>
          <Notice error>This link is missing or invalid. Request a new one.</Notice>
          <Link className="button" to={reset ? '/forgot-password' : '/resend-verification'}>
            Request a new link
          </Link>
        </>
      ) : (
        <form onSubmit={submit}>
          <Notice error>{action.error}</Notice>
          {action.error && (
            <p>
              <Link to={reset ? '/forgot-password' : '/resend-verification'}>
                Request a new link
              </Link>
            </p>
          )}
          {reset ? (
            <>
              <Field
                label="New password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={72}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint="At least 12 characters. Choose a unique passphrase."
              />
              <Field
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </>
          ) : (
            <p>Your verification link is ready. Confirm below to continue.</p>
          )}
          <button className="button wide" disabled={action.pending}>
            {action.pending ? 'Please wait…' : reset ? 'Reset password' : 'Verify email'}
          </button>
        </form>
      )}
    </AuthFrame>
  );
}
