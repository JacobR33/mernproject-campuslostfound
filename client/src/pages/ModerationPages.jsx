import { FactorField } from './MfaSettings';
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { useAuth } from '../auth';
import {
  Confirm,
  Empty,
  Field,
  Notice,
  PageTitle,
  Pagination,
  ResourceState,
} from '../components/ui';

export function ReportPost({ postId }) {
  const auth = useAuth();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    action.run(async (signal) => {
      await api.post(
        `/api/posts/${postId}/reports`,
        { reason: form.get('reason'), details: form.get('details').trim() },
        { auth: true, signal }
      );
      setSent(true);
      setOpen(false);
    });
  }
  if (sent) {
    return <Notice>Report received. A moderator can review it.</Notice>;
  }
  if (!auth.user) {
    return (
      <p className="small">
        <Link to="/login" state={{ from: `/posts/${postId}` }}>
          Sign in to report this post
        </Link>
      </p>
    );
  }
  return (
    <section className="report-section" aria-label="Report post">
      <button
        className="text-button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? 'Cancel report' : 'Report this post'}
      </button>
      {open && (
        <form onSubmit={submit}>
          <Notice error>{action.error}</Notice>
          <Field label="Report reason" name="reason" required>
            <select name="reason" required>
              <option value="privacy">Personal information</option>
              <option value="unsafe">Unsafe content or behavior</option>
              <option value="spam">Spam or misleading post</option>
              <option value="other">Other concern</option>
            </select>
          </Field>
          <Field
            label="Report details"
            name="details"
            required
            minLength={5}
            maxLength={1000}
            hint="Only moderators see this text. Include what concerns you, without passwords or private verification answers."
          >
            <textarea name="details" required minLength={5} maxLength={1000} rows={4} />
          </Field>
          <button className="button secondary" disabled={action.pending}>
            {action.pending ? 'Sending report...' : 'Send report'}
          </button>
        </form>
      )}
    </section>
  );
}

export function DeleteAccount() {
  const action = useAction();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [code, setCode] = useState('');
  function submit(event) {
    event.preventDefault();
    if (confirmation === 'DELETE' && password) {
      setConfirm(true);
    }
  }
  function erase() {
    action.run(async (signal) => {
      try {
        await api.deleteAccount(
          { password, confirmation, ...(code.trim() ? { code: code.trim() } : {}) },
          signal
        );
      } finally {
        setPassword('');
        setCode('');
        setConfirm(false);
      }
    });
  }
  return (
    <section>
      <h2>Delete account</h2>
      <p>
        This permanently removes your account, posts, reports, claims, and conversations involving
        you, including the other participant's chat history. Images are queued for storage cleanup.
        This cannot be undone.
      </p>
      <form onSubmit={submit}>
        <Notice error>{action.error}</Notice>
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          name="deletePassword"
          required
          maxLength={72}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <FactorField value={code} onChange={(event) => setCode(event.target.value)} />
        <Field
          label="Type DELETE to confirm"
          name="confirmation"
          required
          pattern="DELETE"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
        />
        <button
          className="button danger"
          disabled={action.pending || confirmation !== 'DELETE' || !password}
        >
          Delete my account
        </button>
      </form>
      {confirm && (
        <Confirm
          title="Permanently delete your account?"
          label="Permanently delete"
          pending={action.pending}
          onCancel={() => {
            setConfirm(false);
            setPassword('');
            setCode('');
          }}
          onConfirm={erase}
        >
          Your shared conversations will also be erased for their other participants. Your account
          cannot be restored.
        </Confirm>
      )}
    </section>
  );
}

function AdminUser({ id, onDone }) {
  const resource = useResource(id, (signal) =>
    api.get(`/api/admin/users/${id}`, { auth: true, signal })
  );
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  const user = resource.data?.user;
  return (
    <section className="surface editor">
      <h2>Account moderation</h2>
      <ResourceState resource={resource}>
        {user && (
          <>
            <p>
              <strong>{user.displayName}</strong> ({user.role})
            </p>
            <p>
              Account ID: <code className="wrap-id">{user.id}</code>
            </p>
            {user.isBanned ? (
              <Notice>This account is banned.</Notice>
            ) : user.role === 'admin' ? (
              <Notice>Administrator roles are managed by the server operator.</Notice>
            ) : (
              <button className="button danger" onClick={() => setConfirm(true)}>
                Ban account
              </button>
            )}
          </>
        )}
      </ResourceState>
      <button className="text-button" onClick={onDone}>
        Close account review
      </button>
      {confirm && (
        <Confirm
          title="Ban this account?"
          label="Ban account"
          pending={action.pending}
          error={action.error}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            action.run(async (signal) => {
              await api.post(`/api/admin/users/${id}/ban`, {}, { auth: true, signal });
              setConfirm(false);
              resource.reload();
            })
          }
        >
          This revokes sessions, hides the account's posts, and disables its conversations. Bans
          cannot be reversed from this interface.
        </Confirm>
      )}
    </section>
  );
}

