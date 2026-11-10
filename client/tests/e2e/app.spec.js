import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as OTPAuth from 'otpauth';
const password = 'Campus browser testing passphrase 47!'; // disposable fixture accounts only

test('production build serves strict CSP headers and blocks inline script execution', async ({ page }) => {
  test.skip(process.env.BROWSER_PRODUCTION !== 'true', 'Production preview check; run test:e2e:production.');
  const response = await page.goto('/'), headers = await response.allHeaders();
  expect(headers['content-security-policy']).toContain("script-src 'self'");
  expect(headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(headers['x-content-type-options']).toBe('nosniff'); expect(headers['referrer-policy']).toBe('no-referrer'); expect(headers['x-frame-options']).toBe('DENY');
  await page.evaluate(() => {
    window.__policyViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__policyViolations.push(event.violatedDirective));
    const script = document.createElement('script'); script.textContent = 'window.__cspExecuted = true'; document.body.appendChild(script);
  });
  expect(await page.evaluate(() => window.__cspExecuted)).toBeUndefined();
  await expect.poll(() => page.evaluate(() => window.__policyViolations)).toContain('script-src-elem');
});
const mailFile = path.resolve('../.tools/e2e-mail.json');
async function login(page, email = 'claimant@ucf.edu', value = password) {
  await page.goto('/login'); await page.getByLabel('UCF email').fill(email); await page.getByLabel('Password', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
async function noAxeViolations(page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
}
async function mailboxLink(email, subject) {
  let link = '';
  await expect.poll(async () => { try { const messages = JSON.parse(await fs.readFile(mailFile, 'utf8')); const message = messages.filter(m => m.to === email && m.subject.includes(subject)).at(-1); link = message?.text.match(/https:\/\/\S+/)?.[0] || ''; } catch {} return link; }).not.toBe('');
  return link;
}
test('desktop browse is responsive, searchable, keyboard-accessible and has no automated AA violations', async ({ page }) => {
  await page.goto('/browse'); await expect(page.getByText('Black campus backpack', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByLabel('Search the board').fill('backpack'); await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('1 matching post', { exact: true })).toBeVisible();
  await noAxeViolations(page);
  await fs.mkdir(path.resolve('../.tools/previews'), { recursive: true }); await page.screenshot({ path: '../.tools/previews/phase5-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Black campus backpack', exact: true }).click(); await expect(page.getByRole('heading', { level: 1, name: 'Black campus backpack' })).toBeVisible();
  await expect(page.getByText('do-not-disclose-e2e')).toHaveCount(0); await expect(page.getByText('Navy blue', { exact: true })).toHaveCount(0);
  await noAxeViolations(page);
});
test('mobile navigation, form labels and public pages pass automated AA checks without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/browse'); await expect(page.getByText('Black campus backpack', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Menu', exact: true }).click(); await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
  await noAxeViolations(page); await page.screenshot({ path: '../.tools/previews/phase5-mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { level: 1, name: 'Welcome back, Knight.' })).toBeVisible(); await noAxeViolations(page);
});
test('private routes redirect safely and admin access remains restricted', async ({ page }) => {
  await page.goto('/my-posts'); await expect(page).toHaveURL(/\/login$/); await expect(page.getByRole('heading', { name: 'My Posts' })).toHaveCount(0);
  await login(page); await page.goto('/settings'); await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible(); await noAxeViolations(page);
  await page.goto('/admin'); await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
  await page.goto('/chat'); await expect(page.getByRole('heading', { name: 'Campus chat', exact: true })).toBeVisible(); await expect(page.getByText('A private place to reconnect.', { exact: true })).toBeVisible();
});
test('real HTTPS cookies stay HttpOnly/Secure and two tabs renew shared refresh credentials once', async ({ page, context }) => {
  await login(page);
  const cookies = (await context.cookies()).filter(c => c.name.startsWith('__Host-ucf_'));
  expect(cookies.map(c => c.name)).toContain('__Host-ucf_refresh');
  for (const cookie of cookies) { expect(cookie.httpOnly).toBe(true); expect(cookie.secure).toBe(true); expect(cookie.sameSite).toBe('Strict'); expect(cookie.path).toBe('/'); }
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }))).toEqual({ local: 0, session: 0, cookie: '' });
  const responses = []; context.on('response', response => { if (response.url().endsWith('/api/auth/refresh')) responses.push(response.status()); });
  await context.clearCookies({ name: '__Host-ucf_access' });
  const a = await context.newPage(), b = await context.newPage(); await Promise.all([a.goto('/my-claims'), b.goto('/notifications')]);
  await expect(a.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible(); await expect(b.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  expect(responses.filter(status => status === 200)).toHaveLength(1); expect(responses).not.toContain(401);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(a).toHaveURL(/\/login$/); await expect(b).toHaveURL(/\/login$/);
});
test('registration, explicit verification and password reset work without leaving link tokens in the URL', async ({ page }) => {
  const email = `browser-new-${Date.now()}@ucf.edu`;
  await page.goto('/register'); await page.getByLabel('Display name').fill('New Campus Knight'); await page.getByLabel('UCF email').fill(email); await page.getByLabel('Choose a password').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click(); await expect(page.getByText(/If eligible/)).toBeVisible();
  const verify = await mailboxLink(email, 'Verify'); await page.goto(verify); expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByRole('button', { name: 'Verify email', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Verify email', exact: true }).click(); await expect(page.getByText(/Your email is verified/)).toBeVisible();
  await login(page, email); await page.goto('/forgot-password'); await page.getByLabel('UCF email').fill(email); await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/If eligible/)).toBeVisible(); await page.goto(await mailboxLink(email, 'Reset')); expect(new URL(page.url()).hash).toBe('');
  await page.getByLabel('New password', { exact: true }).fill('An updated campus passphrase 53!'); await page.getByLabel('Confirm new password').fill('An updated campus passphrase 53!'); await noAxeViolations(page);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click(); await expect(page.getByText('Your password was reset. Sign in again.')).toBeVisible();
  await login(page, email, 'An updated campus passphrase 53!');
});
test('lost post creation, literal text rendering, owner edit and confirmed deletion use the real API', async ({ page }) => {
  await login(page); await page.goto('/lost/new');
  await page.getByLabel('Category', { exact: true }).selectOption('books'); await page.getByLabel('Short title').fill('Notebook from browser test');
  await page.getByLabel('Public description', { exact: true }).fill('<script>window.__xss = 1</script>'); await page.getByLabel('Private distinguishing details').fill('private-browser-sentinel'); await page.getByLabel('Campus area').fill('Main Campus');
  await page.getByRole('button', { name: 'Publish post' }).click(); await expect(page.getByRole('heading', { level: 1, name: 'Notebook from browser test' })).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined(); await expect(page.getByText('private-browser-sentinel')).toHaveCount(0);
  await page.goto('/my-posts'); const row = page.locator('article').filter({ hasText: 'Notebook from browser test' }); await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Private distinguishing details')).toHaveValue('private-browser-sentinel'); await page.getByLabel('Short title').fill('Edited notebook from browser test'); await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edited notebook from browser test' })).toBeVisible();
  await page.goto('/my-posts'); const edited = page.locator('article').filter({ hasText: 'Edited notebook from browser test' }); await edited.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await edited.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Delete post', exact: true }).click(); await expect(page.getByText('Edited notebook from browser test')).toHaveCount(0);
});
test('found upload, conversation acceptance, notifications and physical return work end to end', async ({ browser }) => {
  const options = { baseURL: 'https://localhost:5473', ignoreHTTPSErrors: true, timezoneId: 'America/New_York' };
  const finderContext = await browser.newContext(options), claimantContext = await browser.newContext(options);
  const finder = await finderContext.newPage(), claimant = await claimantContext.newPage();
  try {
    await login(finder, 'finder@ucf.edu'); await finder.goto('/found/new');
    await finder.getByLabel('Category', { exact: true }).selectOption('bags'); await finder.getByLabel('Short title').fill('Recovered camera pouch'); await finder.getByLabel('Public description', { exact: true }).fill('A camera pouch found around campus.'); await finder.getByLabel('Campus area').fill('Main Campus');
    const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#222222' } }).png().toBuffer();
    await finder.getByLabel('Add photos').setInputFiles({ name: 'private-original.png', mimeType: 'image/png', buffer: image }); await expect(finder.getByAltText('Item photo 1')).toBeVisible();
    await finder.getByRole('button', { name: 'Publish post' }).click(); await expect(finder.getByRole('heading', { level: 1, name: 'Recovered camera pouch' })).toBeVisible(); const postUrl = finder.url(); const id = new URL(postUrl).pathname.split('/').at(-1);
    await login(claimant); await claimant.goto(postUrl); await claimant.getByRole('link', { name: 'This might be mine' }).click();
    await claimant.getByRole('button', { name: 'Request a private conversation' }).click();
    await finder.goto('/notifications');
    await finder.locator('article').filter({ hasText: 'A conversation request needs your review' }).first().getByRole('link', { name: 'View Campus chat' }).click();
    await finder.getByRole('button', { name: 'Accept request', exact: true }).click();
    await finder.getByRole('dialog').getByRole('button', { name: 'Accept request', exact: true }).click();
    await finder.getByRole('link', { name: 'Open conversation' }).first().click();
    await claimant.goto('/chat');
    await claimant.getByRole('link', { name: 'Open conversation' }).first().click();
    await expect(finder.getByText('Connected', { exact: true })).toBeVisible(); await expect(claimant.getByText('Connected', { exact: true })).toBeVisible();
    const literal = '<script>window.__chatxss = 1</script>';
    await finder.getByLabel('Message', { exact: true }).fill(literal); await finder.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(claimant.getByText(literal, { exact: true })).toBeVisible(); expect(await claimant.evaluate(() => window.__chatxss)).toBeUndefined();
    await claimant.getByLabel('Message', { exact: true }).fill('Thanks! Meet at the library front desk.'); await claimant.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(finder.getByText('Thanks! Meet at the library front desk.', { exact: true })).toBeVisible();
    await claimant.reload(); await expect(claimant.getByText(literal, { exact: true })).toBeVisible(); await noAxeViolations(claimant);
    await claimant.screenshot({ path: '../.tools/previews/phase6-chat.png', fullPage: true });
    await finder.goto('/my-posts'); const row = finder.locator('article').filter({ hasText: 'Recovered camera pouch' }); await row.getByRole('button', { name: 'Mark returned' }).click(); await finder.getByRole('dialog').getByRole('button', { name: 'Confirm return', exact: true }).click(); await expect(row.getByText('Returned', { exact: true })).toBeVisible();
    await claimant.goto(`/posts/${id}`); await expect(claimant.getByRole('link', { name: 'This might be mine' })).toHaveCount(0);
  } finally { await finderContext.close(); await claimantContext.close(); }
});
test('lost-post conversation requests require acceptance before real-time chat opens', async ({ browser }) => {
  const options = { baseURL: 'https://localhost:5473', ignoreHTTPSErrors: true, timezoneId: 'America/New_York' };
  const ownerContext = await browser.newContext(options), finderContext = await browser.newContext(options);
  const owner = await ownerContext.newPage(), finder = await finderContext.newPage();
  try {
    await login(owner); await owner.goto('/lost/new');
    await owner.getByLabel('Category', { exact: true }).selectOption('electronics'); await owner.getByLabel('Short title').fill('Missing tablet from chat test'); await owner.getByLabel('Public description', { exact: true }).fill('A tablet was misplaced around campus.'); await owner.getByLabel('Campus area').fill('Main Campus');
    await owner.getByRole('button', { name: 'Publish post' }).click(); await expect(owner.getByRole('heading', { level: 1, name: 'Missing tablet from chat test' })).toBeVisible(); const url = owner.url();
    await login(finder, 'finder@ucf.edu'); await finder.goto(url); await finder.getByRole('link', { name: 'I think I found this' }).click(); await finder.getByRole('button', { name: 'Request a private conversation' }).click();
    await expect(finder.getByRole('heading', { name: 'Campus chat', exact: true })).toBeVisible(); await finder.getByLabel('Request direction').selectOption('mine'); await expect(finder.locator('article').filter({ hasText: 'Missing tablet from chat test' }).getByText('Pending', { exact: true })).toBeVisible();
    await owner.goto('/chat'); const request = owner.locator('article').filter({ hasText: 'Missing tablet from chat test' }); await request.getByRole('button', { name: 'Accept request', exact: true }).click(); await owner.getByRole('dialog').getByRole('button', { name: 'Accept request', exact: true }).click();
    await expect(owner.getByRole('dialog')).toHaveCount(0); await owner.locator('article').filter({ hasText: 'Missing tablet from chat test' }).getByRole('link', { name: 'Open conversation', exact: true }).first().click();
    await finder.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await finder.locator('article').filter({ hasText: 'Missing tablet from chat test' }).getByRole('link', { name: 'Open conversation', exact: true }).first().click();
    await expect(owner.getByText('Connected', { exact: true })).toBeVisible(); await expect(finder.getByText('Connected', { exact: true })).toBeVisible();
    await finder.getByLabel('Message', { exact: true }).fill('I may have your tablet. Let us compare the details privately.'); await finder.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(owner.getByText('I may have your tablet. Let us compare the details privately.', { exact: true })).toBeVisible();
    await owner.setViewportSize({ width: 390, height: 844 }); expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await noAxeViolations(owner);
  } finally { await ownerContext.close(); await finderContext.close(); }
});

