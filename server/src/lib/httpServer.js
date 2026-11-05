const { createServer } = require('node:http');
function createHttpServer(app) {
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 10000,
      requestTimeout: 30000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    app
  );
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  return server;
}
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
module.exports = { createHttpServer, listen };
