const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../src/app');
const models = require('../src/models');
const { User, Post, Item, Claim, Conversation, Message } = models;
const { AuthSession, RateBucket, MailOutbox } = require('../src/models/auth');
const Report = require('../src/models/report');
const Audit = require('../src/models/moderationAudit');
const Upload = require('../src/models/upload');
const Notification = require('../src/models/notification');
const MatchRequest = require('../src/models/matchRequest');
const { hashPassword, mintCsrf, token, hash } = require('../src/lib/authCrypto');
const { hashQuestions } = require('../src/lib/verificationAnswers');
const { createQueuedMailer, deliverOne } = require('../src/lib/mailQueue');
const { cookies } = require('../src/middleware/auth');
const { runPostCleanup } = require('../src/jobs/postCleanup');
const { assertModerationIndexes } = require('../src/config/indexes');
const { withTransaction } = require('../src/lib/transaction');
const { lockActor } = require('../src/lib/lockActor');
jest.setTimeout(120000);
const config = { NODE_ENV: 'test', CLIENT_ORIGIN: 'https://campus.example', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ACCESS_TOKEN_TTL_SECONDS: 900, POST_RETENTION_DAYS: 90 };
const password = 'Campus moderation fixture passphrase 47!';
const allModels = [...Object.values(models), AuthSession, RateBucket, MailOutbox, Report, Audit, Upload, Notification, MatchRequest];
let mongo, app, passwordHash, logger, questions, serial = 0;
const oid = () => new mongoose.Types.ObjectId();
async function actor(overrides = {}) {
  const user = await User.create({ email: `moderation${++serial}@ucf.edu`, passwordHash, displayName: `Knight ${serial}`, emailVerified: true, ...overrides });
  const sid = token(), refresh = token(), csrf = mintCsrf(config.JWT_SECRET);
  await AuthSession.create({ _id: sid, user: user._id, authVersion: 0, currentHash: hash(refresh), expiresAt: new Date(Date.now() + 86400000) });
  const access = jwt.sign({ sid, ver: 0 }, config.JWT_SECRET, { subject: String(user._id), issuer: 'ucf-lost-found', audience: 'ucf-lost-found-api', expiresIn: 900 });
  return { user, csrf, sid, headers: { Origin: config.CLIENT_ORIGIN, Cookie: `${cookies.access}=${access}; ${cookies.csrf}=${csrf}; ${cookies.refresh}=${sid}.${refresh}` } };
}
async function post(owner, type = 'lost') {
  const item = await Item.create({ category: 'other', title: 'Moderated item', publicDescription: '<script>public text</script>', privateDetails: 'private-moderation-sentinel', dateFoundOrLost: new Date() });
  return Post.create({ type, item: item._id, author: owner.user._id, verificationQuestions: type === 'found' ? questions : [], expiresAt: new Date(Date.now() + 86400000) });
}
const get = (who, url) => request(app).get(url).set(who.headers);
const mutate = (who, method, url, body = {}) => request(app)[method](url).set(who.headers).set('X-CSRF-Token', who.csrf).send(body);
const report = (who, p, body = { reason: 'privacy', details: 'Sensitive details on the board.' }) => mutate(who, 'post', `/api/posts/${p._id}/reports`, body);
const remove = (who, body = { password, confirmation: 'DELETE' }) => mutate(who, 'delete', '/api/account', body);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  mongoose.set('sanitizeFilter', true); mongoose.set('strictQuery', true); await mongoose.connect(mongo.getUri());
  await Promise.all(allModels.map(model => model.init()));
  passwordHash = await hashPassword(password);
  questions = await hashQuestions([{ question: 'Private first question?', answer: 'secret-one' }, { question: 'Private second question?', answer: 'secret-two' }]);
  logger = jest.fn(); app = createApp(config, { logger, mailer: { send: async () => {} } });
});
beforeEach(async () => { for (const model of allModels) await model.deleteMany({}); logger.mockClear(); });
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('reports are private, deduplicated and never overwrite the first submission', async () => {
  const owner = await actor(), reporter = await actor(), admin = await actor({ role: 'admin' }), p = await post(owner, 'found');
  const results = await Promise.all([report(reporter, p), report(reporter, p)]); expect(results.map(r => r.status)).toEqual([202, 202]);
  expect((await report(reporter, p, { reason: 'spam', details: 'Changed report content' })).status).toBe(202);
  expect(await Report.countDocuments()).toBe(1);
  const queue = await get(admin, '/api/admin/reports?status=open&limit=1');
  expect(queue.status).toBe(200); expect(queue.body.reports[0].reason).toBe('privacy'); expect(queue.body.pagination.total).toBe(1);
  const output = JSON.stringify(queue.body);
  for (const value of ['@ucf.edu', 'private-moderation-sentinel', 'secret-one', 'answerHash', 'passwordHash', 'verificationQuestions', 'submittedAnswers']) expect(output).not.toContain(value);
  expect((await get(reporter, '/api/admin/reports')).status).toBe(403);
  expect((await get(owner, `/api/posts/${p._id}`)).body.post.reports).toBeUndefined();
});

