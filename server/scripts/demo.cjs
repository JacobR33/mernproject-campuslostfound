#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');

const projectDirectory = path.resolve(__dirname, '../..');
const serverDirectory = path.join(projectDirectory, 'server');
const serviceName = 'campus-lost-found-demo.service';
const website = 'https://lostfound.jacobreyes1234.me';

process.chdir(serverDirectory);
require('dotenv').config({ path: path.join(serverDirectory, '.env') });

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed. See the output above.`);
  }
  return result;
}

function serviceIsActive() {
  return spawnSync('systemctl', ['is-active', '--quiet', serviceName]).status === 0;
}

function configuration() {
  const config = require('../src/config/env').loadConfig();
  if (config.CLIENT_ORIGIN !== website) {
    throw new Error(`Set CLIENT_ORIGIN=${website} in server/.env first.`);
  }
  if (!config.TRUST_PROXY.includes('127.0.0.1')) {
    throw new Error('Set TRUST_PROXY=127.0.0.1 in server/.env for the local Nginx proxy.');
  }
  if (config.PORT !== 4000) {
    throw new Error('This demo expects PORT=4000, matching the existing Nginx configuration.');
  }
  return config;
}

async function responseFrom(url) {
  return fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
    cache: 'no-store',
  });
}

async function checkApi(url) {
  const response = await responseFrom(url);
  if (!response.ok || (await response.json()).status !== 'ok') {
    throw new Error(`API health check failed at ${url}`);
  }
}

async function checkDatabase(config) {
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(config.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      autoIndex: false,
    });
    const info = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!info.setName && info.msg !== 'isdbgrid') {
      throw new Error('Transactions unavailable');
    }
    console.log('PASS: Atlas connection and replica-set support.');
  } catch {
    // Driver errors can include connection details; never print the URI.
    throw new Error('Atlas check failed. Check credentials, IP access, and replica-set support.');
  } finally {
    await mongoose.disconnect();
  }
}

async function check() {
  const config = configuration();
  await checkApi(`http://127.0.0.1:${config.PORT}/api/health`);
  console.log('PASS: Local backend is responding.');

  const redirect = await responseFrom(website.replace('https:', 'http:'));
  const destination = redirect.headers.get('location');
  if (
    ![301, 302, 307, 308].includes(redirect.status) ||
    !destination ||
    new URL(destination, website).origin !== website
  ) {
    throw new Error('HTTP is not redirecting to the expected HTTPS domain.');
  }
  console.log('PASS: HTTP redirects to HTTPS.');

  const page = await responseFrom(`${website}/login`);
  const html = await page.text();
  if (!page.ok || !html.includes('id="root"') || !html.includes('/assets/')) {
    throw new Error('The HTTPS domain is not serving the built React app.');
  }
  console.log('PASS: Domain serves React over certificate-validated HTTPS.');
  await checkApi(`${website}/api/health`);
  console.log('PASS: Public API forwards through Nginx.');
  await checkDatabase(config);

  console.log('\nInfrastructure checks passed. Browser interaction still needs the walkthrough.');
  console.log(`Open a private browser window at ${website}/`);
  console.log('If Browse appears before sign-in, upload the rebuilt client from this revision.');
  console.log('Run: bash demo.sh link   after registering the account.');
}

