import React, { useState } from 'react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { Confirm, Empty, Field, Notice, Pagination, ResourceState } from '../components/ui';
import { FactorField } from './MfaSettings';

const dateLabel = (value) => (value ? new Date(value).toLocaleString() : 'None');

export function AdminAccountReview({ id, onDone, onChanged = () => {} }) {
  const resource = useResource(id, (signal) =>
    api.get(`/api/admin/users/${id}`, { auth: true, signal })
  );
  const action = useAction();
  const [confirmation, setConfirmation] = useState(null);
  const [message, setMessage] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [deleteText, setDeleteText] = useState('');
  const user = resource.data?.user;

  function closeConfirmation() {
    setConfirmation(null);
    setPassword('');
    setCode('');
    setDeleteText('');
  }

  function perform() {
    const selected = confirmation;
    action.run(async (signal) => {
      try {
        if (selected.action === 'delete') {
          await api.adminDeleteAccount(
            id,
            {
              password,
              confirmation: deleteText,
              ...(code.trim() ? { code: code.trim() } : {}),
            },
            signal
          );
          closeConfirmation();
          onChanged();
          onDone();
          return;
        }
        const result = await api.post(
          `/api/admin/users/${id}/${selected.action}`,
          {},
          { auth: true, signal }
        );
        setMessage(result?.message || 'Account updated.');
        closeConfirmation();
        resource.reload();
        onChanged();
      } finally {
        setPassword('');
        setCode('');
      }
    });
  }

  function ask(label, endpoint, description) {
    setMessage('');
    action.setError('');
    setConfirmation({ label, action: endpoint, description });
  }

  return (
    <section className="surface editor" aria-label="Account details">
      <h2>Account details</h2>
      <Notice>{message}</Notice>
      <Notice error>{confirmation ? '' : action.error}</Notice>
      <ResourceState resource={resource}>
        {user && (
          <>
            <h3>{user.displayName}</h3>
            <p>{user.email}</p>
            <dl className="details-list">
              <dt>Account ID</dt>
              <dd>
                <code className="wrap-id">{user.id}</code>
              </dd>
              <dt>Role</dt>
              <dd>{user.role}</dd>
              <dt>Email</dt>
              <dd>{user.emailVerified ? 'Verified' : 'Not verified'}</dd>
              <dt>Verification link expires</dt>
              <dd>{dateLabel(user.verificationExpiresAt)}</dd>
              <dt>Access</dt>
              <dd>{user.isBanned ? 'Banned' : 'Allowed'}</dd>
              <dt>Login lock</dt>
              <dd>{user.isLocked ? `Locked until ${dateLabel(user.lockUntil)}` : 'Not locked'}</dd>
              <dt>Failed login attempts</dt>
              <dd>{user.failedLoginCount}</dd>
              <dt>Two-step authentication</dt>
              <dd>{user.mfaEnabled ? 'Enabled' : 'Not enabled'}</dd>
              <dt>Registered</dt>
              <dd>{dateLabel(user.createdAt)}</dd>
            </dl>
            {user.role === 'admin' ? (
              <Notice>Administrator accounts are managed by the server operator.</Notice>
            ) : (
              <>
                <div className="actions admin-actions">
                  {!user.isBanned && !user.emailVerified && (
                    <button
                      className="button secondary"
                      disabled={action.pending}
                      onClick={() =>
                        ask(
                          'Send verification email',
                          'email/verification',
                          'Queue a fresh verification email for this account. Previous verification links will stop working.'
                        )
                      }
                    >
                      Send verification email
                    </button>
                  )}
                  {!user.isBanned && (
                    <button
                      className="button secondary"
                      disabled={action.pending}
                      onClick={() =>
                        ask(
                          'Send password reset',
                          'email/password-reset',
                          'Send a password-reset email. The account holder chooses the new password; existing reset links will be replaced.'
                        )
                      }
                    >
                      Send password reset
                    </button>
                  )}
                  <button
                    className="button secondary"
                    disabled={action.pending}
                    onClick={() =>
                      ask(
                        'Unlock account',
                        'unlock',
                        'Clear failed-login attempts and the temporary login lock. Existing sessions will be revoked. This does not verify email or remove a ban.'
                      )
                    }
                  >
                    Unlock account
                  </button>
                  <button
                    className="button secondary"
                    disabled={action.pending}
                    onClick={() =>
                      ask(
                        'Revoke sessions',
                        'revoke-sessions',
                        'Sign this user out of all devices. Their password and email verification remain unchanged.'
                      )
                    }
                  >
                    Revoke sessions
                  </button>
                  <button
                    className="button danger"
                    disabled={action.pending}
                    onClick={() =>
                      ask(
                        user.isBanned ? 'Unban account' : 'Ban account',
                        user.isBanned ? 'unban' : 'ban',
                        user.isBanned
                          ? 'Allow this user to sign in again. Verification and temporary lock requirements still apply.'
                          : 'Revoke all sessions and hide this account’s posts and conversations.'
                      )
                    }
                  >
                    {user.isBanned ? 'Unban account' : 'Ban account'}
                  </button>
                  <button
                    className="button danger"
                    disabled={action.pending}
                    onClick={() =>
                      ask(
                        'Permanently delete account',
                        'delete',
                        'Permanently remove this account and its claims, reports, and shared conversations. Posts are hidden immediately and images are queued for cleanup. This cannot be undone.'
                      )
                    }
                  >
                    Delete account
                  </button>
                </div>
                <p className="small">
                  Emails use the configured delivery method. In classroom file-mail mode, use the
                  server demo helper to retrieve verification links.
                </p>
              </>
            )}
          </>
        )}
      </ResourceState>
      <button className="text-button" disabled={action.pending} onClick={onDone}>
        Close account review
      </button>
      {confirmation && (
        <Confirm
          title={`${confirmation.label}?`}
          label={confirmation.label}
          pending={action.pending}
          error={action.error}
          onCancel={closeConfirmation}
          onConfirm={perform}
          disabled={confirmation.action === 'delete' && (!password || deleteText !== 'DELETE')}
        >
          <p>{confirmation.description}</p>
          {confirmation.action === 'delete' && (
            <>
              <Field
                label="Your administrator password"
                type="password"
                name="adminPassword"
                autoComplete="current-password"
                required
                maxLength={72}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FactorField value={code} onChange={(event) => setCode(event.target.value)} />
              <Field
                label="Type DELETE to confirm account removal"
                name="deleteConfirmation"
                autoComplete="off"
                value={deleteText}
                onChange={(event) => setDeleteText(event.target.value)}
              />
            </>
          )}
        </Confirm>
      )}
    </section>
  );
}

