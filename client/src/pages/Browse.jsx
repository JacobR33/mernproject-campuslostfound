import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useResource } from '../hooks';
import { categories, queryString, titleCase } from '../lib/forms';
import { Empty, Field, Icon, Pagination, PostCard, ResourceState } from '../components/ui';
export function Browse() {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(
    ['q', 'type', 'category', 'location', 'from', 'to', 'status'].map((key) => [
      key,
      params.get(key) || '',
    ])
  );
  const page = Math.max(1, Math.min(10000, Number(params.get('page')) || 1));
  const query = { ...filters, page, limit: 12 };
  for (const key of ['from', 'to'])
    if (filters[key]) {
      query[key] = `${filters[key]}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`;
    }
  const resource = useResource(queryString(query), (signal) =>
    api.get(`/api/posts?${queryString(query)}`, { signal })
  );
  function search(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setParams(queryString({ ...form, page: 1 }));
  }
  function changeType(type) {
    setParams(queryString({ ...filters, type, page: 1 }));
  }
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">KNIGHTS LOOK OUT FOR KNIGHTS</p>
          <h1 tabIndex="-1">
            Lost something?
            <br />
            <span>Let’s find it.</span>
          </h1>
          <p>
            From a misplaced set of keys to a favorite hoodie. Connect with your campus and help
            good things find their way back.
          </p>
          <div className="hero-trust">
            <Icon name="shield" />
            <span>UCF email verification. Your contact details stay private.</span>
          </div>
        </div>
        <aside className="hero-card">
          <span className="hero-emblem">
            <Icon name="bag" width="50" height="50" />
          </span>
          <p className="eyebrow">MAKE SOMEONE’S DAY</p>
          <h2>Found something?</h2>
          <p>A small gesture can mean a lot. Post what you found and help its owner find you.</p>
          <Link className="button" to="/found/new">
            Post a found item <Icon name="arrow" />
          </Link>
          <Link className="hero-secondary" to="/lost/new">
            Or report something you lost
          </Link>
        </aside>
      </section>
      <section className="browse-section" aria-labelledby="browse-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE CAMPUS BOARD</p>
            <h2 id="browse-title">A place to reconnect.</h2>
          </div>
          <p className="muted">Public clues. Private conversations.</p>
        </div>
        <div className="tabs" aria-label="Post type">
          {[
            ['', 'All posts'],
            ['found', 'Found items'],
            ['lost', 'Lost items'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filters.type === value ? 'active' : ''}
              aria-pressed={filters.type === value}
              onClick={() => changeType(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <form className="filter-bar surface" key={params.toString()} onSubmit={search}>
          <div className="search-field">
            <label htmlFor="search">Search the board</label>
            <div>
              <Icon />
              <input
                id="search"
                name="q"
                placeholder="Headphones, keys, backpack…"
                maxLength={100}
                defaultValue={filters.q}
              />
            </div>
          </div>
          <input type="hidden" name="type" value={filters.type} />
          <Field label="Category">
            <select name="category" defaultValue={filters.category}>
              <option value="">All categories</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {value === 'claim_pending' ? 'Conversation active' : titleCase(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Campus location"
            name="location"
            placeholder="Building or campus area"
            maxLength={120}
            defaultValue={filters.location}
          />
          <button className="button filter-submit">
            Search <Icon name="arrow" />
          </button>
          <details className="more-filters">
            <summary>Dates and status</summary>
            <div className="form-grid">
              <Field label="Date from" name="from" type="date" defaultValue={filters.from} />
              <Field label="Date to" name="to" type="date" defaultValue={filters.to} />
              <Field label="Status">
                <select name="status" defaultValue={filters.status}>
                  <option value="">All statuses</option>
                  {['open', 'claim_pending', 'returned', 'closed'].map((value) => (
                    <option key={value} value={value}>
                      {value === 'claim_pending' ? 'Conversation active' : titleCase(value)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </details>
        </form>
        <div className="results-heading">
          <p role="status">
            {resource.data
              ? `${resource.data.pagination.total} matching ${resource.data.pagination.total === 1 ? 'post' : 'posts'}`
              : 'Campus posts'}
          </p>
          {Object.values(filters).some(Boolean) && (
            <button className="text-button" onClick={() => setParams({})}>
              Clear filters
            </button>
          )}
        </div>
        <ResourceState resource={resource}>
          {resource.data?.posts.length ? (
            <>
              <div className="post-grid">
                {resource.data.posts.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
              <Pagination
                value={resource.data.pagination}
                onPage={(page) => setParams(queryString({ ...filters, page }))}
              />
            </>
          ) : (
            <Empty
              title="Nothing here just yet."
              action={
                <Link className="button" to="/lost/new">
                  Post a lost item
                </Link>
              }
            >
              Try a different search, or create a post so your campus knows what to look for.
            </Empty>
          )}
        </ResourceState>
      </section>
      <section className="steps">
        <h2>A little care. A happy reunion.</h2>
        <div>
          {[
            [
              '01',
              'Share a few clues',
              'Keep your description helpful without giving away every detail.',
            ],
            [
              '02',
              'Request a conversation',
              'Ask the post owner to accept a private conversation request.',
            ],
            [
              '03',
              'Bring it back together',
              'Discuss identifying details privately and confirm the return.',
            ],
          ].map(([number, title, text]) => (
            <article key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
