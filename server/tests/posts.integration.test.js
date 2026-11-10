const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { randomBytes, scryptSync } = require('node:crypto');
const { createApp } = require('../src/app');
const { User, Post, Item, Claim, Conversation, Message } = require('../src/models');
const { AuthSession, RateBucket } = require('../src/models/auth');
const Upload = require('../src/models/upload');
const { createGridFSStorage } = require('../src/storage/gridfs');
const { runPostCleanup } = require('../src/jobs/postCleanup');
const { assertTransactionsSupported } = require('../src/config/database');
const { assertPostIndexes } = require('../src/config/indexes');
const { hashPassword, token } = require('../src/lib/authCrypto');
const { hashQuestions } = require('../src/lib/verificationAnswers');
const { cookies } = require('../src/middleware/auth');
const { MAX_BYTES } = require('../src/middleware/imageUpload');

jest.setTimeout(120000);
const config = { NODE_ENV: 'test', CLIENT_ORIGIN: 'https://campus.example', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ACCESS_TOKEN_TTL_SECONDS: 900, POST_RETENTION_DAYS: 90 };
const prompts = [{ question: 'What color is the lining?', answer: '  Navy   BLUE ' }, { question: 'Describe the sticker on it', answer: '  Navy   BLUE ' }];
let mongo, app, storage, logger, png, jpeg, baseHash, hashedQuestions, serial = 0;
const oid = () => new mongoose.Types.ObjectId();
const cookieHeader = jar => Object.entries(jar).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
async function browser(role = 'user', target = app) {
  const record = await User.create({ email: `student${++serial}@ucf.edu`, displayName: `Knight ${serial}`, passwordHash: baseHash, emailVerified: true, role });
  const sid = token();
  await AuthSession.create({ _id: sid, user: record._id, authVersion: 0, currentHash: token(), expiresAt: new Date(Date.now() + 86400000) });
  const csrfResponse = await request(target).get('/api/auth/csrf');
  expect(csrfResponse.status).toBe(200);
  const csrf = csrfResponse.body.csrfToken;
  const access = jwt.sign({ ver: 0, sid }, config.JWT_SECRET, { algorithm: 'HS256', subject: String(record._id), issuer: 'ucf-lost-found', audience: 'ucf-lost-found-api', expiresIn: 900 });
  return { target, user: record, csrf, jar: { [cookies.csrf]: csrf, [cookies.access]: access } };
}
const authenticated = (b, method, path) => request(b.target)[method](path).set('Cookie', cookieHeader(b.jar)).set('Origin', config.CLIENT_ORIGIN).set('X-CSRF-Token', b.csrf);
const mutate = (b, method, path, body = {}) => authenticated(b, method, path).send(body);
async function upload(b, buffer = png, type = 'image/png', filename = 'private-original.png') {
  return authenticated(b, 'post', '/api/uploads').attach('image', buffer, { filename, contentType: type });
}
async function imageId(b) { const response = await upload(b); expect(response.status).toBe(201); return response.body.image.id; }
const lostBody = (overrides = {}) => ({ type: 'lost', category: 'electronics', title: 'Campus headphones', publicDescription: 'Headphones lost on campus', privateDetails: 'quartzprivatezebra', location: { campusArea: 'Main', buildingName: 'Library' }, dateFoundOrLost: '2026-10-01T12:00:00.000Z', ...overrides });
async function foundBody(b, overrides = {}) { return lostBody({ type: 'found', images: [await imageId(b)], ...overrides }); }
async function create(b, value = lostBody()) { const res = await mutate(b, 'post', '/api/posts', value); expect(res.status).toBe(201); return res.body.post; }
async function seed(b, values = {}) {
  const item = await Item.create({ category: values.category || 'electronics', title: values.title || 'Campus headphones', publicDescription: values.publicDescription || 'Headphones lost on campus', privateDetails: 'quartzprivatezebra', images: [], ...(values.type === 'found' ? { locationFound: { campusArea: 'Main', buildingName: 'Library' } } : { lastSeen: { campusArea: 'Main', buildingName: 'Library' } }), dateFoundOrLost: values.dateFoundOrLost || new Date('2026-10-01T12:00:00Z') });
  const post = await Post.create({ type: values.type || 'lost', item: item._id, author: b.user._id, verificationQuestions: values.type === 'found' ? hashedQuestions : [], expiresAt: values.expiresAt || new Date(Date.now() + 86400000), ...(values.createdAt ? { createdAt: values.createdAt } : {}), ...(values.deletedAt ? { deletedAt: values.deletedAt } : {}) });
  return { post, item };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  mongoose.set('sanitizeFilter', true); mongoose.set('strictQuery', true);
  await mongoose.connect(mongo.getUri());
  await Promise.all([User, Post, Item, Claim, Conversation, Message, Upload, AuthSession, RateBucket].map(model => model.init()));
  storage = createGridFSStorage(); logger = jest.fn();
  app = createApp(config, { storage, logger, mailer: { send: async () => {} } });
  png = await sharp({ create: { width: 80, height: 40, channels: 4, background: '#ffc904' } }).png().toBuffer();
  jpeg = await sharp(png).withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { Artist: 'Sensitive Photographer' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '28/1 36/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '81/1 12/1 0/1' } }).jpeg().toBuffer();
  baseHash = await hashPassword('Campus testing passphrase 47!');
  hashedQuestions = await hashQuestions(prompts);
});
beforeEach(async () => {
  for (const model of [Post, Item, Claim, Conversation, Message, Upload, AuthSession, RateBucket, User]) await model.deleteMany({});
  await mongoose.connection.db.collection('images.chunks').deleteMany({});
  await mongoose.connection.db.collection('images.files').deleteMany({});
  logger.mockClear();
});
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('replica-set support and privacy-critical indexes are present', async () => {
  await expect(assertTransactionsSupported(mongoose.connection)).resolves.toBeUndefined();
  await expect(assertPostIndexes()).resolves.toBeUndefined();
});