test('report availability excludes self, missing, expired, deleted and banned-author posts', async () => {
  const owner = await actor(), reporter = await actor(), p = await post(owner);
  expect((await report(owner, p)).status).toBe(404); expect((await report(reporter, { _id: oid() })).status).toBe(404);
  for (const state of [{ expiresAt: new Date(0) }, { expiresAt: new Date(Date.now() + 86400000), deletedAt: new Date() }]) {
    await Post.updateOne({ _id: p._id }, { $set: state }); expect((await report(reporter, p)).status).toBe(404);
  }
  await Post.updateOne({ _id: p._id }, { $set: { deletedAt: null } }); await User.updateOne({ _id: owner.user._id }, { $set: { isBanned: true } });
  expect((await report(reporter, p)).status).toBe(404); expect(await Report.countDocuments()).toBe(0);
});

test('all admin routes require current administrator privileges', async () => {
  const normal = await actor(), admin = await actor({ role: 'admin' }), target = await actor(), p = await post(target); await report(normal, p); const row = await Report.findOne();
  const routes = [['get', '/api/admin/reports', {}], ['get', `/api/admin/users/${target.user._id}`, {}], ['post', `/api/admin/users/${target.user._id}/ban`, {}], ['delete', `/api/admin/posts/${p._id}`, {}], ['patch', `/api/admin/reports/${row._id}`, { revision: 0, status: 'dismissed' }]];
  for (const [method, url, body] of routes) expect((await mutate(normal, method, url, body)).status).toBe(403);
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'user' } });
  expect((await get(admin, '/api/admin/reports')).status).toBe(403);
  expect(await Audit.countDocuments()).toBe(0); expect((await Post.findById(p._id)).deletedAt).toBeNull();
});

test('new mutation routes reject missing CSRF, cross-origin requests and anonymous access', async () => {
  const admin = await actor({ role: 'admin' }), owner = await actor(), p = await post(owner);
  const routes = [['post', `/api/posts/${p._id}/reports`, { reason: 'spam', details: 'Spam report text' }], ['post', `/api/admin/users/${owner.user._id}/ban`, {}], ['delete', `/api/admin/posts/${p._id}`, {}], ['patch', `/api/admin/reports/${oid()}`, { revision: 0, status: 'resolved' }], ['delete', '/api/account', { password, confirmation: 'DELETE' }]];
  for (const [method, url, body] of routes) {
    expect((await request(app)[method](url).set(admin.headers).send(body)).status).toBe(403);
    expect((await mutate({ ...admin, headers: { ...admin.headers, Origin: 'https://attacker.example' } }, method, url, body)).status).toBe(403);
    expect((await mutate({ ...admin, headers: { Origin: config.CLIENT_ORIGIN, Cookie: `${cookies.csrf}=${admin.csrf}` } }, method, url, body)).status).toBe(401);
  }
  expect((await request(app).get('/api/admin/reports')).status).toBe(401);
});

