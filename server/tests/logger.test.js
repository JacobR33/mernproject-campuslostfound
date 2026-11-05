const { createLogger } = require('../src/lib/logger');
test('claim audits retain target identifiers and attempt counts while suppressing answer material', () => {
  const write = jest.fn();
  createLogger({ write })('audit_claim_submit', { actorId: 'actor', postId: 'post', claimId: 'claim', attemptCount: 2, outcome: 'pending', submittedAnswers: ['private'], verificationPassed: true, answerHash: 'private', answerSalt: 'private' });
  expect(JSON.parse(write.mock.calls[0][0])).toEqual({ time: expect.any(String), event: 'audit_claim_submit', actorId: 'actor', postId: 'post', claimId: 'claim', attemptCount: 2, outcome: 'pending' });
});
test('logs allowlisted metadata only', () => {
  const write = jest.fn();
  createLogger({ write })('http_request', { requestId: 'id', status: 200, password: 'secret', token: 'secret', answers: ['secret'], email: 'private', url: '/token' });
  const value = JSON.parse(write.mock.calls[0][0]);
  expect(value).toEqual({ time: expect.any(String), event: 'http_request', requestId: 'id', status: 200 });
});