test('lost creation and public/owner DTOs never disclose emails or private details to other users', async () => {
  const a = await browser(), b = await browser();
  const post = await create(a);
  expect(post.item.privateDetails).toBe('quartzprivatezebra');
  expect(post.item.images).toEqual([]); expect(post.item.lastSeen.buildingName).toBe('Library');
  expect(post.author).toEqual({ id: String(a.user._id), displayName: a.user.displayName });
  for (const res of [await request(app).get('/api/posts'), await request(app).get(`/api/posts/${post.id}`), await authenticated(a, 'get', `/api/posts/${post.id}`), await authenticated(b, 'get', `/api/posts/${post.id}`)]) {
    expect(res.status).toBe(200); expect(res.text).not.toMatch(/privateDetails|quartzprivatezebra|@ucf\.edu|passwordHash|authVersion|answerHash|answerSalt/);
  }
  const manage = await authenticated(a, 'get', `/api/posts/${post.id}/manage`);
  expect(manage.body.post.item.privateDetails).toBe('quartzprivatezebra');
  expect((await authenticated(a, 'get', '/api/posts/mine')).body.posts[0].item.privateDetails).toBe('quartzprivatezebra');
  expect((await authenticated(b, 'get', '/api/posts/mine')).body.posts).toEqual([]);
});

test('found posts attach owned images without requiring or exposing verification questions', async () => {
  const b = await browser(); const post = await create(b, await foundBody(b));
  expect(post.verificationQuestions).toBeUndefined();
  expect(post.acceptingMatches).toBe(true);
  const stored = await Post.findById(post.id).lean();
  expect(stored.verificationQuestions).toEqual([]);
  for (const path of ['/api/posts', `/api/posts/${post.id}`, `/api/posts/${post.id}/manage`, '/api/posts/mine']) {
    const res = await authenticated(b, 'get', path);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/verificationQuestions|answerHash|answerSalt/);
  }
  const attached = await Upload.findById(post.item.images[0].id);
  expect(attached.state).toBe('attached'); expect(String(attached.post)).toBe(post.id);
});

test.each([
  { author: 'a'.repeat(24) }, { status: 'returned' }, { expiresAt: '2030-01-01T00:00:00Z' },
  { item: 'a'.repeat(24) }, { role: 'admin' }, { category: 'untrusted' }, { title: '' },
  { dateFoundOrLost: '2099-01-01T00:00:00Z' }, { dateFoundOrLost: 'bad-date' },
  { location: { campusArea: 'Main', coordinates: [181, 0] } }, { location: { campusArea: 'Main', extra: true } },
  { verificationQuestions: prompts }, { images: ['bad-id'] }, { images: ['a'.repeat(24), 'a'.repeat(24)] },
  { images: Array.from({ length: 5 }, (_, i) => String(i).repeat(24)) },
])('invalid creation inputs and mass assignment are rejected: %j', async override => {
  const b = await browser();
  expect((await mutate(b, 'post', '/api/posts', lostBody(override))).status).toBe(400);
  expect(await Post.countDocuments()).toBe(0); expect(await Item.countDocuments()).toBe(0);
});

