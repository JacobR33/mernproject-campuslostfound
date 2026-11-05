import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { mergeMessages, openConversation } from '../api/chat';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';
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
export function MatchPage() {
  const { id } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const action = useAction();
  const resource = useResource(id, (signal) => api.get(`/api/posts/${id}`, { signal }));
  const post = resource.data?.post;
  return (
    <div className="narrow">
      <PageTitle eyebrow="A POSSIBLE REUNION">Think you found this?</PageTitle>
      <ResourceState resource={resource}>
        {post && (
          <section className="surface editor">
            <h2>{post.item.title}</h2>
            {post.type !== 'lost' || !post.acceptingMatches || post.author.id === auth.user.id ? (
              <Notice>This post is not accepting a conversation request from you.</Notice>
            ) : (
              <>
                <p>
                  Ask the person who lost this item to open a private campus conversation. No
                  messages can be sent until they accept.
                </p>
                <Notice>
                  Do not put identifying details or contact information on the public board. Discuss
                  them privately after acceptance.
                </Notice>
                <Notice error>{action.error}</Notice>
                <button
                  className="button"
                  disabled={action.pending}
                  onClick={() =>
                    action.run(async (signal) => {
                      await api.post(`/api/posts/${id}/matches`, {}, { auth: true, signal });
                      navigate('/chat', { replace: true });
                    })
                  }
                >
                  {action.pending ? 'Requesting…' : 'Request a private conversation'}
                </button>
              </>
            )}
          </section>
        )}
      </ResourceState>
    </div>
  );
}
export function ChatPage() {
  const { conversationId } = useParams();
  return conversationId ? (
    <ChatThread key={conversationId} conversationId={conversationId} />
  ) : (
    <ChatInbox />
  );
}
function ChatInbox() {
  const [page, setPage] = useState(1);
  const [requestPage, setRequestPage] = useState(1);
  const [direction, setDirection] = useState('incoming');
  const [confirm, setConfirm] = useState(null);
  const action = useAction();
  const resource = useResource(page, (signal) =>
    api.get(`/api/conversations?page=${page}&limit=10`, { auth: true, signal })
  );
  const requests = useResource(`${direction}:${requestPage}`, (signal) =>
    api.get(`/api/matches/${direction}?page=${requestPage}&limit=10`, { auth: true, signal })
  );
  const refresh = useRef();
  refresh.current = () => {
    resource.reload();
    requests.reload();
  };
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refresh.current();
      }
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  function decide() {
    action.run(async (signal) => {
      await api.post(
        `/api/posts/${confirm.post.id}/matches/${confirm.id}/decision`,
        { decision: confirm.decision },
        { auth: true, signal }
      );
      setConfirm(null);
      requests.reload();
      resource.reload();
    });
  }
  return (
    <>
      <PageTitle
        eyebrow="KEEP THE CONVERSATION ON CAMPUS"
        description="Private conversations open only after an approved claim or accepted request."
      >
        Campus chat
      </PageTitle>
      <button
        className="button secondary"
        onClick={() => {
          resource.reload();
          requests.reload();
        }}
      >
        Refresh inbox
      </button>
      <h2 className="inbox-heading">Your conversations</h2>
      <ResourceState resource={resource}>
        {resource.data?.conversations.length ? (
          <div className="stack">
            {resource.data.conversations.map((conversation) => (
              <article className="surface list-row" key={conversation.id}>
                <div>
                  <h3>{conversation.post.title}</h3>
                  <p className="small muted">
                    {conversation.participants.map((person) => person.displayName).join(' · ')}
                  </p>
                </div>
                <Link className="button" to={`/chat/${conversation.id}`}>
                  Open conversation
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="A private place to reconnect.">
            Approved claims and accepted requests will appear here.
          </Empty>
        )}
        <Pagination value={resource.data?.pagination} onPage={setPage} />
      </ResourceState>
      <h2 className="inbox-heading">Lost-item conversation requests</h2>
      <div className="toolbar">
        <Field label="Request direction">
          <select
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value);
              setRequestPage(1);
            }}
          >
            <option value="incoming">Requests on my lost posts</option>
            <option value="mine">Requests I sent</option>
          </select>
        </Field>
      </div>
      <ResourceState resource={requests}>
        {requests.data?.requests.length ? (
          <div className="stack">
            {requests.data.requests.map((request) => (
              <article className="surface list-row" key={request.id}>
                <div>
                  <h3>
                    <Link to={`/posts/${request.post.id}`}>{request.post.title}</Link>
                  </h3>
                  <p>
                    {request.requester.displayName} · <Status value={request.status} />
                  </p>
                </div>
                <div className="actions">
                  {request.conversationId ? (
                    <Link className="button" to={`/chat/${request.conversationId}`}>
                      Open conversation
                    </Link>
                  ) : direction === 'incoming' &&
                    request.status === 'pending' &&
                    request.post.status === 'open' ? (
                    <>
                      <button
                        className="button"
                        onClick={() => {
                          action.setError('');
                          setConfirm({ ...request, decision: 'accept' });
                        }}
                      >
                        Accept request
                      </button>
                      <button
                        className="button secondary"
                        onClick={() => {
                          action.setError('');
                          setConfirm({ ...request, decision: 'deny' });
                        }}
                      >
                        Deny request
                      </button>
                    </>
                  ) : (
                    <span className="muted small">
                      {request.status === 'pending'
                        ? 'Waiting for the post author'
                        : 'Request resolved'}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="No requests here yet.">
            If you think you found a lost item, request a conversation from its post.
          </Empty>
        )}
        <Pagination value={requests.data?.pagination} onPage={setRequestPage} />
      </ResourceState>
      {confirm && (
        <Confirm
          title={
            confirm.decision === 'accept'
              ? 'Accept this conversation request?'
              : 'Deny this request?'
          }
          label={confirm.decision === 'accept' ? 'Accept request' : 'Deny request'}
          pending={action.pending}
          error={action.error}
          onConfirm={decide}
          onCancel={() => setConfirm(null)}
        >
          {confirm.decision === 'accept'
            ? 'This opens a private conversation with this finder and resolves other pending requests for this post.'
            : 'The requester will see that the request was denied.'}
        </Confirm>
      )}
    </>
  );
}
function ChatThread({ conversationId }) {
  const auth = useAuth();
  const action = useAction();
  const historyAction = useAction();
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState('');
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [before, setBefore] = useState(null);
  const [draft, setDraft] = useState('');
  const [retry, setRetry] = useState(null);
  const [version, setVersion] = useState(0);
  const connection = useRef();
  const bottom = useRef();
  const activeDraft = useRef(null);
  activeDraft.current = retry;
  async function loadHistory(cursor, signal) {
    const data = await api.get(
      `/api/conversations/${conversationId}/messages?limit=30${cursor ? `&before=${cursor}` : ''}`,
      { auth: true, signal }
    );
    setMessages((previous) => mergeMessages(previous, data.messages));
    setBefore(data.nextBefore);
  }
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setError('');
    connection.current = openConversation(conversationId, {
      onStatus: (value) => {
        if (live) {
          setStatus(value);
        }
      },
      onError: (value) => {
        if (live) {
          setError(value);
        }
      },
      onReady: (value) => {
        if (live) {
          setConversation(value);
          loadHistory(null, controller.signal).catch(() => {
            if (live) {
              setError('History could not be loaded. Use Refresh history to try again.');
            }
          });
        }
      },
      onMessage: (message) => {
        if (!live) {
          return;
        }
        setMessages((previous) => mergeMessages(previous, [message]));
        if (
          message.clientMessageId === activeDraft.current?.clientMessageId &&
          message.sender.id === auth.user.id
        ) {
          setRetry(null);
          setDraft('');
          action.setError('');
        }
      },
    });
    return () => {
      live = false;
      controller.abort();
      connection.current.close();
    };
  }, [conversationId, auth.user.id, version]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.at(-1)?.id]);
  function send(event) {
    event.preventDefault();
    action.run(async () => {
      if (!draft.trim()) {
        throw new Error('Write a message first.');
      }
      const envelope = retry || { clientMessageId: crypto.randomUUID(), body: draft.trim() };
      setRetry(envelope);
      const result = await connection.current.send(envelope);
      setMessages((previous) => mergeMessages(previous, [result]));
      setRetry(null);
      setDraft('');
    });
  }
  return (
    <div className="chat-thread">
      <PageTitle
        eyebrow="PRIVATE CAMPUS CONVERSATION"
        actions={
          <Link className="button secondary" to="/chat">
            Chat inbox
          </Link>
        }
      >
        {conversation?.post.title || 'Campus conversation'}
      </PageTitle>
      <div className="chat-toolbar">
        <span role="status" className={`connection-state ${status}`}>
          {status === 'connected'
            ? 'Connected'
            : status === 'connecting'
              ? 'Connecting…'
              : 'Disconnected'}
        </span>
        {status === 'disconnected' && (
          <button className="button secondary" onClick={() => setVersion((value) => value + 1)}>
            Reconnect
          </button>
        )}
        <button
          className="text-button"
          disabled={historyAction.pending}
          onClick={() => historyAction.run((signal) => loadHistory(null, signal))}
        >
          Refresh history
        </button>
      </div>
      <Notice error>{error || historyAction.error}</Notice>
      <section className="surface chat-surface" aria-label="Conversation">
        <div className="chat-people">
          {conversation?.participants.map((person) => person.displayName).join(' · ')}
          <small>Arrange a safe campus handoff. No account emails are shared.</small>
        </div>
        {before && (
          <button
            className="text-button older-messages"
            disabled={historyAction.pending}
            onClick={() => historyAction.run((signal) => loadHistory(before, signal))}
          >
            Load earlier messages
          </button>
        )}
        <ol
          className="message-list"
          aria-label="Messages"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {messages.map((message) => (
            <li
              key={message.id}
              className={message.sender.id === auth.user.id ? 'message mine' : 'message'}
            >
              <span className="message-author">{message.sender.displayName}</span>
              <p className="preserve">{message.body}</p>
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </time>
            </li>
          ))}
          {!messages.length && (
            <li className="muted empty-chat">No messages yet. Start with a hello.</li>
          )}
          <li ref={bottom} aria-hidden="true" />
        </ol>
        <form className="composer" onSubmit={send}>
          <Notice error>{action.error}</Notice>
          <Field
            label="Message"
            hint="Up to 2,000 characters. Messages are saved in this private conversation."
          >
            <textarea
              rows={3}
              maxLength={2000}
              required
              value={draft}
              readOnly={Boolean(retry)}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <div className="actions">
            <button className="button" disabled={status !== 'connected' || action.pending}>
              {action.pending ? 'Sending…' : retry ? 'Retry same message' : 'Send message'}
            </button>
            {retry && !action.pending && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setRetry(null);
                  action.setError('');
                }}
              >
                Edit draft
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
