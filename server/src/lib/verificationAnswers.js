const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const { limitedWork } = require('./workLimit');
const deriveAnswer = (value, salt) => limitedWork('answers', 2, () => derive(value, salt, 32));
const normalizeAnswer = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');
async function hashQuestions(questions) {
  const results = [];
  // Sequential hashing bounds per-request scrypt memory use; request validators cap this at three.
  for (const { question, answer } of questions) {
    const answerSalt = randomBytes(32).toString('hex');
    const answerHash = (await deriveAnswer(normalizeAnswer(answer), answerSalt)).toString('hex');
    results.push({ question, answerSalt, answerHash });
  }
  return results;
}
async function verifyAnswers(questions, submittedAnswers) {
  if (
    questions.length < 2 ||
    questions.length > 3 ||
    submittedAnswers.length !== questions.length
  ) {
    throw new Error('Invalid verification state');
  }
  let passed = true;
  // Compare every answer, including after a mismatch. No per-question feedback is exposed.
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    if (
      !/^[a-f0-9]{64}$/.test(question.answerHash) ||
      !/^[a-f0-9]{64}$/.test(question.answerSalt)
    ) {
      throw new Error('Invalid verification state');
    }
    const candidate = await deriveAnswer(normalizeAnswer(submittedAnswers[i]), question.answerSalt);
    const matches = timingSafeEqual(candidate, Buffer.from(question.answerHash, 'hex'));
    passed = matches && passed;
  }
  return passed;
}
module.exports = { normalizeAnswer, hashQuestions, verifyAnswers };
