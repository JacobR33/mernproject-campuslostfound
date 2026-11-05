const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../src/app');
const { User, Post, Item, Claim, Conversation, Message } = require('../src/models');
const Notification = require('../src/models/notification');
const { AuthSession, RateBucket } = require('../src/models/auth');
const { hashPassword, token } = require('../src/lib/authCrypto');
const { hashQuestions } = require('../src/lib/verificationAnswers');
const { cookies } = require('../src/middleware/auth');
const { assertClaimIndexes } = require('../src/config/indexes');
const { runPostCleanup } = require('../src/jobs/postCleanup');

jest.setTimeout(120000);
const config = { NODE_ENV: 'test', CLIENT_ORIGIN: 'https://campus.example', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ACCESS_TOKEN_TTL_SECONDS: 900, POST_RETENTION_DAYS: 90 };
const canonical = ['Silver griffin badge', 'Pocket #73'];
const questions = [{ question: 'Describe a hidden marking', answer: canonical[0] }, { question: 'Which pocket is numbered?', answer: canonical[1] }];
const cookieHeader = jar => Object.entries(jar).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
let mongo, app, logger, hashed, baseHash, serial = 0;
const oid = () => new mongoose.Types.ObjectId();
async function browser(role = 'user', overrides = {}) {
  const user = await User.create({ email: `claim-user${++serial}@ucf.edu`, displayName: `Knight ${serial}`, passwordHash: baseHash, emailVerified: true, role, ...overrides });
  const sid = token();
  await AuthSession.create({ _id: sid, user: user._id, authVersion: 0, currentHash: token(), expiresAt: new Date(Date.now() + 86400000) });
  const response = await request(app).get('/api/auth/csrf'); expect(response.status).toBe(200);
  const csrf = response.body.csrfToken;
  const access = jwt.sign({ ver: 0, sid }, config.JWT_SECRET, { algorithm: 'HS256', subject: String(user._id), issuer: 'ucf-lost-found', audience: 'ucf-lost-found-api', expiresIn: 900 });
  return { user, csrf, jar: { [cookies.csrf]: csrf, [cookies.access]: access } };
}
const auth = (b, method, path) => request(app)[method](path).set('Cookie', cookieHeader(b.jar)).set('Origin', config.CLIENT_ORIGIN).set('X-CSRF-Token', b.csrf);
const mutate = (b, method, path, body = {}) => auth(b, method, path).send(body);
async function found(finder, overrides = {}) {
  const item = await Item.create({ category: 'bags', title: 'Found campus bag', publicDescription: 'A bag was found on campus', privateDetails: 'finder-private-sentinel', dateFoundOrLost: new Date('2026-10-01T00:00:00Z'), locationFound: { campusArea: 'Main' } });
  return Post.create({ type: 'found', item: item._id, author: finder.user._id, verificationQuestions: hashed.map(q => ({ ...q, _id: oid() })), expiresAt: new Date(Date.now() + 86400000), ...overrides });
}
const submission = (post, values = canonical) => ({ answers: post.verificationQuestions.map((q, i) => ({ questionId: String(q._id), answer: values[i] })) });
const submit = (claimant, post, values) => mutate(claimant, 'post', `/api/posts/${post._id}/claims`, submission(post, values));
async function pending(claimant, post, values) { const res = await submit(claimant, post, values); expect(res.status).toBe(202); return res.body.claim; }
const decide = (finder, post, claim, decision = 'approve', attemptCount = claim.attemptCount) => mutate(finder, 'post', `/api/posts/${post._id}/claims/${claim.id}/decision`, { decision, attemptCount });
function expectNoSecrets(response) {
  const text = response.text;
  expect(text).not.toMatch(/answerHash|answerSalt|passwordHash|authVersion|@ucf\.edu|finder-private-sentinel|approvedClaim/);
  for (const q of hashed) { expect(text).not.toContain(q.answerHash); expect(text).not.toContain(q.answerSalt); }
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  mongoose.set('sanitizeFilter', true); mongoose.set('strictQuery', true);
  await mongoose.connect(mongo.getUri());
  await Promise.all([User, Post, Item, Claim, Conversation, Message, Notification, AuthSession, RateBucket].map(model => model.init()));
  logger = jest.fn(); app = createApp(config, { logger, mailer: { send: async () => {} } });
  hashed = await hashQuestions(questions); baseHash = await hashPassword('Campus claim testing passphrase!');
});
beforeEach(async () => {
  for (const model of [Notification, Message, Conversation, Claim, Post, Item, AuthSession, RateBucket, User]) await model.deleteMany({});
  logger.mockClear();
});
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('normalization compares all answers and sends generic pending responses with an atomic finder notification', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const res = await submit(claimant, post, ['  SILVER  griffin\t badge  ', '  pocket   #73 ']);
  expect(res.status).toBe(202); expectNoSecrets(res);
  expect(res.body.claim).toMatchObject({ status: 'pending', attemptCount: 1, conversationId: null });
  expect(res.text).not.toMatch(/submittedAnswers|verificationPassed|SILVER|pocket/);
  const stored = await Claim.findById(res.body.claim.id).select('+verificationPassed +submittedAnswers');
  expect(stored.verificationPassed).toBe(true); expect(stored.submittedAnswers[0]).toBe('  SILVER  griffin\t badge  ');
  expect(await Conversation.countDocuments()).toBe(0);
  expect((await Post.findById(post._id)).status).toBe('claim_pending');
  const notification = await Notification.findOne({ recipient: finder.user._id });
  expect(notification).toMatchObject({ kind: 'claim_submitted', attemptCount: 1 });
  expect(String(notification.claim)).toBe(res.body.claim.id);
  const review = await auth(finder, 'get', `/api/posts/${post._id}/claims/${stored._id}`);
  expect(review.status).toBe(200); expectNoSecrets(review);
  expect(review.body.claim.verificationPassed).toBe(true);
  expect(review.body.claim.submittedAnswers[0].answer).toBe('  SILVER  griffin\t badge  ');
});

