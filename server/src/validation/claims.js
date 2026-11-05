const { z } = require('zod');
const { objectId } = require('./posts');
const { normalizeAnswer } = require('../lib/verificationAnswers');
const claimSubmission = z
  .object({
    answers: z
      .array(
        z
          .object({
            questionId: objectId,
            answer: z
              .string()
              .min(1)
              .max(500)
              .refine((value) => normalizeAnswer(value).length > 0),
          })
          .strict()
      )
      .min(2)
      .max(3)
      .refine(
        (answers) => new Set(answers.map((value) => value.questionId)).size === answers.length
      ),
  })
  .strict();
const decision = z
  .object({ decision: z.enum(['approve', 'deny']), attemptCount: z.number().int().min(1).max(3) })
  .strict();
const pagination = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};
const claimQuery = z
  .object({ ...pagination, status: z.enum(['pending', 'approved', 'denied']).optional() })
  .strict();
const notificationQuery = z
  .object({
    ...pagination,
    unread: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();
module.exports = { claimSubmission, decision, claimQuery, notificationQuery };
