require('dotenv').config();
const mongoose = require('mongoose');
const { loadConfig } = require('../src/config/env');
const models = {
  ...require('../src/models'),
  ...require('../src/models/auth'),
  Upload: require('../src/models/upload'),
  Notification: require('../src/models/notification'),
  MatchRequest: require('../src/models/matchRequest'),
};
const { createLogger } = require('../src/lib/logger');
const logger = createLogger();
models.Report = require('../src/models/report');
models.ModerationAudit = require('../src/models/moderationAudit');
async function run() {
  const config = loadConfig();
  await mongoose.connect(config.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  try {
    for (const model of Object.values(models)) await model.createIndexes();
    logger('indexes_created');
  } finally {
    await mongoose.disconnect();
  }
}
run().catch(() => {
  logger('index_creation_failed');
  process.exitCode = 1;
});