test('found posts require photos and reject retired verification inputs', async () => {
  const b = await browser();
  for (const change of [ { images: [] }, { verificationQuestions: [] }, { verificationQuestions: prompts.slice(0, 1) }, { verificationQuestions: [...prompts, ...prompts] }, { verificationQuestions: [{ question: 'A question?', answer: '   ' }, prompts[1]] } ]) {
    const value = lostBody({ type: 'found', images: ['a'.repeat(24)], ...change });
    expect((await mutate(b, 'post', '/api/posts', value)).status).toBe(400);
  }
  expect(await Post.countDocuments()).toBe(0);
});

test('unauthenticated mutations and invalid IDs cannot access or change posts', async () => {
  const b = await browser(); const post = await create(b);
  const anonymous = { ...b, jar: { [cookies.csrf]: b.csrf } };
  expect((await mutate(anonymous, 'post', '/api/posts', lostBody())).status).toBe(401);
  expect((await mutate(anonymous, 'patch', `/api/posts/${post.id}`, { revision: 0, title: 'Attack' })).status).toBe(401);
  expect((await mutate(anonymous, 'delete', `/api/posts/${post.id}`, { revision: 0 })).status).toBe(401);
  expect((await request(app).get('/api/posts/mine')).status).toBe(401);
  expect((await request(app).get('/api/posts/not-an-id')).status).toBe(400);
  expect((await request(app).get(`/api/posts/${'a'.repeat(24)}`)).status).toBe(404);
});

test('IDOR checks forbid another user and admins from owner edit, delete or private details', async () => {
  const a = await browser(), b = await browser(), admin = await browser('admin');
  const post = await create(a);
  for (const attacker of [b, admin]) {
    expect((await authenticated(attacker, 'get', `/api/posts/${post.id}/manage`)).status).toBe(404);
    expect((await mutate(attacker, 'patch', `/api/posts/${post.id}`, { revision: 0, privateDetails: 'Attack' })).status).toBe(404);
    expect((await mutate(attacker, 'delete', `/api/posts/${post.id}`, { revision: 0 })).status).toBe(404);
  }
  expect((await Post.findById(post.id)).deletedAt).toBeNull();
});

test('edits whitelist fields, retain privacy, enforce revisions, and do not renew expiry', async () => {
  const b = await browser(); const post = await create(b);
  const changed = await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, title: 'Updated', privateDetails: 'new private', location: { campusArea: 'North' }, status: 'closed' });
  expect(changed.status).toBe(200); expect(changed.body.post.revision).toBe(1);
  expect(changed.body.post.expiresAt).toBe(post.expiresAt); expect(changed.body.post.item.title).toBe('Updated');
  expect(changed.body.post.item.privateDetails).toBe('new private');
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, title: 'Stale' })).status).toBe(409);
  for (const field of ['author', 'type', 'item', 'expiresAt', 'verificationQuestions']) expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 1, [field]: 'attack' })).status).toBe(400);
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 1, status: 'returned' })).status).toBe(400);
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 1, status: 'open' })).status).toBe(200);
});

test('concurrent edits permit one revision and cannot lose updates', async () => {
  const b = await browser(); const post = await create(b);
  const results = await Promise.all(['One', 'Two'].map(title => mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, title })));
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  const saved = await Item.findById(post.item.id);
  expect(['One', 'Two']).toContain(saved.title); expect((await Post.findById(post.id)).revision).toBe(1);
});

test('pending or returned posts cannot have their distinguishing information edited', async () => {
  const b = await browser(); const post = await create(b);
  for (const status of ['claim_pending', 'returned']) {
    await Post.updateOne({ _id: post.id }, { $set: { status } });
    expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, title: 'Changed' })).status).toBe(409);
  }
});

