const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function() {
  const controlFile = path.resolve(__dirname, '../../../.tools/e2e-control.json');
  const stopFile = path.resolve(__dirname, '../../../.tools/e2e-stop');
  const control = JSON.parse(await fs.readFile(controlFile, 'utf8'));
  if (control.closed) return;
  await fs.writeFile(stopFile, control.nonce, { mode: 0o600 });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 200)); if (JSON.parse(await fs.readFile(controlFile, 'utf8')).closed) return; }
  throw new Error('Browser fixture cleanup did not finish');
};
