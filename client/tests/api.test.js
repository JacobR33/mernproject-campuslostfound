import { createApiClient } from '../src/api/client';
const csrfToken = `${'a'.repeat(64)}.${Date.now()}.${'b'.repeat(64)}`;
const response = (status, data = null) => ({ status, ok: status < 400, json: async () => data, headers: { get: () => null } });
const json = (status, data) => Promise.resolve(response(status, data));
const lock = { request: jest.fn((name, work) => work()) };

test.each(['post', 'mfa', 'delete', 'socket'])('a session switch during CSRF acquisition blocks stale %s dispatch', async kind => {
  let resolveCsrf, started, switched = false;
  const ready = new Promise(resolve => { started = resolve; });
  const fetchImpl = jest.fn(path => {
    if (path.endsWith('/csrf')) return new Promise(resolve => { resolveCsrf = resolve; started(); });
    if (path.endsWith('/me')) return json(200, { user: { id: switched ? 'new-owner' : 'old-owner' } });
    return json(200, { user: { id: 'new-owner' } });
  });
  const channel = { postMessage: jest.fn() }, api = createApiClient({ fetchImpl, locks: lock, channel }); await api.session();
  const pending = kind === 'post' ? api.post('/api/posts', { privateDetails: 'old-user-only' }, { auth: true }) : kind === 'mfa' ? api.mfaChange('confirm', { password: 'old-password', code: '123456' }) : kind === 'delete' ? api.deleteAccount({ password: 'old-password', confirmation: 'DELETE' }) : api.socketCredentials();
  await ready; switched = true; channel.onmessage({ data: { type: 'session-changed' } });
  resolveCsrf(response(200, { csrfToken }));
  await expect(pending).rejects.toMatchObject({ status: 401 });
  expect(fetchImpl.mock.calls.every(([path]) => path.endsWith('/me') || path.endsWith('/csrf'))).toBe(true);
});

test('queued security changes retain the initiating account generation before acquiring the cross-tab lock', async () => {
  let run;
  const fetchImpl = jest.fn(path => path.endsWith('/csrf') ? json(200, { csrfToken }) : json(200, { user: { id: 'owner' } }));
  const deferredLock = { request: jest.fn((name, work) => { run = work; return new Promise(() => {}); }) };
  const channel = { postMessage: jest.fn() }, api = createApiClient({ fetchImpl, locks: deferredLock, channel });
  await api.session(); api.mfaChange('disable', { password: 'old-password', code: '123456' });
  channel.onmessage({ data: { type: 'session-changed' } });
  await expect(run()).rejects.toMatchObject({ status: 401 });
  expect(fetchImpl.mock.calls.some(([path]) => path === '/api/mfa/disable')).toBe(false);
});

test('MFA changes are serialized, never retry password failures, and never broadcast secrets or remount the current account', async () => {
  let success = false;
  const user = { id: 'owner' }, codes = ['ABCDE-12345-ABCDE-12345'];
  const fetchImpl = jest.fn(path => path.endsWith('/csrf') ? json(200, { csrfToken }) : path.startsWith('/api/mfa/') ? json(success ? 200 : 401, success ? { user, backupCodes: codes } : { error: 'Authentication failed' }) : json(200, { user }));
  const channel = { postMessage: jest.fn() }, api = createApiClient({ fetchImpl, locks: lock, channel }), observer = jest.fn(); api.subscribe(observer);
  await api.session(); const generation = observer.mock.calls.at(-1)[0].generation;
  await expect(api.mfaChange('disable', { password: 'wrong', code: '123456' })).rejects.toMatchObject({ status: 401 });
  expect(fetchImpl.mock.calls.filter(([path]) => path === '/api/mfa/disable')).toHaveLength(1); expect(channel.postMessage).not.toHaveBeenCalled();
  success = true; expect((await api.mfaChange('backup-codes', { password: 'fixture password', code: '123456' })).backupCodes).toEqual(codes);
  expect(observer.mock.calls.at(-1)[0].generation).toBe(generation); expect(channel.postMessage).toHaveBeenLastCalledWith({ type: 'session-changed' });
  expect(JSON.stringify(channel.postMessage.mock.calls)).not.toContain(codes[0]); await expect(api.mfaChange('../admin', {})).rejects.toMatchObject({ status: 0 });
});

test('a late MFA response cannot republish a signed-out account or reveal its backup codes', async () => {
  let finish, started;
  const pending = new Promise(resolve => { started = resolve; });
  const fetchImpl = jest.fn(path => {
    if (path.endsWith('/csrf')) return json(200, { csrfToken });
    if (path === '/api/mfa/confirm') return new Promise(resolve => { finish = resolve; started(); });
    if (path.endsWith('/logout')) return json(204);
    return json(200, { user: { id: 'owner' } });
  });
  const api = createApiClient({ fetchImpl, locks: lock }), observer = jest.fn(); api.subscribe(observer); await api.session();
  const change = api.mfaChange('confirm', { password: 'fixture password', code: '123456' });
  await pending; await api.logout(); finish(response(200, { user: { id: 'owner' }, backupCodes: ['private-code'] }));
  await expect(change).rejects.toMatchObject({ status: 401 });
  expect(observer).toHaveBeenLastCalledWith(expect.objectContaining({ user: null }));
});