test('strict body, query and identifier validation prevents mass assignment and injection', async () => {
  const admin = await actor({ role: 'admin' }), owner = await actor(), p = await post(owner);
  for (const body of [{ reason: 'unknown', details: 'reason text' }, { reason: 'spam', details: 'x'.repeat(1001) }, { reason: 'spam', details: '    ' }, { reason: 'spam', details: 'valid text', status: 'resolved' }, { reason: { $ne: '' }, details: 'valid text' }]) expect((await report(admin, p, body)).status).toBe(400);
  for (const url of ['/api/admin/reports?limit=1000', '/api/admin/reports?page=0', '/api/admin/reports?status=all', '/api/admin/reports?email=true', '/api/admin/users/not-an-id']) expect((await get(admin, url)).status).toBe(400);
  expect((await mutate(admin, 'post', `/api/admin/users/${owner.user._id}/ban`, { role: 'admin' })).status).toBe(400);
  expect((await mutate(admin, 'delete', `/api/admin/posts/${p._id}`, { author: String(owner.user._id) })).status).toBe(400);
  for (const body of [{ password, confirmation: 'delete' }, { password, confirmation: 'DELETE', userId: String(owner.user._id) }, { password: 'x'.repeat(73), confirmation: 'DELETE' }]) expect((await remove(owner, body)).status).toBe(400);
});

test('report pagination and status filters are bounded and deterministic', async () => {
  const owner = await actor(), admin = await actor({ role: 'admin' }), p = await post(owner);
  for (let i = 0; i < 3; i++) await report(await actor(), p);
  const first = await get(admin, '/api/admin/reports?limit=2'), second = await get(admin, '/api/admin/reports?limit=2&page=2');
  expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 3, pages: 2 });
  expect(new Set([...first.body.reports, ...second.body.reports].map(row => row.id)).size).toBe(3);
  const row = first.body.reports[0]; expect((await mutate(admin, 'patch', `/api/admin/reports/${row.id}`, { revision: row.revision, status: 'dismissed' })).status).toBe(204);
  expect((await get(admin, '/api/admin/reports?status=dismissed')).body.reports).toHaveLength(1);
});

test('concurrent report decisions allow one winner and audit only committed decisions', async () => {
  const owner = await actor(), reporter = await actor(), a = await actor({ role: 'admin' }), b = await actor({ role: 'admin' }), p = await post(owner); await report(reporter, p); const row = await Report.findOne();
  const results = await Promise.all([mutate(a, 'patch', `/api/admin/reports/${row._id}`, { revision: 0, status: 'resolved' }), mutate(b, 'patch', `/api/admin/reports/${row._id}`, { revision: 0, status: 'dismissed' })]);
  expect(results.map(r => r.status).sort()).toEqual([204, 409]); expect(await Audit.countDocuments()).toBe(1);
});

test('administrators remove any post; tombstones immediately hide detail, owner reads and history', async () => {
  const owner = await actor(), reporter = await actor(), admin = await actor({ role: 'admin' }), p = await post(owner); await report(reporter, p);
  expect((await mutate(admin, 'delete', `/api/admin/posts/${p._id}`)).status).toBe(204);
  expect((await get(owner, `/api/posts/${p._id}`)).status).toBe(404); expect((await get(owner, `/api/posts/${p._id}/manage`)).status).toBe(404);
  expect((await Report.findOne()).status).toBe('resolved'); expect((await Audit.findOne()).action).toBe('post_removed');
  expect((await mutate(admin, 'delete', `/api/admin/posts/${p._id}`)).status).toBe(404);
  await runPostCleanup({ storage: { remove: async () => {} }, logger }); expect(await Post.countDocuments()).toBe(0); expect(await Report.countDocuments()).toBe(0);
});

test('audit insertion failure rolls back post removal and report resolution', async () => {
  const owner = await actor(), reporter = await actor(), admin = await actor({ role: 'admin' }), p = await post(owner); await report(reporter, p);
  const spy = jest.spyOn(Audit, 'create').mockRejectedValueOnce(new Error('secret audit backend failure'));
  expect((await mutate(admin, 'delete', `/api/admin/posts/${p._id}`)).status).toBe(500); spy.mockRestore();
  expect((await Post.findById(p._id)).deletedAt).toBeNull(); expect((await Report.findOne()).status).toBe('open'); expect(await Audit.countDocuments()).toBe(0);
  expect(JSON.stringify(logger.mock.calls)).not.toContain('secret audit backend failure');
});

