const { RateBucket } = require('../models/auth');
const { hash } = require('../lib/authCrypto');
const limits = Object.freeze({
  csrf: 120,
  register: 10,
  login: 30,
  reset: 10,
  verify: 20,
  refresh: 120,
  logout: 30,
});
async function consumeRate(scope, identity, maximum, windowMs = 60000) {
  const window = Math.floor(Date.now() / windowMs);
  const expiresAt = new Date((window + 1) * windowMs);
  const key = hash(`${scope}|${identity}|${window}`);
  let bucket;
  try {
    bucket = await RateBucket.findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, new: true }
    );
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
    bucket = await RateBucket.findOneAndUpdate({ _id: key }, { $inc: { count: 1 } }, { new: true });
  }
  if (bucket.count > maximum) {
    throw Object.assign(new Error('Too many requests'), { httpStatus: 429 });
  }
}
function rateLimit(scope, maximum = limits[scope], windowMs = 15 * 60 * 1000) {
  return async (req, res, next) => {
    try {
      const window = Math.floor(Date.now() / windowMs);
      const expiresAt = new Date((window + 1) * windowMs);
      const key = hash(`${scope}|${req.ip}|${window}`);
      let bucket;
      try {
        bucket = await RateBucket.findOneAndUpdate(
          { _id: key },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
          { upsert: true, new: true }
        );
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }
        bucket = await RateBucket.findOneAndUpdate(
          { _id: key },
          { $inc: { count: 1 } },
          { new: true }
        );
      }
      if (bucket.count > maximum) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)));
        return res.status(429).json({ error: 'Too many requests', requestId: req.id });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
module.exports = { rateLimit, limits, consumeRate };
