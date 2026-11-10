const { z } = require('zod');
const pagination = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};
const notificationQuery = z
  .object({
    ...pagination,
    unread: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();
module.exports = { notificationQuery };
