import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, RequireAuth } from '../src/auth';
import { ReportPost, DeleteAccount, Admin } from '../src/pages/ModerationPages';
import { api } from '../src/api';
jest.mock('../src/api', () => ({ api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(), deleteAccount: jest.fn(), subscribe: jest.fn(() => () => {}), session: jest.fn() } }));
const id = 'a'.repeat(24), reportId = 'b'.repeat(24);
function mount(element, user = { id, role: 'user' }) {
  api.session.mockResolvedValue(user);
  return render(<MemoryRouter><AuthProvider>{element}</AuthProvider></MemoryRouter>);
}
beforeEach(() => { jest.clearAllMocks(); api.subscribe.mockImplementation(() => () => {}); });

test('anonymous reports link to login without exposing a report form', async () => {
  mount(<ReportPost postId={id} />, null);
  expect(await screen.findByRole('link', { name: 'Sign in to report this post' })).toHaveAttribute('href', '/login');
  expect(screen.queryByLabelText('Report details')).not.toBeInTheDocument(); expect(api.post).not.toHaveBeenCalled();
});

test('report submission sends only whitelisted fields once and clears sensitive text on success', async () => {
  let finish; api.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount(<ReportPost postId={id} />); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Report this post' }));
  await user.selectOptions(screen.getByLabelText('Report reason'), 'privacy'); await user.type(screen.getByLabelText('Report details'), 'Private report sentinel');
  await user.dblClick(screen.getByRole('button', { name: 'Send report' })); expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0].slice(0, 2)).toEqual([`/api/posts/${id}/reports`, { reason: 'privacy', details: 'Private report sentinel' }]);
  finish({}); await screen.findByText(/Report received/); expect(screen.queryByDisplayValue('Private report sentinel')).not.toBeInTheDocument();
});

test('account deletion requires explicit confirmation, clears password on cancellation and sends no early mutation', async () => {
  mount(<DeleteAccount />); const user = userEvent.setup();
  expect(screen.getByRole('button', { name: 'Delete my account' })).toBeDisabled();
  await user.type(screen.getByLabelText('Current password'), 'A disposable passphrase'); await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
  await user.click(screen.getByRole('button', { name: 'Delete my account' })); expect(api.deleteAccount).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByLabelText('Current password')).toHaveValue(''); expect(api.deleteAccount).not.toHaveBeenCalled();
});

test('failed account deletion clears credentials and requires a fresh explicit confirmation', async () => {
  api.deleteAccount.mockRejectedValue(new Error('Authentication failed'));
  mount(<DeleteAccount />); const user = userEvent.setup();
  await user.type(screen.getByLabelText('Current password'), 'A disposable passphrase'); await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
  await user.click(screen.getByRole('button', { name: 'Delete my account' })); await user.click(screen.getByRole('button', { name: 'Permanently delete', exact: true }));
  await screen.findByText('Authentication failed'); expect(screen.getByLabelText('Current password')).toHaveValue('');
  expect(api.deleteAccount).toHaveBeenCalledTimes(1); expect(api.deleteAccount.mock.calls[0][0]).toEqual({ password: 'A disposable passphrase', confirmation: 'DELETE' });
});

test('non-admin route guard never fetches moderation data', async () => {
  mount(<RequireAuth admin><Admin /></RequireAuth>);
  await screen.findByRole('heading', { name: 'Access restricted' }); expect(api.get).not.toHaveBeenCalled();
});

test('moderation renders report content literally and sends revision-checked decisions', async () => {
  api.get.mockResolvedValue({ reports: [{ id: reportId, postId: id, title: 'Reported book', reporter: { displayName: 'Knight' }, details: '<script>reportSentinel()</script>', reason: 'privacy', status: 'open', revision: 3, createdAt: '2026-11-04T12:00:00Z' }], pagination: { page: 1, pages: 1, total: 1 } });
  api.patch.mockResolvedValue({}); mount(<RequireAuth admin><Admin /></RequireAuth>, { id, role: 'admin' });
  await screen.findByText('<script>reportSentinel()</script>'); expect(document.querySelector('script')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss', exact: true }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/api/admin/reports/${reportId}`, { revision: 3, status: 'dismissed' }, expect.objectContaining({ auth: true })));
});

test('moderator removal requires confirmation before any mutation', async () => {
  api.get.mockResolvedValue({ reports: [{ id: reportId, postId: id, title: 'Reported book', reporter: { displayName: 'Knight' }, details: 'Report details', reason: 'privacy', status: 'open', revision: 0, createdAt: '2026-11-04T12:00:00Z' }], pagination: { page: 1, pages: 1, total: 1 } });
  mount(<Admin />, { id, role: 'admin' });
  await userEvent.click(await screen.findByRole('button', { name: 'Remove post', exact: true })); expect(api.delete).not.toHaveBeenCalled();
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })); expect(api.delete).not.toHaveBeenCalled();
});