test('image IDOR and transaction rollback leave no partial posts, items or attachment changes', async () => {
  const a = await browser(), b = await browser();
  const own = await imageId(a), other = await imageId(b);
  const res = await mutate(a, 'post', '/api/posts', lostBody({ images: [own, other] }));
  expect(res.status).toBe(400);
  expect(await Post.countDocuments()).toBe(0); expect(await Item.countDocuments()).toBe(0);
  expect((await Upload.findById(own)).state).toBe('staged');
  expect((await Upload.findById(other)).state).toBe('staged');
  expect((await mutate(a, 'post', '/api/posts', lostBody({ images: ['a'.repeat(24)] }))).status).toBe(400);
});

test('concurrent attempts to attach the same staged image cannot create shared references', async () => {
  const b = await browser(); const id = await imageId(b);
  const value = lostBody({ images: [id] });
  const results = await Promise.all([mutate(b, 'post', '/api/posts', value), mutate(b, 'post', '/api/posts', value)]);
  expect(results.map(r => r.status).sort()).toEqual([201, 400]);
  expect(await Item.countDocuments()).toBe(1); expect(await Post.countDocuments()).toBe(1);
});

test('images attach once; expired uploads, other-post images and deleting images are rejected', async () => {
  const b = await browser(); const id = await imageId(b); await create(b, lostBody({ images: [id] }));
  expect((await mutate(b, 'post', '/api/posts', lostBody({ images: [id] }))).status).toBe(400);
  const expired = await imageId(b);
  await Upload.updateOne({ _id: expired }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  expect((await mutate(b, 'post', '/api/posts', lostBody({ images: [expired] }))).status).toBe(400);
  await Upload.updateOne({ _id: expired }, { $set: { state: 'deleting', expiresAt: new Date(Date.now() + 60000) } });
  expect((await mutate(b, 'post', '/api/posts', lostBody({ images: [expired] }))).status).toBe(400);
});

test('replacing images hides detached files immediately, retains existing images and preserves found minimum', async () => {
  const b = await browser(); const post = await create(b, await foundBody(b));
  const oldId = post.item.images[0].id, replacement = await imageId(b);
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, images: [] })).status).toBe(400);
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, images: [oldId, replacement] })).status).toBe(200);
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 1, images: [replacement] })).status).toBe(200);
  expect((await request(app).get(`/api/uploads/${oldId}`)).status).toBe(404);
  expect((await request(app).get(`/api/uploads/${replacement}`)).status).toBe(200);
  expect((await Upload.findById(oldId)).state).toBe('deleting');
  expect((await mutate(b, 'delete', `/api/uploads/${replacement}`)).status).toBe(404);
});

test('image pipeline verifies content, strips EXIF/GPS/ICC, respects orientation and replaces filenames', async () => {
  expect((await sharp(jpeg).metadata()).exif).toBeDefined();
  const b = await browser();
  const response = await upload(b, jpeg, 'image/jpeg', '../../private-camera-location.jpg');
  expect(response.status).toBe(201);
  const record = await Upload.findById(response.body.image.id);
  expect(record.filename).toMatch(/^[a-f0-9]{48}\.jpg$/);
  expect(JSON.stringify(record)).not.toContain('private-camera');
  const res = await authenticated(b, 'get', response.body.image.url);
  expect(res.status).toBe(200); expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-disposition']).not.toContain('private-camera');
  const meta = await sharp(res.body).metadata();
  expect(meta.width).toBe(40); expect(meta.height).toBe(80);
  for (const field of ['exif', 'icc', 'xmp', 'iptc', 'orientation']) expect(meta[field]).toBeUndefined();
  const stored = await mongoose.connection.db.collection('images.files').findOne({ _id: record._id });
  expect(stored.filename).toBe(record.filename); expect(stored.contentType).toBe('image/jpeg');
  expect(await mongoose.connection.db.collection('images.chunks').countDocuments({ files_id: record._id })).toBeGreaterThan(0);
});

