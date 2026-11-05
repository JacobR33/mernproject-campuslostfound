import { ReportPost, AdminRemovePost } from './ModerationPages';
import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useResource } from '../hooks';
import { categories, formatDate, titleCase } from '../lib/forms';
import {
  Confirm,
  Empty,
  Field,
  Image,
  Notice,
  PageTitle,
  Pagination,
  ResourceState,
  Status,
} from '../components/ui';
const localDate = (value) => {
  const date = new Date(value || Date.now());
  return new Date(date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function PostDetail() {
  const { id } = useParams();
  const auth = useAuth();
  const resource = useResource(id, (signal) => api.get(`/api/posts/${id}`, { signal }));
  const post = resource.data?.post;
  const owner = post?.author.id === auth.user?.id;
  return (
    <>
      <PageTitle eyebrow="THE CAMPUS BOARD">{post?.item.title || 'Post details'}</PageTitle>
      <ResourceState resource={resource}>
        {post && (
          <div className="detail-grid">
            <section>
              <div className="detail-photo">
                <Image image={post.item.images[0]} title={post.item.title} />
              </div>
              {post.item.images.length > 1 && (
                <div className="photo-strip">
                  {post.item.images.slice(1).map((image, index) => (
                    <Image
                      key={image.id}
                      image={image}
                      title={`${post.item.title}, photo ${index + 2}`}
                    />
                  ))}
                </div>
              )}
            </section>
            <section className="surface detail-content">
              <div className="card-meta">
                <span className={`type-label ${post.type}`}>
                  {post.type === 'found' ? 'Found item' : 'Lost item'}
                </span>
                <Status value={post.status} />
              </div>
              <h2>Does this look familiar?</h2>
              <p className="preserve">{post.item.publicDescription}</p>
              <dl className="details-list">
                <dt>Category</dt>
                <dd>{titleCase(post.item.category)}</dd>
                <dt>{post.type === 'found' ? 'Found at' : 'Last seen'}</dt>
                <dd>
                  {(post.item.locationFound || post.item.lastSeen)?.buildingName ||
                    'Building not specified'}{' '}
                  · {(post.item.locationFound || post.item.lastSeen)?.campusArea}
                </dd>
                <dt>Date</dt>
                <dd>{formatDate(post.item.dateFoundOrLost)}</dd>
                <dt>Posted by</dt>
                <dd>{post.author.displayName}</dd>
              </dl>
              {owner ? (
                <div className="actions">
                  <Link className="button" to="/my-posts">
                    Manage my posts
                  </Link>
                  {post.type === 'found' && (
                    <Link className="button secondary" to={`/posts/${id}/review`}>
                      Review claims
                    </Link>
                  )}
                </div>
              ) : post.type === 'found' ? (
                post.acceptingClaims ? (
                  <>
                    <Notice>
                      Know the details only its owner would know? Answer the finder’s private
                      verification questions.
                    </Notice>
                    <Link className="button wide" to={`/posts/${id}/claim`}>
                      This might be mine
                    </Link>
                  </>
                ) : (
                  <Notice>This item is not accepting new claims.</Notice>
                )
              ) : post.acceptingMatches ? (
                <>
                  <Notice>
                    Think you found this? Ask its owner to open a private conversation.
                  </Notice>
                  <Link className="button wide" to={`/posts/${id}/match`}>
                    I think I found this
                  </Link>
                </>
              ) : (
                <Notice>This post is not accepting new conversation requests.</Notice>
              )}
              <p className="small muted">
                Keep distinctive details private. Never post phone numbers, email addresses, or
                photos of personal documents.
              </p>
              {!owner && <ReportPost key={id} postId={id} />}
              {auth.user?.role === 'admin' && (
                <AdminRemovePost postId={id} authorId={post.author.id} />
              )}
            </section>
          </div>
        )}
      </ResourceState>
    </>
  );
}
function ImageEditor({ images, setImages, onBusy }) {
  const action = useAction();
  async function add(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    action.run(async (signal) => {
      onBusy(true);
      try {
        if (images.length + files.length > 4) {
          throw new Error('Use no more than four photos.');
        }
        if (
          files.some(
            (file) =>
              !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
              file.size > 5 * 1024 * 1024
          )
        ) {
          throw new Error('Choose JPEG, PNG, or static WebP photos up to 5 MiB each.');
        }
        for (const file of files) {
          const body = new FormData();
          body.append('image', file);
          const response = await api.post('/api/uploads', body, { auth: true, signal });
          setImages((value) => [...value, { ...response.image, staged: true }]);
        }
      } finally {
        onBusy(false);
      }
    });
  }
  function remove(image) {
    action.run(async (signal) => {
      onBusy(true);
      try {
        if (image.staged) {
          await api.delete(`/api/uploads/${image.id}`, {}, { auth: true, signal });
        }
        setImages((value) => value.filter((v) => v.id !== image.id));
      } finally {
        onBusy(false);
      }
    });
  }
  return (
    <fieldset>
      <legend>Photos</legend>
      <p className="muted small">
        All published photos are public. Avoid identifying marks that answer your questions, contact
        details, student IDs, or other personal documents.
      </p>
      <Notice error>{action.error}</Notice>
      <div className="upload-grid">
        {images.map((image, index) => (
          <div className="upload-preview" key={image.id}>
            <Image image={image} title={`Item photo ${index + 1}`} />
            <button
              type="button"
              className="text-button"
              disabled={action.pending}
              onClick={() => remove(image)}
            >
              Remove photo {index + 1}
            </button>
          </div>
        ))}
      </div>
      <Field
        label="Add photos"
        hint="Up to four JPEG, PNG, or static WebP files. Maximum 5 MiB per photo."
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={action.pending || images.length >= 4}
          onChange={add}
        />
      </Field>
      {action.pending && <p role="status">Preparing your photos…</p>}
    </fieldset>
  );
}
export function PostEditor({ type }) {
  const { id } = useParams();
  if (!id) {
    return <EditablePost type={type} />;
  }
  return <EditLoader id={id} />;
}
function EditLoader({ id }) {
  const resource = useResource(id, (signal) =>
    api.get(`/api/posts/${id}/manage`, { auth: true, signal })
  );
  return (
    <>
      <PageTitle>Manage your post</PageTitle>
      <ResourceState resource={resource}>
        {resource.data &&
          (['open', 'closed'].includes(resource.data.post.status) ? (
            <EditablePost
              key={`${id}:${resource.data.post.revision}`}
              initial={resource.data.post}
              type={resource.data.post.type}
              reload={resource.reload}
            />
          ) : (
            <Notice>
              Editing is paused while a claim is pending or an item has been returned.{' '}
              <Link to="/my-posts">Back to My Posts</Link>
            </Notice>
          ))}
      </ResourceState>
    </>
  );
}
function EditablePost({ type, initial, reload }) {
  const navigate = useNavigate();
  const action = useAction();
  const [images, setImages] = useState(initial?.item.images || []);
  const [uploading, setUploading] = useState(false);
  const [questions, setQuestions] = useState([
    { question: '', answer: '' },
    { question: '', answer: '' },
  ]);
  function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    action.run(async (signal) => {
      if (uploading) {
        throw new Error('Wait for the photos to finish uploading.');
      }
      if (type === 'found' && !images.length) {
        throw new Error('Add at least one photo for a found item.');
      }
      if (
        !initial &&
        type === 'found' &&
        questions.some((q) => q.question.trim().length < 5 || !q.answer.trim())
      ) {
        throw new Error('Add two or three questions with nonblank private answers.');
      }
      const body = {
        category: data.get('category'),
        title: data.get('title').trim(),
        publicDescription: data.get('publicDescription').trim(),
        privateDetails: data.get('privateDetails').trim(),
        images: images.map((image) => image.id),
        location: {
          campusArea: data.get('campusArea').trim(),
          ...(data.get('buildingName').trim()
            ? { buildingName: data.get('buildingName').trim() }
            : {}),
        },
        dateFoundOrLost: new Date(data.get('date')).toISOString(),
      };
      // Preserve explicitly supplied coordinates when editing; this form does not collect GPS data.
      const previousLocation = initial?.item.locationFound || initial?.item.lastSeen;
      if (previousLocation?.coordinates) {
        body.location.coordinates = previousLocation.coordinates;
      }
      let response;
      if (initial) {
        response = await api.patch(
          `/api/posts/${initial.id}`,
          { ...body, revision: initial.revision, status: data.get('status') },
          { auth: true, signal }
        );
      } else {
        response = await api.post(
          '/api/posts',
          { ...body, type, ...(type === 'found' ? { verificationQuestions: questions } : {}) },
          { auth: true, signal }
        );
      }
      setQuestions([
        { question: '', answer: '' },
        { question: '', answer: '' },
      ]);
      navigate(`/posts/${response.post.id}`, { replace: true });
    });
  }
  const location = initial?.item.locationFound || initial?.item.lastSeen;
  return (
    <div className="narrow">
      {!initial && (
        <PageTitle
          eyebrow={type === 'found' ? 'A GOOD DEED STARTS HERE' : 'LET YOUR CAMPUS KNOW'}
          description={
            type === 'found'
              ? 'Share enough to help someone recognize it. Keep the proof private.'
              : 'Give your campus a few clues about what you’re looking for.'
          }
        >
          {type === 'found' ? 'Post a found item.' : 'Post a lost item.'}
        </PageTitle>
      )}
      <form className="surface editor" onSubmit={submit}>
        <Notice error>
          {action.error}
          {action.error.includes('Reload') && reload && (
            <>
              {' '}
              <button type="button" className="text-button" onClick={reload}>
                Reload saved post
              </button>
            </>
          )}
        </Notice>
        <fieldset disabled={action.pending}>
          <legend>About the item</legend>
          <div className="form-grid">
            <Field label="Category">
              <select name="category" defaultValue={initial?.item.category || ''} required>
                <option value="" disabled>
                  Choose a category
                </option>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Short title"
              name="title"
              required
              maxLength={120}
              defaultValue={initial?.item.title}
              placeholder="For example, black wireless headphones"
            />
          </div>
          <Field
            label="Public description"
            hint="Keep it vague. Do not include contact details or the answers to verification questions."
          >
            <textarea
              name="publicDescription"
              required
              maxLength={2000}
              rows={4}
              defaultValue={initial?.item.publicDescription}
            />
          </Field>
          <Field
            label="Private distinguishing details"
            hint="Only you can view these. Claimants will not see this text."
          >
            <textarea
              name="privateDetails"
              maxLength={2000}
              rows={3}
              defaultValue={initial?.item.privateDetails}
            />
          </Field>
        </fieldset>
        <fieldset disabled={action.pending}>
          <legend>
            {type === 'found' ? 'Where and when you found it' : 'Where and when you last saw it'}
          </legend>
          <div className="form-grid">
            <Field
              label="Campus area"
              name="campusArea"
              required
              maxLength={120}
              defaultValue={location?.campusArea}
              placeholder="For example, Main Campus"
            />
            <Field
              label="Building (optional)"
              name="buildingName"
              maxLength={120}
              defaultValue={location?.buildingName}
              placeholder="For example, John C. Hitt Library"
            />
            <Field
              label="Date and time"
              name="date"
              type="datetime-local"
              required
              max={localDate()}
              defaultValue={initial ? localDate(initial.item.dateFoundOrLost) : localDate()}
            />
          </div>
        </fieldset>
        <ImageEditor images={images} setImages={setImages} onBusy={setUploading} />
        {type === 'found' && (
          <fieldset disabled={action.pending}>
            <legend>Private ownership verification</legend>
            {initial ? (
              <>
                <p className="small muted">
                  Your original questions stay the same. Their private answers are never displayed.
                </p>
                <ol>
                  {initial.verificationQuestions.map((q) => (
                    <li key={q.id}>{q.question}</li>
                  ))}
                </ol>
              </>
            ) : (
              <>
                <Notice>
                  Ask about details only the owner should know. Questions are public; answers are
                  private. Do not reveal those answers in your description or photos.
                </Notice>
                {questions.map((question, index) => (
                  <div className="question-box" key={index}>
                    <h3>Question {index + 1}</h3>
                    <Field
                      label={`Verification question ${index + 1}`}
                      required
                      minLength={5}
                      maxLength={250}
                      value={question.question}
                      onChange={(event) =>
                        setQuestions((values) =>
                          values.map((q, i) =>
                            i === index ? { ...q, question: event.target.value } : q
                          )
                        )
                      }
                      placeholder="For example, describe a hidden marking"
                    />
                    <Field
                      label={`Private answer ${index + 1}`}
                      type="password"
                      autoComplete="off"
                      required
                      maxLength={500}
                      value={question.answer}
                      onChange={(event) =>
                        setQuestions((values) =>
                          values.map((q, i) =>
                            i === index ? { ...q, answer: event.target.value } : q
                          )
                        )
                      }
                    />
                    {index === 2 && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setQuestions((values) => values.slice(0, 2))}
                      >
                        Remove third question
                      </button>
                    )}
                  </div>
                ))}
                {questions.length < 3 && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      setQuestions((value) => [...value, { question: '', answer: '' }])
                    }
                  >
                    Add a third question
                  </button>
                )}
              </>
            )}
          </fieldset>
        )}
        {initial && (
          <Field label="Post status">
            <select name="status" defaultValue={initial.status}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </Field>
        )}
        <div className="actions form-actions">
          <button className="button" disabled={action.pending || uploading}>
            {action.pending ? 'Saving…' : initial ? 'Save changes' : 'Publish post'}
          </button>
          <Link className="button secondary" to={initial ? '/my-posts' : '/'}>
            Cancel
          </Link>
        </div>
        <p className="small muted">
          Unpublished photos are private and expire automatically after 24 hours.
        </p>
      </form>
    </div>
  );
}
export function MyPosts() {
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState(null);
  const action = useAction();
  const resource = useResource(page, (signal) =>
    api.get(`/api/posts/mine?page=${page}&limit=10`, { auth: true, signal })
  );
  function perform() {
    action.run(async (signal) => {
      if (confirm.returning) {
        await api.post(
          `/api/posts/${confirm.id}/return`,
          { revision: confirm.revision },
          { auth: true, signal }
        );
      } else {
        await api.delete(
          `/api/posts/${confirm.id}`,
          { revision: confirm.revision },
          { auth: true, signal }
        );
      }
      setConfirm(null);
      resource.reload();
    });
  }
  return (
    <>
      <PageTitle
        eyebrow="YOUR CAMPUS CORNER"
        actions={
          <>
            <Link className="button" to="/found/new">
              Post found item
            </Link>
            <Link className="button secondary" to="/lost/new">
              Post lost item
            </Link>
          </>
        }
      >
        My Posts
      </PageTitle>
      <ResourceState resource={resource}>
        {resource.data?.posts.length ? (
          <div className="stack">
            {resource.data.posts.map((post) => (
              <article className="surface list-row" key={post.id}>
                <div>
                  <span className={`type-label ${post.type}`}>{titleCase(post.type)}</span>
                  <h2>
                    <Link to={`/posts/${post.id}`}>{post.item.title}</Link>
                  </h2>
                  <p className="small muted">
                    {formatDate(post.createdAt)} · <Status value={post.status} />
                  </p>
                </div>
                <div className="actions">
                  {post.type === 'found' && (
                    <Link className="button secondary" to={`/posts/${post.id}/review`}>
                      Review claims
                    </Link>
                  )}
                  {post.type === 'lost' && (
                    <Link className="button secondary" to="/chat">
                      Review requests
                    </Link>
                  )}
                  {['open', 'closed'].includes(post.status) && (
                    <Link className="button secondary" to={`/posts/${post.id}/edit`}>
                      Edit
                    </Link>
                  )}
                  {post.status === 'claim_pending' &&
                    (post.type === 'found' ? !post.acceptingClaims : !post.acceptingMatches) && (
                      <button
                        className="button secondary"
                        onClick={() => {
                          action.setError('');
                          setConfirm({ ...post, returning: true });
                        }}
                      >
                        Mark returned
                      </button>
                    )}
                  <button
                    className="text-button danger-text"
                    onClick={() => {
                      action.setError('');
                      setConfirm(post);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="Your board is a blank slate."
            action={
              <Link className="button" to="/lost/new">
                Create your first post
              </Link>
            }
          >
            Your active posts will appear here.
          </Empty>
        )}
        <Pagination value={resource.data?.pagination} onPage={setPage} />
      </ResourceState>
      {confirm && (
        <Confirm
          title={confirm.returning ? 'Confirm the item was returned?' : 'Delete this post?'}
          label={confirm.returning ? 'Confirm return' : 'Delete post'}
          pending={action.pending}
          error={action.error}
          onCancel={() => setConfirm(null)}
          onConfirm={perform}
        >
          {confirm.returning
            ? 'Only confirm once the item is back with its owner.'
            : 'The post and its photos will become unavailable. Related claims and conversations will be removed.'}
        </Confirm>
      )}
    </>
  );
}