test('account deletion publishes signout only after success and never refreshes or replays a failed password check', async () => {
  let allowed = false;
  const fetchImpl = jest.fn(path => path.endsWith('/csrf') ? json(200, { csrfToken }) : path === '/api/account' ? json(allowed ? 204 : 401, { error: 'Authentication failed' }) : json(200, { user: { id: 'owner' } }));
  const channel = { postMessage: jest.fn() }, api = createApiClient({ fetchImpl, locks: lock, channel }), observer = jest.fn(); api.subscribe(observer);
  await api.session(); observer.mockClear();
  await expect(api.deleteAccount({ password: 'wrong', confirmation: 'DELETE' })).rejects.toMatchObject({ status: 401 });
  expect(observer).not.toHaveBeenCalled(); expect(fetchImpl.mock.calls.filter(([path]) => path === '/api/account')).toHaveLength(1); expect(fetchImpl.mock.calls.some(([path]) => path.endsWith('/refresh'))).toBe(false);
  allowed = true; await api.deleteAccount({ password: 'correct fixture', confirmation: 'DELETE' });
  expect(observer).toHaveBeenLastCalledWith(expect.objectContaining({ user: null })); expect(channel.postMessage).toHaveBeenCalledWith({ type: 'session-changed' });
});
test('mutations use credentials and a CSRF header, and never expose cookies or tokens to storage', async () => {
  const fetchImpl = jest.fn(path => path.endsWith('/csrf') ? json(200, { csrfToken }) : json(201, { post: { id: 'created' } }));
  const api = createApiClient({ fetchImpl, locks: lock });
  await api.post('/api/posts', { title: 'My item' });
  expect(fetchImpl.mock.calls[1][1]).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' } });
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
test('multipart leaves Content-Type to the browser and still carries CSRF', async () => {
  const fetchImpl = jest.fn(path => path.endsWith('/csrf') ? json(200, { csrfToken }) : json(201, {}));
  const api = createApiClient({ fetchImpl }); const form = new FormData(); form.append('image', new Blob(['data']), 'photo.jpg');
  await api.post('/api/uploads', form);
  expect(fetchImpl.mock.calls[1][1].headers).toEqual({ 'X-CSRF-Token': csrfToken });
  expect(fetchImpl.mock.calls[1][1].body).toBe(form);
});
test('a CSRF rejection retries once but a network failure never replays a mutation', async () => {
  let attempts = 0;
  const fetchImpl = jest.fn(path => path.endsWith('/csrf') ? json(200, { csrfToken }) : ++attempts === 1 ? json(403, { error: 'Request rejected' }) : json(201, {}));
  await createApiClient({ fetchImpl }).post('/api/posts', {}); expect(attempts).toBe(2);
  const offline = jest.fn(path => path.endsWith('/csrf') ? json(200, { csrfToken }) : Promise.reject(new Error('private transport URL')));
  await expect(createApiClient({ fetchImpl: offline }).post('/api/posts', {})).rejects.toMatchObject({ status: 0 }); expect(offline).toHaveBeenCalledTimes(2);
});
test('concurrent protected failures share one refresh, with an in-lock session probe', async () => {
  let authenticated = false, refreshes = 0;
  const fetchImpl = jest.fn(path => {
    if (path.endsWith('/csrf')) return json(200, { csrfToken });
    if (path.endsWith('/refresh')) { refreshes++; authenticated = true; return json(200, { user: { id: 'knight' } }); }
    if (path.endsWith('/me')) return authenticated ? json(200, { user: { id: 'knight' } }) : json(401, {});
    return authenticated ? json(200, { claims: [] }) : json(401, {});
  });
  const api = createApiClient({ fetchImpl, locks: lock }); await api.session(); authenticated = false;
  await Promise.all([api.get('/api/claims/mine', { auth: true }), api.get('/api/notifications', { auth: true })]);
  expect(refreshes).toBe(2); // one bootstrap rotation and one shared renewal
});
test('unsupported cross-tab locks fail closed instead of risking refresh replay', async () => {
  const fetchImpl = jest.fn(() => json(401, {}));
  const api = createApiClient({ fetchImpl, locks: null });
  expect(await api.session()).toBeNull(); expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls.some(([path]) => path.endsWith('/refresh'))).toBe(false);
});
test('a delayed session probe cannot overwrite a newer login or return old private data', async () => {
  let finish;
  const fetchImpl = jest.fn(path => {
    if (path.endsWith('/csrf')) return json(200, { csrfToken });
    if (path.endsWith('/login')) return json(200, { user: { id: 'new-user' } });
    return new Promise(resolve => { finish = resolve; });
  });
  const api = createApiClient({ fetchImpl, locks: lock }); const bootstrap = api.session();
  await api.login({ email: 'fixture@ucf.edu', password: 'fixture-only' }); finish(response(200, { user: { id: 'old-user' } }));
  expect(await bootstrap).toEqual({ id: 'new-user' });
  const privateRead = api.get('/api/claims/mine', { auth: true });
  await api.login({}); finish(response(200, { private: 'previous user data' }));
  await expect(privateRead).rejects.toMatchObject({ status: 401 });
});
test('asset and request paths cannot forward credentials to arbitrary sites', async () => {
  const fetchImpl = jest.fn(); const api = createApiClient({ fetchImpl });
  expect(api.asset('https://evil.example/tracker')).toBe(''); expect(api.asset('javascript:alert(1)')).toBe('');
  expect(api.asset(`/api/uploads/${'a'.repeat(24)}`)).toBe(`/api/uploads/${'a'.repeat(24)}`);
  await expect(api.get('https://evil.example/api')).rejects.toMatchObject({ status: 0 }); expect(fetchImpl).not.toHaveBeenCalled();
  expect(() => createApiClient({ origin: 'https://api.example/path' })).toThrow();
  expect(() => createApiClient({ origin: 'http://remote.example' })).toThrow();
});
test('encoded search punctuation stays in the query while encoded path traversal is rejected', async () => {
  const fetchImpl = jest.fn(() => json(200, {})); const api = createApiClient({ fetchImpl });
  await api.get('/api/posts?q=some..thing+*&location=Main+Campus');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(api.get('/api/%2e%2e/private')).rejects.toMatchObject({ status: 0 });
});