test('mismatching answers have no success oracle and cannot be approved even by the finder', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const res = await submit(claimant, post, ['wrong-sentinel-one', 'wrong-sentinel-two']);
  expect(res.status).toBe(202); expect(res.body.claim.status).toBe('pending');
  expectNoSecrets(res); expect(res.text).not.toMatch(/wrong-sentinel|verificationPassed|matches|correct/);
  const claim = res.body.claim;
  const review = await auth(finder, 'get', `/api/posts/${post._id}/claims/${claim.id}`);
  expect(review.body.claim.verificationPassed).toBe(false);
  expect(review.body.claim.submittedAnswers.map(v => v.answer)).toEqual(['wrong-sentinel-one', 'wrong-sentinel-two']);
  for (const answer of canonical) expect(review.text).not.toContain(answer);
  expect((await decide(finder, post, claim)).status).toBe(409);
  expect((await Claim.findById(claim.id)).status).toBe('pending'); expect(await Conversation.countDocuments()).toBe(0);
});

test('partial matches do not reveal question-level results and still fail approval', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const claim = await pending(claimant, post, [canonical[0], 'incorrect']);
  const res = await auth(finder, 'get', `/api/posts/${post._id}/claims/${claim.id}`);
  expect(res.body.claim.verificationPassed).toBe(false);
  expect(res.text).not.toMatch(/answerHash|answerSalt|matchedQuestions|matchCount/);
  expect((await decide(finder, post, claim)).status).toBe(409);
});

test('question IDs are mapped explicitly so client ordering cannot swap answers', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const value = submission(post); value.answers.reverse();
  const res = await mutate(claimant, 'post', `/api/posts/${post._id}/claims`, value);
  expect(res.status).toBe(202);
  const stored = await Claim.findById(res.body.claim.id).select('+verificationPassed +submittedAnswers');
  expect(stored.verificationPassed).toBe(true); expect([...stored.submittedAnswers]).toEqual(canonical);
});

test('exactly three lifetime attempts persist through pending resubmission and finder denial', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const first = await pending(claimant, post, ['wrong1', 'wrong2']);
  const second = await pending(claimant, post, ['wrong3', 'wrong4']);
  expect(second.id).toBe(first.id); expect(second.attemptCount).toBe(2);
  expect((await decide(finder, post, second, 'deny')).status).toBe(200);
  const third = await pending(claimant, post);
  expect(third.attemptCount).toBe(3); expect(third.status).toBe('pending');
  expect((await submit(claimant, post)).status).toBe(429);
  expect(await Claim.countDocuments()).toBe(1); expect((await Claim.findById(third.id)).attemptCount).toBe(3);
  expect(await Notification.countDocuments({ recipient: finder.user._id, kind: 'claim_submitted' })).toBe(3);
  expect((await decide(finder, post, third)).status).toBe(200);
});

test('concurrent submissions cannot exceed three attempts, duplicate claim rows, or reset the counter', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const responses = await Promise.all(Array.from({ length: 6 }, () => submit(claimant, post, ['not right', 'also wrong'])));
  expect(responses.filter(r => r.status === 202)).toHaveLength(3);
  expect(responses.filter(r => r.status === 429)).toHaveLength(3);
  expect(await Claim.countDocuments({ post: post._id, claimant: claimant.user._id })).toBe(1);
  const claim = await Claim.findOne({ post: post._id, claimant: claimant.user._id });
  expect(claim.attemptCount).toBe(3);
  expect(await Notification.countDocuments({ kind: 'claim_submitted' })).toBe(3);
  expect((await Post.findById(post._id)).revision).toBe(3);
});

