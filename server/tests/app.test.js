const request = require('supertest');
const { createApp } = require('../src/app');
const logger = jest.fn();
const app = createApp({ CLIENT_ORIGIN: 'https://campus.example' }, { logger });
test('health response has strict security headers', async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
  expect(res.headers['x-powered-by']).toBeUndefined();
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  expect(res.headers['strict-transport-security']).toBeDefined();
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-request-id']).toBeDefined();
});
test('single origin credentialed CORS', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'https://campus.example');
  expect(res.headers['access-control-allow-origin']).toBe('https://campus.example');
  expect(res.headers['access-control-allow-credentials']).toBe('true');
  expect((await request(app).get('/api/health').set('Origin', 'https://evil.example')).status).toBe(403);
  expect((await request(app).options('/api/health').set('Origin', 'null')).status).toBe(403);
});
test.each(['/api/health?unexpected=1', '/api/health?a=1&a=2', '/api/health?%24where=attack', '/api/health?user.name=attack'])('reject invalid query %s', async url => expect((await request(app).get(url)).status).toBe(400));
test.each([{ unexpected: true }, { $ne: null }, { nested: { 'a.b': 1 } }])('reject unexpected or operator body %j', async body => expect((await request(app).get('/api/health').send(body)).status).toBe(400));
test('malformed JSON and oversized bodies use generic errors', async () => {
  const malformed = await request(app).post('/api/missing').set('Content-Type', 'application/json').send('{"password":');
  expect(malformed.status).toBe(400);
  expect(malformed.text).not.toContain('password');
  const large = await request(app).post('/api/missing').send({ data: 'a'.repeat(40000) });
  expect(large.status).toBe(413);
});
test('404 does not echo attacker-controlled URLs', async () => {
  const res = await request(app).get('/secret-token');
  expect(res.status).toBe(404);
  expect(res.text).not.toContain('secret-token');
  expect(JSON.stringify(logger.mock.calls)).not.toContain('secret-token');
});