export function Admin() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('open');
  const [selectedUser, setSelectedUser] = useState('');
  const [remove, setRemove] = useState(null);
  const resource = useResource(`${page}:${status}`, (signal) =>
    api.get(`/api/admin/reports?status=${status}&page=${page}&limit=20`, { auth: true, signal })
  );
  const action = useAction();
  function decide(row, nextStatus) {
    action.run(async (signal) => {
      await api.patch(
        `/api/admin/reports/${row.id}`,
        { revision: row.revision, status: nextStatus },
        { auth: true, signal }
      );
      resource.reload();
    });
  }
  return (
    <>
      <PageTitle
        eyebrow="CAMPUS CARE"
        description="Review reports using public post content. Private verification details and chat are restricted to their participants."
      >
        Moderation
      </PageTitle>
      <div className="surface editor">
        <Field label="Report status">
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </Field>
        <button className="button secondary" onClick={resource.reload}>
          Refresh reports
        </button>
        <form
          className="moderation-lookup"
          onSubmit={(event) => {
            event.preventDefault();
            setSelectedUser(new FormData(event.currentTarget).get('userId'));
          }}
        >
          <Field
            label="Review an account by ID"
            name="userId"
            pattern="[a-f0-9]{24}"
            required
            maxLength={24}
            hint="Use the account ID shown on a report or public post."
          />
          <button className="button secondary">Review account</button>
        </form>
      </div>
      <Notice error>{action.error}</Notice>
      {selectedUser && (
        <AdminUser key={selectedUser} id={selectedUser} onDone={() => setSelectedUser('')} />
      )}
      <ResourceState resource={resource}>
        {resource.data && (
          <>
            {!resource.data.reports.length ? (
              <Empty title="No reports in this queue.">
                Choose another status or check again later.
              </Empty>
            ) : (
              <div className="moderation-list">
                {resource.data.reports.map((row) => (
                  <article className="surface editor" key={row.id}>
                    <h2>
                      <Link to={`/posts/${row.postId}`}>{row.title}</Link>
                    </h2>
                    <p className="small">
                      {row.reason} / {row.status} / {new Date(row.createdAt).toLocaleString()}
                    </p>
                    <p className="preserve">{row.details}</p>
                    <p>Reported by {row.reporter.displayName}</p>
                    <div className="actions">
                      {row.authorId && (
                        <button
                          className="button secondary"
                          onClick={() => setSelectedUser(row.authorId)}
                        >
                          Review post author
                        </button>
                      )}
                      {row.status === 'open' && (
                        <>
                          <button
                            className="button secondary"
                            disabled={action.pending}
                            onClick={() => decide(row, 'resolved')}
                          >
                            Resolve
                          </button>
                          <button
                            className="button secondary"
                            disabled={action.pending}
                            onClick={() => decide(row, 'dismissed')}
                          >
                            Dismiss
                          </button>
                          <button
                            className="button danger"
                            disabled={action.pending}
                            onClick={() => setRemove(row)}
                          >
                            Remove post
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
            <Pagination value={resource.data.pagination} onPage={setPage} />
          </>
        )}
      </ResourceState>
      {remove && (
        <Confirm
          title="Remove this post?"
          label="Remove post"
          pending={action.pending}
          error={action.error}
          onCancel={() => setRemove(null)}
          onConfirm={() =>
            action.run(async (signal) => {
              await api.delete(`/api/admin/posts/${remove.postId}`, {}, { auth: true, signal });
              setRemove(null);
              resource.reload();
            })
          }
        >
          This hides the post and its images immediately and queues its claims and conversations for
          permanent cleanup. Open reports on the post will be resolved.
        </Confirm>
      )}
    </>
  );
}

export function AdminRemovePost({ postId, authorId }) {
  const navigate = useNavigate();
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="report-section">
      <p className="small">
        Author account ID: <code className="wrap-id">{authorId}</code>
      </p>
      <Link to="/admin">Open moderation</Link>
      <button className="button danger" onClick={() => setConfirm(true)}>
        Remove post as admin
      </button>
      {confirm && (
        <Confirm
          title="Remove this post?"
          label="Remove post"
          pending={action.pending}
          error={action.error}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            action.run(async (signal) => {
              await api.delete(`/api/admin/posts/${postId}`, {}, { auth: true, signal });
              navigate('/', { replace: true });
            })
          }
        >
          The post will be hidden and queued for permanent cleanup, including its conversations.
        </Confirm>
      )}
    </section>
  );
}