test('attempt budgets are isolated by user and by post', async () => {
  const finder = await browser(), a = await browser(), b = await browser(); const one = await found(finder), two = await found(finder);
  for (let i = 0; i < 3; i++) await pending(a, one);
  expect((await submit(a, one)).status).toBe(429);
  expect((await submit(a, two)).status).toBe(202); expect((await submit(b, one)).status).toBe(202);
  expect(await Claim.countDocuments()).toBe(3);
});

test('finder denial reopens only when no other pending claim exists and never creates a conversation', async () => {
  const finder = await browser(), a = await browser(), b = await browser(); const post = await found(finder);
  const first = await pending(a, post), second = await pending(b, post);
  expect((await decide(finder, post, first, 'deny')).status).toBe(200);
  expect((await Post.findById(post._id)).status).toBe('claim_pending');
  expect((await decide(finder, post, second, 'deny')).status).toBe(200);
  expect((await Post.findById(post._id)).status).toBe('open'); expect(await Conversation.countDocuments()).toBe(0);
  expect(await Notification.countDocuments({ kind: 'claim_denied' })).toBe(2);
});

test('approval atomically reserves the post, resolves competitors and creates exactly the server-selected conversation', async () => {
  const finder = await browser(), a = await browser(), b = await browser(); const post = await found(finder);
  const approved = await pending(a, post), other = await pending(b, post);
  const res = await decide(finder, post, approved); expect(res.status).toBe(200); expectNoSecrets(res);
  const conversation = await Conversation.findOne({ post: post._id });
  expect(conversation.participants.map(String)).toEqual([String(finder.user._id), String(a.user._id)]);
  expect(String(conversation.claim)).toBe(approved.id); expect(res.body.claim.conversationId).toBe(String(conversation._id));
  expect((await Claim.findById(other.id)).status).toBe('denied');
  expect((await submit(b, post)).status).toBe(404);
  expect((await request(app).get(`/api/posts/${post._id}`)).body.post.acceptingClaims).toBe(false);
  expect((await auth(finder, 'get', `/api/posts/${post._id}/manage`)).body.post.acceptingClaims).toBe(false);
  expect((await request(app).get('/api/posts')).body.posts[0].acceptingClaims).toBe(false);
  const mine = await auth(a, 'get', '/api/claims/mine');
  expect(mine.body.claims[0].conversationId).toBe(String(conversation._id)); expectNoSecrets(mine);
  expect((await auth(b, 'get', '/api/claims/mine')).body.claims[0].conversationId).toBeNull();
  expect(await Notification.countDocuments({ recipient: a.user._id, kind: 'claim_approved' })).toBe(1);
  expect((await Post.findById(post._id)).status).toBe('claim_pending');
});

test('repeated/concurrent approvals cannot create duplicate conversations or decision notifications', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post);
  const results = await Promise.all([decide(finder, post, claim), decide(finder, post, claim)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await Conversation.countDocuments()).toBe(1); expect(await Notification.countDocuments({ kind: 'claim_approved' })).toBe(1);
  expect((await decide(finder, post, claim)).status).toBe(409);
});

test('concurrent approvals for different claimants choose one winner only', async () => {
  const finder = await browser(), a = await browser(), b = await browser(); const post = await found(finder);
  const one = await pending(a, post), two = await pending(b, post);
  const responses = await Promise.all([decide(finder, post, one), decide(finder, post, two)]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await Conversation.countDocuments()).toBe(1); expect(await Claim.countDocuments({ status: 'approved' })).toBe(1);
  expect(await Claim.countDocuments({ status: 'denied' })).toBe(1);
});

test('resubmission makes stale finder decisions conflict rather than approving unseen answers', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const first = await pending(claimant, post); const second = await pending(claimant, post, ['changed', 'incorrect']);
  expect((await decide(finder, post, first)).status).toBe(409);
  expect((await decide(finder, post, second)).status).toBe(409);
  expect(await Conversation.countDocuments()).toBe(0);
  const review = await auth(finder, 'get', `/api/posts/${post._id}/claims/${first.id}`);
  expect(review.body.claim.attemptCount).toBe(2); expect(review.body.claim.submittedAnswers[0].answer).toBe('changed');
});