test('reports, admin removal and bans use real authorization and safe text rendering', async ({ page, browser }) => {
  const options = { baseURL: 'https://localhost:5473', ignoreHTTPSErrors: true, timezoneId: 'America/New_York' };
  const adminContext = await browser.newContext(options);
  const targetContext = await browser.newContext(options);
  const admin = await adminContext.newPage(), target = await targetContext.newPage();
  try {
    await login(target, 'moderated@ucf.edu');
    await login(page, 'reporter@ucf.edu'); await page.goto('/');
    await page.getByRole('link', { name: 'Notebook for moderation', exact: true }).click();
    const postUrl = page.url();
    await page.getByRole('button', { name: 'Report this post', exact: true }).click();
    await page.getByLabel('Report reason').selectOption('privacy');
    await page.getByLabel('Report details').fill('<script>window.__reportXss = 1</script>'); await noAxeViolations(page);
    await page.getByRole('button', { name: 'Send report', exact: true }).click(); await expect(page.getByText(/Report received/)).toBeVisible();
    await login(admin, 'moderator@ucf.edu'); await admin.goto('/admin');
    await expect(admin.getByText('<script>window.__reportXss = 1</script>', { exact: true })).toBeVisible();
    expect(await admin.evaluate(() => window.__reportXss)).toBeUndefined(); await noAxeViolations(admin);
    await admin.screenshot({ path: '../.tools/previews/phase7-moderation.png', fullPage: true });
    await admin.getByRole('button', { name: 'Review post author', exact: true }).click(); await expect(admin.getByRole('button', { name: 'Ban account', exact: true })).toBeVisible();
    await admin.getByRole('button', { name: 'Remove post', exact: true }).click();
    await admin.getByRole('dialog').getByRole('button', { name: 'Remove post', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'No reports in this queue.' })).toBeVisible();
    await page.goto(postUrl); await expect(page.getByRole('alert')).toContainText('This record is unavailable');
    await admin.getByRole('button', { name: 'Ban account', exact: true }).click(); await noAxeViolations(admin);
    await admin.getByRole('dialog').getByRole('button', { name: 'Ban account', exact: true }).click();
    await expect(admin.getByText('This account is banned.')).toBeVisible();
    await target.goto('/my-posts'); await expect(target).toHaveURL(/\/login$/);
  } finally { await adminContext.close(); await targetContext.close(); }
});

