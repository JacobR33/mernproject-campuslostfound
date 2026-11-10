const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const sharp = require('sharp');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createApp } = require('../../../server/src/app');
const { createHttpServer } = require('../../../server/src/lib/httpServer');
const { attachChat } = require('../../../server/src/realtime/chat');
const MatchRequest = require('../../../server/src/models/matchRequest');
const Report = require('../../../server/src/models/report');
const ModerationAudit = require('../../../server/src/models/moderationAudit');
const models = require('../../../server/src/models');
const authModels = require('../../../server/src/models/auth');
const Upload = require('../../../server/src/models/upload');
const Notification = require('../../../server/src/models/notification');
const { hashPassword } = require('../../../server/src/lib/authCrypto');
const { createGridFSStorage } = require('../../../server/src/storage/gridfs');
const mailFile = path.resolve(__dirname, '../../../.tools/e2e-mail.json');
const controlFile = path.resolve(__dirname, '../../../.tools/e2e-control.json');
const stopFile = path.resolve(__dirname, '../../../.tools/e2e-stop');
(async () => {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  mongoose.set('sanitizeFilter', true); mongoose.set('strictQuery', true); await mongoose.connect(mongo.getUri());
  for (const model of [...Object.values(models), ...Object.values(authModels), Upload, Notification, MatchRequest, Report, ModerationAudit]) await model.init();
  const passwordHash = await hashPassword('Campus browser testing passphrase 47!');
  const finder = await models.User.create({ email: 'finder@ucf.edu', displayName: 'Campus Finder', passwordHash, emailVerified: true });
  await models.User.create({ email: 'claimant@ucf.edu', displayName: 'Campus Claimant', passwordHash, emailVerified: true });
  await models.User.create({ email: 'moderator@ucf.edu', displayName: 'Campus Moderator', role: 'admin', passwordHash, emailVerified: true });
  await models.User.create({ email: 'reporter@ucf.edu', displayName: 'Campus Reporter', passwordHash, emailVerified: true });
  await models.User.create({ email: 'mfa-browser@ucf.edu', displayName: 'MFA Browser Knight', passwordHash, emailVerified: true });
  const moderated = await models.User.create({ email: 'moderated@ucf.edu', displayName: 'Moderated Knight', passwordHash, emailVerified: true });
  const deleting = await models.User.create({ email: 'deleting@ucf.edu', displayName: 'Deleting Knight', passwordHash, emailVerified: true });
  for (const [owner, title] of [[moderated, 'Notebook for moderation'], [deleting, 'Notebook for account deletion']]) {
    const row = await models.Item.create({ category: 'books', title, publicDescription: 'A disposable browser fixture notebook.', dateFoundOrLost: new Date(), lastSeen: { campusArea: 'Main Campus' } });
    await models.Post.create({ type: 'lost', author: owner._id, item: row._id, expiresAt: new Date(Date.now() + 86400000) });
  }
  const item = await models.Item.create({ category: 'bags', title: 'Black campus backpack', publicDescription: 'A backpack was found near the library.', privateDetails: 'do-not-disclose-e2e', dateFoundOrLost: new Date('2026-10-01T12:00:00Z'), locationFound: { campusArea: 'Main Campus', buildingName: 'Library' } });
  const post = await models.Post.create({ type: 'found', author: finder._id, item: item._id, expiresAt: new Date(Date.now() + 86400000) });
  const image = await Upload.create({ owner: finder._id, post: post._id, filename: `${randomBytes(24).toString('hex')}.jpg`, state: 'attached', expiresAt: post.expiresAt });
  const storage = createGridFSStorage(); await storage.write(image._id, await sharp({ create: { width: 800, height: 500, channels: 3, background: '#ddd9c6' } }).jpeg().toBuffer(), image.filename);
  await models.Item.updateOne({ _id: item._id }, { $set: { images: [image._id] } });
  const mailbox = []; await fs.mkdir(path.dirname(mailFile), { recursive: true }); await fs.writeFile(mailFile, '[]', { mode: 0o600 });
  const config = { NODE_ENV: 'test', CLIENT_ORIGIN: 'https://localhost:5473', JWT_SECRET: randomBytes(48).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ACCESS_TOKEN_TTL_SECONDS: 900, POST_RETENTION_DAYS: 90 };
  const api = createApp(config, { storage, logger: () => {}, mailer: { send: async message => { mailbox.push(message); await fs.writeFile(mailFile, JSON.stringify(mailbox), { mode: 0o600 }); } } });
  const server = createHttpServer(api); const realtime = attachChat(server, config, () => {}); server.listen(5474, '127.0.0.1');
  process.env.DEV_API_TARGET = 'http://127.0.0.1:5474'; process.env.DEV_HTTPS = 'true'; process.env.VITE_API_ORIGIN = '';
  const { createServer, build, preview } = await import('vite'); let vite;
  if (process.env.BROWSER_PRODUCTION === 'true') {
    process.env.VITE_API_ORIGIN = config.CLIENT_ORIGIN;
    await build();
    const instance = await preview({ preview: { host: '127.0.0.1', port: 5473, strictPort: true } });
    vite = { close: () => new Promise(resolve => instance.httpServer.close(resolve)) };
  } else {
    vite = await createServer({ server: { host: '127.0.0.1', port: 5473, strictPort: true } }); await vite.listen();
  }
  process.stdout.write('Disposable browser fixture ready\n');
  const nonce = randomBytes(32).toString('hex'); await fs.writeFile(controlFile, JSON.stringify({ nonce, closed: false }), { mode: 0o600 });
  let stopping = false;
  async function stop() { if (stopping) return; stopping = true; clearInterval(stopTimer); await vite.close(); await realtime.close(); await mongoose.disconnect(); await mongo.stop(); await fs.writeFile(controlFile, JSON.stringify({ nonce, closed: true }), { mode: 0o600 }); }
  // A file signal lets Windows finish native child cleanup before Playwright tears down its shell.
  const stopTimer = setInterval(async () => { if (stopping) return; try { if ((await fs.readFile(stopFile, 'utf8')) === nonce) await stop().then(() => process.exit(0)); } catch {} }, 250).unref();
  process.on('SIGTERM', () => stop().then(() => process.exit(0))); process.on('SIGINT', () => stop().then(() => process.exit(0)));
})().catch(() => { process.stderr.write('Browser fixture startup failed\n'); process.exit(1); });
