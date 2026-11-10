const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../src/app');
const { User } = require('../src/models');
const { AuthSession, RateBucket } = require('../src/models/auth');
const { mintCsrf, hashPassword, token, hash } = require('../src/lib/authCrypto');
const { authenticator, mfaSelection, decryptSecret } = require('../src/lib/mfa');
const { cookies } = require('../src/middleware/auth');
const { runPostCleanup } = require('../src/jobs/postCleanup');
jest.setTimeout(120000);
const config = { NODE_ENV: 'test', CLIENT_ORIGIN: 'https://campus.example', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ACCESS_TOKEN_TTL_SECONDS: 900, POST_RETENTION_DAYS: 90 };
const password = 'A campus MFA fixture passphrase 47!';
let mongo, app, logger, passwordHash, serial = 0;
const parse = res => Object.fromEntries((res.headers['set-cookie'] || []).map(row => { const [name, ...parts] = row.split(';')[0].split('='); return [name, decodeURIComponent(parts.join('='))]; }));
const header = actor => Object.entries(actor.jar).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
async function identity(overrides = {}) {
  const email = `mfa${++serial}@ucf.edu`, user = await User.create({ email, displayName: `MFA Knight ${serial}`, passwordHash, emailVerified: true, ...overrides });
  const sid = token(), raw = token(), csrf = mintCsrf(config.JWT_SECRET);
  await AuthSession.create({ _id: sid, user: user._id, authVersion: 0, currentHash: hash(raw), expiresAt: new Date(Date.now() + 86400000) });
  const access = jwt.sign({ sid, ver: 0 }, config.JWT_SECRET, { subject: String(user._id), issuer: 'ucf-lost-found', audience: 'ucf-lost-found-api', expiresIn: 900 });
  return { user, email, sid, jar: { [cookies.access]: access, [cookies.refresh]: `${sid}.${raw}`, [cookies.csrf]: csrf }, csrf };
}
async function mutate(actor, path, body = {}, method = 'post') {
  const res = await request(app)[method](path).set('Origin', config.CLIENT_ORIGIN).set('Cookie', header(actor)).set('X-CSRF-Token', actor.csrf).send(body);
  Object.assign(actor.jar, parse(res)); return res;
}
const get = (actor, path) => request(app).get(path).set('Cookie', header(actor));
const start = actor => mutate(actor, '/api/mfa/enrollment', { password });
const login = (actor, code, override = {}) => mutate(actor, '/api/auth/login', { email: actor.email, password, ...(code ? { code } : {}), ...override });
const otp = (seed, offset = 0) => authenticator(seed).generate({ timestamp: Date.now() + offset * 30000 });
async function enable(actor) {
  const enrollment = await start(actor); expect(enrollment.status).toBe(200);
  const confirmed = await mutate(actor, '/api/mfa/confirm', { password, enrollmentId: enrollment.body.enrollmentId, code: otp(enrollment.body.secret) }); expect(confirmed.status).toBe(200);
  return { ...enrollment.body, ...confirmed.body };
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }); mongoose.set('sanitizeFilter', true); mongoose.set('strictQuery', true); await mongoose.connect(mongo.getUri());
  await Promise.all([User, AuthSession, RateBucket].map(model => model.init())); passwordHash = await hashPassword(password);
  logger = jest.fn(); app = createApp(config, { logger, mailer: { send: async () => {} } });
});
beforeEach(async () => { for (const model of [User, AuthSession, RateBucket]) await model.deleteMany({}); logger.mockClear(); });
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('private enrollment returns only a fresh seed/QR and stores a purpose-bound encrypted ten-minute pending secret', async () => {
  const actor = await identity(), before = Date.now(), res = await start(actor); expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/); expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/); expect(res.body.enrollmentId).toMatch(/^[a-f0-9]{64}$/);
  expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(before + 9 * 60000);
  const user = await User.findById(actor.user._id).select(mfaSelection); expect(user.mfa.enabled).toBe(false); expect(user.mfa.pending.secretEncrypted).not.toContain(res.body.secret);
  expect(decryptSecret(user.mfa.pending.secretEncrypted, user._id, `pending:${res.body.enrollmentId}`, config)).toBe(res.body.secret);
  expect((await get(actor, '/api/mfa')).body).toEqual({ enabled: false, backupCodesRemaining: 0 });
  expect((await login(actor)).status).toBe(200);
});

