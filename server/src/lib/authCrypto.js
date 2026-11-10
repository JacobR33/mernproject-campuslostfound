const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { limitedWork } = require('./workLimit');
const token = () => randomBytes(32).toString('hex');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const common = new Set([
  'password1234',
  'password12345',
  'password123456',
  'password123456789',
  '123456789012',
  '1234567890123456',
  'qwertyuiop123',
  'qwertyuiopasdfghjkl',
  'letmein123456',
  'welcome12345',
  'iloveyou12345',
  'ucfknights123',
]);
const passwordSchema = z
  .string()
  .min(12)
  .max(72)
  .refine((v) => Array.from(v).length >= 12, 'Use at least 12 characters')
  .refine(
    (v) => Buffer.byteLength(v, 'utf8') <= 72 && !v.includes('\0'),
    'Password exceeds bcrypt input bounds'
  )
  .refine(
    (v) => !common.has(v.toLowerCase()) && !/^(.)\1+$/u.test(v) && !/^\d+$/.test(v),
    'Choose a less common password'
  );
const hashPassword = (password) => limitedWork('password', 8, () => bcrypt.hash(password, 12));
const verifyPassword = (password, digest) =>
  limitedWork('password', 8, () => bcrypt.compare(password, digest));
function csrfSignature(value, key) {
  return createHmac('sha256', key).update(`csrf:${value}`).digest('hex');
}
function mintCsrf(key) {
  const value = `${token()}.${Date.now()}`;
  return `${value}.${csrfSignature(value, key)}`;
}
function validCsrf(value, key) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/.test(value)) {
    return false;
  }
  const [nonce, issued, signature] = value.split('.');
  const age = Date.now() - Number(issued);
  return age >= 0 && age <= 3600000 && equal(signature, csrfSignature(`${nonce}.${issued}`, key));
}
module.exports = {
  token,
  hash,
  equal,
  passwordSchema,
  hashPassword,
  verifyPassword,
  mintCsrf,
  validCsrf,
};
