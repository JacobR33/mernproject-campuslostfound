const express = require('express');
const request = require('supertest');
const { z } = require('zod');
const { validate } = require('../src/middleware/validation');
const app = express();
app.use(express.json());
app.post('/resource/:id', validate({ params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).strict(), query: z.object({}).strict(), body: z.object({ title: z.string().min(1).max(120) }).strict() }), (req, res) => res.json(req.validated));
test('validated whitelisted data is available to controllers', async () => {
  const res = await request(app).post(`/resource/${'a'.repeat(24)}`).send({ title: 'Hello' });
  expect(res.status).toBe(200);
  expect(res.body.body).toEqual({ title: 'Hello' });
});
test.each([
  ['/resource/bad', { title: 'Hello' }],
  [`/resource/${'a'.repeat(24)}?admin=true`, { title: 'Hello' }],
  [`/resource/${'a'.repeat(24)}`, { title: 'Hello', role: 'admin' }],
  [`/resource/${'a'.repeat(24)}`, { title: { $ne: null } }],
])('rejects invalid params, query and mass assignment', async (url, body) => {
  const res = await request(app).post(url).send(body);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Invalid request');
});