test('confirm activates MFA, consumes its code, issues one-time backup codes, and revokes all older families', async () => {
  const actor = await identity(), stale = { ...actor, jar: { ...actor.jar } }, result = await enable(actor);
  expect(result.backupCodes).toHaveLength(10); expect(new Set(result.backupCodes).size).toBe(10);
  expect((await get(stale, '/api/auth/me')).status).toBe(401); expect((await mutate(stale, '/api/auth/refresh')).status).toBe(401);
  expect((await get(actor, '/api/auth/me')).status).toBe(200);
  const current = await User.findById(actor.user._id).select(mfaSelection); expect(current.mfa.enabled).toBe(true); expect(current.mfa.pending).toBeUndefined(); expect(current.mfa.lastUsedStep).toBeGreaterThan(0);
  expect(current.mfa.backupCodeHashes).toHaveLength(10); expect(JSON.stringify(current.mfa.backupCodeHashes)).not.toContain(result.backupCodes[0]);
  expect(decryptSecret(current.mfa.secretEncrypted, current._id, 'active', config)).toBe(result.secret);
  expect((await AuthSession.findById(actor.sid)).revoked).toBe(true);
  expect((await login(actor, otp(result.secret))).status).toBe(401); // Enrollment code is already spent.
});

test('missing/wrong factors and unknown/disabled accounts use the same generic login failure without cookies', async () => {
  const actor = await identity(), result = await enable(actor);
  const failures = [await login(actor), await login(actor, '000000'), await login(actor, result.backupCodes[0], { password: 'wrong password' }), await login(actor, result.backupCodes[0], { email: 'unknown@ucf.edu' })];
  for (const res of failures) { expect(res.status).toBe(401); expect(res.body.error).toBe('Authentication failed'); expect(res.headers['set-cookie']).toBeUndefined(); }
  const user = await User.findById(actor.user._id).select(mfaSelection); expect(user.mfa.backupCodeHashes).toHaveLength(10);
});

test('an unused authenticator step grants an MFA-proven session which can refresh', async () => {
  const actor = await identity(), result = await enable(actor);
  expect((await login(actor, otp(result.secret, 1))).status).toBe(200);
  const sid = actor.jar[cookies.refresh].split('.')[0], family = await AuthSession.findById(sid); expect(family.mfaAuthenticated).toBe(true);
  expect((await get(actor, '/api/auth/me')).status).toBe(200); expect((await mutate(actor, '/api/auth/refresh')).status).toBe(200);
});

test.each(['totp', 'backup'])('concurrent %s replays grant at most one session', async kind => {
  const actor = await identity(), result = await enable(actor), code = kind === 'totp' ? otp(result.secret, 1) : result.backupCodes[0];
  const clone = () => ({ ...actor, jar: { ...actor.jar } });
  const responses = await Promise.all([login(clone(), code), login(clone(), code)]);
  expect(responses.map(res => res.status).sort()).toEqual([200, 401]);
  expect(await AuthSession.countDocuments({ user: actor.user._id, revoked: false })).toBe(2); // enrollment session plus one login
  expect((await login(clone(), code)).status).toBe(401);
});

test('concurrent replay denials commit failure counters instead of resetting them outside the session transaction', async () => {
  const actor = await identity(), result = await enable(actor), code = result.backupCodes[0];
  const copies = Array.from({ length: 4 }, () => ({ ...actor, jar: { ...actor.jar } }));
  const responses = await Promise.all(copies.map(copy => login(copy, code)));
  expect(responses.filter(res => res.status === 200)).toHaveLength(1); expect(responses.filter(res => res.status === 401)).toHaveLength(3);
  const user = await User.findById(actor.user._id).select('+failedLoginCount'); expect(user.failedLoginCount).toBe(3);
});