test('banning revokes all families, tokens and public post visibility without exposing email', async () => {
  const admin = await actor({ role: 'admin' }), target = await actor(), p = await post(target);
  await User.updateOne({ _id: target.user._id }, { $set: { resetTokenHash: token(), verificationTokenHash: token() } });
  const userResponse = await get(admin, `/api/admin/users/${target.user._id}`); expect(Object.keys(userResponse.body.user).sort()).toEqual(['displayName', 'id', 'isBanned', 'role']);
  expect((await mutate(admin, 'post', `/api/admin/users/${target.user._id}/ban`)).status).toBe(204);
  expect((await get(target, '/api/auth/me')).status).toBe(401); expect((await mutate(target, 'post', '/api/auth/refresh')).status).toBe(401);
  expect((await mutate(target, 'post', '/api/auth/login', { email: `moderation${serial}@ucf.edu`, password })).status).toBe(401);
  expect((await get(admin, `/api/posts/${p._id}`)).status).toBe(404);
  const current = await User.findById(target.user._id).select('+resetTokenHash +verificationTokenHash +authVersion'); expect(current.authVersion).toBe(1); expect(current.resetTokenHash).toBeUndefined(); expect(current.verificationTokenHash).toBeUndefined();
  expect((await AuthSession.findById(target.sid)).revoked).toBe(true); expect((await Audit.findOne()).action).toBe('user_banned');
});

test('admins cannot ban themselves or other admins and cannot promote users', async () => {
  const a = await actor({ role: 'admin' }), b = await actor({ role: 'admin' });
  for (const target of [a, b]) expect((await mutate(a, 'post', `/api/admin/users/${target.user._id}/ban`)).status).toBe(404);
  expect(await Audit.countDocuments()).toBe(0); expect((await User.findById(a.user._id)).isBanned).toBe(false);
});

test('banning is atomic with revocation and durable audit', async () => {
  const admin = await actor({ role: 'admin' }), target = await actor();
  const spy = jest.spyOn(AuthSession, 'updateMany').mockRejectedValueOnce(new Error('failure'));
  expect((await mutate(admin, 'post', `/api/admin/users/${target.user._id}/ban`)).status).toBe(500); spy.mockRestore();
  expect((await User.findById(target.user._id)).isBanned).toBe(false); expect(await Audit.countDocuments()).toBe(0);
});

test('report, deletion and admin endpoints have separate persistent rate limits', async () => {
  const owner = await actor(), reporter = await actor(), admin = await actor({ role: 'admin' }), p = await post(owner);
  for (let i = 0; i < 10; i++) expect((await report(reporter, p)).status).toBe(202); expect((await report(reporter, p)).status).toBe(429);
  expect((await get(admin, '/api/admin/reports')).status).toBe(200);
  for (let i = 0; i < 5; i++) expect((await remove(owner, { password: 'wrong password', confirmation: 'DELETE' })).status).toBe(401);
  expect((await remove(owner)).status).toBe(429); expect(await User.exists({ _id: owner.user._id })).toBeTruthy();
});

test('account deletion requires the current password and cannot target another account', async () => {
  const owner = await actor(), other = await actor();
  expect((await remove(owner, { password: 'wrong password', confirmation: 'DELETE' })).status).toBe(401);
  expect((await remove(owner, { password, confirmation: 'DELETE', id: String(other.user._id) })).status).toBe(400);
  expect(await User.countDocuments()).toBe(2); expect(await AuthSession.countDocuments()).toBe(2);
});

async function linked(owner, claimant, type = 'found') {
  const p = await post(owner, type);
  let proof;
  if (type === 'found') proof = await Claim.create({ post: p._id, claimant: claimant.user._id, submittedAnswers: ['private submitted one', 'private submitted two'], status: 'approved', verificationPassed: true });
  else proof = await MatchRequest.create({ post: p._id, requester: claimant.user._id, status: 'accepted' });
  const conversation = await Conversation.create({ post: p._id, participants: [owner.user._id, claimant.user._id], [type === 'found' ? 'claim' : 'matchRequest']: proof._id });
  await proof.updateOne({ $set: { conversation: conversation._id } });
  await Post.updateOne({ _id: p._id }, { $set: { status: 'claim_pending', [type === 'found' ? 'approvedClaim' : 'approvedMatch']: proof._id } });
  await Message.create({ conversation: conversation._id, sender: owner.user._id, body: 'private conversation text', sequence: 1 });
  return { p, proof, conversation };
}