test('denial and approval racing the same attempt produce exactly one decision', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post);
  const responses = await Promise.all([decide(finder, post, claim), decide(finder, post, claim, 'deny')]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const stored = await Claim.findById(claim.id);
  expect(await Conversation.countDocuments()).toBe(stored.status === 'approved' ? 1 : 0);
  expect(await Notification.countDocuments({ kind: mongoose.trusted({ $in: ['claim_approved', 'claim_denied'] }) })).toBe(1);
});

test('claimant/finder/admin IDOR cannot read submitted answers, other claims or make decisions', async () => {
  const finder = await browser(), claimant = await browser(), stranger = await browser(), admin = await browser('admin');
  const post = await found(finder); const claim = await pending(claimant, post, ['private-submission-one', 'private-submission-two']);
  for (const actor of [claimant, stranger, admin]) {
    const list = await auth(actor, 'get', `/api/posts/${post._id}/claims`); expect(list.status).toBe(404); expectNoSecrets(list);
    expect((await auth(actor, 'get', `/api/posts/${post._id}/claims/${claim.id}`)).status).toBe(404);
    expect((await decide(actor, post, claim)).status).toBe(404);
  }
  for (const actor of [finder, stranger, admin]) expect((await auth(actor, 'get', `/api/claims/${claim.id}`)).status).toBe(404);
  for (const path of ['/api/claims/mine', `/api/claims/${claim.id}`]) {
    const own = await auth(claimant, 'get', path); expect(own.status).toBe(200); expectNoSecrets(own);
    expect(own.text).not.toMatch(/private-submission|verificationPassed|submittedAnswers/);
  }
  expect((await auth(stranger, 'get', '/api/claims/mine')).body.claims).toEqual([]);
});

test('claim IDs cannot be transplanted to another finder post', async () => {
  const finder = await browser(), claimant = await browser(); const one = await found(finder), two = await found(finder); const claim = await pending(claimant, one);
  expect((await decide(finder, two, claim)).status).toBe(404);
  expect((await auth(finder, 'get', `/api/posts/${two._id}/claims/${claim.id}`)).status).toBe(404);
  expect((await Post.findById(two._id)).revision).toBe(0); expect(await Conversation.countDocuments()).toBe(0);
});

test('owners cannot claim their own found posts and lost/closed/returned posts cannot accept claims', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  expect((await submit(finder, post)).status).toBe(404);
  for (const status of ['closed', 'returned']) { await Post.updateOne({ _id: post._id }, { $set: { status } }); expect((await submit(claimant, post)).status).toBe(404); }
  await Post.updateOne({ _id: post._id }, { $set: { type: 'lost', status: 'open', verificationQuestions: [] } });
  expect((await submit(claimant, post)).status).toBe(404); expect(await Claim.countDocuments()).toBe(0);
});

test('three verification questions are required exactly and checked in full', async () => {
  const finder = await browser(), claimant = await browser();
  const three = await hashQuestions([...questions, { question: 'What is written inside?', answer: 'secret third marker' }]);
  const post = await found(finder, { verificationQuestions: three });
  expect((await mutate(claimant, 'post', `/api/posts/${post._id}/claims`, { answers: submission(post, [...canonical, 'wrong']).answers.slice(0, 2) })).status).toBe(400);
  const claim = await pending(claimant, post, [...canonical, 'wrong']);
  expect((await decide(finder, post, claim)).status).toBe(409);
  const second = await pending(claimant, post, [...canonical, ' SECRET   third marker ']);
  expect((await decide(finder, post, second)).status).toBe(200);
});

test.each([
  { answers: [] }, { answers: [{ questionId: 'a'.repeat(24), answer: 'test' }] },
  { status: 'approved' }, { attemptCount: 0 }, { verificationPassed: true },
  { claimant: 'a'.repeat(24) }, { post: 'a'.repeat(24) }, { conversation: 'a'.repeat(24) },
])('claim submission whitelists all inputs: %j', async override => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const res = await mutate(claimant, 'post', `/api/posts/${post._id}/claims`, { ...submission(post), ...override });
  expect(res.status).toBe(400); expect(await Claim.countDocuments()).toBe(0); expect((await Post.findById(post._id)).revision).toBe(0);
});

test('duplicate/foreign question IDs, blank/oversized answers and extra answer fields reject without consuming attempts', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const basic = submission(post).answers;
  for (const answers of [
    [basic[0], basic[0]], [basic[0], { ...basic[1], questionId: String(oid()) }],
    [{ ...basic[0], answer: '  \n  ' }, basic[1]], [{ ...basic[0], answer: 'x'.repeat(501) }, basic[1]],
    [{ ...basic[0], answerHash: token() }, basic[1]], [...basic, basic[0], basic[1]],
  ]) expect((await mutate(claimant, 'post', `/api/posts/${post._id}/claims`, { answers })).status).toBe(400);
  expect(await Claim.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
  expect((await Post.findById(post._id)).status).toBe('open');
});

