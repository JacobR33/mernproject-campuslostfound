import React, { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';
import { Field, Notice, ResourceState } from '../components/ui';

export function FactorField({
  value,
  onChange,
  required = false,
  label = 'Authenticator or backup code',
}) {
  return (
    <Field
      label={label}
      name="mfaCode"
      autoComplete="one-time-code"
      required={required}
      maxLength={32}
      spellCheck={false}
      value={value}
      onChange={onChange}
      hint={
        required
          ? 'Use a fresh six-digit code or an unused backup code. Each code works once.'
          : 'If you enabled two-step verification, enter a fresh six-digit code or unused backup code.'
      }
    />
  );
}

export function MfaSettings() {
  const auth = useAuth();
  const action = useAction();
  const resource = useResource(`mfa:${auth.user?.id}:${auth.generation}`, (signal) =>
    api.get('/api/mfa', { auth: true, signal })
  );
  const [mode, setMode] = useState(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState(null);
  const [backupCodes, setBackupCodes] = useState(null);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState('');
  function open(next) {
    setMode(next);
    setPassword('');
    setCode('');
    setMessage('');
    action.setError('');
  }
  function cancel() {
    setMode(null);
    setEnrollment(null);
    setPassword('');
    setCode('');
    action.setError('');
  }
  function submit(event) {
    event.preventDefault();
    action.run(async (signal) => {
      try {
        const operation = mode === 'enable' ? (enrollment ? 'confirm' : 'enrollment') : mode;
        const body = {
          password,
          ...(operation === 'confirm'
            ? { enrollmentId: enrollment.enrollmentId, code: code.trim() }
            : operation === 'enrollment'
              ? {}
              : { code: code.trim() }),
        };
        const data = await api.mfaChange(operation, body, signal);
        if (operation === 'enrollment') {
          if (
            !/^[A-Z2-7]{32}$/.test(data.secret || '') ||
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrDataUrl || '') ||
            !/^[a-f0-9]{64}$/.test(data.enrollmentId || '')
          ) {
            throw new Error('Setup could not be displayed. Start a new setup.');
          }
          setEnrollment(data);
        } else {
          setEnrollment(null);
          setMode(null);
          resource.reload();
          if (data.backupCodes) {
            setBackupCodes(data.backupCodes);
            setSaved(false);
          } else {
            setMessage('Two-step verification is disabled. Your other sessions were signed out.');
          }
        }
      } finally {
        setPassword('');
        setCode('');
      }
    });
  }
  return (
    <section className="mfa-settings" aria-label="Two-step verification">
      <h2>Two-step verification</h2>
      <p>
        Add an authenticator app to protect your account. Setup and security changes require your
        password. Enabling, disabling, or replacing backup codes signs out other sessions.
      </p>
      <Notice error>{action.error}</Notice>
      <Notice>{message}</Notice>
      {backupCodes ? (
        <div className="backup-code-panel">
          <h3>Save your backup codes</h3>
          <p>
            Save these ten single-use codes somewhere private and offline. They will not be shown
            again. A backup code still requires your password at sign-in.
          </p>
          <ul className="backup-codes">
            {backupCodes.map((value) => (
              <li key={value}>
                <code>{value}</code>
              </li>
            ))}
          </ul>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />{' '}
            I saved my backup codes
          </label>
          <button
            className="button"
            disabled={!saved}
            onClick={() => {
              setBackupCodes(null);
              setSaved(false);
              setMessage(
                'Your backup codes are saved. Use a fresh authenticator code for your next sign-in.'
              );
            }}
          >
            Done saving codes
          </button>
        </div>
      ) : (
        <>
          <ResourceState resource={resource}>
            {resource.data && (
              <>
                <p>
                  <strong>{resource.data.enabled ? 'Enabled' : 'Not enabled'}</strong>
                  {resource.data.enabled &&
                    ` - ${resource.data.backupCodesRemaining} backup codes remaining`}
                </p>
                {!mode && (
                  <div className="actions">
                    {resource.data.enabled ? (
                      <>
                        <button className="button secondary" onClick={() => open('backup-codes')}>
                          Replace backup codes
                        </button>
                        <button className="button danger" onClick={() => open('disable')}>
                          Disable two-step verification
                        </button>
                      </>
                    ) : (
                      <button className="button secondary" onClick={() => open('enable')}>
                        Set up authenticator
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </ResourceState>
          {mode && (
            <form onSubmit={submit}>
              <h3>
                {mode === 'enable'
                  ? enrollment
                    ? 'Confirm your authenticator'
                    : 'Start authenticator setup'
                  : mode === 'disable'
                    ? 'Disable two-step verification'
                    : 'Replace all backup codes'}
              </h3>
              {enrollment && (
                <div className="mfa-enrollment">
                  <p>
                    Scan this QR code in your authenticator app. Keep the QR code private.
                  </p>
                  <img
                    className="mfa-qr"
                    src={enrollment.qrDataUrl}
                    alt="Private authenticator enrollment QR code"
                  />
                  <p>
                    Manual setup key: <code className="mfa-secret">{enrollment.secret}</code>
                  </p>
                  <p className="small">
                    Setup expires at {new Date(enrollment.expiresAt).toLocaleTimeString()}. Nothing
                    is enabled until you confirm.
                  </p>
                </div>
              )}
              {mode === 'backup-codes' && (
                <Notice>
                  Every old backup code becomes invalid after replacement. Save the new set before
                  leaving this page.
                </Notice>
              )}
              {mode === 'disable' && (
                <Notice>
                  This removes the authenticator secret and all backup codes. Your password will be
                  sufficient for future sign-ins.
                </Notice>
              )}
              <Field
                label="Account password"
                name="mfaPassword"
                type="password"
                autoComplete="current-password"
                required
                maxLength={72}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {enrollment ? (
                <Field
                  label="Six-digit authenticator code"
                  name="enrollmentCode"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              ) : (
                mode !== 'enable' && (
                  <FactorField
                    value={code}
                    required
                    onChange={(event) => setCode(event.target.value)}
                  />
                )
              )}
              <div className="actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={action.pending}
                  onClick={cancel}
                >
                  Cancel setup or change
                </button>
                <button
                  className={`button ${mode === 'disable' ? 'danger' : ''}`}
                  disabled={action.pending}
                >
                  {action.pending
                    ? 'Please wait...'
                    : mode === 'enable'
                      ? enrollment
                        ? 'Enable two-step verification'
                        : 'Create setup key'
                      : mode === 'disable'
                        ? 'Confirm disable'
                        : 'Confirm replacement'}
                </button>
              </div>
              <p className="small muted">
                If the result is unclear after a network error, reload Settings to check the current
                status. Codes are never sent automatically again.
              </p>
            </form>
          )}
        </>
      )}
    </section>
  );
}
