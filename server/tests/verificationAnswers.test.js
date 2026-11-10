const { normalizeAnswer, hashQuestions, verifyAnswers } = require('../src/lib/verificationAnswers');
test('answer normalization is trim, lowercase and whitespace collapse', () => {
  expect(normalizeAnswer(' \t Blue\n  STRIPE \r\n')).toBe('blue stripe');
});
test('salted hashes compare normalized answers and reject a mismatch in every position', async () => {
  const questions = await hashQuestions([{ question: 'First?', answer: 'Blue stripe' }, { question: 'Second?', answer: 'Blue stripe' }, { question: 'Third?', answer: 'Pocket 5' }]);
  expect(new Set(questions.map(q => q.answerHash)).size).toBe(3);
  expect(await verifyAnswers(questions, [' BLUE\tstripe ', 'blue stripe', ' pocket   5 '])).toBe(true);
  for (let i = 0; i < 3; i++) {
    const answers = ['blue stripe', 'blue stripe', 'pocket 5']; answers[i] = 'wrong';
    expect(await verifyAnswers(questions, answers)).toBe(false);
  }
  await expect(verifyAnswers(questions, ['blue stripe'])).rejects.toThrow('Invalid verification state');
  await expect(verifyAnswers([{ ...questions[0], answerSalt: 'bad' }, questions[1]], ['blue stripe', 'blue stripe'])).rejects.toThrow('Invalid verification state');
});