test('decision bodies reject client-selected participants, status, verification result and stale/invalid counters', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post);
  for (const override of [{ participants: [String(finder.user._id), String(claimant.user._id)] }, { status: 'approved' }, { verificationPassed: true }, { attemptCount: 0 }, { decision: 'return' }]) {
    expect((await mutate(finder, 'post', `/api/posts/${post._id}/claims/${claim.id}/decision`, { decision: 'approve', attemptCount: 1, ...override })).status).toBe(400);
  }
  expect((await decide(finder, post, claim, 'approve', 2)).status).toBe(409); expect(await Conversation.countDocuments()).toBe(0);
});

test('claim reads, submissions and decisions require verified non-banned authentication and CSRF', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  expect((await request(app).post(`/api/posts/${post._id}/claims`).send(submission(post))).status).toBe(403);
  const anonymous = { ...claimant, jar: { [cookies.csrf]: claimant.csrf } };
  expect((await submit(anonymous, post)).status).toBe(401);
  expect((await request(app).get(`/api/posts/${post._id}/claims`)).status).toBe(401);
  expect((await request(app).get('/api/claims/mine')).status).toBe(401);
  await User.updateOne({ _id: claimant.user._id }, { $set: { emailVerified: false } });
  expect((await submit(claimant, post)).status).toBe(401);
  await User.updateOne({ _id: claimant.user._id }, { $set: { emailVerified: true, isBanned: true } });
  expect((await submit(claimant, post)).status).toBe(401);
});

test('banned authors cannot receive claims and banned claimants cannot be approved', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post);
  await User.updateOne({ _id: claimant.user._id }, { $set: { isBanned: true } });
  expect((await decide(finder, post, claim)).status).toBe(409);
  expect((await decide(finder, post, claim, 'deny')).status).toBe(200);
  await User.updateOne({ _id: claimant.user._id }, { $set: { isBanned: false } });
  await User.updateOne({ _id: finder.user._id }, { $set: { isBanned: true } });
  expect((await submit(claimant, post)).status).toBe(404);
  expect((await auth(claimant, 'get', `/api/claims/${claim.id}`)).status).toBe(404);
});

test('finder notifications are recipient-scoped, paginated, safe, and read state is idempotent', async () => {
  const finder = await browser(), claimant = await browser(), stranger = await browser(), admin = await browser('admin'); const post = await found(finder);
  const first = await pending(claimant, post, ['submitted-private-one', 'submitted-private-two']); await pending(claimant, post);
  const res = await auth(finder, 'get', '/api/notifications').query({ limit: 1 });
  expect(res.status).toBe(200); expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 2, pages: 2 }); expectNoSecrets(res);
  expect(res.text).not.toMatch(/submitted-private|submittedAnswers|verificationPassed/);
  const note = res.body.notifications[0]; expect(note.kind).toBe('claim_submitted'); expect(note.claimId).toBe(first.id);
  for (const actor of [claimant, stranger, admin]) {
    expect((await auth(actor, 'get', '/api/notifications')).body.notifications).toEqual([]);
    expect((await mutate(actor, 'patch', `/api/notifications/${note.id}/read`)).status).toBe(404);
  }
  expect((await request(app).patch(`/api/notifications/${note.id}/read`).send({})).status).toBe(403);
  expect((await mutate(finder, 'patch', `/api/notifications/${note.id}/read`)).status).toBe(204);
  const timestamp = (await Notification.findById(note.id)).readAt;
  expect((await mutate(finder, 'patch', `/api/notifications/${note.id}/read`)).status).toBe(204);
  expect((await Notification.findById(note.id)).readAt).toEqual(timestamp);
  expect((await auth(finder, 'get', '/api/notifications').query({ unread: 'true' })).body.pagination.total).toBe(1);
});

test('My Claims and finder lists are paginated, status-filtered and private', async () => {
  const finder = await browser(), claimant = await browser();
  const one = await found(finder), two = await found(finder), three = await found(finder);
  const first = await pending(claimant, one); await pending(claimant, two); await pending(claimant, three);
  await decide(finder, one, first, 'deny');
  const list = await auth(claimant, 'get', '/api/claims/mine').query({ limit: 1 });
  expect(list.status).toBe(200); expect(list.body.pagination.total).toBe(3); expect(list.body.claims).toHaveLength(1); expectNoSecrets(list);
  const next = await auth(claimant, 'get', '/api/claims/mine').query({ limit: 1, page: 2 });
  expect(next.body.claims[0].id).not.toBe(list.body.claims[0].id);
  expect((await auth(claimant, 'get', '/api/claims/mine').query({ status: 'denied' })).body.pagination.total).toBe(1);
  const review = await auth(finder, 'get', `/api/posts/${one._id}/claims`).query({ status: 'denied', limit: 1 });
  expect(review.status).toBe(200); expect(review.body.claims[0].claimant.id).toBe(String(claimant.user._id)); expectNoSecrets(review);
});

