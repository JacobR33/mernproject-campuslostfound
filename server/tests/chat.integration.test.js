const mongoose = require('mongoose');
const request = require('supertest');
const { createServer } = require('node:http');
const { randomUUID, randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../src/app');
const { attachChat } = require('../src/realtime/chat');
const { User, Item, Post, Claim, Conversation, Message } = require('../src/models');
const MatchRequest = require('../src/models/matchRequest');
const { AuthSession, RateBucket } = require('../src/models/auth');
const { hashQuestions } = require('../src/lib/verificationAnswers');
const { hashPassword, mintCsrf, hash, token } = require('../src/lib/authCrypto');
const { cookies } = require('../src/middleware/auth');
const { assertChatIndexes } = require('../src/config/indexes');
const { runPostCleanup } = require('../src/jobs/postCleanup');
jest.setTimeout(120000);
const config = { NODE_ENV: 'test', CLIENT_ORIGIN: 'https://campus.example', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ACCESS_TOKEN_TTL_SECONDS: 900, POST_RETENTION_DAYS: 90 };
let mongo, server, chat, app, url, logger, passwordHash, questions, serial = 0;
const clients = [];
const oid = () => new mongoose.Types.ObjectId();
const jar = values => Object.entries(values).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
async function identity(overrides = {}) {
  const user = await User.create({ email: `chat${++serial}@ucf.edu`, displayName: `Knight ${serial}`, passwordHash, emailVerified: true, ...overrides });
  const sid = token(); await AuthSession.create({ _id: sid, user: user._id, authVersion: 0, currentHash: token(), expiresAt: new Date(Date.now() + 86400000) });
  const access = jwt.sign({ sid, ver: 0 }, config.JWT_SECRET, { subject: String(user._id), algorithm: 'HS256', issuer: 'ucf-lost-found', audience: 'ucf-lost-found-api', expiresIn: 900 });
  const csrf = mintCsrf(config.JWT_SECRET);
  return { user, sid, access, csrf, headers: { Origin: config.CLIENT_ORIGIN, Cookie: jar({ [cookies.access]: access, [cookies.csrf]: csrf }) } };
}
async function post(owner, type = 'found') {
  const item = await Item.create({ title: 'Campus item', category: 'other', publicDescription: 'A campus item', privateDetails: 'private-chat-item', dateFoundOrLost: new Date() });
  return Post.create({ type, author: owner.user._id, item: item._id, verificationQuestions: type === 'found' ? questions : [], expiresAt: new Date(Date.now() + 86400000) });
}
async function approved(a, b) {
  const p = await post(a);
  const claim = await Claim.create({ post: p._id, claimant: b.user._id, submittedAnswers: ['canonical answer', 'another answer'], verificationPassed: true, status: 'approved' });
  const conversation = await Conversation.create({ post: p._id, claim: claim._id, participants: [a.user._id, b.user._id] });
  await Claim.updateOne({ _id: claim._id }, { $set: { conversation: conversation._id } });
  await Post.updateOne({ _id: p._id }, { $set: { status: 'claim_pending', approvedClaim: claim._id } });
  return { post: p, claim, conversation };
}
function connect(actor, overrides = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 4000, auth: { csrfToken: actor.csrf }, extraHeaders: actor.headers, ...overrides }); clients.push(socket);
    socket.once('connect', () => resolve(socket)); socket.once('connect_error', reject);
  });
}
const emit = (socket, event, value) => socket.timeout(5000).emitWithAck(event, value);
const join = (socket, conversation) => emit(socket, 'conversation:join', { conversationId: String(conversation._id) });
const send = (socket, conversation, body = 'Hello, Knight!', clientMessageId = randomUUID()) => emit(socket, 'message:send', { conversationId: String(conversation._id), body, clientMessageId });
const get = (actor, path) => request(app).get(path).set(actor.headers);
const mutate = (actor, path, body = {}) => request(app).post(path).set(actor.headers).set('X-CSRF-Token', actor.csrf).send(body);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); mongoose.set('sanitizeFilter', true); mongoose.set('strictQuery', true); await mongoose.connect(mongo.getUri());
  await Promise.all([User, Item, Post, Claim, Conversation, Message, MatchRequest, AuthSession, RateBucket].map(model => model.init()));
  passwordHash = await hashPassword('Campus chat fixture passphrase 47!'); questions = await hashQuestions([{ question: 'First question?', answer: 'canonical answer' }, { question: 'Second question?', answer: 'another answer' }]);
  logger = jest.fn(); app = createApp(config, { logger, mailer: { send: async () => {} } }); server = createServer(app); chat = attachChat(server, config, logger);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { chat.io.disconnectSockets(true); clients.splice(0).forEach(client => client.disconnect()); for (const model of [Message, Conversation, MatchRequest, Claim, Post, Item, AuthSession, RateBucket, User]) await model.deleteMany({}); logger.mockClear(); });
