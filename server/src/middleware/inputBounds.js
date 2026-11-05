const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
// Iterative inspection bounds work before recursive sanitizer/schema traversal.
function boundedInput(value) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [current, depth] = stack.pop();
    if (++nodes > 1000 || depth > 12) {
      return false;
    }
    if (!current || typeof current !== 'object') {
      continue;
    }
    for (const key of Object.keys(current)) {
      if (forbidden.has(key)) {
        return false;
      }
      stack.push([current[key], depth + 1]);
      if (stack.length > 1000) {
        return false;
      }
    }
  }
  return true;
}
function inputBounds(req, res, next) {
  if (!boundedInput(req.body) || !boundedInput(req.query)) {
    return res.status(400).json({ error: 'Invalid request', requestId: req.id });
  }
  next();
}
module.exports = { boundedInput, inputBounds };
