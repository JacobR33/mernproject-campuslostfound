const { assertTransactionsSupported } = require('../src/config/database');
const { assertPostIndexes, assertClaimIndexes } = require('../src/config/indexes');
const { Post, Item, Claim, Conversation } = require('../src/models');
const Notification = require('../src/models/notification');
test('standalone MongoDB fails fast while replica sets and mongos are accepted', async () => {
  const connection = hello => ({ db: { admin: () => ({ command: async () => hello }) } });
  await expect(assertTransactionsSupported(connection({ isWritablePrimary: true }))).rejects.toThrow('replica set required');
  await expect(assertTransactionsSupported(connection({ setName: 'rs0' }))).resolves.toBeUndefined();
  await expect(assertTransactionsSupported(connection({ msg: 'isdbgrid' }))).resolves.toBeUndefined();
});
test('claim production checks fail closed on missing or partial uniqueness constraints', async () => {
  const claims = jest.spyOn(Claim.collection, 'indexes').mockResolvedValue([{ key: { post: 1, claimant: 1 }, unique: true }]);
  const conversations = jest.spyOn(Conversation.collection, 'indexes').mockResolvedValue([{ key: { claim: 1 }, unique: true, sparse: true }]);
  const notifications = jest.spyOn(Notification.collection, 'indexes').mockResolvedValue([{ key: { recipient: 1, claim: 1, kind: 1, attemptCount: 1 }, unique: true }]);
  try {
    await expect(assertClaimIndexes()).resolves.toBeUndefined();
    conversations.mockResolvedValue([{ key: { claim: 1 }, unique: false }]);
    await expect(assertClaimIndexes()).rejects.toThrow('Required claim indexes missing');
    conversations.mockResolvedValue([{ key: { claim: 1 }, unique: true, sparse: true }]);
    claims.mockResolvedValue([{ key: { post: 1, claimant: 1 }, unique: true, partialFilterExpression: { status: 'pending' } }]);
    await expect(assertClaimIndexes()).rejects.toThrow('Required claim indexes missing');
    claims.mockResolvedValue([{ key: { post: 1, claimant: 1 }, unique: true }]);
    notifications.mockResolvedValue([]);
    await expect(assertClaimIndexes()).rejects.toThrow('Required claim indexes missing');
  } finally { claims.mockRestore(); conversations.mockRestore(); notifications.mockRestore(); }
});
test('production index checks reject missing uniqueness and text indexes that include private data', async () => {
  const posts = jest.spyOn(Post.collection, 'indexes').mockResolvedValue([{ key: { item: 1 }, unique: true }]);
  const items = jest.spyOn(Item.collection, 'indexes').mockResolvedValue([{ weights: { title: 1, publicDescription: 1, privateDetails: 1 } }]);
  try {
    await expect(assertPostIndexes()).rejects.toThrow('Required post indexes missing');
    items.mockResolvedValue([{ weights: { title: 1, publicDescription: 1 } }]);
    await expect(assertPostIndexes()).resolves.toBeUndefined();
    posts.mockResolvedValue([{ key: { item: 1 }, unique: false }]);
    await expect(assertPostIndexes()).rejects.toThrow('Required post indexes missing');
  } finally { posts.mockRestore(); items.mockRestore(); }
});