async function setup() {
  const config = configuration();
  if (process.platform !== 'linux') {
    throw new Error('Run setup on the Ubuntu Droplet, not Windows.');
  }
  if (!serviceIsActive()) {
    // Avoid taking over a backend owned by a teammate or a foreground terminal.
    const net = require('node:net');
    const listening = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: config.PORT });
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening) {
      throw new Error(
        'Port 4000 is already in use. Stop your old foreground backend with Ctrl+C, then run setup again.'
      );
    }
  }

  const username = require('node:os').userInfo().username;
  if (username === 'root') {
    throw new Error(
      'Run bash demo.sh setup as your normal SSH user; it requests sudo when needed.'
    );
  }
  for (const value of [username, serverDirectory, process.execPath]) {
    if (/[\r\n"\\%]/.test(value)) throw new Error('Unsupported character in service paths.');
  }
  const unit = `[Unit]
Description=Campus Lost and Found classroom demo
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${username}
WorkingDirectory=${serverDirectory}
ExecStart="${process.execPath}" "${path.join(serverDirectory, 'src/index.js')}"
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
  command('sudo', ['-v']);
  command('sudo', ['tee', `/etc/systemd/system/${serviceName}`], {
    input: unit,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  command('sudo', ['systemd-analyze', 'verify', `/etc/systemd/system/${serviceName}`]);
  command('sudo', ['systemctl', 'daemon-reload']);
  command('sudo', ['systemctl', 'enable', serviceName]);
  await start();
  console.log(
    '\nBackground service is running and checked. It survives SSH disconnects and starts after reboot.'
  );
}

async function start() {
  configuration();
  command('sudo', ['systemctl', 'start', serviceName]);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await checkApi('http://127.0.0.1:4000/api/health');
      break;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await check();
}

async function verificationLink(email) {
  const config = configuration();
  if (config.MAIL_TRANSPORT !== 'file') {
    throw new Error(
      'Email delivery uses SMTP. Get the verification link from the recipient inbox.'
    );
  }
  if (!email) {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      email = await terminal.question('Which registered @ucf.edu address? ');
    } finally {
      terminal.close();
    }
  }
  email = email.trim().toLowerCase();
  if (!/^[^\s@]+@ucf\.edu$/.test(email)) throw new Error('Enter the registered @ucf.edu address.');
  const directory = path.join(serverDirectory, '.mail');
  const messages = [];
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(directory, name);
      try {
        const message = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (message.to?.toLowerCase() !== email) continue;
        const match = message.text?.match(/https:\/\/[^\s]+\/verify-email#token=[a-f0-9]{64}/);
        if (match) messages.push({ link: match[0], modified: fs.statSync(file).mtimeMs });
      } catch {
        // A worker may still be writing its message; skip incomplete JSON.
      }
    }
  }
  messages.sort((a, b) => b.modified - a.modified);
  const newest = messages[0];
  if (
    !newest ||
    new URL(newest.link).origin !== website ||
    Date.now() - newest.modified >= 86400000
  ) {
    throw new Error(
      'No recent verification email for this account and domain. Use Resend verification on the website, wait a few seconds, and run this command again.'
    );
  }
  console.log('\nPrivate verification link (Ctrl+click in Windows Terminal):\n');
  console.log(newest.link);
  console.log('\nClick Verify email in the browser, then sign in.');
  console.log('If already used or invalidated, request a fresh link and rerun this command.');
}

function help() {
  console.log(`Campus Lost & Found demo — run on the Droplet

  bash demo.sh setup          One-time setup of the background service (sudo)
  bash demo.sh                Start the service and check the website
  bash demo.sh check          Check backend, HTTPS, public routing, and Atlas
  bash demo.sh link           Show one account's latest verification link
  bash demo.sh status         Show background service status
  bash demo.sh logs           Show recent backend logs
  bash demo.sh stop           Stop the background service (sudo)
  bash demo.sh help           Show these commands

This is the existing classroom configuration, including file-based email.
It does not configure SMTP, deploy frontend files, or claim production readiness.
See DEMO.md for the rubric walkthrough and one-time deployment steps.`);
}

async function main() {
  const action = process.argv[2] || 'start';
  switch (action) {
    case 'setup':
      return setup();
    case 'start':
      return start();
    case 'check':
      return check();
    case 'link':
      return verificationLink(process.argv[3]);
    case 'status':
      return command('systemctl', ['status', '--no-pager', serviceName]);
    case 'logs':
      return command('sudo', ['journalctl', '-u', serviceName, '-n', '60', '--no-pager']);
    case 'stop':
      return command('sudo', ['systemctl', 'stop', serviceName]);
    case 'help':
      return help();
    default:
      throw new Error('Unknown command. Run: bash demo.sh help');
  }
}

main().catch((error) => {
  // Unexpected network errors can contain connection details; allow only our own messages.
  if (error.name === 'Error' && !error.cause) console.error(`\n${error.message}`);
  else
    console.error(
      '\nCheck failed. Check network access and run bash demo.sh logs for backend diagnostics.'
    );
  process.exitCode = 1;
});