test.each(['?limit=51', '?page=0', '?page=10001', '?claimant=x', '?status=admin', '?page=1&page=2', '?%24where=attack'])('claim query rejects unexpected or unbounded inputs: %s', async query => {
  const actor = await browser(); expect((await auth(actor, 'get', `/api/claims/mine${query}`)).status).toBe(400);
});

test('notification/body/params validation rejects injection and malformed IDs on every new route', async () => {
  const actor = await browser();
  for (const path of ['/api/claims/not-an-id', '/api/posts/not-an-id/claims', '/api/posts/not-an-id/claims/not-an-id', '/api/notifications?unread=maybe', '/api/notifications?limit=51']) expect((await auth(actor, 'get', path)).status).toBe(400);
  expect((await mutate(actor, 'patch', '/api/notifications/not-an-id/read')).status).toBe(400);
  expect((await mutate(actor, 'patch', `/api/notifications/${oid()}/read`, { recipient: String(actor.user._id) })).status).toBe(400);
});

test('notification failure rolls back claim, counter, post status and revision', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const spy = jest.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('private database credential'));
  try {
    const res = await submit(claimant, post); expect(res.status).toBe(500); expect(res.text).not.toContain('private database credential');
  } finally { spy.mockRestore(); }
  expect(await Claim.countDocuments()).toBe(0); expect(await Conversation.countDocuments()).toBe(0);
  expect((await Post.findById(post._id)).status).toBe('open'); expect((await Post.findById(post._id)).revision).toBe(0);
  expect((await submit(claimant, post)).body.claim.attemptCount).toBe(1);
});

test('approval notification failure rolls back the conversation, competing denials and reservation', async () => {
  const finder = await browser(), a = await browser(), b = await browser(); const post = await found(finder);
  const one = await pending(a, post), two = await pending(b, post);
  const spy = jest.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('private storage secret'));
  try { expect((await decide(finder, post, one)).status).toBe(500); } finally { spy.mockRestore(); }
  expect(await Conversation.countDocuments()).toBe(0); expect((await Claim.findById(one.id)).status).toBe('pending'); expect((await Claim.findById(two.id)).status).toBe('pending');
  expect((await Post.findById(post._id).select('+approvedClaim')).approvedClaim).toBeNull();
  expect((await decide(finder, post, one)).status).toBe(200);
});

test('return confirmation requires finder, an approved conversation and current revision', async () => {
  const finder = await browser(), claimant = await browser(), stranger = await browser(); const post = await found(finder);
  expect((await mutate(finder, 'post', `/api/posts/${post._id}/return`, { revision: 0 })).status).toBe(409);
  const claim = await pending(claimant, post); const approved = await decide(finder, post, claim); expect(approved.status).toBe(200);
  const revision = approved.body.postRevision;
  expect((await mutate(claimant, 'post', `/api/posts/${post._id}/return`, { revision })).status).toBe(404);
  expect((await mutate(stranger, 'post', `/api/posts/${post._id}/return`, { revision })).status).toBe(404);
  expect((await mutate(finder, 'post', `/api/posts/${post._id}/return`, { revision: 0 })).status).toBe(409);
  expect((await mutate(finder, 'post', `/api/posts/${post._id}/return`, { revision })).status).toBe(204);
  expect((await Post.findById(post._id)).status).toBe('returned'); expect(await Conversation.countDocuments()).toBe(1);
  expect((await submit(stranger, post)).status).toBe(404);
});

test('deletion/expiry hides claims, review and notifications before cascade; cleanup removes sensitive dependencies', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post); await decide(finder, post, claim);
  const conversation = await Conversation.findOne({ post: post._id }); await Message.create({ conversation: conversation._id, sender: claimant.user._id, body: 'private chat fixture' });
  const note = await Notification.findOne({ recipient: finder.user._id });
  await Post.updateOne({ _id: post._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  expect((await submit(claimant, post)).status).toBe(404);
  expect((await auth(claimant, 'get', `/api/claims/${claim.id}`)).status).toBe(404);
  expect((await auth(claimant, 'get', '/api/claims/mine')).body.claims).toEqual([]);
  expect((await auth(finder, 'get', `/api/posts/${post._id}/claims`)).status).toBe(404);
  expect((await auth(finder, 'get', '/api/notifications')).body.notifications).toEqual([]);
  expect((await mutate(finder, 'patch', `/api/notifications/${note._id}/read`)).status).toBe(404);
  await runPostCleanup({ logger, storage: { remove: async () => {} } });
  for (const model of [Claim, Notification, Conversation, Message, Post, Item]) expect(await model.countDocuments()).toBe(0);
});