test.each(['found', 'lost'])('deleting a claimant removes shared %s conversations and reopens the surviving post', async type => {
  const owner = await actor(), claimant = await actor(), { p, conversation } = await linked(owner, claimant, type);
  expect((await remove(claimant)).status).toBe(204);
  expect(await User.exists({ _id: claimant.user._id })).toBeNull(); expect(await User.exists({ _id: owner.user._id })).toBeTruthy();
  expect(await Message.countDocuments()).toBe(0); expect(await Conversation.countDocuments()).toBe(0); expect(await Claim.countDocuments()).toBe(0); expect(await MatchRequest.countDocuments()).toBe(0);
  const current = await Post.findById(p._id).select('+approvedClaim +approvedMatch'); expect(current.status).toBe('open'); expect(current.approvedClaim).toBeNull(); expect(current.approvedMatch).toBeNull();
  expect((await get(owner, `/api/conversations/${conversation._id}/messages`)).status).toBe(404);
  expect((await get(claimant, '/api/auth/me')).status).toBe(401);
});

test('deleting an author removes credentials, queues, reports, notifications and stages physical image cleanup', async () => {
  const owner = await actor(), claimant = await actor(), { p, proof } = await linked(owner, claimant), admin = await actor({ role: 'admin' });
  await report(claimant, p);
  await Notification.create({ recipient: owner.user._id, post: p._id, claim: proof._id, kind: 'claim_submitted', attemptCount: 1 });
  await createQueuedMailer(config).send({ to: `moderation${serial - 2}@ucf.edu`, subject: 'private subject', text: 'secret mail' });
  // Select the real email directly; public user serialization intentionally redacts it.
  const full = await User.findById(owner.user._id).select('+email');
  await createQueuedMailer(config).send({ to: full.email, subject: 'private subject', text: 'secret mail' });
  const image = await Upload.create({ owner: owner.user._id, post: p._id, filename: 'random.jpg', state: 'attached', expiresAt: new Date(Date.now() + 86400000) });
  await Item.updateOne({ _id: p.item }, { $set: { images: [image._id] } });
  const response = await remove(owner); expect(response.status).toBe(204); expect(response.headers['set-cookie'].filter(value => /Expires=Thu, 01 Jan 1970/.test(value))).toHaveLength(3);
  expect(await AuthSession.exists({ user: owner.user._id })).toBeNull(); expect(await MailOutbox.countDocuments({ recipientHash: hash(full.email) })).toBe(0);
  expect(await Notification.countDocuments()).toBe(0); expect(await Report.countDocuments()).toBe(0); expect((await Upload.findById(image._id)).state).toBe('deleting');
  expect((await get(admin, `/api/posts/${p._id}`)).status).toBe(404); expect((await get(admin, `/api/uploads/${image._id}`)).status).toBe(404);
  const storage = { remove: jest.fn().mockRejectedValueOnce(new Error('temporary storage failure')) };
  await runPostCleanup({ storage, logger }); expect(await Post.countDocuments()).toBe(0); expect(await Item.countDocuments()).toBe(0); expect(await Upload.countDocuments()).toBe(1);
  storage.remove.mockResolvedValue(); await runPostCleanup({ storage, logger }); expect(await Upload.countDocuments()).toBe(0);
  const output = JSON.stringify(logger.mock.calls); for (const secret of [password, full.email, 'private submitted one', 'private conversation text', 'secret mail']) expect(output).not.toContain(secret);
});

test('account deletion failure rolls back erasure and session changes', async () => {
  const owner = await actor(), claimant = await actor(); const { p } = await linked(owner, claimant);
  const spy = jest.spyOn(User, 'deleteOne').mockRejectedValueOnce(new Error('failure'));
  expect((await remove(owner)).status).toBe(500); spy.mockRestore();
  expect(await User.exists({ _id: owner.user._id })).toBeTruthy(); expect(await AuthSession.exists({ user: owner.user._id })).toBeTruthy();
  expect((await Post.findById(p._id)).deletedAt).toBeNull(); expect(await Message.countDocuments()).toBe(1); expect(await Claim.countDocuments()).toBe(1);
});

