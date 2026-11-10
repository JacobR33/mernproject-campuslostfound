const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../src/app');
const { User, Post, Item, Claim, Conversation, Message } = require('../src/models');
const Notification = require('../src/models/notification');
const MatchRequest = require('../src/models/matchRequest');
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
  for (const model of [Notification, Message, Conversation, MatchRequest, Claim, Post, Item, AuthSession, RateBucket, User]) await model.deleteMany({});
  logger.mockClear();
});
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

// Existing approved claim proofs remain readable so historical conversations keep working.
async function historicalChat(owner, claimant) {
  const post = await found(owner);
  const claim = await Claim.create({ post: post._id, claimant: claimant.user._id, submittedAnswers: canonical, verificationPassed: true, status: 'approved' });
  const conversation = await Conversation.create({ post: post._id, claim: claim._id, participants: [owner.user._id, claimant.user._id] });
  await Claim.updateOne({ _id: claim._id }, { $set: { conversation: conversation._id } });
  await Post.updateOne({ _id: post._id }, { $set: { status: 'claim_pending', approvedClaim: claim._id } });
  return { post, claim, conversation };
}
test('retired verification submission and review endpoints cannot create or approve claims', async () => {
  const owner = await browser(), claimant = await browser(), post = await found(owner);
  expect((await mutate(claimant, 'post', `/api/posts/${post._id}/claims`, { answers: [] })).status).toBe(404);
  expect((await auth(owner, 'get', `/api/posts/${post._id}/claims`)).status).toBe(404);
  expect((await mutate(owner, 'post', `/api/posts/${post._id}/claims/${oid()}/decision`, { decision: 'approve', attemptCount: 1 })).status).toBe(404);
  expect(await Claim.countDocuments()).toBe(0);
});
test('historical approved claims resolve only for their claimant without exposing verification material', async () => {
  const owner = await browser(), claimant = await browser(), stranger = await browser();
  const { post, claim, conversation } = await historicalChat(owner, claimant);
  const detail = await auth(claimant, 'get', `/api/claims/${claim._id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.claim.conversationId).toBe(String(conversation._id));
  expectNoSecrets(detail);
  expect(detail.text).not.toMatch(/submittedAnswers|verificationQuestions|verificationPassed/);
  for (const person of [owner, stranger]) expect((await auth(person, 'get', `/api/claims/${claim._id}`)).status).toBe(404);
  for (const person of [owner, claimant]) expect((await auth(person, 'get', `/api/conversations/${conversation._id}`)).status).toBe(200);
  expect((await auth(claimant, 'get', `/api/posts/${post._id}`)).text).not.toContain('verificationQuestions');
});
test('historical approved found-item chats still support marking an item returned', async () => {
  const owner = await browser(), claimant = await browser();
  const { post } = await historicalChat(owner, claimant);
  expect((await mutate(claimant, 'post', `/api/posts/${post._id}/return`, { revision: 0 })).status).toBe(404);
  expect((await mutate(owner, 'post', `/api/posts/${post._id}/return`, { revision: 0 })).status).toBe(204);
  expect((await Post.findById(post._id)).status).toBe('returned');
});
test('legacy notifications remain private and readable after verification is retired', async () => {
  const owner = await browser(), claimant = await browser(), stranger = await browser();
  const { post, claim } = await historicalChat(owner, claimant);
  const note = await Notification.create({ recipient: claimant.user._id, post: post._id, claim: claim._id, kind: 'claim_approved', attemptCount: 1 });
  const list = await auth(claimant, 'get', '/api/notifications?unread=true');
  expect(list.status).toBe(200); expect(list.body.notifications).toHaveLength(1); expectNoSecrets(list);
  expect((await auth(stranger, 'get', '/api/notifications')).body.notifications).toEqual([]);
  expect((await mutate(stranger, 'patch', `/api/notifications/${note._id}/read`)).status).toBe(404);
  expect((await mutate(claimant, 'patch', `/api/notifications/${note._id}/read`)).status).toBe(204);
  expect((await auth(claimant, 'get', '/api/notifications?unread=true')).body.notifications).toEqual([]);
});
