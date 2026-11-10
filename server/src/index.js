require('dotenv').config();
const mongoose = require('mongoose');
const { loadConfig } = require('./config/env');
const { createApp } = require('./app');
const { createLogger } = require('./lib/logger');
const { startMailWorker } = require('./lib/mailQueue');
const {
  assertAuthIndexes,
  assertPostIndexes,
  assertClaimIndexes,
  assertChatIndexes,
  assertModerationIndexes,
  assertRetentionIndexes,
} = require('./config/indexes');
const { createHttpServer, listen } = require('./lib/httpServer');
const { attachChat } = require('./realtime/chat');
const { assertTransactionsSupported } = require('./config/database');
const { startPostCleanup } = require('./jobs/postCleanup');
const { createGridFSStorage } = require('./storage/gridfs');
const logger = createLogger();
async function start() {
  const config = loadConfig();
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);
  await mongoose.connect(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex: config.NODE_ENV !== 'production',
  });
  await assertTransactionsSupported(mongoose.connection);
  if (config.NODE_ENV === 'production') {
    await assertAuthIndexes();
    await assertPostIndexes();
    await assertClaimIndexes();
    await assertChatIndexes();
    await assertModerationIndexes();
    await assertRetentionIndexes();
  }
  const storage = createGridFSStorage();
  const server = createHttpServer(createApp(config, { storage, logger }));
  const chat = attachChat(server, config, logger);
  await listen(server, config.PORT);
  const stopMail = startMailWorker(config, logger);
  const stopCleanup = startPostCleanup(config, { storage, logger });
  logger('server_started');
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 10000).unref();
    chat
      .close()
      .then(async () => {
        await stopMail();
        await stopCleanup();
        await mongoose.disconnect();
        clearTimeout(timer);
      })
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.on('error', () => {
    logger('server_failed');
    process.exitCode = 1;
    shutdown();
  });
}
start().catch(async (error) => {
  logger('startup_failed', {
    code: ['EADDRINUSE', 'EACCES'].includes(error.code) ? error.code : 'configuration_or_database',
  });
  await mongoose.disconnect();
  process.exitCode = 1;
});