export function AdminAccounts() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const query = new URLSearchParams({
    page,
    limit: 20,
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
  });
  const resource = useResource(query.toString(), (signal) =>
    api.get(`/api/admin/users?${query}`, { auth: true, signal })
  );
  return (
    <section aria-label="Account directory">
      <h2>Accounts</h2>
      <p>
        Search by name or email. Account emails and security status are visible only to
        administrators.
      </p>
      <form
        className="surface editor"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setSearch(form.get('search').trim());
          setStatus(form.get('status'));
          setPage(1);
        }}
      >
        <Field
          label="Search accounts"
          name="search"
          maxLength={120}
          placeholder="Name or UCF email"
        />
        <Field label="Account status">
          <select name="status" defaultValue="">
            <option value="">All accounts</option>
            <option value="unverified">Not verified</option>
            <option value="verified">Verified</option>
            <option value="locked">Locked</option>
            <option value="banned">Banned</option>
          </select>
        </Field>
        <div className="actions">
          <button className="button">Search accounts</button>
          <button className="button secondary" type="button" onClick={resource.reload}>
            Refresh accounts
          </button>
        </div>
      </form>
      {selectedId && (
        <AdminAccountReview
          key={selectedId}
          id={selectedId}
          onDone={() => setSelectedId('')}
          onChanged={resource.reload}
        />
      )}
      <ResourceState resource={resource}>
        {resource.data && (
          <>
            {!resource.data.users.length ? (
              <Empty title="No matching accounts.">Try a different name, email, or status.</Empty>
            ) : (
              <>
                <p role="status">{resource.data.pagination.total} matching accounts</p>
                <div className="admin-table-scroll">
                  <table className="admin-table">
                    <caption className="sr-only">Registered accounts</caption>
                    <thead>
                      <tr>
                        <th scope="col">Name / email</th>
                        <th scope="col">Role</th>
                        <th scope="col">Status</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resource.data.users.map((user) => (
                        <tr key={user.id}>
                          <td>
                            <strong>{user.displayName}</strong>
                            <br />
                            <span>{user.email}</span>
                          </td>
                          <td>{user.role}</td>
                          <td>
                            {user.emailVerified ? 'Verified' : 'Not verified'}
                            {user.isBanned ? ' · Banned' : ''}
                            {user.isLocked ? ' · Locked' : ''}
                          </td>
                          <td>
                            <button
                              className="button secondary"
                              aria-label={`Review ${user.email}`}
                              onClick={() => setSelectedId(user.id)}
                            >
                              Review account
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <Pagination value={resource.data.pagination} onPage={setPage} />
          </>
        )}
      </ResourceState>
    </section>
  );
}

export function AdminActivity() {
  const [page, setPage] = useState(1);
  const resource = useResource(page, (signal) =>
    api.get(`/api/admin/activity?page=${page}&limit=20`, { auth: true, signal })
  );
  return (
    <section aria-label="Administrator activity">
      <h2>Activity log</h2>
      <button className="button secondary" onClick={resource.reload}>
        Refresh activity
      </button>
      <ResourceState resource={resource}>
        {resource.data && (
          <>
            {!resource.data.events.length ? (
              <Empty title="No administrator actions recorded." />
            ) : (
              <div className="moderation-list">
                {resource.data.events.map((event) => (
                  <article className="surface editor" key={event.id}>
                    <h3>{event.action.replaceAll('_', ' ')}</h3>
                    <p>{dateLabel(event.createdAt)}</p>
                    <p>
                      Administrator: <code className="wrap-id">{event.actorId}</code>
                    </p>
                    <p>
                      Target: <code className="wrap-id">{event.targetId}</code>
                    </p>
                  </article>
                ))}
              </div>
            )}
            <Pagination value={resource.data.pagination} onPage={setPage} />
          </>
        )}
      </ResourceState>
    </section>
  );
}
