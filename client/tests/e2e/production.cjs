const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, BROWSER_PRODUCTION: 'true' },
});
process.exitCode = result.status ?? 1;
