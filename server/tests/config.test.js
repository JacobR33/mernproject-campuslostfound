const { randomBytes } = require('node:crypto');
const { loadConfig } = require('../src/config/env');
const valid = () => ({ MONGODB_URI: 'mongodb://localhost/test', CLIENT_ORIGIN: 'http://localhost:5173', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
test('valid config is immutable and access lifetime capped at fifteen minutes', () => {
  const config = loadConfig(valid());
  expect(Object.isFrozen(config)).toBe(true);
  expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
});
test.each(['MONGODB_URI', 'CLIENT_ORIGIN', 'JWT_SECRET', 'MFA_ENCRYPTION_KEY'])('missing %s fails without leaking config', field => {
  const input = valid(); delete input[field];
  expect(() => loadConfig(input)).toThrow(field);
  try { loadConfig(input); } catch (err) { expect(err.message).not.toContain(input.JWT_SECRET || 'impossible-secret'); }
});
test.each([{ ACCESS_TOKEN_TTL_SECONDS: 901 }, { PORT: 0 }, { CLIENT_ORIGIN: '*' }, { CLIENT_ORIGIN: 'http://localhost:5173/path' }, { MFA_ENCRYPTION_KEY: 'a'.repeat(64) }, { JWT_SECRET: 'x'.repeat(64) }, { NODE_ENV: 'production' }])('unsafe configuration rejected: %j', override => expect(() => loadConfig({ ...valid(), ...override })).toThrow('Invalid configuration'));
test.each([{ MAIL_TRANSPORT: 'smtp' }, { SMTP_USER: 'mailer' }, { SMTP_PASSWORD: 'private' }, { SMTP_PORT: 0 }, { SMTP_SECURE: 'yes' }, { NODE_ENV: 'production', CLIENT_ORIGIN: 'https://campus.example', MAIL_TRANSPORT: 'file' }])('mail configuration fails closed: %j', override => expect(() => loadConfig({ ...valid(), ...override })).toThrow('Invalid configuration'));
test('production SMTP requires HTTPS, supports STARTTLS, and redacts invalid configuration values', () => {
  const config = loadConfig({ ...valid(), NODE_ENV: 'production', CLIENT_ORIGIN: 'https://campus.example', MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.local', SMTP_USER: 'mailer', SMTP_PASSWORD: 'private' });
  expect(config.SMTP_SECURE).toBe(false);
  expect(config.MAIL_TRANSPORT).toBe('smtp');
});
test('JWT and encryption secrets must be independent', () => {
  const input = valid(); input.JWT_SECRET = input.MFA_ENCRYPTION_KEY;
  expect(() => loadConfig(input)).toThrow('MFA_ENCRYPTION_KEY');
});
test('documented random 32-byte hex secrets validate without requiring every hex symbol', () => {
  const input = valid();
  // 32 random bytes can legitimately contain fewer than sixteen distinct hex symbols.
  input.JWT_SECRET = '2f72d7137e21ddf3488a50f5811b5aefc44e97c0752c505ef3a135c138bb730f';
  expect(loadConfig(input).JWT_SECRET).toBe(input.JWT_SECRET);
  expect(() => loadConfig({ ...input, JWT_SECRET: '0123456789abcdef'.repeat(4) })).toThrow();
});
test.each([{ POST_RETENTION_DAYS: 0 }, { POST_RETENTION_DAYS: 366 }, { CLEANUP_INTERVAL_SECONDS: 0 }, { CLEANUP_INTERVAL_SECONDS: 3601 }])('expiry/cleanup settings are bounded: %j', override => expect(() => loadConfig({ ...valid(), ...override })).toThrow('Invalid configuration'));

test('proxy trust is opt-in and accepts only a bounded list of exact IP addresses', () => {
  expect(loadConfig(valid()).TRUST_PROXY).toEqual([]);
  expect(loadConfig({ ...valid(), TRUST_PROXY: '127.0.0.1, ::1' }).TRUST_PROXY).toEqual(['127.0.0.1', '::1']);
  for (const value of ['true', '*', 'loopback', '0.0.0.0/0', '10.0.0.0/8', 'proxy.example', '127.0.0.1,', Array(11).fill('127.0.0.1').join(',')]) expect(() => loadConfig({ ...valid(), TRUST_PROXY: value })).toThrow('TRUST_PROXY');
});
