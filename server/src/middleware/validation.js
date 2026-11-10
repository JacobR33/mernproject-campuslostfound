const { z } = require('zod');
const empty = z.object({}).strict();
function validate({ params = empty, query = empty, body = empty } = {}) {
  return (req, res, next) => {
    const result = z.object({ params, query, body }).safeParse({
      params: req.params,
      query: req.query,
      body: req.body ?? {},
    });
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid request', requestId: req.id });
    }
    req.validated = result.data;
    next();
  };
}
module.exports = { validate };