test('staged images are owner-only, published images require a live post, and preview never accepts other owners', async () => {
  const a = await browser(), b = await browser(); const id = await imageId(a);
  expect((await request(app).get(`/api/uploads/${id}`)).status).toBe(404);
  expect((await request(app).get(`/api/uploads/${id}/preview`)).status).toBe(401);
  expect((await authenticated(b, 'get', `/api/uploads/${id}/preview`)).status).toBe(404);
  expect((await mutate(b, 'delete', `/api/uploads/${id}`)).status).toBe(404);
  expect((await authenticated(a, 'get', `/api/uploads/${id}/preview`)).status).toBe(200);
  const post = await create(a, lostBody({ images: [id] }));
  expect((await request(app).get(`/api/uploads/${id}`)).status).toBe(200);
  expect((await authenticated(a, 'get', `/api/uploads/${id}/preview`)).status).toBe(404);
  await Post.updateOne({ _id: post.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  expect((await request(app).get(`/api/uploads/${id}`)).status).toBe(404);
});

test.each([
  ['text/html', Buffer.from('<script>secret()</script>')], ['image/svg+xml', Buffer.from('<svg/>')],
  ['image/gif', Buffer.from('GIF89a')], ['image/png', Buffer.from('not-a-png')],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0])],
])('upload rejects MIME or malformed magic-byte payloads: %s', async (mime, buffer) => {
  const b = await browser(); expect((await upload(b, buffer, mime)).status).toBe(400);
  expect(await Upload.countDocuments()).toBe(0);
});

test('MIME mismatch, oversized bytes, excess files, multipart fields and malformed boundaries are rejected', async () => {
  const b = await browser();
  expect((await upload(b, png, 'image/jpeg')).status).toBe(400);
  expect((await upload(b, Buffer.alloc(MAX_BYTES + 1), 'image/png')).status).toBe(413);
  expect((await authenticated(b, 'post', '/api/uploads').attach('image', png, 'one.png').attach('image', png, 'two.png')).status).toBe(400);
  expect((await authenticated(b, 'post', '/api/uploads').field('owner', 'attack').attach('image', png, 'one.png')).status).toBe(400);
  expect((await authenticated(b, 'post', '/api/uploads').attach('other', png, 'one.png')).status).toBe(400);
  expect((await mutate(b, 'post', '/api/uploads')).status).toBe(400);
  expect((await authenticated(b, 'post', '/api/uploads').set('Content-Type', 'multipart/form-data').send('no-boundary')).status).toBe(400);
  expect(await Upload.countDocuments()).toBe(0);
});

test('multipart uploads require authentication and CSRF before buffering and are not accepted by auth/post endpoints', async () => {
  const b = await browser();
  expect((await request(app).post('/api/uploads').attach('image', png, 'image.png')).status).toBe(403);
  expect((await authenticated({ ...b, jar: { [cookies.csrf]: b.csrf } }, 'post', '/api/uploads').attach('image', png, 'image.png')).status).toBe(401);
  expect((await authenticated(b, 'post', '/api/auth/login').attach('image', png, 'image.png')).status).toBe(415);
  expect((await authenticated(b, 'post', '/api/posts').attach('image', png, 'image.png')).status).toBe(415);
  expect(await Upload.countDocuments()).toBe(0);
});

test('large dimensions are bounded, resize limits output, and WebP is re-encoded to JPEG', async () => {
  const b = await browser();
  // Valid compressed image under the byte limit but above the decoded-pixel budget.
  const bomb = await sharp({ create: { width: 4500, height: 4500, channels: 3, background: 'white' } }).png().toBuffer();
  expect(bomb.length).toBeLessThan(MAX_BYTES);
  expect((await upload(b, bomb)).status).toBe(400);
  const big = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: 'blue' } }).png().toBuffer();
  const res = await upload(b, big);
  expect(res.status).toBe(201); expect(res.body.image.width).toBe(1600); expect(res.body.image.height).toBe(800);
  const webp = await sharp(png).webp().toBuffer();
  const converted = await upload(b, webp, 'image/webp');
  expect(converted.status).toBe(201); expect(converted.body.image.contentType).toBe('image/jpeg');
});

test('search/filter/pagination use public text only and return stable non-overlapping pages', async () => {
  const b = await browser(); const createdAt = new Date('2026-10-01T00:00:00Z');
  for (let i = 0; i < 5; i++) await seed(b, { createdAt, title: `Headphones number ${i}` });
  await seed(b, { title: 'Umbrella', publicDescription: 'An umbrella on campus', category: 'other', type: 'found', dateFoundOrLost: new Date('2026-09-01T00:00:00Z') });
  const first = await request(app).get('/api/posts').query({ q: 'headphones', limit: 2 });
  const second = await request(app).get('/api/posts').query({ q: 'headphones', limit: 2, page: 2 });
  expect(first.status).toBe(200); expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 5, pages: 3 });
  expect(second.body.posts.every(post => !first.body.posts.some(prior => prior.id === post.id))).toBe(true);
  expect(first.body.posts[0].id > first.body.posts[1].id).toBe(true);
  expect((await request(app).get('/api/posts').query({ q: 'quartzprivatezebra' })).body.pagination.total).toBe(0);
  const filtered = await request(app).get('/api/posts').query({ type: 'found', category: 'other', location: 'Library', from: '2026-08-01T00:00:00Z', to: '2026-09-30T23:59:59Z', status: 'open' });
  expect(filtered.status).toBe(200); expect(filtered.body.pagination.total).toBe(1); expect(filtered.body.posts[0].item.title).toBe('Umbrella');
  expect((await request(app).get('/api/posts').query({ location: 'does-not-exist' })).body.pagination.total).toBe(0);
});

