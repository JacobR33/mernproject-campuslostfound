function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}
module.exports = { httpError };
