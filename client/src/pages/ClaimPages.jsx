import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';
import { queryString, titleCase } from '../lib/forms';
import {
  Confirm,
  Empty,
  Field,
  Notice,
  PageTitle,
  Pagination,
  ResourceState,
  Status,
} from '../components/ui';
export function ClaimPage() {
  const { id } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const action = useAction();
  const [answers, setAnswers] = useState({});
  const resource = useResource(id, async (signal) => {
    const [post, mine] = await Promise.all([
      api.get(`/api/posts/${id}`, { signal }),
      api.get(`/api/posts/${id}/my-claim`, { auth: true, signal }),
    ]);
    return { ...post, ...mine };
  });
  const post = resource.data?.post;
  const claim = resource.data?.claim;
  function submit(event) {
    event.preventDefault();
    action.run(async (signal) => {
      const submitted = post.verificationQuestions.map((question) => ({
        questionId: question.id,
        answer: answers[question.id] || '',
      }));
      if (submitted.some((value) => !value.answer.trim())) {
        throw new Error('Answer every verification question.');
      }
      await api.post(`/api/posts/${id}/claims`, { answers: submitted }, { auth: true, signal });
      setAnswers({});
      navigate('/my-claims', {
        replace: true,
        state: { notice: 'Your claim was submitted for finder review.' },
      });
    });
  }
  return (
    <div className="narrow">
      <PageTitle
        eyebrow="A LITTLE PROOF GOES A LONG WAY"
        description="These details go privately to the finder, not onto the campus board."
      >
        Is this yours?
      </PageTitle>
      <ResourceState resource={resource}>
        {post && (
          <section className="surface editor">
            <h2>{post.item.title}</h2>
            {post.author.id === auth.user.id ? (
              <Notice>
                You cannot claim your own post.{' '}
                <Link to={`/posts/${id}/review`}>Review claims instead</Link>.
              </Notice>
            ) : !post.acceptingClaims ? (
              <Notice>
                This post is not accepting claims. <Link to="/my-claims">Check My Claims</Link>.
              </Notice>
            ) : claim?.attemptCount >= 3 ? (
              <Notice>
                You have used all three attempts for this post. Your latest claim is{' '}
                {claim.status.replaceAll('_', ' ')}. <Link to="/my-claims">Check My Claims</Link>.
              </Notice>
            ) : (
              <form onSubmit={submit}>
                <Notice>
                  You have {3 - (claim?.attemptCount || 0)} of 3 attempts remaining. Every valid
                  submission counts, even while a previous claim is pending.
                </Notice>
                <Notice error>{action.error}</Notice>
                {post.verificationQuestions.map((question, index) => (
                  <Field
                    key={question.id}
                    label={`${index + 1}. ${question.question}`}
                    hint="Only the finder can read your submitted answer."
                  >
                    <textarea
                      required
                      maxLength={500}
                      rows={3}
                      autoComplete="off"
                      value={answers[question.id] || ''}
                      onChange={(event) =>
                        setAnswers((value) => ({ ...value, [question.id]: event.target.value }))
                      }
                    />
                  </Field>
                ))}
                <button className="button" disabled={action.pending}>
                  {action.pending
                    ? 'Submitting…'
                    : claim
                      ? 'Submit another attempt'
                      : 'Submit claim for review'}
                </button>
                <p className="small muted">
                  A matching answer does not automatically approve your claim. The finder reviews it
                  before a private conversation is created.
                </p>
              </form>
            )}
          </section>
        )}
      </ResourceState>
    </div>
  );
}
export function MyClaims() {
  const location = useLocation();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const key = queryString({ status, page, limit: 10 });
  const resource = useResource(key, (signal) =>
    api.get(`/api/claims/mine?${key}`, { auth: true, signal })
  );
  return (
    <>
      <PageTitle eyebrow="YOUR NEXT REUNION">My Claims</PageTitle>
      <Notice>{location.state?.notice}</Notice>
      <div className="toolbar">
        <Field label="Claim status">
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All claims</option>
            {['pending', 'approved', 'denied'].map((value) => (
              <option key={value} value={value}>
                {titleCase(value)}
              </option>
            ))}
          </select>
        </Field>
        <button className="button secondary" onClick={resource.reload}>
          Refresh claims
        </button>
      </div>
      <ResourceState resource={resource}>
        {resource.data?.claims.length ? (
          <div className="stack">
            {resource.data.claims.map((claim) => (
              <article className="surface list-row" key={claim.id}>
                <div>
                  <Status value={claim.status} />
                  <h2>
                    <Link to={`/posts/${claim.post.id}`}>{claim.post.title}</Link>
                  </h2>
                  <p className="muted small">{claim.attemptCount} of 3 attempts used</p>
                  {claim.status === 'pending' && (
                    <p className="small">Waiting for finder review.</p>
                  )}
                </div>
                <div className="actions">
                  {claim.conversationId ? (
                    <Link className="button secondary" to={`/chat/${claim.conversationId}`}>
                      Open campus chat
                    </Link>
                  ) : claim.attemptCount < 3 && claim.post.acceptingClaims ? (
                    <Link className="button secondary" to={`/posts/${claim.post.id}/claim`}>
                      Submit another attempt
                    </Link>
                  ) : (
                    <Link className="button secondary" to={`/posts/${claim.post.id}`}>
                      View post
                    </Link>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="Your next reunion starts here."
            action={
              <Link className="button" to="/">
                Browse found items
              </Link>
            }
          >
            Claims you submit will appear here, along with the finder’s decision.
          </Empty>
        )}
        <Pagination value={resource.data?.pagination} onPage={setPage} />
      </ResourceState>
    </>
  );
}
export function FinderReview() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const action = useAction();
  const selected = /^[a-f0-9]{24}$/.test(params.get('claim') || '') ? params.get('claim') : '';
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState(null);
  const query = queryString({ status, page, limit: 10 });
  const resource = useResource(`${id}:${selected}:${query}`, async (signal) => {
    const [manage, result] = await Promise.all([
      api.get(`/api/posts/${id}/manage`, { auth: true, signal }),
      api.get(
        selected ? `/api/posts/${id}/claims/${selected}` : `/api/posts/${id}/claims?${query}`,
        { auth: true, signal }
      ),
    ]);
    return { ...manage, ...(selected ? { claims: [result.claim] } : result) };
  });
  function decide() {
    action.run(async (signal) => {
      await api.post(
        `/api/posts/${id}/claims/${confirm.claim.id}/decision`,
        { decision: confirm.decision, attemptCount: confirm.claim.attemptCount },
        { auth: true, signal }
      );
      setConfirm(null);
      resource.reload();
    });
  }
  return (
    <>
      <PageTitle
        eyebrow="A CAREFUL REVIEW. A RIGHTFUL OWNER."
        description={resource.data?.post.item.title || 'Only you can read these claim submissions.'}
        actions={
          <Link className="button secondary" to="/my-posts">
            My Posts
          </Link>
        }
      >
        Review claims
      </PageTitle>
      {selected ? (
        <button className="button secondary" onClick={() => setParams({})}>
          View all claims
        </button>
      ) : (
        <div className="toolbar">
          <Field label="Review status">
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {['pending', 'approved', 'denied'].map((value) => (
                <option key={value} value={value}>
                  {titleCase(value)}
                </option>
              ))}
            </select>
          </Field>
          <button className="button secondary" onClick={resource.reload}>
            Reload latest submissions
          </button>
        </div>
      )}
      <ResourceState resource={resource}>
        {resource.data?.claims.length ? (
          <div className="stack">
            {resource.data.claims.map((claim) => (
              <article className="surface review-card" key={`${claim.id}:${claim.attemptCount}`}>
                <div className="list-row">
                  <div>
                    <h2>{claim.claimant.displayName}</h2>
                    <p className="small muted">
                      Attempt {claim.attemptCount} of 3 · <Status value={claim.status} />
                    </p>
                  </div>
                  <span className={`verification ${claim.verificationPassed ? 'passed' : ''}`}>
                    {claim.verificationPassed ? 'All answers matched' : 'Answers did not all match'}
                  </span>
                </div>
                <dl className="answer-list">
                  {claim.submittedAnswers.map((answer) => (
                    <React.Fragment key={answer.questionId}>
                      <dt>{answer.question}</dt>
                      <dd className="preserve">{answer.answer}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                {claim.status === 'pending' && (
                  <div className="actions">
                    <button
                      className="button"
                      disabled={!claim.verificationPassed}
                      onClick={() => {
                        action.setError('');
                        setConfirm({ claim, decision: 'approve' });
                      }}
                    >
                      Approve claim
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => {
                        action.setError('');
                        setConfirm({ claim, decision: 'deny' });
                      }}
                    >
                      Deny claim
                    </button>
                    {!claim.verificationPassed && (
                      <p className="small muted">
                        Approval requires all verification answers to match.
                      </p>
                    )}
                  </div>
                )}
                {claim.conversationId && (
                  <Link to={`/chat/${claim.conversationId}`}>Open campus chat</Link>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="No claims to review here."
            action={
              status && (
                <button className="button secondary" onClick={() => setStatus('')}>
                  View all statuses
                </button>
              )
            }
          >
            New submissions will appear in your notifications.
          </Empty>
        )}
        <Pagination value={resource.data?.pagination} onPage={setPage} />
      </ResourceState>
      {confirm && (
        <Confirm
          title={confirm.decision === 'approve' ? 'Approve this claim?' : 'Deny this claim?'}
          label={confirm.decision === 'approve' ? 'Approve claim' : 'Deny claim'}
          pending={action.pending}
          error={action.error}
          onCancel={() => setConfirm(null)}
          onConfirm={decide}
        >
          {confirm.decision === 'approve'
            ? 'This reserves the item for this claimant and denies other pending claims. Mark the item returned only after the handoff.'
            : 'The claimant will see your decision. Denial does not restore their used attempts.'}
        </Confirm>
      )}
    </>
  );
}
export function Notifications() {
  const [page, setPage] = useState(1);
  const [unread, setUnread] = useState(false);
  const action = useAction();
  const key = queryString({ page, limit: 10, unread: String(unread) });
  const resource = useResource(key, (signal) =>
    api.get(`/api/notifications?${key}`, { auth: true, signal })
  );
  const latest = useRef(resource.reload);
  latest.current = resource.reload;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        latest.current();
      }
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  const labels = {
    claim_submitted: 'A claim needs your review',
    claim_approved: 'Your claim was approved',
    claim_denied: 'Your claim was denied',
  };
  function read(note) {
    action.run(async (signal) => {
      await api.patch(`/api/notifications/${note.id}/read`, {}, { auth: true, signal });
      resource.reload();
    });
  }
  return (
    <>
      <PageTitle eyebrow="A LITTLE UPDATE FROM CAMPUS">Notifications</PageTitle>
      <div className="toolbar">
        <label className="check">
          <input
            type="checkbox"
            checked={unread}
            onChange={(event) => {
              setUnread(event.target.checked);
              setPage(1);
            }}
          />
          Unread only
        </label>
        <button className="button secondary" onClick={resource.reload}>
          Refresh inbox
        </button>
      </div>
      <Notice error>{action.error}</Notice>
      <ResourceState resource={resource}>
        {resource.data?.notifications.length ? (
          <div className="stack">
            {resource.data.notifications.map((note) => (
              <article className={`surface list-row ${note.readAt ? '' : 'unread'}`} key={note.id}>
                <div>
                  <span className="eyebrow">{note.readAt ? 'READ' : 'NEW'}</span>
                  <h2>{labels[note.kind]}</h2>
                  <p className="muted small">Attempt {note.attemptCount}</p>
                </div>
                <div className="actions">
                  <Link
                    className="button secondary"
                    to={
                      note.kind === 'claim_submitted'
                        ? `/posts/${note.postId}/review?claim=${note.claimId}`
                        : '/my-claims'
                    }
                  >
                    View {note.kind === 'claim_submitted' ? 'submission' : 'My Claims'}
                  </Link>
                  {!note.readAt && (
                    <button
                      className="text-button"
                      disabled={action.pending}
                      onClick={() => read(note)}
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="You’re all caught up.">
            New claims and finder decisions will appear here.
          </Empty>
        )}
        <Pagination value={resource.data?.pagination} onPage={setPage} />
      </ResourceState>
    </>
  );
}
