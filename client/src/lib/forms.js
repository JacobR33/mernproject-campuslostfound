export const categories = [
  'electronics',
  'keys',
  'wallets',
  'bags',
  'clothing',
  'books',
  'jewelry',
  'ids',
  'other',
];
export const titleCase = (value) =>
  (value || '').replaceAll('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
export const formatDate = (value) =>
  value
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value))
    : 'Not specified';
export const safeNext = (value) =>
  typeof value === 'string' &&
  /^\/(?:my-posts|my-claims|notifications|settings|admin|(?:found|lost)\/new|claims\/[a-f0-9]{24}|posts\/[a-f0-9]{24}(?:\/(?:claim|edit|review|match))?|chat(?:\/[a-f0-9]{24})?)?$/.test(
    value
  )
    ? value
    : '/';
const common = new Set([
  'password1234',
  'password12345',
  'password123456',
  'password123456789',
  '123456789012',
  '1234567890123456',
  'qwertyuiop123',
  'qwertyuiopasdfghjkl',
  'letmein123456',
  'welcome12345',
  'iloveyou12345',
  'ucfknights123',
]);
export function passwordError(value) {
  if (Array.from(value).length < 12) {
    return 'Use at least 12 characters.';
  }
  if (new TextEncoder().encode(value).length > 72 || value.includes('\0')) {
    return 'This password is too long or contains an unsupported character.';
  }
  if (common.has(value.toLowerCase()) || /^(.)\1+$/u.test(value) || /^\d+$/.test(value)) {
    return 'Choose a less common passphrase.';
  }
  return '';
}
export function consumeLink(location = window.location, history = window.history) {
  if (!['/verify-email', '/reset-password'].includes(location.pathname)) {
    return { token: null };
  }
  const value = new URLSearchParams(location.hash.slice(1)).get('token');
  // Scrub the fragment before mounting React, loading data, or rendering links.
  history.replaceState(history.state, '', location.pathname);
  return { token: /^[a-f0-9]{64}$/.test(value || '') ? value : null };
}
export function queryString(value) {
  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(value))
    if (item !== '' && item !== undefined) {
      params.set(key, item);
    }
  return params.toString();
}