test('password-confirmed account deletion clears cookies and signs out other tabs', async ({ page, context }) => {
  await login(page, 'deleting@ucf.edu');
  await page.goto('/browse'); await page.getByRole('link', { name: 'Notebook for account deletion', exact: true }).click(); const postUrl = page.url();
  const other = await context.newPage(); await other.goto('/my-posts'); await expect(other.getByRole('heading', { name: 'My Posts', exact: true })).toBeVisible();
  await page.goto('/settings'); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Current password', { exact: true }).fill(password); await page.getByLabel('Type DELETE to confirm').fill('DELETE'); await noAxeViolations(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await noAxeViolations(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await expect(other).toHaveURL(/\/login$/); await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).filter(cookie => cookie.name.startsWith('__Host-ucf_'))).toHaveLength(0);
  await page.goto(postUrl); await expect(page.getByRole('alert')).toContainText('This record is unavailable');
});

test('authenticator enrollment, backup recovery, replacement and disabling work without persisting secrets', async ({ page, context }) => {
  const email = 'mfa-browser@ucf.edu';
  await login(page, email); await page.goto('/settings');
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  await page.getByLabel('Account password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Create setup key', exact: true }).click();
  await expect(page.getByAltText('Private authenticator enrollment QR code')).toBeVisible();
  const secret = await page.locator('.mfa-secret').textContent(); expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.setViewportSize({ width: 390, height: 844 }); await noAxeViolations(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
  await page.getByLabel('Account password', { exact: true }).fill(password); await page.getByLabel('Six-digit authenticator code').fill(code);
  await page.getByRole('button', { name: 'Enable two-step verification', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your backup codes', exact: true })).toBeVisible();
  const original = await page.locator('.backup-codes code').allTextContents(); expect(original).toHaveLength(10); expect(new Set(original).size).toBe(10);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 }); await noAxeViolations(page);
  await page.getByLabel('I saved my backup codes').check(); await page.getByRole('button', { name: 'Done saving codes' }).click(); await expect(page.locator('.mfa-secret')).toHaveCount(0); await expect(page.locator('.backup-codes')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  async function submitLogin(value) {
    await page.goto('/login'); await page.getByLabel('UCF email').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
    if (value) await page.getByLabel('Authenticator or backup code', { exact: true }).fill(value);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await submitLogin(); await expect(page.getByRole('alert')).toContainText('Sign-in failed');
  expect((await context.cookies()).some(cookie => cookie.name === '__Host-ucf_access')).toBe(false);
  await submitLogin(original[0].toLowerCase()); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.goto('/settings'); await expect(page.getByText('Enabled - 9 backup codes remaining', { exact: true })).toBeVisible(); await noAxeViolations(page);
  await page.screenshot({ path: '../.tools/previews/phase8-mfa.png', fullPage: true });
  await page.getByRole('button', { name: 'Replace backup codes', exact: true }).click(); await page.getByLabel('Account password', { exact: true }).fill(password);
  await page.getByLabel('Authenticator or backup code', { exact: true }).first().fill(original[1]); await page.getByRole('button', { name: 'Confirm replacement', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your backup codes', exact: true })).toBeVisible(); const replacement = await page.locator('.backup-codes code').allTextContents(); expect(replacement).toHaveLength(10); expect(replacement[0]).not.toBe(original[0]);
  await page.getByLabel('I saved my backup codes').check(); await page.getByRole('button', { name: 'Done saving codes' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await submitLogin(original[2]); await expect(page.getByRole('alert')).toContainText('Sign-in failed');
  await submitLogin(replacement[0]); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.goto('/settings'); await page.getByRole('button', { name: 'Disable two-step verification', exact: true }).click();
  await page.getByLabel('Account password', { exact: true }).fill(password); await page.getByLabel('Authenticator or backup code', { exact: true }).first().fill(replacement[1]);
  await page.getByRole('button', { name: 'Confirm disable', exact: true }).click(); await expect(page.getByText('Not enabled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await submitLogin(); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});
