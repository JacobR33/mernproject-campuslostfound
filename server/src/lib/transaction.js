const mongoose = require('mongoose');
const transactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  maxCommitTimeMS: 10000,
  timeoutMS: 15000,
};
async function withTransaction(work) {
  const session = await mongoose.startSession();
  try {
    // Every callback must load/create fresh documents on retries; no document escapes for later save().
    // Driver sessions avoid Mongoose's rollback bookkeeping bug with strict nested schemas and __v.
    return await session.withTransaction(() => work(session), transactionOptions);
  } finally {
    await session.endSession();
  }
}
module.exports = { withTransaction };