test('backup codes accept case/hyphen normalization, are single-use, and remain password-bound', async () => {
  const actor = await identity(), result = await enable(actor), code = result.backupCodes[0];
  expect((await login(actor, code.toLowerCase().replaceAll('-', ''))).status).toBe(200);
  expect((await get(actor, '/api/mfa')).body.backupCodesRemaining).toBe(9); expect((await login(actor, code)).status).toBe(401);
  expect((await login(actor, result.backupCodes[1], { password: 'incorrect password' })).status).toBe(401);
  expect((await login(actor, result.backupCodes[1])).status).toBe(200);
});

test('failed MFA login attempts trigger the existing account lockout and reject correct factors while locked', async () => {
  const actor = await identity(), result = await enable(actor);
  for (let i = 0; i < 5; i++) expect((await login(actor)).status).toBe(401);
  const user = await User.findById(actor.user._id).select('+failedLoginCount +lockUntil'); expect(user.failedLoginCount).toBe(5); expect(user.lockUntil.getTime()).toBeGreaterThan(Date.now());
  expect((await login(actor, result.backupCodes[0])).status).toBe(401);
});

test('MFA-sensitive status and mutations reject unauthenticated, cross-origin and missing-CSRF requests', async () => {
  const actor = await identity(); expect((await request(app).get('/api/mfa')).status).toBe(401);
  for (const [path, body] of [['enrollment', { password }], ['confirm', { password, enrollmentId: token(), code: '123456' }], ['backup-codes', { password, code: '123456' }], ['disable', { password, code: '123456' }]]) {
    expect((await request(app).post(`/api/mfa/${path}`).set('Origin', config.CLIENT_ORIGIN).set('Cookie', header(actor)).send(body)).status).toBe(403);
    expect((await request(app).post(`/api/mfa/${path}`).set('Origin', 'https://attacker.example').set('Cookie', header(actor)).set('X-CSRF-Token', actor.csrf).send(body)).status).toBe(403);
    expect((await request(app).post(`/api/mfa/${path}`).set('Origin', config.CLIENT_ORIGIN).set('Cookie', `${cookies.csrf}=${actor.csrf}`).set('X-CSRF-Token', actor.csrf).send(body)).status).toBe(401);
  }
});

test('strict validation rejects caller IDs, roles, secrets, malformed codes and query pollution', async () => {
  const actor = await identity();
  for (const body of [{ password, userId: String(actor.user._id) }, { password, secret: 'ATTACKERSECRET' }, { password: { $ne: null } }, { password, enabled: true }]) expect((await mutate(actor, '/api/mfa/enrollment', body)).status).toBe(400);
  for (const code of ['12345', '1234567', 'not-a-code', { $ne: '' }, 'x'.repeat(1000)]) expect((await login(actor, code)).status).toBe(400);
  expect((await get(actor, '/api/mfa?userId=other')).status).toBe(400);
  expect((await mutate(actor, '/api/mfa/confirm', { password, enrollmentId: 'bad', code: '123456' })).status).toBe(400);
});

test('setup and confirmation require the current password; enabled accounts cannot replace their seed through enrollment', async () => {
  const actor = await identity();
  expect((await mutate(actor, '/api/mfa/enrollment', { password: 'wrong password' })).status).toBe(401);
  const seed = await start(actor);
  expect((await mutate(actor, '/api/mfa/confirm', { password: 'wrong password', enrollmentId: seed.body.enrollmentId, code: otp(seed.body.secret) })).status).toBe(401);
  expect((await mutate(actor, '/api/mfa/confirm', { password, enrollmentId: seed.body.enrollmentId, code: otp(seed.body.secret) })).status).toBe(200);
  expect((await start(actor)).status).toBe(409);
});

test('expired, replaced, incorrect, foreign and already-confirmed enrollment proofs cannot enable MFA', async () => {
  const actor = await identity(), other = await identity(), first = await start(actor), second = await start(actor);
  const confirm = (who, enrollmentId, code) => mutate(who, '/api/mfa/confirm', { password, enrollmentId, code });
  expect((await confirm(actor, first.body.enrollmentId, otp(first.body.secret))).status).toBe(401);
  expect((await confirm(other, second.body.enrollmentId, otp(second.body.secret))).status).toBe(401);
  expect((await confirm(actor, second.body.enrollmentId, '000000')).status).toBe(401);
  await User.updateOne({ _id: actor.user._id }, { $set: { 'mfa.pending.expiresAt': new Date(0) } });
  expect((await confirm(actor, second.body.enrollmentId, otp(second.body.secret))).status).toBe(401);
  const third = await start(actor); expect((await confirm(actor, third.body.enrollmentId, otp(third.body.secret))).status).toBe(200);
  expect((await confirm(actor, third.body.enrollmentId, otp(third.body.secret))).status).toBe(401);
});

