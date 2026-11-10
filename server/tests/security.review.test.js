const request = require('supertest');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { createApp } = require('../src/app');
const { createHttpServer, listen } = require('../src/lib/httpServer');
const { limitedWork } = require('../src/lib/workLimit');
const { boundedInput } = require('../src/middleware/inputBounds');
const { clientAddress } = require('../src/lib/clientAddress');
const logger = jest.fn(), app = createApp({ CLIENT_ORIGIN: 'https://campus.example' }, { logger });

test.each([
  '{"__proto__":{"polluted":"private-marker"}}',
  '{"profile":{"constructor":{"prototype":{"polluted":"private-marker"}}}}',
  '{"profile":{"prototype":"private-marker"}}',
])('dangerous object keys are rejected before sanitizer traversal', async body => {
  const res = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send(body);
  expect(res.status).toBe(400); expect(res.text).not.toContain('private-marker'); expect({}.polluted).toBeUndefined();
});

test('deep and broad JSON are rejected with generic errors before recursive middleware', async () => {
  const deep = '{"nested":'.repeat(1000) + '"private-marker"' + '}'.repeat(1000);
  const wide = { values: Array.from({ length: 1001 }, () => 'x') };
  for (const body of [deep, JSON.stringify(wide)]) {
    const res = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(400); expect(res.body.error).toBe('Invalid request');
  }
  expect(JSON.stringify(logger.mock.calls)).not.toContain('private-marker');
  expect(boundedInput({ verificationQuestions: [{ question: 'A question?', answer: 'Constructor is a legal value' }] })).toBe(true);
});

test('compressed JSON and unsupported charsets are rejected as unsupported formats without revealing bodies', async () => {
  const zipped = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send(gzipSync('{"password":"private-marker"}'));
  const charset = await request(app).post('/api/auth/register').set('Content-Type', 'application/json; charset=iso-8859-1').send('{"password":"private-marker"}');
  for (const res of [zipped, charset]) { expect(res.status).toBe(415); expect(res.body.error).toBe('Unsupported request format'); expect(res.text).not.toContain('private-marker'); }
});

test('transport has bounded headers, request deadlines and keep-alive reuse; oversized headers never reach Express', async () => {
  const server = createHttpServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    expect(server.headersTimeout).toBe(10000); expect(server.requestTimeout).toBe(30000); expect(server.keepAliveTimeout).toBe(5000); expect(server.maxRequestsPerSocket).toBe(100);
    const result = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/health', agent: false, headers: { 'X-Oversized': 'private-marker'.repeat(1000) } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
      req.on('error', reject);
    });
    expect(result.status).toBe(431); expect(result.body).not.toContain('private-marker');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('work admission rejects overflow, isolates workloads and releases capacity after failures', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const one = limitedWork('review-password', 2, () => gate), two = limitedWork('review-password', 2, () => gate);
  await expect(limitedWork('review-password', 2, () => 'must not run')).rejects.toMatchObject({ httpStatus: 503 });
  await expect(limitedWork('review-answers', 1, () => 'independent')).resolves.toBe('independent');
  release(); await Promise.all([one, two]);
  await expect(limitedWork('review-password', 2, () => { throw new Error('Failure'); })).rejects.toThrow('Failure');
  await expect(limitedWork('review-password', 2, () => 'recovered')).resolves.toBe('recovered');
});

test('occupied listen ports reject asynchronously so startup can fail closed without a raw uncaught error', async () => {
  const first = createHttpServer(app), second = createHttpServer(app); await listen(first, 0, '127.0.0.1');
  try { await expect(listen(second, first.address().port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' }); }
  finally { await new Promise(resolve => first.close(resolve)); }
});

test('HTTP and socket identity ignore untrusted forwarding and stop at the first untrusted hop', () => {
  const req = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.7' } };
  expect(clientAddress({})(req)).toBe('::ffff:127.0.0.1');
  expect(clientAddress({ TRUST_PROXY: ['127.0.0.1'] })(req)).toBe('203.0.113.7');
  expect(clientAddress({ TRUST_PROXY: ['10.0.0.1'] })(req)).toBe('::ffff:127.0.0.1');
  const trustedApp = createApp({ CLIENT_ORIGIN: 'https://campus.example', TRUST_PROXY: ['127.0.0.1'] }, { logger });
  expect(trustedApp.get('trust proxy fn')('::ffff:127.0.0.1', 0)).toBe(true);
  expect(trustedApp.get('trust proxy fn')('203.0.113.7', 1)).toBe(false);
});