test.each(['?limit=51', '?page=0', '?page=10001', '?page=bad', '?type=admin', '?category=bad', '?sort=$where', '?q[$ne]=x', '?%24where=x', '?page=1&page=2', '?from=bad', '?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z'])('query validation rejects unbounded or injected filters: %s', async query => expect((await request(app).get(`/api/posts${query}`)).status).toBe(400));

test('delete requires current revision and immediately hides post, private view, search and attached files', async () => {
  const b = await browser(); const id = await imageId(b); const post = await create(b, lostBody({ images: [id] }));
  expect((await mutate(b, 'delete', `/api/posts/${post.id}`, { revision: 1 })).status).toBe(409);
  expect((await mutate(b, 'delete', `/api/posts/${post.id}`, { revision: 0 })).status).toBe(204);
  expect((await request(app).get(`/api/posts/${post.id}`)).status).toBe(404);
  expect((await authenticated(b, 'get', `/api/posts/${post.id}/manage`)).status).toBe(404);
  expect((await request(app).get(`/api/uploads/${id}`)).status).toBe(404);
  expect((await request(app).get('/api/posts')).body.pagination.total).toBe(0);
  expect((await authenticated(b, 'get', '/api/posts/mine')).body.pagination.total).toBe(0);
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 1, title: 'Resurrection' })).status).toBe(404);
});

