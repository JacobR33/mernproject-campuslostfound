const proxyaddr = require('proxy-addr');
function clientAddress(config) {
  const trust = proxyaddr.compile(config.TRUST_PROXY || []);
  return (request) => proxyaddr(request, trust);
}
module.exports = { clientAddress };
