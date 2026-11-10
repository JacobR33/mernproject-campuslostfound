const mongoose = require('mongoose');
const { User, Item, Post, Claim, Conversation, Message } = require('../src/models');
const id = () => new mongoose.Types.ObjectId();
const question = () => ({ question: 'Describe a feature', answerHash: 'sensitive-hash', answerSalt: 'sensitive-salt' });
test('UCF email normalized and restricted, safe role defaults', () => {
  const user = new User({ email: ' Student@UCF.EDU ', displayName: 'Student', passwordHash: 'hash' });
  expect(user.email).toBe('student@ucf.edu'); expect(user.role).toBe('user');
  expect(user.emailVerified).toBe(false); expect(user.validateSync()).toBeUndefined();
  for (const email of ['x@ucf.edu.attacker.com', 'x@gmail.com', 'x@knights.ucf.edu']) {
    expect(new User({ email, displayName: 'a', passwordHash: 'h' }).validateSync()).toBeDefined();
  }
});
test('sensitive data excluded from serialization and default projections', () => {
  const user = new User({ email: 'x@ucf.edu', displayName: 'x', passwordHash: 'secret', verificationTokenHash: 'secret', refreshTokenHashes: ['secret'], mfa: { secretEncrypted: 'secret' } });
  expect(JSON.stringify(user)).not.toMatch(/secret|email"|passwordHash|mfa/);
  const item = new Item({ privateDetails: 'hidden-detail' });
  expect(JSON.stringify(item)).not.toContain('hidden-detail');
  const post = new Post({ type: 'found', verificationQuestions: [question(), question()] });
  expect(JSON.stringify(post)).not.toMatch(/sensitive|answerHash|answerSalt/);
  expect(JSON.stringify(new Claim({ submittedAnswers: ['private', 'answer'] }))).not.toContain('submittedAnswers');
  for (const [Model, path] of [[User, 'passwordHash'], [User, 'email'], [Item, 'privateDetails'], [Claim, 'submittedAnswers']]) expect(Model.schema.path(path).options.select).toBe(false);
});
test('new posts need no questions and legacy found challenges remain valid', () => {
  const base = { item: id(), author: id(), expiresAt: new Date() };
  for (const count of [1, 4]) expect(new Post({ ...base, type: 'found', verificationQuestions: Array.from({ length: count }, question) }).validateSync()).toBeDefined();
  expect(new Post({ ...base, type: 'found' }).validateSync()).toBeUndefined();
  expect(new Post({ ...base, type: 'found', verificationQuestions: [question(), question()] }).validateSync()).toBeUndefined();
  expect(new Post({ ...base, type: 'lost', verificationQuestions: [question()] }).validateSync()).toBeDefined();
});
test('strict schemas reject unknown fields', () => expect(() => new User({ unknown: true })).toThrow());
test('item image count and optional coordinates are bounded', () => {
  const base = { category: 'Other', title: 'Item', publicDescription: 'Description', dateFoundOrLost: new Date() };
  expect(new Item({ ...base, images: Array.from({ length: 5 }, id) }).validateSync()).toBeDefined();
  expect(new Item({ ...base, locationFound: { campusArea: 'Main', coordinates: [181, 0] } }).validateSync()).toBeDefined();
  expect(new Item({ ...base, locationFound: { campusArea: 'Main', coordinates: [-81.2, 28.6] } }).validateSync()).toBeUndefined();
});
test('bounded message, claims and distinct conversation participants', () => {
  expect(new Message({ conversation: id(), sender: id(), body: 'a'.repeat(2001) }).validateSync()).toBeDefined();
  expect(new Claim({ post: id(), claimant: id(), submittedAnswers: ['a', 'b'], attemptCount: 4 }).validateSync()).toBeDefined();
  const same = id();
  expect(new Conversation({ post: id(), participants: [same, same] }).validateSync()).toBeDefined();
});
test('required uniqueness and search/expiry indexes exist', () => {
  expect(User.schema.indexes()).toContainEqual([{ email: 1 }, expect.objectContaining({ unique: true })]);
  expect(Claim.schema.indexes()).toContainEqual([{ post: 1, claimant: 1 }, expect.objectContaining({ unique: true })]);
  expect(Item.schema.indexes()).toContainEqual([{ title: 'text', publicDescription: 'text' }, expect.any(Object)]);
  expect(Post.schema.indexes()).toContainEqual([{ expiresAt: 1 }, expect.not.objectContaining({ expireAfterSeconds: expect.anything() })]);
});
