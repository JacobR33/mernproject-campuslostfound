const { randomBytes } = require('node:crypto');
const { encryptMessage, decryptMessage } = require('../src/lib/mailQueue');
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ accepted: [] }) })) }));
const nodemailer = require('nodemailer');
const { createMailer } = require('../src/lib/mail');
const fs = require('node:fs/promises');

test('outbox payload encryption is authenticated and uses unique random nonces', () => {
  const config = { MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
  const message = { to: 'student@ucf.edu', subject: 'Verify', text: 'secret-verification-token' };
  const a = encryptMessage(message, config), b = encryptMessage(message, config);
  expect(a).not.toBe(b); expect(a).not.toContain(message.text); expect(a).not.toContain(message.to);
  expect(decryptMessage(a, config)).toEqual(message);
  expect(() => decryptMessage(a, { MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex') })).toThrow();
  expect(() => decryptMessage(a.replace(/.$/, a.endsWith('0') ? '1' : '0'), config)).toThrow();
  expect(() => decryptMessage('v0.a.b.c', config)).toThrow();
});
test('production forbids file delivery', () => expect(() => createMailer({ NODE_ENV: 'production', MAIL_TRANSPORT: 'file' })).toThrow('File mailbox forbidden'));
test('SMTP requires validated TLS certificates, STARTTLS when needed, and timeouts', async () => {
  const config = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.local', SMTP_PORT: 587, SMTP_SECURE: false, SMTP_USER: 'mailer', SMTP_PASSWORD: 'private', MAIL_FROM: 'lostfound@ucf.edu' };
  await createMailer(config).send({ to: 'student@ucf.edu', subject: 'Hi', text: 'Content' });
  expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ requireTLS: true, tls: { rejectUnauthorized: true }, socketTimeout: 15000, auth: { user: 'mailer', pass: 'private' } }));
  createMailer({ ...config, SMTP_SECURE: true });
  expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: true, requireTLS: false }));
});

test('SMTP cannot fetch caller-supplied attachment URLs/files or override access restrictions', async () => {
  const config = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.local', SMTP_PORT: 587, SMTP_SECURE: false, MAIL_FROM: 'lostfound@ucf.edu' };
  await createMailer(config).send({ to: 'student@ucf.edu', subject: 'Account', text: 'Plain text only', html: '<img src="http://127.0.0.1/private">', attachments: [{ path: '/private/file' }], disableFileAccess: false, disableUrlAccess: false });
  expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ disableFileAccess: true, disableUrlAccess: true }));
  const transport = nodemailer.createTransport.mock.results.at(-1).value;
  expect(transport.sendMail).toHaveBeenCalledWith({ from: config.MAIL_FROM, to: 'student@ucf.edu', subject: 'Account', text: 'Plain text only', disableFileAccess: true, disableUrlAccess: true });
});
test('development file delivery uses private modes, exclusive creation and random filenames', async () => {
  const mkdir = jest.spyOn(fs, 'mkdir').mockResolvedValue();
  const writeFile = jest.spyOn(fs, 'writeFile').mockResolvedValue();
  try {
    const mailer = createMailer({ NODE_ENV: 'development', MAIL_TRANSPORT: 'file', MAIL_FROM: 'lostfound@ucf.edu' });
    const message = { to: 'student@ucf.edu', text: 'Delivered token' };
    await mailer.send(message); await mailer.send(message);
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.mail'), { recursive: true, mode: 0o700 });
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/[a-f0-9]{64}\.json$/), expect.any(String), { mode: 0o600, flag: 'wx' });
    expect(writeFile.mock.calls[0][0]).not.toBe(writeFile.mock.calls[1][0]);
  } finally { mkdir.mockRestore(); writeFile.mockRestore(); }
});
