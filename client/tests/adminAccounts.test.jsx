import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminAccounts, AdminAccountReview } from '../src/pages/AdminAccounts';
import { api } from '../src/api';

jest.mock('../src/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), adminDeleteAccount: jest.fn() },
}));
const account = {
  id: 'a'.repeat(24),
  email: 'test@ucf.edu',
  displayName: '<script>Account</script>',
  role: 'user',
  emailVerified: false,
  isBanned: false,
  isLocked: true,
  failedLoginCount: 5,
  mfaEnabled: true,
  createdAt: '2026-11-01T12:00:00Z',
};
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation((path) =>
    Promise.resolve(
      path.includes('/users?')
        ? { users: [account], pagination: { page: 1, pages: 1, total: 1 } }
        : { user: account }
    )
  );
  api.post.mockResolvedValue({});
  api.adminDeleteAccount.mockResolvedValue({});
});

test('account directory searches by email and status without interpreting display-name HTML', async () => {
  render(<AdminAccounts />);
  await screen.findByText(account.email);
  expect(document.querySelector('script')).toBeNull();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Search accounts'), account.email);
  await user.selectOptions(screen.getByLabelText('Account status'), 'unverified');
  await user.click(screen.getByRole('button', { name: 'Search accounts' }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      expect.stringContaining('search=test%40ucf.edu&status=unverified'),
      expect.objectContaining({ auth: true })
    )
  );
});

test('account email actions require confirmation and use the authenticated admin endpoint', async () => {
  render(<AdminAccountReview id={account.id} onDone={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Send verification email' }));
  expect(api.post).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Send verification email' })
  );
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/api/admin/users/${account.id}/email/verification`,
      {},
      expect.objectContaining({ auth: true })
    )
  );
});

test('admin deletion requires credentials and typed confirmation, and cancellation clears both', async () => {
  render(<AdminAccountReview id={account.id} onDone={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Delete account', exact: true }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Permanently delete account' })).toBeDisabled();
  await user.type(
    screen.getByLabelText('Your administrator password'),
    'A disposable administrator passphrase'
  );
  await user.type(screen.getByLabelText('Type DELETE to confirm account removal'), 'DELETE');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(api.adminDeleteAccount).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Delete account', exact: true }));
  expect(screen.getByLabelText('Your administrator password')).toHaveValue('');
  expect(screen.getByLabelText('Type DELETE to confirm account removal')).toHaveValue('');
});

test('confirmed deletion sends administrator credentials and MFA, then closes the review', async () => {
  const onDone = jest.fn(),
    onChanged = jest.fn();
  render(<AdminAccountReview id={account.id} onDone={onDone} onChanged={onChanged} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Delete account', exact: true }));
  await user.type(
    screen.getByLabelText('Your administrator password'),
    'A disposable administrator passphrase'
  );
  await user.type(screen.getByLabelText('Authenticator or backup code'), '123456');
  await user.type(screen.getByLabelText('Type DELETE to confirm account removal'), 'DELETE');
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Permanently delete account' })
  );
  await waitFor(() =>
    expect(api.adminDeleteAccount).toHaveBeenCalledWith(
      account.id,
      {
        password: 'A disposable administrator passphrase',
        code: '123456',
        confirmation: 'DELETE',
      },
      expect.any(AbortSignal)
    )
  );
  expect(onChanged).toHaveBeenCalled();
  expect(onDone).toHaveBeenCalled();
});

test('administrator details are read-only and expose no destructive actions', async () => {
  api.get.mockResolvedValue({ user: { ...account, role: 'admin' } });
  render(<AdminAccountReview id={account.id} onDone={() => {}} />);
  await screen.findByText('Administrator accounts are managed by the server operator.');
  expect(screen.queryByRole('button', { name: 'Delete account' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ban account' })).not.toBeInTheDocument();
});