test('expired pending secrets are removed by cleanup without deleting the account', async () => {
  const actor = await identity(); await start(actor);
  await User.updateOne({ _id: actor.user._id }, { $set: { 'mfa.pending.expiresAt': new Date(0) } });
  await runPostCleanup({ storage: { remove: async () => {} }, logger });
  const user = await User.findById(actor.user._id).select(mfaSelection); expect(user).toBeTruthy(); expect(user.mfa.pending).toBeUndefined();
});

test('backup replacement consumes a factor, invalidates every old code/session and shows the replacement set only once', async () => {
  const actor = await identity(), result = await enable(actor), stale = { ...actor, jar: { ...actor.jar } };
  const res = await mutate(actor, '/api/mfa/backup-codes', { password, code: result.backupCodes[0] }); expect(res.status).toBe(200); expect(res.body.backupCodes).toHaveLength(10);
  expect((await get(stale, '/api/auth/me')).status).toBe(401); expect((await login(actor, result.backupCodes[1])).status).toBe(401);
  expect((await login(actor, res.body.backupCodes[0])).status).toBe(200);
  expect((await get(actor, '/api/mfa')).body).toEqual({ enabled: true, backupCodesRemaining: 9 });
});

test('disabling requires password and a fresh factor, erases all MFA material and revokes old sessions', async () => {
  const actor = await identity(), result = await enable(actor), stale = { ...actor, jar: { ...actor.jar } };
  expect((await mutate(actor, '/api/mfa/disable', { password: 'wrong password', code: result.backupCodes[0] })).status).toBe(401);
  expect((await mutate(actor, '/api/mfa/disable', { password, code: '000000' })).status).toBe(401);
  expect((await mutate(actor, '/api/mfa/disable', { password, code: result.backupCodes[0] })).status).toBe(200);
  const user = await User.findById(actor.user._id).select(mfaSelection); expect(user.mfa.enabled).toBe(false); expect(user.mfa.secretEncrypted).toBeUndefined(); expect(user.mfa.pending).toBeUndefined(); expect(user.mfa.backupCodeHashes).toHaveLength(0);
  expect((await get(stale, '/api/auth/me')).status).toBe(401); expect((await login(actor)).status).toBe(200);
});

test('failed session creation rolls back enrollment confirmation, backup-code consumption and code replacement', async () => {
  const actor = await identity(), seed = await start(actor);
  let spy = jest.spyOn(AuthSession, 'create').mockRejectedValueOnce(new Error('private session failure'));
  expect((await mutate(actor, '/api/mfa/confirm', { password, enrollmentId: seed.body.enrollmentId, code: otp(seed.body.secret) })).status).toBe(500); spy.mockRestore();
  let user = await User.findById(actor.user._id).select(mfaSelection); expect(user.mfa.enabled).toBe(false); expect(user.mfa.pending).toBeTruthy();
  const result = await enable(actor), before = (await User.findById(actor.user._id).select(mfaSelection)).mfa.backupCodeHashes.slice();
  spy = jest.spyOn(AuthSession, 'create').mockRejectedValueOnce(new Error('private failure'));
  expect((await mutate(actor, '/api/mfa/backup-codes', { password, code: result.backupCodes[0] })).status).toBe(500); spy.mockRestore();
  user = await User.findById(actor.user._id).select(mfaSelection); expect(user.mfa.backupCodeHashes).toEqual(before);
  expect((await get(actor, '/api/auth/me')).status).toBe(200); expect((await login(actor, result.backupCodes[0])).status).toBe(200);
});

test('a failed MFA login session write does not spend the backup code', async () => {
  const actor = await identity(), result = await enable(actor), spy = jest.spyOn(AuthSession, 'create').mockRejectedValueOnce(new Error('failure'));
  expect((await login(actor, result.backupCodes[0])).status).toBe(500); spy.mockRestore();
  expect((await login(actor, result.backupCodes[0])).status).toBe(200);
});

