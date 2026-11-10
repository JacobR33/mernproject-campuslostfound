const { randomBytes } = require('node:crypto');
const { encryptSecret, decryptSecret, authenticator, matchingStep, newBackupCodes, backupHash } = require('../src/lib/mfa');
const config = { MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex') }, userId = 'a'.repeat(24);
// RFC 6238 Appendix B SHA-1 vectors, reduced to the configured six decimal digits.
// https://www.rfc-editor.org/rfc/rfc6238.html#appendix-B
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']])('TOTP matches the RFC vector at %s seconds', (seconds, expected) => {
  expect(authenticator(secret).generate({ timestamp: seconds * 1000 })).toBe(expected);
  expect(matchingStep(secret, expected, seconds * 1000)).toBe(Math.floor(seconds / 30));
});
test('validation accepts only the adjacent 30-second steps and exactly six digits', () => {
  const timestamp = 1234567890000, otp = authenticator(secret);
  for (const offset of [-1, 0, 1]) expect(matchingStep(secret, otp.generate({ timestamp: timestamp + offset * 30000 }), timestamp)).toBe(Math.floor(timestamp / 30000) + offset);
  for (const offset of [-2, 2]) expect(matchingStep(secret, otp.generate({ timestamp: timestamp + offset * 30000 }), timestamp)).toBeNull();
  for (const value of ['12345', '1234567', 'abcdef', '<script>', '']) expect(matchingStep(secret, value, timestamp)).toBeNull();
});
test('encryption uses unique nonces, binds user/purpose and authenticates ciphertext, tag and key', () => {
  const first = encryptSecret(secret, userId, 'active', config), second = encryptSecret(secret, userId, 'active', config);
  expect(first).not.toBe(second); expect(first).not.toContain(secret); expect(decryptSecret(first, userId, 'active', config)).toBe(secret);
  for (const [id, purpose, key] of [['b'.repeat(24), 'active', config], [userId, 'pending:abc', config], [userId, 'active', { MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex') }]]) expect(() => decryptSecret(first, id, purpose, key)).toThrow();
  const parts = first.split('.');
  for (const index of [1, 2, 3]) { const corrupt = [...parts]; corrupt[index] = (corrupt[index][0] === 'a' ? 'b' : 'a') + corrupt[index].slice(1); expect(() => decryptSecret(corrupt.join('.'), userId, 'active', config)).toThrow(); }
  for (const value of ['', 'v2.invalid', first + '.extra']) expect(() => decryptSecret(value, userId, 'active', config)).toThrow();
});
test('ten high-entropy backup codes have only user-bound digests, with predictable formatting normalization', () => {
  const backup = newBackupCodes(userId, config); expect(new Set(backup.codes).size).toBe(10); expect(new Set(backup.hashes).size).toBe(10);
  backup.codes.forEach((code, index) => { expect(code).toMatch(/^[A-F0-9]{5}(?:-[A-F0-9]{5}){3}$/); expect(backupHash(code.toLowerCase().replaceAll('-', ''), userId, config)).toBe(backup.hashes[index]); expect(backupHash(code, 'b'.repeat(24), config)).not.toBe(backup.hashes[index]); });
});