test('claim submission racing finder deletion never leaves a claim or notification after cleanup', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const responses = await Promise.all([submit(claimant, post), mutate(finder, 'delete', `/api/posts/${post._id}`, { revision: 0 })]);
  expect(responses.every(res => [202, 204, 404, 409].includes(res.status))).toBe(true);
  const current = await Post.findById(post._id);
  if (!current.deletedAt) expect((await mutate(finder, 'delete', `/api/posts/${post._id}`, { revision: current.revision })).status).toBe(204);
  await runPostCleanup({ logger, storage: { remove: async () => {} } });
  expect(await Claim.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
});

test('claim endpoint rate limits are separate from per-post attempts and ignore spoofed proxy IPs', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  let known = new Set((await RateBucket.find({})).map(row => row._id));
  const claim = await pending(claimant, post);
  let bucket = (await RateBucket.find({})).find(row => !known.has(row._id)); expect(bucket).toBeDefined();
  await RateBucket.updateOne({ _id: bucket._id }, { $set: { count: 20 } });
  expect((await auth(claimant, 'post', `/api/posts/${post._id}/claims`).set('X-Forwarded-For', '1.2.3.4').send(submission(post))).status).toBe(429);
  expect((await Claim.findById(claim.id)).attemptCount).toBe(1);
  known = new Set((await RateBucket.find({})).map(row => row._id));
  expect((await decide(finder, post, claim, 'deny')).status).toBe(200);
  bucket = (await RateBucket.find({})).find(row => !known.has(row._id)); await RateBucket.updateOne({ _id: bucket._id }, { $set: { count: 60 } });
  expect((await decide(finder, post, claim, 'deny')).status).toBe(429);
});

test('model serialization and structured audits suppress submitted/canonical answers and verification results', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post);
  const selected = await Claim.findById(claim.id).select('+submittedAnswers +verificationPassed');
  expect(JSON.stringify(selected)).not.toMatch(/submittedAnswers|verificationPassed|Silver|Pocket/);
  expect(JSON.stringify(await Post.findById(post._id).select('+approvedClaim +verificationQuestions.answerHash +verificationQuestions.answerSalt'))).not.toMatch(/answerHash|answerSalt|approvedClaim/);
  const approved = await decide(finder, post, claim); expect(approved.status).toBe(200);
  const logged = JSON.stringify(logger.mock.calls);
  for (const value of [...canonical, ...hashed.flatMap(q => [q.answerHash, q.answerSalt]), claimant.csrf, claimant.jar[cookies.access]]) expect(logged).not.toContain(value);
  expect(logged).not.toContain('@ucf.edu');
  expect(logger).toHaveBeenCalledWith('audit_claim_submit', expect.objectContaining({ outcome: 'pending' }));
  expect(logger).toHaveBeenCalledWith('audit_claim_approve', expect.objectContaining({ actorId: String(finder.user._id), outcome: 'approved' }));
});

test('production indexes enforce per-user claim and conversation uniqueness', async () => {
  await expect(assertClaimIndexes()).resolves.toBeUndefined();
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post); await decide(finder, post, claim);
  await expect(Claim.create({ post: post._id, claimant: claimant.user._id, submittedAnswers: canonical })).rejects.toHaveProperty('code', 11000);
  await expect(Conversation.create({ post: post._id, claim: claim.id, participants: [finder.user._id, claimant.user._id] })).rejects.toHaveProperty('code', 11000);
});

test('an approval racing resubmission cannot approve newly changed answers', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const first = await pending(claimant, post);
  const [approval, retry] = await Promise.all([decide(finder, post, first), submit(claimant, post, ['changed private answer', 'another mismatch'])]);
  expect([200, 409]).toContain(approval.status); expect([202, 404]).toContain(retry.status);
  const stored = await Claim.findById(first.id).select('+verificationPassed +submittedAnswers');
  if (stored.status === 'approved') {
    expect(stored.attemptCount).toBe(1); expect(stored.verificationPassed).toBe(true); expect(await Conversation.countDocuments()).toBe(1);
  } else {
    expect(stored.attemptCount).toBe(2); expect(stored.verificationPassed).toBe(false); expect(await Conversation.countDocuments()).toBe(0);
  }
});