test('MFA secrets, canonical hashes, backup codes and QR content never appear in ordinary DTOs or audit logs', async () => {
  const actor = await identity(), result = await enable(actor);
  const user = await User.findById(actor.user._id).select(mfaSelection);
  const output = JSON.stringify([(await get(actor, '/api/auth/me')).body, (await get(actor, '/api/mfa')).body, user.toJSON(), logger.mock.calls]);
  for (const secret of [result.secret, result.qrDataUrl, result.enrollmentId, result.backupCodes[0], user.mfa.secretEncrypted, user.mfa.backupCodeHashes[0]]) expect(output).not.toContain(secret);
  expect(output).not.toContain(password); expect(output).not.toContain(actor.email);
});

test('ciphertext corruption and cross-user transplantation fail closed without disclosing envelopes', async () => {
  const a = await identity(), b = await identity(), result = await enable(a); await enable(b);
  const source = await User.findById(a.user._id).select(mfaSelection);
  await User.updateOne({ _id: b.user._id }, { $set: { 'mfa.secretEncrypted': source.mfa.secretEncrypted } });
  const res = await login(b, otp(result.secret, 1)); expect(res.status).toBe(500); expect(JSON.stringify(res.body)).not.toContain(source.mfa.secretEncrypted);
  expect(JSON.stringify(logger.mock.calls)).not.toContain(source.mfa.secretEncrypted);
});

test('legacy/unproven session families cannot authenticate or refresh an MFA-enabled account', async () => {
  const actor = await identity(), result = await enable(actor), sid = actor.jar[cookies.refresh].split('.')[0];
  await AuthSession.updateOne({ _id: sid }, { $set: { mfaAuthenticated: false } });
  expect((await get(actor, '/api/auth/me')).status).toBe(401); expect((await mutate(actor, '/api/auth/refresh')).status).toBe(401);
  expect((await login(actor, result.backupCodes[0])).status).toBe(200);
});

test('password reset preserves active MFA, clears pending enrollment and never grants an MFA bypass', async () => {
  const actor = await identity(), result = await enable(actor), raw = token();
  await User.updateOne({ _id: actor.user._id }, { $set: { resetTokenHash: hash(raw), resetTokenExpiry: new Date(Date.now() + 60000) } });
  const nextPassword = 'Updated MFA campus passphrase 53!';
  expect((await mutate(actor, '/api/auth/reset-password', { token: raw, password: nextPassword })).status).toBe(200);
  expect((await login(actor, undefined, { password: nextPassword })).status).toBe(401);
  expect((await login(actor, result.backupCodes[0], { password: nextPassword })).status).toBe(200);
  const pending = await identity(), seed = await start(pending), reset = token();
  await User.updateOne({ _id: pending.user._id }, { $set: { resetTokenHash: hash(reset), resetTokenExpiry: new Date(Date.now() + 60000) } });
  expect((await mutate(pending, '/api/auth/reset-password', { token: reset, password: nextPassword })).status).toBe(200);
  expect((await User.findById(pending.user._id).select(mfaSelection)).mfa.pending).toBeUndefined();
});

test('MFA account deletion requires a factor and erases the active seed and backup codes', async () => {
  const actor = await identity(), result = await enable(actor), body = { password, confirmation: 'DELETE' };
  expect((await mutate(actor, '/api/account', body, 'delete')).status).toBe(401);
  expect((await mutate(actor, '/api/account', { ...body, code: result.backupCodes[0] }, 'delete')).status).toBe(204);
  expect(await User.exists({ _id: actor.user._id })).toBeNull(); expect(await AuthSession.countDocuments({ user: actor.user._id })).toBe(0);
});

test('persistent per-account management limits apply across IPs and across different MFA operations', async () => {
  const actor = await identity();
  for (let i = 0; i < 10; i++) expect((await mutate(actor, '/api/mfa/enrollment', { password: 'incorrect password' })).status).toBe(401);
  expect((await mutate(actor, '/api/mfa/enrollment', { password })).status).toBe(429);
  expect((await mutate(actor, '/api/mfa/disable', { password, code: '123456' })).status).toBe(429);
  expect((await get(actor, '/api/mfa')).status).toBe(200);
});