test('expiry is enforced before cleanup; cleanup cascades database data and GridFS idempotently', async () => {
  const a = await browser(), b = await browser(); const id = await imageId(a);
  const post = await create(a, lostBody({ images: [id] }));
  const unrelated = await create(b);
  await Claim.create({ post: post.id, claimant: b.user._id, submittedAnswers: ['private', 'answer'] });
  const conversation = await Conversation.create({ post: post.id, participants: [a.user._id, b.user._id] });
  await Message.create({ conversation: conversation._id, sender: b.user._id, body: 'Private message' });
  await Post.updateOne({ _id: post.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  expect((await request(app).get(`/api/posts/${post.id}`)).status).toBe(404);
  expect((await authenticated(a, 'get', '/api/posts/mine')).body.posts).toEqual([]);
  expect((await mutate(a, 'patch', `/api/posts/${post.id}`, { revision: 0, title: 'Expired' })).status).toBe(404);
  expect((await request(app).get(`/api/uploads/${id}`)).status).toBe(404);
  await runPostCleanup({ storage, logger }); await runPostCleanup({ storage, logger });
  expect(await Post.findById(post.id)).toBeNull(); expect(await Item.findById(post.item.id)).toBeNull();
  expect(await Upload.findById(id)).toBeNull(); expect(await Claim.countDocuments()).toBe(0);
  expect(await Conversation.countDocuments()).toBe(0); expect(await Message.countDocuments()).toBe(0);
  expect(await mongoose.connection.db.collection('images.files').countDocuments()).toBe(0);
  expect(await mongoose.connection.db.collection('images.chunks').countDocuments()).toBe(0);
  expect(await Post.findById(unrelated.id)).not.toBeNull();
});

test('abandoned/partial uploads are swept without deleting live staged files', async () => {
  const b = await browser(); const stale = await imageId(b), live = await imageId(b);
  await Upload.updateOne({ _id: stale }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  const partial = await Upload.create({ owner: b.user._id, filename: 'partial.jpg', state: 'writing', expiresAt: new Date(Date.now() - 1) });
  await mongoose.connection.db.collection('images.chunks').insertOne({ files_id: partial._id, n: 0, data: Buffer.from('partial image') });
  await runPostCleanup({ storage, logger });
  expect(await Upload.findById(stale)).toBeNull(); expect(await Upload.findById(partial._id)).toBeNull();
  expect(await Upload.findById(live)).not.toBeNull();
  expect(await mongoose.connection.db.collection('images.chunks').countDocuments({ files_id: partial._id })).toBe(0);
});

test('storage failures preserve cleanup ledger and retry safely after database deletion', async () => {
  const b = await browser(); const id = await imageId(b); const post = await create(b, lostBody({ images: [id] }));
  await mutate(b, 'delete', `/api/posts/${post.id}`, { revision: 0 });
  const failingStorage = { ...storage, remove: async () => { throw new Error('private storage password'); }, sweepOrphans: undefined };
  await runPostCleanup({ storage: failingStorage, logger });
  expect(await Post.findById(post.id)).toBeNull(); expect((await Upload.findById(id)).state).toBe('deleting');
  expect((await request(app).get(`/api/uploads/${id}`)).status).toBe(404);
  expect(JSON.stringify(logger.mock.calls)).not.toContain('private storage password');
  await runPostCleanup({ storage, logger }); expect(await Upload.findById(id)).toBeNull();
});

test('failed GridFS writes do not leave accessible files; deferred rollback survives retry', async () => {
  const faulty = createApp(config, { logger, mailer: { send: async () => {} }, storage: { ...storage, write: async (...args) => { await storage.write(...args); throw new Error('private storage password'); }, remove: async () => { throw new Error('offline'); } } });
  const b = await browser('user', faulty);
  const res = await upload(b);
  expect(res.status).toBe(500); expect(res.text).not.toContain('private storage password');
  const entry = await Upload.findOne({}); expect(entry.state).toBe('deleting');
  expect((await request(app).get(`/api/uploads/${entry._id}`)).status).toBe(404);
  await runPostCleanup({ storage, logger }); expect(await Upload.countDocuments()).toBe(0);
  expect(await mongoose.connection.db.collection('images.files').countDocuments()).toBe(0);
});

test('owner can discard only staged uploads; no original filenames, answers or private details reach logs', async () => {
  const b = await browser(); const id = await imageId(b);
  expect((await mutate(b, 'delete', `/api/uploads/${id}`)).status).toBe(204);
  expect(await Upload.findById(id)).toBeNull();
  const post = await create(b, await foundBody(b));
  const logged = JSON.stringify(logger.mock.calls);
  for (const value of ['private-original', 'quartzprivatezebra', 'Navy', 'BLUE', b.csrf, b.jar[cookies.access]]) expect(logged).not.toContain(value);
  expect(logger).toHaveBeenCalledWith('audit_post_create', expect.objectContaining({ actorId: String(b.user._id) }));
  expect(post.item.images).toHaveLength(1);
});

test('banned authors public posts and attached images are hidden', async () => {
  const b = await browser(); const id = await imageId(b); const post = await create(b, lostBody({ images: [id] }));
  await User.updateOne({ _id: b.user._id }, { $set: { isBanned: true } });
  expect((await request(app).get(`/api/posts/${post.id}`)).status).toBe(404);
  expect((await request(app).get('/api/posts')).body.posts).toEqual([]);
  expect((await request(app).get(`/api/uploads/${id}`)).status).toBe(404);
});

test('animated WebP is rejected rather than silently publishing its first frame', async () => {
  const b = await browser();
  const other = await sharp({ create: { width: 80, height: 40, channels: 4, background: 'blue' } }).png().toBuffer();
  const animation = await sharp([png, other], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  expect((await sharp(animation).metadata()).pages).toBe(2);
  expect((await upload(b, animation, 'image/webp')).status).toBe(400);
  expect(await Upload.countDocuments()).toBe(0);
});

test('upload admission bounds active memory work and releases capacity after completion', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const startedTwice = new Promise(resolve => { started = resolve; });
  let count = 0;
  const blocked = createApp(config, { logger, mailer: { send: async () => {} }, storage: { ...storage, write: async (...args) => { if (++count === 2) started(); await gate; await storage.write(...args); } } });
  const b = await browser('user', blocked);
  const first = upload(b).then(res => res), second = upload(b).then(res => res);
  let timer;
  try {
    await Promise.race([startedTwice, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Upload start timeout')), 10000).unref(); })]);
    const rejected = await upload(b);
    expect(rejected.status).toBe(503); expect(rejected.headers['retry-after']).toBe('1');
  } finally { clearTimeout(timer); release(); await Promise.all([first, second]); }
  expect((await upload(b)).status).toBe(201);
});

test('new post/upload endpoint limits are persistent, independent and enforced before parsing extra uploads', async () => {
  const b = await browser();
  let known = new Set((await RateBucket.find({})).map(row => row._id));
  await imageId(b);
  let bucket = (await RateBucket.find({})).find(row => !known.has(row._id));
  expect(bucket).toBeDefined();
  await RateBucket.updateOne({ _id: bucket._id }, { $set: { count: 20 } });
  expect((await upload(b)).status).toBe(429);
  known = new Set((await RateBucket.find({})).map(row => row._id));
  const post = await create(b);
  bucket = (await RateBucket.find({})).find(row => !known.has(row._id));
  expect(bucket).toBeDefined();
  await RateBucket.updateOne({ _id: bucket._id }, { $set: { count: 30 } });
  expect((await mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, title: 'Limited' })).status).toBe(429);
  known = new Set((await RateBucket.find({})).map(row => row._id));
  expect((await request(app).get('/api/posts')).status).toBe(200);
  bucket = (await RateBucket.find({})).find(row => !known.has(row._id));
  await RateBucket.updateOne({ _id: bucket._id }, { $set: { count: 300 } });
  expect((await request(app).get('/api/posts')).status).toBe(429);
  expect((await authenticated(b, 'get', `/api/posts/${post.id}/manage`)).status).toBe(200);
});

test('orphan GridFS files are swept after a grace period while recent files remain', async () => {
  const old = oid(), recent = oid();
  await storage.write(old, png, 'old.jpg'); await storage.write(recent, png, 'recent.jpg');
  await mongoose.connection.db.collection('images.files').updateOne({ _id: old }, { $set: { uploadDate: new Date(Date.now() - 2 * 86400000) } });
  await runPostCleanup({ storage, logger });
  expect(await storage.read(old)).toBeNull();
  expect(await mongoose.connection.db.collection('images.files').countDocuments({ _id: recent })).toBe(1);
  expect(await mongoose.connection.db.collection('images.chunks').countDocuments({ files_id: old })).toBe(0);
});

test('a missing GridFS file returns generic 404 without leaking storage internals', async () => {
  const b = await browser(); const id = await imageId(b); await create(b, lostBody({ images: [id] }));
  await storage.remove(new mongoose.Types.ObjectId(id));
  const res = await request(app).get(`/api/uploads/${id}`);
  expect(res.status).toBe(404); expect(res.body.error).toBe('Not found');
});

test('orphan chunk reconciliation covers missing files/ledger without touching recent or journaled writes', async () => {
  const b = await browser();
  const old = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - 2 * 86400000) / 1000));
  const journaled = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - 3 * 86400000) / 1000));
  const recent = oid();
  await Upload.create({ _id: journaled, owner: b.user._id, filename: 'partial.jpg', state: 'writing', expiresAt: new Date(Date.now() + 60000) });
  for (const id of [old, journaled, recent]) await mongoose.connection.db.collection('images.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('partial') });
  await runPostCleanup({ storage, logger });
  expect(await mongoose.connection.db.collection('images.chunks').countDocuments({ files_id: old })).toBe(0);
  expect(await mongoose.connection.db.collection('images.chunks').countDocuments({ files_id: journaled })).toBe(1);
  expect(await mongoose.connection.db.collection('images.chunks').countDocuments({ files_id: recent })).toBe(1);
});

test('cleanup racing a revisioned edit/delete never resurrects a removed post or orphan item', async () => {
  const b = await browser(); const post = await create(b);
  const results = await Promise.all([
    mutate(b, 'patch', `/api/posts/${post.id}`, { revision: 0, title: 'Edited' }),
    mutate(b, 'delete', `/api/posts/${post.id}`, { revision: 0 }),
  ]);
  expect(results.filter(res => res.status >= 200 && res.status < 300)).toHaveLength(1);
  expect(results.every(res => [200, 204, 404, 409].includes(res.status))).toBe(true);
  const saved = await Post.findById(post.id);
  if (!saved.deletedAt) expect((await mutate(b, 'delete', `/api/posts/${post.id}`, { revision: saved.revision })).status).toBe(204);
  await Promise.all([runPostCleanup({ storage, logger }), runPostCleanup({ storage, logger })]);
  expect(await Post.findById(post.id)).toBeNull(); expect(await Item.findById(post.item.id)).toBeNull();
});
