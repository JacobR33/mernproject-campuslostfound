const active = new Map();
// Reject overflow rather than building an unbounded CPU/memory work queue.
async function limitedWork(scope, maximum, work) {
  const count = active.get(scope) || 0;
  if (count >= maximum) {
    throw Object.assign(new Error('Service busy'), { httpStatus: 503 });
  }
  active.set(scope, count + 1);
  try {
    return await work();
  } finally {
    const remaining = active.get(scope) - 1;
    if (remaining) {
      active.set(scope, remaining);
    } else {
      active.delete(scope);
    }
  }
}
module.exports = { limitedWork };
