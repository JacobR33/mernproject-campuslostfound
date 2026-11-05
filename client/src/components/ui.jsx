import React, { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatDate, titleCase } from '../lib/forms';
export function Icon({ name = 'search', ...props }) {
  const paths = {
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    bag: 'M5 7h14l1 14H4L5 7zm3 0V5a4 4 0 0 1 8 0v2',
    bell: 'M18 8a6 6 0 0 0-12 0c0 8-3 8-3 9h18c0-1-3-1-3-9M10 21h4',
    shield: 'M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4zm-4 10 3 3 5-6',
    plus: 'M12 4v16M4 12h16',
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name] || paths.search} />
    </svg>
  );
}
export function PageTitle({ eyebrow, children, description, actions }) {
  const ref = useRef();
  useEffect(() => {
    document.title = `${ref.current?.textContent || 'Campus'} | UCF Lost & Found`;
  }, [children]);
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 ref={ref} tabIndex="-1">
          {children}
        </h1>
        {description && <p className="muted intro">{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
export function Notice({ children, error = false }) {
  return children ? (
    <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      {children}
    </div>
  ) : null;
}
export function ResourceState({ resource, children }) {
  if (resource.loading) {
    return (
      <div className="loading" role="status">
        <span className="spinner" />
        Loading…
      </div>
    );
  }
  if (resource.error) {
    return (
      <Notice error>
        {resource.error.message}{' '}
        <button className="text-button" onClick={resource.reload}>
          Try again
        </button>
      </Notice>
    );
  }
  return children;
}
export function Field({ label, hint, children, ...props }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children ? (
        React.cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })
      ) : (
        <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...props} />
      )}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Status({ value }) {
  return <span className={`status status-${value}`}>{titleCase(value)}</span>;
}
export function Empty({ title, children, action }) {
  return (
    <section className="empty">
      <span className="empty-icon">
        <Icon name="bag" />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </section>
  );
}
export function Pagination({ value, onPage }) {
  if (!value || value.pages <= 1) {
    return null;
  }
  return (
    <nav className="pagination" aria-label="Pagination">
      <button
        className="button secondary"
        disabled={value.page <= 1}
        onClick={() => onPage(value.page - 1)}
      >
        Previous
      </button>
      <span>
        Page {value.page} of {value.pages}
      </span>
      <button
        className="button secondary"
        disabled={value.page >= value.pages}
        onClick={() => onPage(value.page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
export function Image({ image, title, className = '' }) {
  const [failed, setFailed] = React.useState(false);
  const src = api.asset(image?.url);
  return src && !failed ? (
    <img
      className={className}
      src={src}
      alt={title}
      loading="lazy"
      crossOrigin="use-credentials"
      onError={() => setFailed(true)}
    />
  ) : (
    <div
      className={`image-placeholder ${className}`}
      role="img"
      aria-label={`No photo available for ${title}`}
    >
      <Icon name="bag" width="42" height="42" />
      <span>No photo</span>
    </div>
  );
}
export function PostCard({ post }) {
  const location = post.item.locationFound || post.item.lastSeen;
  return (
    <article className="post-card">
      <Link
        to={`/posts/${post.id}`}
        className="card-picture"
        aria-label={`View ${post.item.title}`}
      >
        <Image image={post.item.images[0]} title={post.item.title} />
      </Link>
      <div className="card-body">
        <div className="card-meta">
          <span className={`type-label ${post.type}`}>
            {post.type === 'found' ? 'Found item' : 'Lost item'}
          </span>
          <span>{titleCase(post.item.category)}</span>
        </div>
        <h2>
          <Link to={`/posts/${post.id}`}>{post.item.title}</Link>
        </h2>
        <p className="clamp">{post.item.publicDescription}</p>
        <p className="location">
          {location?.buildingName || location?.campusArea || 'Campus location'}{' '}
          <span>· {formatDate(post.item.dateFoundOrLost)}</span>
        </p>
        <div className="card-bottom">
          <Status value={post.status} />
          <Link to={`/posts/${post.id}`} aria-label={`Details for ${post.item.title}`}>
            <Icon name="arrow" />
          </Link>
        </div>
      </div>
    </article>
  );
}
export function Confirm({
  title,
  children,
  onCancel,
  onConfirm,
  pending,
  error,
  label = 'Confirm',
}) {
  const ref = useRef();
  const id = useId();
  useEffect(() => {
    ref.current.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        if (pending) {
          event.preventDefault();
        } else {
          onCancel();
        }
      }}
    >
      <h2 id={id}>{title}</h2>
      <p>{children}</p>
      <Notice error>{error}</Notice>
      <div className="actions">
        <button className="button secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button className="button danger" disabled={pending} onClick={onConfirm}>
          {pending ? 'Please wait…' : label}
        </button>
      </div>
    </dialog>
  );
}
