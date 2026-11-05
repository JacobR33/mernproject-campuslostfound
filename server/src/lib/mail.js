const fs = require('node:fs/promises');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { token } = require('./authCrypto');

function createMailer(config) {
  if (config.MAIL_TRANSPORT === 'smtp') {
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      requireTLS: !config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      connectionTimeout: 10000,
      socketTimeout: 15000,
      tls: { rejectUnauthorized: true },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return {
      send: (message) =>
        transport.sendMail({
          from: config.MAIL_FROM,
          to: message.to,
          subject: message.subject,
          text: message.text,
          disableFileAccess: true,
          disableUrlAccess: true,
        }),
    };
  }
  if (config.NODE_ENV === 'production') {
    throw new Error('File mailbox forbidden in production');
  }
  return {
    async send(message) {
      const directory = path.resolve(__dirname, '../../.mail');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(directory, `${token()}.json`),
        JSON.stringify({ from: config.MAIL_FROM, ...message }),
        { mode: 0o600, flag: 'wx' }
      );
    },
  };
}
module.exports = { createMailer };