test('deletion preserves unrelated users, reports and conversations and keeps returned items returned', async () => {
  const owner = await actor(), deleting = await actor(), other = await actor(), fourth = await actor();
  const removed = await linked(owner, deleting), unrelated = await linked(other, fourth);
  await Post.updateOne({ _id: removed.p._id }, { $set: { status: 'returned' } });
  await report(deleting, unrelated.p); await report(owner, unrelated.p);
  expect((await remove(deleting)).status).toBe(204);
  const kept = await Post.findById(removed.p._id).select('+approvedClaim'); expect(kept.status).toBe('returned'); expect(kept.approvedClaim).toBeNull();
  expect(await Report.countDocuments()).toBe(1); expect((await Report.findOne()).reporter.toString()).toBe(String(owner.user._id));
  expect(await Conversation.countDocuments()).toBe(1); expect((await Conversation.findOne())._id.toString()).toBe(String(unrelated.conversation._id));
  expect(await Message.countDocuments()).toBe(1); expect(await Claim.countDocuments()).toBe(1); expect(await User.countDocuments()).toBe(3);
});

test('concurrent account deletion and post creation leave no live orphan', async () => {
  const owner = await actor();
  const body = { type: 'lost', category: 'other', title: 'Race item', publicDescription: 'Race item description', location: { campusArea: 'Main Campus' }, dateFoundOrLost: new Date().toISOString(), images: [] };
  const [deleted, created] = await Promise.all([remove(owner), mutate(owner, 'post', '/api/posts', body)]);
  expect(deleted.status).toBe(204); expect([201, 401]).toContain(created.status);
  expect(await Post.countDocuments({ author: owner.user._id, deletedAt: null })).toBe(0); expect(await User.exists({ _id: owner.user._id })).toBeNull();
});

test('transaction actor fence rejects a stale role or credential version after authentication', async () => {
  const admin = await actor({ role: 'admin' });
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'user' } });
  await expect(withTransaction(session => lockActor(session, admin.user, 0))).rejects.toMatchObject({ authStatus: 401 });
  await User.updateOne({ _id: admin.user._id }, { $set: { role: 'admin', authVersion: 1 } });
  await expect(withTransaction(session => lockActor(session, admin.user, 0))).rejects.toMatchObject({ authStatus: 401 });
});

test('a login using a pre-deletion account snapshot cannot recreate a session after deletion', async () => {
  const owner = await actor(), full = await User.findById(owner.user._id).select('+email');
  let reached, release;
  const checkpoint = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const original = User.findOne;
  const spy = jest.spyOn(User, 'findOne').mockImplementation(function(...args) {
    const query = original.apply(this, args);
    if (args[0].email) {
      const exec = query.exec.bind(query);
      query.exec = async () => { const result = await exec(); reached(); await gate; return result; };
    }
    return query;
  });
  const login = mutate(owner, 'post', '/api/auth/login', { email: full.email, password }).then(result => result);
  try {
    await checkpoint; expect((await remove(owner)).status).toBe(204); release(); expect((await login).status).toBe(401);
    expect(await AuthSession.countDocuments({ user: owner.user._id })).toBe(0);
  } finally { release(); spy.mockRestore(); }
});

test('queued mail is bound to a live recipient and concurrent deletion leaves no new envelope', async () => {
  const owner = await actor(), full = await User.findById(owner.user._id).select('+email');
  const mailer = createQueuedMailer(config), message = { to: full.email, subject: 'Account link', text: 'private mail token text' };
  const [, response] = await Promise.all([mailer.send(message, { userId: owner.user._id }), remove(owner)]);
  expect(response.status).toBe(204); expect(await MailOutbox.countDocuments()).toBe(0);
  await mailer.send(message, { userId: owner.user._id }); expect(await MailOutbox.countDocuments()).toBe(0);
});

test('the mail worker discards recipient-bound mail after a ban without sending it', async () => {
  const owner = await actor(), full = await User.findById(owner.user._id).select('+email');
  await createQueuedMailer(config).send({ to: full.email, subject: 'Account link', text: 'private link' }, { userId: owner.user._id });
  await User.updateOne({ _id: owner.user._id }, { $set: { isBanned: true } });
  const transport = { send: jest.fn() };
  expect(await deliverOne(config, { transport, logger })).toBe(true); expect(transport.send).not.toHaveBeenCalled(); expect(await MailOutbox.countDocuments()).toBe(0);
});

test('required unique report index is provisioned and checked', async () => {
  await expect(assertModerationIndexes()).resolves.toBeUndefined();
  const owner = await actor(), reporter = await actor(), p = await post(owner); await report(reporter, p);
  await expect(Report.create({ post: p._id, reporter: reporter.user._id, reason: 'spam', details: 'duplicate text' })).rejects.toMatchObject({ code: 11000 });
});
