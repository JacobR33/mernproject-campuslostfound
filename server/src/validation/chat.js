const { z } = require('zod');
const { objectId } = require('./posts');
const page = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};
const pagination = z.object(page).strict();
const historyQuery = z
  .object({
    limit: page.limit,
    before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const messagePayload = z
  .object({
    conversationId: objectId,
    clientMessageId: z.string().uuid(),
    body: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)),
  })
  .strict();
const joinPayload = z.object({ conversationId: objectId }).strict();
module.exports = { pagination, historyQuery, messagePayload, joinPayload };
