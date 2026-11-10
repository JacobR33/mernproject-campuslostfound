#!/usr/bin/env node
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { User } = require('../src/models');
const { AuthSession } = require('../src/models/auth');
const { loadConfig } = require('../src/config/env');
const { withTransaction } = require('../src/lib/transaction');
const { assertTransactionsSupported } = require('../src/config/database');

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@ucf\.edu$/.test(email) || process.argv.length !== 3) {
    throw new Error('Usage: npm run admin:grant --workspace server -- your-email@ucf.edu');
  }
  const config = loadConfig();
  mongoose.set('sanitizeFilter', true);
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false });
  await assertTransactionsSupported(mongoose.connection);
  await withTransaction(async (session) => {
    const user = await User.findOne({ email, emailVerified: true, isBanned: false }).session(
      session
    );
    if (!user)
      throw new Error(
        'Register and verify this account first. Banned accounts cannot be promoted.'
      );
    if (user.role === 'admin') return;
    await User.updateOne(
      { _id: user._id },
      {
        $set: { role: 'admin', refreshTokenHashes: [] },
        $inc: { authVersion: 1, activityVersion: 1 },
      },
      { session }
    );
    await AuthSession.updateMany({ user: user._id }, { $set: { revoked: true } }, { session });
  });
  console.log('Administrator access granted. Sign in again and open /admin.');
}

main()
  .catch((error) => {
    const known = ['Usage:', 'Register and verify'];
    console.error(
      known.some((prefix) => error.message?.startsWith(prefix))
        ? error.message
        : 'Unable to grant access. Check server configuration and Atlas connectivity.'
    );
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
