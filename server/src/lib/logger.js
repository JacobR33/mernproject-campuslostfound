// Allowlisted fields only: request bodies, URLs, headers, and errors may contain secrets.
function createLogger(stream = process.stdout) {
  return (event, fields = {}) => {
    const entry = { time: new Date().toISOString(), event };
    for (const key of [
      'requestId',
      'method',
      'status',
      'durationMs',
      'code',
      'actorId',
      'outcome',
      'postId',
      'claimId',
      'attemptCount',
    ]) {
      if (fields[key] !== undefined) {
        entry[key] = fields[key];
      }
    }
    stream.write(`${JSON.stringify(entry)}\n`);
  };
}
module.exports = { createLogger };
