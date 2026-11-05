const { User } = require('../models');
// Serialize durable user mutations with banning/deletion. Check the current role
// and credential version again inside the transaction, after HTTP authentication.
async function lockActor(session, user, version) {
  const result = await User.updateOne(
    {
      _id: user._id,
      emailVerified: true,
      isBanned: false,
      role: user.role,
      ...(version === undefined ? {} : { authVersion: version }),
    },
    { $inc: { activityVersion: 1 } },
    { session }
  );
  if (result.matchedCount !== 1) {
    throw Object.assign(new Error('Authentication required'), { authStatus: 401 });
  }
}
module.exports = { lockActor };
