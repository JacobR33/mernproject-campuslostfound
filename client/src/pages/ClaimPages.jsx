import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAction, useResource } from '../hooks';
import { queryString } from '../lib/forms';
import {
  Empty,
  Notice,
  PageTitle,
  Pagination,
  ResourceState,
} from '../components/ui';
export function ClaimDestination() {
  const { claimId } = useParams();
  const resource = useResource(claimId, (signal) =>
    api.get(`/api/claims/${claimId}`, { auth: true, signal })
  );
  const claim = resource.data?.claim;
  return (
    <ResourceState resource={resource}>
      {claim && <Navigate replace to={claim.conversationId ? `/chat/${claim.conversationId}` : `/posts/${claim.post.id}`} />}
    </ResourceState>
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
    claim_submitted: 'An earlier ownership claim was submitted',
    claim_approved: 'Your claim was approved',
    claim_denied: 'Your claim was denied',
    match_submitted: 'A conversation request needs your review',
    match_accepted: 'Your conversation request was accepted',
    match_denied: 'Your conversation request was denied',
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
                </div>
                <div className="actions">
                  <Link
                    className="button secondary"
                    to={
                      note.kind === 'match_denied'
                        ? '/chat?direction=mine'
                        : note.kind.startsWith('match_')
                          ? '/chat'
                          : note.kind === 'claim_submitted'
                            ? `/posts/${note.postId}`
                            : note.kind === 'claim_approved'
                              ? `/claims/${note.claimId}`
                              : `/posts/${note.postId}`
                    }
                  >
                    View{' '}
                    {note.kind.startsWith('match_')
                      ? 'Campus chat'
                      : note.kind === 'claim_approved' ? 'conversation' : 'post'}
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
            Conversation requests and decisions will appear here.
          </Empty>
        )}
        <Pagination value={resource.data?.pagination} onPage={setPage} />
      </ResourceState>
    </>
  );
}
