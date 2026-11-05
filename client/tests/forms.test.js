import { consumeLink, passwordError, safeNext } from '../src/lib/forms';
test('email-link tokens are removed from browser URLs before rendering and are not stored', () => {
  const replaceState = jest.fn(), token = 'a'.repeat(64);
  expect(consumeLink({ pathname: '/reset-password', hash: `#token=${token}` }, { replaceState })).toEqual({ token });
  expect(replaceState).toHaveBeenCalledWith(undefined, '', '/reset-password');
  expect(consumeLink({ pathname: '/verify-email', hash: '#token=invalid' }, { replaceState })).toEqual({ token: null });
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
test.each(['https://evil.example', '//evil.example', '/\\evil.example', '/%2f%2fevil.example', '/login?token=secret'])('login return navigation rejects unsafe destinations: %s', value => expect(safeNext(value)).toBe('/'));
test('only internal app routes are used as return destinations', () => expect(safeNext(`/posts/${'a'.repeat(24)}/claim`)).toBe(`/posts/${'a'.repeat(24)}/claim`));
test('client password guidance rejects short, common, numeric, repeated and overlong Unicode passwords', () => {
  for (const value of ['short', 'password123456', '1234567890123456', '🌙'.repeat(6), 'x'.repeat(12), '🌙'.repeat(20)]) expect(passwordError(value)).not.toBe('');
  expect(passwordError('A useful unique passphrase 47!')).toBe('');
});
