const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { randomBytes } = require('node:crypto');
const { createApp } = require('../src/app');
const { User } = require('../src/models');
const { AuthSession, RateBucket, MailOutbox } = require('../src/models/auth');
const { createQueuedMailer, deliverOne } = require('../src/lib/mailQueue');
const { assertAuthIndexes, assertRetentionIndexes } = require('../src/config/indexes');
const { hash, hashPassword, verifyPassword, token } = require('../src/lib/authCrypto');
const { cookies } = require('../src/middleware/auth');

jest.setTimeout(120000);
const config = { NODE_ENV: 'test', CLIENT_ORIGIN: 'https://campus.example', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ACCESS_TOKEN_TTL_SECONDS: 900, MAIL_TRANSPORT: 'file' };
const password = 'Copper harbor lantern 47!';
const secondPassword = 'Moonlight campus river 28!';
const email = 'student@ucf.edu';
let mongo, app, inbox, logger, baseHash;
const parseCookies = res => Object.fromEntries((res.headers['set-cookie'] || []).map(value => {
  const [name, ...parts] = value.split(';')[0].split('='); return [name, decodeURIComponent(parts.join('='))];
}));
const cookieHeader = jar => Object.entries(jar).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
async function browser(target = app) {
  const res = await request(target).get('/api/auth/csrf');
  expect(res.status).toBe(200);
  return { jar: parseCookies(res), csrf: res.body.csrfToken, target };
}
async function post(browser, path, body = {}, headers = {}) {
  let req = request(browser.target).post(`/api/auth/${path}`).set('Cookie', cookieHeader(browser.jar)).set('Origin', config.CLIENT_ORIGIN).set('X-CSRF-Token', browser.csrf);
  for (const [key, value] of Object.entries(headers)) req = req.set(key, value);
  const res = await req.send(body);
  Object.assign(browser.jar, parseCookies(res));
  return res;
}
const me = browser => request(browser.target).get('/api/auth/me').set('Cookie', cookieHeader(browser.jar));
async function user(overrides = {}) {
  return User.create({ email, displayName: 'Knight', passwordHash: baseHash, emailVerified: true, ...overrides });
}
const mailToken = index => new URL(inbox[index ?? inbox.length - 1].text.match(/https:\/\/\S+/)[0]).hash.split('=')[1];
async function login(browser, credentials = {}) {
  const res = await post(browser, 'login', { email, password, ...credentials });
  expect(res.status).toBe(200);
  return res;
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  mongoose.set('sanitizeFilter', true);
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongo.getUri());
  await Promise.all([User.init(), AuthSession.init(), RateBucket.init(), MailOutbox.init()]);
  baseHash = await hashPassword(password);
  inbox = [];
  logger = jest.fn();
  app = createApp(config, { logger, mailer: { send: async message => inbox.push(message) } });
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), AuthSession.deleteMany({}), RateBucket.deleteMany({}), MailOutbox.deleteMany({})]);
  inbox.length = 0;
  logger.mockClear();
});
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('registration normalizes email, hashes passwords at cost 12, sends private one-use verification', async () => {
  const b = await browser();
  const res = await post(b, 'register', { email: ' Student@UCF.EDU ', password, displayName: ' Knight ' });
  expect(res.status).toBe(202);
  expect(res.text).not.toMatch(/token|passwordHash|student@/);
  const saved = await User.findOne({ email }).select('+passwordHash +verificationTokenHash +verificationTokenExpiry');
  expect(saved.displayName).toBe('Knight');
  expect(saved.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  expect(await verifyPassword(password, saved.passwordHash)).toBe(true);
  expect(saved.emailVerified).toBe(false);
  const raw = mailToken();
  expect(saved.verificationTokenHash).toBe(hash(raw));
  expect(JSON.stringify(await User.collection.findOne({ _id: saved._id }))).not.toContain(raw);
  expect((await post(b, 'login', { email, password })).status).toBe(401);
  expect((await post(b, 'verify-email', { token: raw })).status).toBe(200);
  expect((await post(b, 'verify-email', { token: raw })).status).toBe(400);
  await login(b);
  expect((await me(b)).body.user).toEqual({ id: String(saved._id), displayName: 'Knight', role: 'user', emailVerified: true });
});

test('duplicate registration returns identical generic response without overwriting account', async () => {
  const b = await browser();
  const first = await post(b, 'register', { email, password, displayName: 'Original' });
  const second = await post(b, 'register', { email, password: secondPassword, displayName: 'Attacker' });
  expect(first.body).toEqual(second.body);
  expect(second.status).toBe(202);
  expect(await User.countDocuments()).toBe(1);
  expect((await User.findOne({ email })).displayName).toBe('Original');
  expect(inbox).toHaveLength(1);
});

test.each([
  { email: 'student@ucf.edu.attacker.com' }, { email: 'student@knights.ucf.edu' },
  { password: 'short' }, { password: 'password123456' }, { password: 'x'.repeat(12) },
  { password: '1234567890123456' }, { password: '🦉'.repeat(20) },
  { role: 'admin' }, { emailVerified: true }, { passwordHash: 'fake' },
])('registration rejects invalid policy or mass assignment %j', async override => {
  const b = await browser();
  expect((await post(b, 'register', { email, password, displayName: 'Knight', ...override })).status).toBe(400);
  expect(await User.countDocuments()).toBe(0);
});

test('verification rejects expired/invalid tokens; resend replaces previous token without enumeration', async () => {
  const raw = token();
  const u = await user({ emailVerified: false, verificationTokenHash: hash(raw), verificationTokenExpiry: new Date(Date.now() - 1) });
  const b = await browser();
  expect((await post(b, 'verify-email', { token: raw })).status).toBe(400);
  expect((await post(b, 'verify-email', { token: token() })).status).toBe(400);
  const known = await post(b, 'resend-verification', { email });
  const unknown = await post(b, 'resend-verification', { email: 'missing@ucf.edu' });
  expect(known.status).toBe(202); expect(known.body).toEqual(unknown.body);
  expect((await post(b, 'verify-email', { token: raw })).status).toBe(400);
  expect((await post(b, 'verify-email', { token: mailToken() })).status).toBe(200);
  expect((await User.findById(u._id)).emailVerified).toBe(true);
});

test('login responses are generic for unknown, wrong-password, unverified, locked and banned accounts', async () => {
  const u = await user(); const b = await browser();
  const wrong = await post(b, 'login', { email, password: secondPassword });
  const unknown = await post(b, 'login', { email: 'missing@ucf.edu', password });
  await User.updateOne({ _id: u._id }, { $set: { emailVerified: false } });
  const unverified = await post(b, 'login', { email, password });
  await User.updateOne({ _id: u._id }, { $set: { emailVerified: true, lockUntil: new Date(Date.now() + 60000) } });
  const locked = await post(b, 'login', { email, password });
  await User.updateOne({ _id: u._id }, { $set: { isBanned: true }, $unset: { lockUntil: 1 } });
  const banned = await post(b, 'login', { email, password });
  for (const res of [wrong, unknown, unverified, locked, banned]) {
    expect(res.status).toBe(401); expect(res.body.error).toBe('Authentication failed');
    expect(res.headers['set-cookie']).toBeUndefined();
  }
});

test('account lockout increases backoff and a later successful login clears failure state', async () => {
  const u = await user(); const b = await browser();
  for (let i = 0; i < 5; i++) expect((await post(b, 'login', { email, password: secondPassword })).status).toBe(401);
  let saved = await User.findById(u._id).select('+failedLoginCount +lockUntil');
  expect(saved.failedLoginCount).toBe(5);
  expect(saved.lockUntil - Date.now()).toBeGreaterThan(50000);
  expect(logger).toHaveBeenCalledWith('security_account_lockout', expect.objectContaining({ actorId: String(u._id), requestId: expect.any(String), attemptCount: 5, outcome: 'locked' }));
  expect((await post(b, 'login', { email, password })).status).toBe(401);
  await User.updateOne({ _id: u._id }, { $set: { lockUntil: new Date(Date.now() - 1) } });
  expect((await post(b, 'login', { email, password: secondPassword })).status).toBe(401);
  saved = await User.findById(u._id).select('+failedLoginCount +lockUntil');
  expect(saved.failedLoginCount).toBe(6);
  expect(saved.lockUntil - Date.now()).toBeGreaterThan(110000);
  await User.updateOne({ _id: u._id }, { $set: { lockUntil: new Date(Date.now() - 1) } });
  await login(b);
  saved = await User.findById(u._id).select('+failedLoginCount +lockUntil');
  expect(saved.failedLoginCount).toBe(0); expect(saved.lockUntil).toBeUndefined();
});

test('concurrent failures cannot lose increments or bypass lockout', async () => {
  const u = await user(); const b = await browser();
  const responses = await Promise.all(Array.from({ length: 5 }, () => post({ ...b, jar: { ...b.jar } }, 'login', { email, password: secondPassword })));
  expect(responses.map(res => res.status)).toEqual([401, 401, 401, 401, 401]);
  const saved = await User.findById(u._id).select('+failedLoginCount +lockUntil');
  expect(saved.failedLoginCount).toBe(5); expect(saved.lockUntil > new Date()).toBe(true);
});

test('session creation failure rolls back the successful-login counter reset', async () => {
  const u = await user({ failedLoginCount: 4 }), b = await browser();
  const spy = jest.spyOn(AuthSession, 'create').mockRejectedValueOnce(new Error('private session failure'));
  try { expect((await post(b, 'login', { email, password })).status).toBe(500); }
  finally { spy.mockRestore(); }
  expect((await User.findById(u._id).select('+failedLoginCount')).failedLoginCount).toBe(4);
  expect(await AuthSession.countDocuments()).toBe(0);
});

test('reset revocation failure rolls back the token, password and credential version', async () => {
  const raw = token(), u = await user({ resetTokenHash: hash(raw), resetTokenExpiry: new Date(Date.now() + 60000) }), b = await browser();
  await login(b); const saved = { ...b, jar: { ...b.jar } };
  const spy = jest.spyOn(AuthSession, 'updateMany').mockRejectedValueOnce(new Error('private revocation failure'));
  try { expect((await post(b, 'reset-password', { token: raw, password: secondPassword })).status).toBe(500); }
  finally { spy.mockRestore(); }
  const current = await User.findById(u._id).select('+passwordHash +authVersion +resetTokenHash');
  expect(current.authVersion).toBe(0); expect(current.resetTokenHash).toBe(hash(raw)); expect(await verifyPassword(password, current.passwordHash)).toBe(true);
  expect((await me(saved)).status).toBe(200);
  expect((await post(b, 'reset-password', { token: raw, password: secondPassword })).status).toBe(200);
});

test('startup refuses partial email uniqueness and missing session/outbox/rate TTL indexes', async () => {
  await expect(assertRetentionIndexes()).resolves.toBeUndefined();
  const spy = jest.spyOn(User.collection, 'indexes').mockResolvedValueOnce([{ unique: true, key: { email: 1 }, partialFilterExpression: { role: 'user' } }]);
  try { await expect(assertAuthIndexes()).rejects.toThrow('Required authentication indexes missing'); }
  finally { spy.mockRestore(); }
  await AuthSession.collection.dropIndex('expiresAt_1');
  try { await expect(assertRetentionIndexes()).rejects.toThrow('Required retention indexes missing'); }
  finally { await AuthSession.createIndexes(); }
});

test('session cookies are host-only Secure HttpOnly SameSite Strict and access lifetime is bounded', async () => {
  await user(); const b = await browser(); const res = await login(b);
  for (const value of res.headers['set-cookie']) {
    expect(value).toContain('HttpOnly'); expect(value).toContain('Secure'); expect(value).toContain('SameSite=Strict');
    expect(value).toContain('Path=/'); expect(value).not.toMatch(/Domain=/i);
  }
  const claims = jwt.verify(b.jar[cookies.access], config.JWT_SECRET);
  expect(logger).toHaveBeenCalledWith('audit_login', expect.objectContaining({ requestId: res.headers['x-request-id'], actorId: String(claims.sub), outcome: 'success' }));
  expect(claims.exp - claims.iat).toBe(900);
  expect(claims).toMatchObject({ iss: 'ucf-lost-found', aud: 'ucf-lost-found-api', ver: 0 });
  const stored = await AuthSession.findById(claims.sid).select('+currentHash +consumedHashes');
  const raw = b.jar[cookies.refresh].split('.')[1];
  expect(stored.currentHash).toBe(hash(raw));
  expect(JSON.stringify(await AuthSession.collection.findOne({ _id: claims.sid }))).not.toContain(raw);
  expect(res.text).not.toContain(email); expect(res.text).not.toContain('token');
});

test('refresh rotates, preserves absolute expiry, and reuse revokes the entire family immediately', async () => {
  await user(); const b = await browser(); await login(b);
  const old = b.jar[cookies.refresh];
  const familyId = old.split('.')[0];
  const expiry = (await AuthSession.findById(familyId)).expiresAt;
  expect((await post(b, 'refresh')).status).toBe(200);
  expect(b.jar[cookies.refresh]).not.toBe(old);
  expect((await AuthSession.findById(familyId)).expiresAt).toEqual(expiry);
  expect((await me(b)).status).toBe(200);
  const replay = { ...b, jar: { ...b.jar, [cookies.refresh]: old } };
  expect((await post(replay, 'refresh')).status).toBe(401);
  expect((await me(b)).status).toBe(401);
  expect((await post(b, 'refresh')).status).toBe(401);
  expect((await AuthSession.findById(familyId)).revoked).toBe(true);
  expect(logger).toHaveBeenCalledWith('audit_refresh_reuse', expect.objectContaining({ outcome: 'revoked' }));
});

test('simultaneous refresh requests fail closed and revoke the winning token too', async () => {
  await user(); const b = await browser(); await login(b);
  const familyId = b.jar[cookies.refresh].split('.')[0];
  const a = { ...b, jar: { ...b.jar } }, c = { ...b, jar: { ...b.jar } };
  const responses = await Promise.all([post(a, 'refresh'), post(c, 'refresh')]);
  expect(responses.some(r => r.status === 401)).toBe(true);
  expect((await AuthSession.findById(familyId)).revoked).toBe(true);
  expect((await me(a)).status).toBe(401); expect((await me(c)).status).toBe(401);
});

test('unknown refresh secrets cannot revoke another family; expired and malformed tokens fail', async () => {
  await user(); const b = await browser(); await login(b);
  const valid = b.jar[cookies.refresh]; const familyId = valid.split('.')[0];
  const attacker = { ...b, jar: { ...b.jar, [cookies.refresh]: `${familyId}.${token()}` } };
  expect((await post(attacker, 'refresh')).status).toBe(401);
  expect((await AuthSession.findById(familyId)).revoked).toBe(false);
  expect((await me(b)).status).toBe(200);
  await AuthSession.updateOne({ _id: familyId }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  expect((await post(b, 'refresh')).status).toBe(401);
  b.jar[cookies.refresh] = 'malformed';
  expect((await post(b, 'refresh')).status).toBe(401);
});

test('logout revokes only its own family, clears cookies and rejects saved access tokens', async () => {
  await user(); const a = await browser(), b = await browser(); await login(a); await login(b);
  const saved = { ...a, jar: { ...a.jar } };
  const res = await post(a, 'logout');
  expect(res.status).toBe(204);
  expect(res.headers['set-cookie'].every(value => value.includes('Expires=Thu, 01 Jan 1970'))).toBe(true);
  expect((await me(saved)).status).toBe(401);
  expect((await post(saved, 'refresh')).status).toBe(401);
  expect((await me(b)).status).toBe(200);
  expect((await post(await browser(), 'logout')).status).toBe(204);
});

test('password reset is generic at request, hashed, one-use, and invalidates every existing session', async () => {
  const u = await user(); const a = await browser(), b = await browser(); await login(a); await login(b);
  const known = await post(a, 'forgot-password', { email });
  const unknown = await post(a, 'forgot-password', { email: 'missing@ucf.edu' });
  expect(known.status).toBe(202); expect(known.body).toEqual(unknown.body);
  const raw = mailToken();
  const saved = await User.findById(u._id).select('+resetTokenHash +resetTokenExpiry');
  expect(saved.resetTokenHash).toBe(hash(raw));
  expect(saved.resetTokenExpiry - Date.now()).toBeGreaterThan(29 * 60 * 1000);
  const old = { ...a, jar: { ...a.jar } };
  expect((await post(a, 'reset-password', { token: raw, password: secondPassword })).status).toBe(200);
  expect((await me(old)).status).toBe(401); expect((await me(b)).status).toBe(401);
  expect((await post(b, 'refresh')).status).toBe(401);
  expect((await post(a, 'reset-password', { token: raw, password: secondPassword })).status).toBe(400);
  expect((await post(a, 'login', { email, password })).status).toBe(401);
  await login(a, { password: secondPassword });
  const current = await User.findById(u._id).select('+authVersion +resetTokenHash');
  expect(current.authVersion).toBe(1); expect(current.resetTokenHash).toBeUndefined();
});

test('expired reset tokens and weak replacement passwords cannot change credentials', async () => {
  const raw = token();
  await user({ resetTokenHash: hash(raw), resetTokenExpiry: new Date(Date.now() - 1) });
  const b = await browser();
  expect((await post(b, 'reset-password', { token: raw, password: secondPassword })).status).toBe(400);
  expect((await post(b, 'reset-password', { token: raw, password: 'password123456' })).status).toBe(400);
  await login(b);
});

test('concurrent reset submissions consume the token exactly once', async () => {
  const raw = token(); await user({ resetTokenHash: hash(raw), resetTokenExpiry: new Date(Date.now() + 60000) });
  const b = await browser();
  const responses = await Promise.all([post({ ...b, jar: { ...b.jar } }, 'reset-password', { token: raw, password: secondPassword }), post({ ...b, jar: { ...b.jar } }, 'reset-password', { token: raw, password: secondPassword })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
});

test('unverified accounts and MFA-enabled accounts cannot bypass login or refresh', async () => {
  const u = await user(); const b = await browser(); await login(b);
  await User.updateOne({ _id: u._id }, { $set: { 'mfa.enabled': true } });
  expect((await post(b, 'login', { email, password })).status).toBe(401);
  expect((await post(b, 'refresh')).status).toBe(401);
});

test('a database-side ban or credential-version change invalidates access immediately', async () => {
  const u = await user(); const b = await browser(); await login(b);
  await User.updateOne({ _id: u._id }, { $set: { isBanned: true } });
  expect((await me(b)).status).toBe(401);
  await User.updateOne({ _id: u._id }, { $set: { isBanned: false }, $inc: { authVersion: 1 } });
  expect((await me(b)).status).toBe(401);
});

test('access rejects expired, tampered, wrong-audience, wrong-issuer and wrong-algorithm JWTs', async () => {
  const u = await user(); const b = await browser(); await login(b);
  const valid = jwt.decode(b.jar[cookies.access]);
  const { exp, iat, ...payload } = valid;
  const variants = [
    jwt.sign({ ...payload }, config.JWT_SECRET, { algorithm: 'HS256', expiresIn: -1 }),
    jwt.sign({ ...payload, aud: 'other' }, config.JWT_SECRET),
    jwt.sign({ ...payload, iss: 'other' }, config.JWT_SECRET),
    jwt.sign({ ...payload }, config.JWT_SECRET, { algorithm: 'HS384' }),
    jwt.sign({ ...payload }, randomBytes(48).toString('hex')),
    jwt.sign({ ...payload, sub: String(u._id), sid: 'bad' }, config.JWT_SECRET),
  ];
  for (const access of variants) { b.jar[cookies.access] = access; expect((await me(b)).status).toBe(401); }
  expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${variants[0]}`)).status).toBe(401);
});

test('CSRF requires signed cookie, matching header, exact Origin and JSON on every mutation', async () => {
  const b = await browser();
  const payload = { email, password, displayName: 'Knight' };
  const missing = await request(app).post('/api/auth/register').send(payload);
  expect(missing.status).toBe(403);
  expect((await request(app).post('/api/auth/register').set('Cookie', cookieHeader(b.jar)).set('Origin', config.CLIENT_ORIGIN).send(payload)).status).toBe(403);
  expect((await request(app).post('/api/auth/register').set('Cookie', cookieHeader(b.jar)).set('X-CSRF-Token', b.csrf).send(payload)).status).toBe(403);
  expect((await post(b, 'register', payload, { Origin: 'https://evil.example' })).status).toBe(403);
  const forged = 'a'.repeat(64) + '.1700000000000.' + 'b'.repeat(64);
  const attacker = { ...b, csrf: forged, jar: { [cookies.csrf]: forged } };
  expect((await post(attacker, 'register', payload)).status).toBe(403);
  expect((await request(app).post('/api/auth/register').set('Cookie', cookieHeader(b.jar)).set('Origin', config.CLIENT_ORIGIN).set('X-CSRF-Token', b.csrf).type('form').send('email=x')).status).toBe(415);
  expect(await User.countDocuments()).toBe(0);
  for (const path of ['register', 'login', 'refresh', 'logout', 'forgot-password', 'reset-password', 'verify-email', 'resend-verification']) expect((await request(app).post(`/api/auth/${path}`).send({})).status).toBe(403);
});

test('separate persistent per-IP limits are not bypassed by spoofed proxy headers', async () => {
  const limited = createApp(config, { logger, mailer: { send: async message => inbox.push(message) }, rateLimits: { login: 2, register: 1, reset: 1, verify: 1, refresh: 1 } });
  const b = await browser(limited);
  for (let i = 0; i < 2; i++) expect((await post(b, 'login', { email, password }, { 'X-Forwarded-For': `1.2.3.${i}` })).status).toBe(401);
  const throttled = await post(b, 'login', { email, password }, { 'X-Forwarded-For': '9.9.9.9' });
  expect(throttled.status).toBe(429); expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  expect((await post(b, 'register', { email, password, displayName: 'Knight' })).status).toBe(202);
  expect((await post(b, 'register', { email: 'other@ucf.edu', password, displayName: 'Other' })).status).toBe(429);
  expect((await post(b, 'forgot-password', { email })).status).toBe(202);
  expect((await post(b, 'forgot-password', { email })).status).toBe(429);
  expect((await post(b, 'verify-email', { token: token() })).status).toBe(400);
  expect((await post(b, 'verify-email', { token: token() })).status).toBe(429);
  expect((await post(b, 'refresh')).status).toBe(401);
  expect((await post(b, 'refresh')).status).toBe(429);
  // A separate Express instance shares Mongo counters, so process restarts do not reset throttles.
  const other = createApp(config, { logger, mailer: { send: async () => {} }, rateLimits: { login: 2 } });
  expect((await post({ ...b, target: other }, 'login', { email, password })).status).toBe(429);
});

test('logs and audit events contain no passwords, emails or raw tokens', async () => {
  await user(); const b = await browser(); await login(b);
  await post(b, 'forgot-password', { email });
  const logged = JSON.stringify(logger.mock.calls);
  for (const secret of [email, password, b.jar[cookies.access], b.jar[cookies.refresh], b.csrf, mailToken()]) expect(logged).not.toContain(secret);
  expect(logger).toHaveBeenCalledWith('audit_login', expect.objectContaining({ outcome: 'success', actorId: expect.any(String) }));
});

test('mail delivery failure does not enumerate accounts or leak SMTP credentials', async () => {
  const failing = createApp(config, { logger, mailer: { send: async () => { throw new Error('SMTP private credential'); } } });
  const b = await browser(failing);
  const res = await post(b, 'register', { email, password, displayName: 'Knight' });
  expect(res.status).toBe(202);
  expect(res.text).not.toContain('SMTP'); expect(JSON.stringify(logger.mock.calls)).not.toContain('private credential');
  expect((await post(b, 'resend-verification', { email })).status).toBe(202);
});

test('database uniqueness and select:false projections are actually enforced', async () => {
  await expect(assertAuthIndexes()).resolves.toBeUndefined();
  await user(); await expect(user()).rejects.toHaveProperty('code', 11000);
  const record = await User.findOne({ email }).lean();
  for (const key of ['email', 'passwordHash', 'authVersion', 'resetTokenHash', 'refreshTokenHashes', 'mfa', 'failedLoginCount']) expect(record[key]).toBeUndefined();
});

test('production index check rejects a missing or nonunique email index', async () => {
  const spy = jest.spyOn(User.collection, 'indexes').mockResolvedValue([{ key: { email: 1 }, unique: false }]);
  try { await expect(assertAuthIndexes()).rejects.toThrow('Required authentication indexes missing'); }
  finally { spy.mockRestore(); }
});

test('reset reissue invalidates the previous token and cannot verify an unverified email', async () => {
  await user({ emailVerified: false }); const b = await browser();
  await post(b, 'forgot-password', { email }); const old = mailToken();
  await post(b, 'forgot-password', { email }); const current = mailToken();
  expect(current).not.toBe(old);
  expect((await post(b, 'reset-password', { token: old, password: secondPassword })).status).toBe(400);
  expect((await post(b, 'reset-password', { token: current, password: secondPassword })).status).toBe(200);
  expect((await post(b, 'login', { email, password: secondPassword })).status).toBe(401);
});

test('refresh rotation cap requires a fresh login instead of unbounded family growth', async () => {
  await user(); const b = await browser(); await login(b);
  const familyId = b.jar[cookies.refresh].split('.')[0];
  await AuthSession.updateOne({ _id: familyId }, { $set: { rotations: 1000 } });
  expect((await post(b, 'refresh')).status).toBe(401);
  expect((await AuthSession.findById(familyId)).revoked).toBe(true);
});

test('encrypted outbox decouples HTTP responses from email delivery and concurrent workers lease once', async () => {
  const queued = createApp(config, { logger, mailer: createQueuedMailer(config) });
  const b = await browser(queued);
  expect((await post(b, 'register', { email, password, displayName: 'Knight' })).status).toBe(202);
  expect(inbox).toHaveLength(0);
  const stored = await MailOutbox.collection.findOne({});
  expect(JSON.stringify(stored)).not.toContain(email);
  expect((await MailOutbox.findOne({})).payloadEncrypted).toBeUndefined();
  const send = jest.fn().mockResolvedValue(undefined);
  await Promise.all([deliverOne(config, { transport: { send }, logger }), deliverOne(config, { transport: { send }, logger })]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].to).toBe(email);
  expect(await MailOutbox.countDocuments()).toBe(0);
});

test('failed mail is retried with backoff, expired mail never delivered, and errors stay private', async () => {
  await createQueuedMailer(config).send({ to: email, text: 'private token' });
  const send = jest.fn().mockRejectedValue(new Error('SMTP secret'));
  expect(await deliverOne(config, { transport: { send }, logger })).toBe(true);
  const saved = await MailOutbox.findOne({});
  expect(saved.attempts).toBe(1); expect(saved.availableAt > new Date()).toBe(true);
  expect(await deliverOne(config, { transport: { send }, logger })).toBe(false);
  await MailOutbox.updateOne({ _id: saved._id }, { $set: { availableAt: new Date(0), expiresAt: new Date(Date.now() - 1) } });
  expect(await deliverOne(config, { transport: { send }, logger })).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(logger.mock.calls)).not.toMatch(/SMTP secret|private token/);
});

test('rate limiter fails closed on database error and generic errors do not leak internals', async () => {
  const mock = jest.spyOn(RateBucket, 'findOneAndUpdate').mockRejectedValueOnce(new Error('MongoDB private password'));
  try {
    const res = await request(app).get('/api/auth/csrf');
    expect(res.status).toBe(500); expect(res.body.error).toBe('Internal server error');
    expect(res.text).not.toContain('private password');
  } finally { mock.mockRestore(); }
});