afterAll(async () => { clients.forEach(client => client.disconnect()); if (chat) await chat.close(); await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('cookie-authenticated participants join and receive persisted messages with explicit safe DTOs', async () => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const first = await connect(a), second = await connect(b);
  expect((await join(first, conversation)).ok).toBe(true); expect((await join(second, conversation)).ok).toBe(true);
  const received = new Promise(resolve => second.once('message:new', resolve));
  const result = await send(first, conversation, '<script>private-message()</script>'); const message = await received;
  expect(result.ok).toBe(true); expect(message.id).toBe(result.message.id); expect(message.sender).toEqual({ id: String(a.user._id), displayName: a.user.displayName });
  expect(message.body).toBe('<script>private-message()</script>'); expect(await Message.countDocuments()).toBe(1);
  const history = await get(b, `/api/conversations/${conversation._id}/messages`); expect(history.status).toBe(200); expect(history.body.messages[0].body).toBe(message.body);
  expect(history.text).not.toMatch(/@ucf.edu|passwordHash|private-chat-item|answerHash|answerSalt|submittedAnswers|approvedClaim/);
});
test.each(['missing-origin', 'evil-origin', 'missing-cookie', 'missing-csrf', 'forged-csrf', 'query-token', 'bearer-payload'])('handshake fails closed: %s', async variant => {
  const actor = await identity(); let options = {};
  if (variant === 'missing-origin') options.extraHeaders = { Cookie: actor.headers.Cookie };
  if (variant === 'evil-origin') options.extraHeaders = { ...actor.headers, Origin: 'https://evil.example' };
  if (variant === 'missing-cookie') options.extraHeaders = { Origin: config.CLIENT_ORIGIN };
  if (variant === 'missing-csrf') options.auth = {};
  if (variant === 'forged-csrf') options.auth = { csrfToken: 'a'.repeat(150) };
  if (variant === 'query-token') options.query = { token: actor.access };
  if (variant === 'bearer-payload') options.auth = { csrfToken: actor.csrf, token: actor.access };
  await expect(connect(actor, options)).rejects.toBeInstanceOf(Error);
  expect(await Message.countDocuments()).toBe(0);
});
test('handshake rejects expired/tampered credentials and current banned/unverified/revoked accounts', async () => {
  const actor = await identity();
  for (const update of [{ isBanned: true }, { isBanned: false, emailVerified: false }]) { await User.updateOne({ _id: actor.user._id }, { $set: update }); await expect(connect(actor)).rejects.toBeInstanceOf(Error); }
  await User.updateOne({ _id: actor.user._id }, { $set: { isBanned: false, emailVerified: true } });
  await AuthSession.updateOne({ _id: actor.sid }, { $set: { revoked: true } }); await expect(connect(actor)).rejects.toBeInstanceOf(Error);
  await AuthSession.updateOne({ _id: actor.sid }, { $set: { revoked: false } });
  const bad = jwt.sign({ sid: actor.sid, ver: 0 }, config.JWT_SECRET, { subject: String(actor.user._id), issuer: 'ucf-lost-found', audience: 'ucf-lost-found-api', expiresIn: -1 });
  await expect(connect(actor, { extraHeaders: { ...actor.headers, Cookie: jar({ [cookies.access]: bad, [cookies.csrf]: actor.csrf }) } })).rejects.toBeInstanceOf(Error);
});
test('nonparticipants and admins cannot join, send, list, read detail or history', async () => {
  const a = await identity(), b = await identity(), stranger = await identity(), admin = await identity({ role: 'admin' }); const { conversation } = await approved(a, b);
  for (const actor of [stranger, admin]) {
    const socket = await connect(actor); expect((await join(socket, conversation)).status).toBe(404); expect((await send(socket, conversation)).status).toBe(404);
    for (const path of [`/api/conversations/${conversation._id}`, `/api/conversations/${conversation._id}/messages`]) expect((await get(actor, path)).status).toBe(404);
    expect((await get(actor, '/api/conversations')).body.conversations).toEqual([]);
  }
  expect(await Message.countDocuments()).toBe(0);
});
test('a forged participant conversation without approved consent cannot be used', async () => {
  const a = await identity(), b = await identity(), p = await post(a);
  const conversation = await Conversation.create({ post: p._id, participants: [a.user._id, b.user._id] }); const socket = await connect(b);
  expect((await join(socket, conversation)).status).toBe(404); expect((await send(socket, conversation)).status).toBe(404);
  expect((await get(b, `/api/conversations/${conversation._id}/messages`)).status).toBe(404);
});
test('invalid/oversized/blank/control-character messages and mass-assigned sender fields never persist', async () => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const socket = await connect(a);
  const base = { conversationId: String(conversation._id), body: 'Hello', clientMessageId: randomUUID() };
  for (const change of [{ body: '' }, { body: '  \n ' }, { body: 'x'.repeat(2001) }, { body: 'a\0b' }, { sender: String(b.user._id) }, { createdAt: new Date().toISOString() }, { conversationId: 'invalid' }, { clientMessageId: 'bad' }, { body: { $ne: null } }]) expect((await emit(socket, 'message:send', { ...base, ...change })).status).toBe(400);
  expect((await emit(socket, 'admin:join', {})).status).toBe(400); expect(await Message.countDocuments()).toBe(0);
});
test('message replay IDs persist once, conflict on changed bodies, and concurrent retries remain idempotent', async () => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const one = await connect(a), two = await connect(a); const id = randomUUID();
  const results = await Promise.all([send(one, conversation, 'one body', id), send(two, conversation, 'one body', id)]);
  expect(results.every(row => row.ok)).toBe(true); expect(results[0].message.id).toBe(results[1].message.id); expect(await Message.countDocuments()).toBe(1);
  expect((await send(one, conversation, 'changed', id)).status).toBe(409); expect((await Conversation.findById(conversation._id)).messageSequence).toBe(1);
});
test('history uses stable sequence cursors, bounded pages and participant sender projections', async () => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const socket = await connect(a);
  for (let i = 0; i < 5; i++) expect((await send(socket, conversation, `message ${i}`)).ok).toBe(true);
  const first = await get(b, `/api/conversations/${conversation._id}/messages?limit=2`); expect(first.body.messages.map(row => row.sequence)).toEqual([4, 5]); expect(first.body.nextBefore).toBe(4);
  const second = await get(b, `/api/conversations/${conversation._id}/messages?limit=2&before=4`); expect(second.body.messages.map(row => row.sequence)).toEqual([2, 3]);
  const last = await get(b, `/api/conversations/${conversation._id}/messages?limit=2&before=2`); expect(last.body.messages.map(row => row.sequence)).toEqual([1]); expect(last.body.nextBefore).toBeNull();
  for (const query of ['limit=51', 'before=0', 'before=bad', 'sender=x', 'limit=1&limit=2']) expect((await get(b, `/api/conversations/${conversation._id}/messages?${query}`)).status).toBe(400);
});
test.each(['logout', 'ban', 'password-reset'])('already-connected senders lose authorization after %s', async action => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const socket = await connect(a); await join(socket, conversation);
  if (action === 'logout') await AuthSession.updateOne({ _id: a.sid }, { $set: { revoked: true } });
  if (action === 'ban') await User.updateOne({ _id: a.user._id }, { $set: { isBanned: true } });
  if (action === 'password-reset') await User.updateOne({ _id: a.user._id }, { $inc: { authVersion: 1 } });
  expect((await send(socket, conversation)).status).toBe(401); expect(await Message.countDocuments()).toBe(0);
});
test('a logged-out subscribed receiver receives no newly persisted message', async () => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const sender = await connect(a), receiver = await connect(b); await join(receiver, conversation);
  const observed = []; receiver.on('message:new', value => observed.push(value)); await AuthSession.updateOne({ _id: b.sid }, { $set: { revoked: true } });
  expect((await send(sender, conversation)).ok).toBe(true); expect(observed).toEqual([]); expect(await Message.countDocuments()).toBe(1);
});
test.each(['deleted', 'expired', 'closed'])('post visibility revokes active conversation access: %s', async state => {
  const a = await identity(), b = await identity(); const { post: p, conversation } = await approved(a, b); const socket = await connect(a); await join(socket, conversation);
  await Post.updateOne({ _id: p._id }, { $set: state === 'deleted' ? { deletedAt: new Date() } : state === 'expired' ? { expiresAt: new Date(Date.now() - 1) } : { status: 'closed' } });
  expect((await send(socket, conversation)).status).toBe(404); expect((await get(a, `/api/conversations/${conversation._id}/messages`)).status).toBe(404); expect((await get(a, '/api/conversations')).body.conversations).toEqual([]);
});
test('account and conversation message limits are shared across sockets and leave counters unchanged on rejection', async () => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const one = await connect(a), two = await connect(a);
  await send(one, conversation); const window = Math.floor(Date.now() / 60000);
  await RateBucket.updateOne({ _id: hash(`chat-send-conversation|${a.user._id}:${conversation._id}|${window}`) }, { $set: { count: 20 } });
  expect((await send(two, conversation)).status).toBe(429); expect(await Message.countDocuments()).toBe(1); expect((await Conversation.findById(conversation._id)).messageSequence).toBe(1);
});
test('connection reservations reject more than five concurrent sockets for the same user', async () => {
  const actor = await identity(); const results = await Promise.allSettled(Array.from({ length: 8 }, () => connect(actor)));
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(5); expect(results.filter(row => row.status === 'rejected')).toHaveLength(3);
});
test('lost matching requires author consent, enforces ownership, and creates only a linked participant conversation', async () => {
  const owner = await identity(), finder = await identity(), stranger = await identity(), p = await post(owner, 'lost');
  const response = await mutate(finder, `/api/posts/${p._id}/matches`); expect(response.status).toBe(201); expect(await Conversation.countDocuments()).toBe(0);
  const match = response.body.request;
  expect((await mutate(owner, `/api/posts/${p._id}/matches`)).status).toBe(404);
  expect((await mutate(finder, `/api/posts/${p._id}/matches`)).status).toBe(200); expect(await MatchRequest.countDocuments()).toBe(1);
  expect((await get(owner, '/api/matches/incoming')).body.requests[0].id).toBe(match.id);
  expect((await get(stranger, '/api/matches/incoming')).body.requests).toEqual([]); expect((await get(stranger, '/api/matches/mine')).body.requests).toEqual([]);
  expect((await mutate(stranger, `/api/posts/${p._id}/matches/${match.id}/decision`, { decision: 'accept' })).status).toBe(404);
  const accepted = await mutate(owner, `/api/posts/${p._id}/matches/${match.id}/decision`, { decision: 'accept' }); expect(accepted.status).toBe(200);
  const conversation = await Conversation.findById(accepted.body.request.conversationId); expect(conversation.participants.map(String)).toEqual([String(finder.user._id), String(owner.user._id)]);
  const socket = await connect(finder); expect((await join(socket, conversation)).ok).toBe(true); expect((await send(socket, conversation)).ok).toBe(true);
  const current = await Post.findById(p._id); expect((await mutate(owner, `/api/posts/${p._id}/return`, { revision: current.revision })).status).toBe(204);
  expect((await Post.findById(p._id)).status).toBe('returned');
});
test('concurrent lost request acceptances select one winner and deny competitors', async () => {
  const owner = await identity(), a = await identity(), b = await identity(), p = await post(owner, 'lost');
  const first = (await mutate(a, `/api/posts/${p._id}/matches`)).body.request, second = (await mutate(b, `/api/posts/${p._id}/matches`)).body.request;
  const results = await Promise.all([mutate(owner, `/api/posts/${p._id}/matches/${first.id}/decision`, { decision: 'accept' }), mutate(owner, `/api/posts/${p._id}/matches/${second.id}/decision`, { decision: 'accept' })]);
  expect(results.filter(row => row.status === 200)).toHaveLength(1); expect(await Conversation.countDocuments()).toBe(1); expect(await MatchRequest.countDocuments({ status: 'accepted' })).toBe(1); expect(await MatchRequest.countDocuments({ status: 'denied' })).toBe(1);
});
test('lost matching rejects denied retries, wrong post types, mass assignment and missing CSRF', async () => {
  const owner = await identity(), finder = await identity(), p = await post(owner, 'lost'), foundPost = await post(owner);
  expect((await mutate(finder, `/api/posts/${foundPost._id}/matches`)).status).toBe(404);
  expect((await mutate(finder, `/api/posts/${p._id}/matches`, { requester: String(owner.user._id) })).status).toBe(400);
  const match = (await mutate(finder, `/api/posts/${p._id}/matches`)).body.request;
  expect((await mutate(owner, `/api/posts/${p._id}/matches/${match.id}/decision`, { decision: 'deny' })).status).toBe(200);
  expect((await mutate(finder, `/api/posts/${p._id}/matches`)).status).toBe(409); expect(await Conversation.countDocuments()).toBe(0);
  expect((await request(app).post(`/api/posts/${p._id}/matches`).set(finder.headers).send({})).status).toBe(403);
});
test('failed message insert rolls back sequence and logs no bodies, cookies, emails or proof material', async () => {
  const a = await identity(), b = await identity(); const { conversation } = await approved(a, b); const socket = await connect(a);
  const spy = jest.spyOn(Message, 'create').mockRejectedValueOnce(new Error('private database secret'));
  try { expect((await send(socket, conversation, 'private sent body')).status).toBe(500); } finally { spy.mockRestore(); }
  expect((await Conversation.findById(conversation._id)).messageSequence).toBe(0); expect(await Message.countDocuments()).toBe(0);
  const logged = JSON.stringify(logger.mock.calls); for (const value of ['private sent body', 'private database secret', a.access, a.csrf, '@ucf.edu', 'canonical answer']) expect(logged).not.toContain(value);
});
test('post cleanup removes lost requests and chat history without leaving a messaging path', async () => {
  const owner = await identity(), finder = await identity(), p = await post(owner, 'lost'); const match = (await mutate(finder, `/api/posts/${p._id}/matches`)).body.request;
  const accepted = await mutate(owner, `/api/posts/${p._id}/matches/${match.id}/decision`, { decision: 'accept' }); const conversation = await Conversation.findById(accepted.body.request.conversationId);
  const socket = await connect(finder); await send(socket, conversation);
  await Post.updateOne({ _id: p._id }, { $set: { deletedAt: new Date() } }); await runPostCleanup({ logger, storage: { remove: async () => {} } });
  for (const model of [MatchRequest, Conversation, Message]) expect(await model.countDocuments()).toBe(0);
  expect((await send(socket, conversation)).status).toBe(404);
});
test('production chat indexes enforce idempotency and request uniqueness', async () => { await expect(assertChatIndexes()).resolves.toBeUndefined(); });
test('short-lived socket credentials disconnect at JWT expiry even without another application event', async () => {
  const actor = await identity();
  const access = jwt.sign({ sid: actor.sid, ver: 0 }, config.JWT_SECRET, { subject: String(actor.user._id), issuer: 'ucf-lost-found', audience: 'ucf-lost-found-api', expiresIn: 2 });
  const socket = await connect(actor, { extraHeaders: { ...actor.headers, Cookie: jar({ [cookies.access]: access, [cookies.csrf]: actor.csrf }) } });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Socket expiry timeout')), 3500); socket.once('disconnect', () => { clearTimeout(timer); resolve(); }); });
  expect(socket.connected).toBe(false);
});
test('frames above the transport byte budget disconnect before a message is stored', async () => {
  const actor = await identity(), socket = await connect(actor);
  const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
  socket.emit('message:send', { conversationId: String(oid()), body: 'x'.repeat(20000), clientMessageId: randomUUID() }, () => {});
  await disconnected; expect(await Message.countDocuments()).toBe(0);
});
test('packet flooding disconnects a socket even when payloads lack acknowledgement callbacks', async () => {
  const actor = await identity(), socket = await connect(actor); const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
  for (let i = 0; i < 101; i++) socket.emit('unknown:event', {});
  await disconnected; expect(await Message.countDocuments()).toBe(0);
});
test('the account-wide message budget applies even to a different approved conversation', async () => {
  const a = await identity(), b = await identity(); const first = await approved(a, b), second = await approved(a, b), socket = await connect(a);
  await send(socket, first.conversation);
  await RateBucket.updateOne({ _id: hash(`chat-send-user|${a.user._id}|${Math.floor(Date.now() / 60000)}`) }, { $set: { count: 60 } });
  expect((await send(socket, second.conversation)).status).toBe(429); expect(await Message.countDocuments()).toBe(1);
});
test('handshake rate storage outages reject connection attempts without exposing database errors', async () => {
  const actor = await identity(); const spy = jest.spyOn(RateBucket, 'findOneAndUpdate').mockRejectedValueOnce(new Error('private rate database password'));
  try { await expect(connect(actor)).rejects.toBeInstanceOf(Error); } finally { spy.mockRestore(); }
  expect(JSON.stringify(logger.mock.calls)).not.toContain('private rate database password');
});
test('failed consent conversation creation rolls back reservation and request decisions', async () => {
  const owner = await identity(), finder = await identity(), p = await post(owner, 'lost'); const match = (await mutate(finder, `/api/posts/${p._id}/matches`)).body.request;
  const spy = jest.spyOn(Conversation, 'create').mockRejectedValueOnce(new Error('private transaction secret'));
  try { expect((await mutate(owner, `/api/posts/${p._id}/matches/${match.id}/decision`, { decision: 'accept' })).status).toBe(500); } finally { spy.mockRestore(); }
  expect((await MatchRequest.findById(match.id)).status).toBe('pending'); expect((await Post.findById(p._id).select('+approvedMatch')).approvedMatch).toBeNull(); expect(await Conversation.countDocuments()).toBe(0);
});
test('sender and receiver membership are rechecked after a conversation changes', async () => {
  const a = await identity(), b = await identity(), stranger = await identity(); const { conversation } = await approved(a, b); const socket = await connect(b); await join(socket, conversation);
  await Conversation.updateOne({ _id: conversation._id }, { $set: { participants: [a.user._id, stranger.user._id] } });
  expect((await send(socket, conversation)).status).toBe(404); expect((await get(b, `/api/conversations/${conversation._id}/messages`)).status).toBe(404);
});
