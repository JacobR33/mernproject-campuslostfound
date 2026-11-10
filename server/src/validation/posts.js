const { z } = require('zod');
const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const categories = [
  'electronics',
  'keys',
  'wallets',
  'bags',
  'clothing',
  'books',
  'jewelry',
  'ids',
  'other',
];
const location = z
  .object({
    buildingName: z.string().trim().min(1).max(120).optional(),
    campusArea: z.string().trim().min(1).max(120),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  })
  .strict();
const date = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));
const itemDate = date.refine(
  (v) => v <= new Date(Date.now() + 5 * 60 * 1000),
  'Date cannot be in the future'
);
const images = z
  .array(objectId)
  .max(4)
  .refine((v) => new Set(v).size === v.length);
const itemFields = {
  category: z.enum(categories),
  title: z.string().trim().min(1).max(120),
  publicDescription: z.string().trim().min(1).max(2000),
  privateDetails: z.string().trim().max(2000).optional(),
  images: images.default([]),
  location,
  dateFoundOrLost: itemDate,
};
const createPost = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('found'),
      ...itemFields,
      images: images.min(1),
    })
    .strict(),
  z.object({ type: z.literal('lost'), ...itemFields }).strict(),
]);
const editPost = z
  .object({
    revision: z.number().int().min(0),
    category: itemFields.category.optional(),
    title: itemFields.title.optional(),
    publicDescription: itemFields.publicDescription.optional(),
    privateDetails: itemFields.privateDetails,
    images: images.optional(),
    location: location.optional(),
    dateFoundOrLost: itemDate.optional(),
    status: z.enum(['open', 'closed']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'Provide a change');
const listQuery = z
  .object({
    type: z.enum(['found', 'lost']).optional(),
    category: z.enum(categories).optional(),
    location: z.string().trim().min(1).max(120).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    from: date.optional(),
    to: date.optional(),
    status: z.enum(['open', 'claim_pending', 'returned', 'closed']).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'Invalid date range');
module.exports = { objectId, createPost, editPost, listQuery, categories };
