const express = require('express');
const request = require('supertest');
const { randomBytes, createHmac } = require('node:crypto');
const { requireRole, requireOwner, cookies } = require('../src/middleware/auth');
const { csrfProtection } = require('../src/middleware/csrf');
const { mintCsrf, validCsrf, passwordSchema } = require('../src/lib/authCrypto');
const config = { JWT_SECRET: randomBytes(48).toString('hex'), CLIENT_ORIGIN: 'https://campus.example' };

function authorizedApp(identity, owner = 'user-a') {
  const app = express();
  app.use((req, res, next) => { req.user = identity; req.resource = { author: owner }; next(); });
  app.get('/admin', requireRole('admin'), (req, res) => res.json({ ok: true }));
  app.get('/owned', requireOwner(req => req.resource.author), (req, res) => res.json({ ok: true }));
  return app;
}
test('role middleware requires identity and current admin role', async () => {
  expect((await request(authorizedApp()).get('/admin')).status).toBe(401);
  expect((await request(authorizedApp({ _id: 'user-a', role: 'user' })).get('/admin')).status).toBe(403);
  expect((await request(authorizedApp({ _id: 'user-a', role: 'admin' })).get('/admin')).status).toBe(200);
});
test('ownership middleware hides other users resources without implicit admin override', async () => {
  expect((await request(authorizedApp()).get('/owned')).status).toBe(401);
  expect((await request(authorizedApp({ _id: 'user-a', role: 'user' })).get('/owned')).status).toBe(200);
  expect((await request(authorizedApp({ _id: 'user-b', role: 'admin' })).get('/owned')).status).toBe(404);
  expect((await request(authorizedApp({ _id: 'user-a' }, null)).get('/owned')).status).toBe(404);
});
test('CSRF tokens are signed, purpose-separated, time-bounded and do not accept malformed inputs', () => {
  const value = mintCsrf(config.JWT_SECRET);
  expect(validCsrf(value, config.JWT_SECRET)).toBe(true);
  for (const invalid of [undefined, {}, '', value + 'x', value.replace(/.$/, value.endsWith('0') ? '1' : '0')]) expect(validCsrf(invalid, config.JWT_SECRET)).toBe(false);
  expect(validCsrf(value, randomBytes(48).toString('hex'))).toBe(false);
  const signed = age => {
    const part = `${randomBytes(32).toString('hex')}.${Date.now() - age}`;
    return `${part}.${createHmac('sha256', config.JWT_SECRET).update(`csrf:${part}`).digest('hex')}`;
  };
  expect(validCsrf(signed(3601000), config.JWT_SECRET)).toBe(false);
  expect(validCsrf(signed(-60000), config.JWT_SECRET)).toBe(false);
});
test('CSRF protects PATCH and DELETE as well as POST, while safe methods pass', () => {
  const middleware = csrfProtection(config);
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const next = jest.fn(); middleware({ method, headers: {}, get: () => undefined, cookies: {} }, response, next);
    expect(response.status).toHaveBeenLastCalledWith(403); expect(next).not.toHaveBeenCalled();
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const next = jest.fn(); middleware({ method }, response, next); expect(next).toHaveBeenCalled();
  }
  const csrf = mintCsrf(config.JWT_SECRET);
  const next = jest.fn();
  middleware({ method: 'PATCH', headers: { origin: config.CLIENT_ORIGIN }, cookies: { [cookies.csrf]: csrf }, get: () => csrf, is: () => true }, response, next);
  expect(next).toHaveBeenCalled();
});
test('password policy counts Unicode codepoints and rejects bcrypt truncation and embedded NUL', () => {
  for (const value of ['🌙'.repeat(6), 'a'.repeat(73), 'many different characters\0 secret', '123456789012', 'password123456']) expect(passwordSchema.safeParse(value).success).toBe(false);
  expect(passwordSchema.safeParse('A long campus passphrase 55!').success).toBe(true);
  expect(passwordSchema.safeParse('a🌙b🌙c🌙d🌙e🌙f🌙').success).toBe(true);
});
