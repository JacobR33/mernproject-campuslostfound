import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, RequireAuth } from '../src/auth';
import { Login, LinkAction } from '../src/pages/AuthPages';
import { ClaimPage } from '../src/pages/ClaimPages';
import { api } from '../src/api';
jest.mock('../src/api', () => ({ api: { get: jest.fn(), post: jest.fn(), login: jest.fn(), subscribe: jest.fn(() => () => {}), session: jest.fn(), asset: jest.fn(() => ''), resetPassword: jest.fn() } }));
const id = 'a'.repeat(24);
function wrapper(element, authenticated = false) {
  api.session.mockResolvedValue(authenticated ? { id: 'claimant', role: 'user' } : null);
  return render(<MemoryRouter><AuthProvider>{element}</AuthProvider></MemoryRouter>);
}
beforeEach(() => { jest.clearAllMocks(); api.subscribe.mockImplementation(() => () => {}); });
test('private pages do not render sensitive content before authentication resolves', async () => {
  let resolve; api.session.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<MemoryRouter><AuthProvider><RequireAuth><p>private-answer-sentinel</p></RequireAuth></AuthProvider></MemoryRouter>);
  expect(screen.queryByText('private-answer-sentinel')).not.toBeInTheDocument();
  resolve(null); await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.queryByText('private-answer-sentinel')).not.toBeInTheDocument();
});
test('login uses JSON credentials only once on rapid double submission and clears the password', async () => {
  let done; api.login.mockReturnValue(new Promise(resolve => { done = resolve; }));
  wrapper(<Login />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('UCF email'), 'Knight@UCF.EDU'); await user.type(screen.getByLabelText('Password'), 'Campus fixture passphrase 47!');
  await user.dblClick(screen.getByRole('button', { name: 'Sign in' })); expect(api.login).toHaveBeenCalledTimes(1);
  expect(api.login.mock.calls[0][0].email).toBe('knight@ucf.edu'); done({ user: { id } });
  await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''));
});
test('verification requires an explicit click, never reflects or stores a link token, and consumes it on success', async () => {
  const actionLink = { token: 'd'.repeat(64) }; api.post.mockResolvedValue({}); wrapper(<LinkAction actionLink={actionLink} />);
  expect(api.post).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain(actionLink.token);
  await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
  await screen.findByText(/Your email is verified/); expect(actionLink.token).toBeNull(); expect(localStorage.length).toBe(0);
});
test('expired verification links offer a recovery route without exposing the token', async () => {
  api.post.mockRejectedValue(Object.assign(new Error('Invalid request'), { status: 400 }));
  wrapper(<LinkAction actionLink={{ token: 'c'.repeat(64) }} />);
  await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
  await screen.findByText(/This link is invalid, expired/);
  expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/resend-verification');
});
test('submitted question HTML is rendered as text and a three-attempt claimant cannot submit again', async () => {
  api.get.mockImplementation(path => Promise.resolve(path.endsWith('/my-claim') ? { claim: { attemptCount: 3, status: 'pending' } } : { post: { id, author: { id: 'finder' }, item: { title: '<script>sentinel()</script>' }, acceptingClaims: true, verificationQuestions: [] } }));
  wrapper(<ClaimPage />, true);
  await screen.findByText('<script>sentinel()</script>'); expect(document.querySelector('script')).toBeNull();
  expect(await screen.findByText(/used all three attempts/)).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
});