test('closed/deleted/expired claims cannot be approved and failures do not consume post revisions', async () => {
  const finder = await browser(), claimant = await browser();
  for (const change of [{ status: 'closed' }, { status: 'returned' }, { deletedAt: new Date() }, { expiresAt: new Date(Date.now() - 1) }]) {
    const post = await found(finder); const claim = await pending(claimant, post);
    await Post.updateOne({ _id: post._id }, { $set: change });
    expect((await decide(finder, post, claim)).status).toBe(404);
    expect((await Post.findById(post._id)).revision).toBe(1);
  }
  expect(await Conversation.countDocuments()).toBe(0);
});

test('corrupt stored verification material fails closed without persisting attempts or leaking internals', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  await Post.updateOne({ _id: post._id }, { $set: { 'verificationQuestions.0.answerHash': 'corrupt-secret-hash' } });
  const res = await submit(claimant, post);
  expect(res.status).toBe(500); expect(res.text).not.toContain('corrupt-secret-hash');
  expect(await Claim.countDocuments()).toBe(0); expect(await Notification.countDocuments()).toBe(0);
  expect((await Post.findById(post._id)).revision).toBe(0);
});

test('submitted HTML remains JSON data for the authorized finder and never reaches public endpoints', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder);
  const text = '<script>privateSubmittedSentinel()</script>';
  const claim = await pending(claimant, post, [text, 'wrong answer']);
  const review = await auth(finder, 'get', `/api/posts/${post._id}/claims/${claim.id}`);
  expect(review.status).toBe(200); expect(review.headers['content-type']).toMatch(/^application\/json/);
  expect(review.headers['x-content-type-options']).toBe('nosniff'); expect(review.body.claim.submittedAnswers[0].answer).toBe(text);
  for (const path of ['/api/posts', `/api/posts/${post._id}`, '/api/claims/mine', '/api/notifications']) {
    const response = await auth(claimant, 'get', path); expect(response.text).not.toContain('privateSubmittedSentinel');
  }
});

test('claim read/notification limits protect their own routes independently of submission attempts', async () => {
  const finder = await browser(), claimant = await browser(); const post = await found(finder); const claim = await pending(claimant, post);
  let known = new Set((await RateBucket.find({})).map(row => row._id));
  expect((await auth(claimant, 'get', '/api/claims/mine')).status).toBe(200);
  let bucket = (await RateBucket.find({})).find(row => !known.has(row._id)); await RateBucket.updateOne({ _id: bucket._id }, { $set: { count: 120 } });
  expect((await auth(claimant, 'get', `/api/claims/${claim.id}`)).status).toBe(429);
  known = new Set((await RateBucket.find({})).map(row => row._id));
  const res = await auth(finder, 'get', '/api/notifications'); expect(res.status).toBe(200);
  bucket = (await RateBucket.find({})).find(row => !known.has(row._id)); await RateBucket.updateOne({ _id: bucket._id }, { $set: { count: 120 } });
  expect((await auth(finder, 'get', '/api/notifications')).status).toBe(429);
  expect((await Claim.findById(claim.id)).attemptCount).toBe(1);
  expect((await decide(finder, post, claim, 'deny')).status).toBe(200);
});
test('per-post current-claim lookup is authenticated, claimant-scoped, answer-free and respects post visibility', async () => {
  const finder = await browser(), claimant = await browser(), stranger = await browser(); const post = await found(finder);
  expect((await request(app).get(`/api/posts/${post._id}/my-claim`)).status).toBe(401);
  expect((await auth(claimant, 'get', `/api/posts/${post._id}/my-claim`)).body).toEqual({ claim: null });
  const claim = await pending(claimant, post, ['private-current-answer', 'another current answer']);
  const response = await auth(claimant, 'get', `/api/posts/${post._id}/my-claim`);
  expect(response.status).toBe(200); expect(response.body.claim.id).toBe(claim.id); expectNoSecrets(response);
  expect(response.text).not.toMatch(/private-current-answer|submittedAnswers|verificationPassed/);
  expect((await auth(stranger, 'get', `/api/posts/${post._id}/my-claim`)).body).toEqual({ claim: null });
  expect((await auth(stranger, 'get', `/api/posts/${post._id}/my-claim?claimant=${claimant.user._id}`)).status).toBe(400);
  await Post.updateOne({ _id: post._id }, { $set: { deletedAt: new Date() } });
  expect((await auth(claimant, 'get', `/api/posts/${post._id}/my-claim`)).status).toBe(404);
});
