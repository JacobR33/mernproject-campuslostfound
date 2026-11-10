import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from '../src/auth';
import { Login, LinkAction } from '../src/pages/AuthPages';
import { ClaimDestination, Notifications } from '../src/pages/ClaimPages';
import { api } from '../src/api';
import { MatchPage } from '../src/pages/ChatPages';
import { PostDetail, PostEditor } from '../src/pages/PostPages';
jest.mock('../src/api', () => ({ api: { get: jest.fn(), post: jest.fn(), login: jest.fn(), subscribe: jest.fn(() => () => {}), session: jest.fn(), asset: jest.fn(() => ''), resetPassword: jest.fn() } }));
const id = 'a'.repeat(24);
function wrapper(element, authenticated = false) {
  api.session.mockResolvedValue(authenticated ? { id: 'claimant', role: 'user' } : null);
  return render(<MemoryRouter><AuthProvider>{element}</AuthProvider></MemoryRouter>);
}
beforeEach(() => { jest.clearAllMocks(); api.subscribe.mockImplementation(() => () => {}); });

test('denied conversation notifications explain the decision and link to sent requests', async () => {
  api.get.mockResolvedValue({ notifications: [{ id, kind: 'match_denied', postId: id, matchRequestId: id, readAt: null }] });
  wrapper(<Notifications />, true);
  expect(await screen.findByText('Your conversation request was denied')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View Campus chat' })).toHaveAttribute('href', '/chat?direction=mine');
});
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
const foundPost = {
  id, type: 'found', status: 'claim_pending', acceptingMatches: true,
  author: { id: 'finder', displayName: 'Finder' },
  item: { title: 'Found keys', publicDescription: 'Keys near the library', category: 'keys', images: [], dateFoundOrLost: '2026-11-01', locationFound: { campusArea: 'Main' } },
};
function claimRoutes(element, route = `/posts/${id}`) {
  api.session.mockResolvedValue({ id: 'claimant', role: 'user' });
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><Routes>
    <Route path="/posts/:id" element={element} />
    <Route path="/claims/:claimId" element={<ClaimDestination />} />
    <Route path="/chat/:conversationId" element={<p>Private chat destination</p>} />
  </Routes></AuthProvider></MemoryRouter>);
}
test('found posts offer conversation requests instead of verification forms', async () => {
  api.get.mockResolvedValue({ post: foundPost });
  claimRoutes(<PostDetail />);
  expect(await screen.findByRole('link', { name: 'This might be mine' })).toHaveAttribute('href', `/posts/${id}/match`);
  expect(api.get.mock.calls.some(([path]) => path.includes('/my-claim'))).toBe(false);
});
test('found item creation has no ownership questions or private answers', async () => {
  wrapper(<PostEditor type="found" />, true);
  expect(await screen.findByRole('button', { name: 'Publish post' })).toBeInTheDocument();
  await waitFor(() => expect(api.session).toHaveBeenCalled());
  expect(screen.queryByText('Private ownership verification')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Private answer/)).not.toBeInTheDocument();
});
test.each([
  ['claim_approved', 'View conversation', `/claims/${id}`],
  ['claim_denied', 'View post', `/posts/${id}`],
])('%s notifications link to their replacement destination', async (kind, label, href) => {
  api.get.mockResolvedValue({ notifications: [{ id, kind, postId: id, claimId: id, attemptCount: 1 }] });
  wrapper(<Notifications />, true);
  expect(await screen.findByRole('link', { name: label })).toHaveAttribute('href', href);
});
test('approved claim destination resolves the private conversation', async () => {
  api.get.mockResolvedValue({ claim: { post: { id }, conversationId: 'conversation1' } });
  claimRoutes(<PostDetail />, `/claims/${id}`);
  expect(await screen.findByText('Private chat destination')).toBeInTheDocument();
});

test('found-item requests submit without ownership questions or answers', async () => {
  api.session.mockResolvedValue({ id: 'claimant', role: 'user' });
  api.get.mockResolvedValue({ post: foundPost });
  api.post.mockResolvedValue({ request: { id: 'request1', status: 'pending' } });
  render(<MemoryRouter initialEntries={[`/posts/${id}/match`]}><AuthProvider><Routes>
    <Route path="/posts/:id/match" element={<RequireAuth><MatchPage /></RequireAuth>} />
    <Route path="/chat" element={<p>Your sent requests</p>} />
  </Routes></AuthProvider></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'Request a private conversation' }));
  expect(api.post).toHaveBeenCalledWith(`/api/posts/${id}/matches`, {}, expect.objectContaining({ auth: true }));
  expect(await screen.findByText('Your sent requests')).toBeInTheDocument();
});
