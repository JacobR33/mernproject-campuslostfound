const { z } = require('zod');
const { isIP } = require('node:net');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    TRUST_PROXY: z
      .string()
      .max(500)
      .default('')
      .transform((value) => (value ? value.split(',').map((ip) => ip.trim()) : []))
      .refine(
        (addresses) => addresses.length <= 10 && addresses.every((ip) => isIP(ip) !== 0),
        'Use exact proxy IP addresses'
      ),
    MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/\S+$/),
    CLIENT_ORIGIN: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
        } catch {
          return false;
        }
      }),
    JWT_SECRET: z
      .string()
      .min(64)
      .max(512)
      .refine((v) => !/\s/.test(v) && !/^(.{1,16})\1+$/.test(v)),
    MFA_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .refine((v) => !/^(.{1,16})\1+$/.test(v)),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
    POST_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
    CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    MAIL_TRANSPORT: z.enum(['file', 'smtp']).default('file'),
    MAIL_FROM: z.string().email().default('lostfound@ucf.edu'),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_SECRET === value.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_ENCRYPTION_KEY'],
        message: 'Use independent secrets',
      });
    }
    if (value.NODE_ENV === 'production' && !value.CLIENT_ORIGIN.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['CLIENT_ORIGIN'], message: 'HTTPS required' });
    }
    if (value.MAIL_TRANSPORT === 'smtp' && !value.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP host required' });
    }
    if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_USER'],
        message: 'Supply both SMTP credentials',
      });
    }
    if (value.NODE_ENV === 'production' && value.MAIL_TRANSPORT !== 'smtp') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'Production requires SMTP',
      });
    }
  });

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${fields.join(', ')}`);
  }
  return Object.freeze(parsed.data);
}
module.exports = { loadConfig };
