import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/auth';
import { MfaSettings } from '../src/pages/MfaSettings';
import { Login } from '../src/pages/AuthPages';
import { api } from '../src/api';
jest.mock('../src/api', () => ({ api: { get: jest.fn(), mfaChange: jest.fn(), login: jest.fn(), session: jest.fn(), subscribe: jest.fn(() => () => {}) } }));
const secret = 'A'.repeat(32), enrollmentId = 'b'.repeat(64), seed = { secret, enrollmentId, qrDataUrl: 'data:image/png;base64,aGVsbG8=', expiresAt: '2026-11-04T16:00:00Z' };
function mount(element, authenticated = true) { api.session.mockResolvedValue(authenticated ? { id: 'owner', role: 'user' } : null); return render(<MemoryRouter><AuthProvider>{element}</AuthProvider></MemoryRouter>); }
beforeEach(() => { jest.clearAllMocks(); api.subscribe.mockImplementation(() => () => {}); api.get.mockResolvedValue({ enabled: false, backupCodesRemaining: 0 }); });
test('login sends an optional second factor only on explicit submission and clears both credentials after failure', async () => {
  api.login.mockRejectedValue(Object.assign(new Error('Authentication failed'), { status: 401 })); mount(<Login />, false); const user = userEvent.setup();
  await user.type(screen.getByLabelText('UCF email'), 'owner@ucf.edu'); await user.type(screen.getByLabelText('Password', { exact: true }), 'A private passphrase'); await user.type(screen.getByLabelText('Authenticator or backup code'), ' ABCDE-12345-ABCDE-12345 ');
  await user.click(screen.getByRole('button', { name: 'Sign in', exact: true })); await screen.findByRole('alert');
  expect(api.login.mock.calls[0][0]).toEqual({ email: 'owner@ucf.edu', password: 'A private passphrase', code: 'ABCDE-12345-ABCDE-12345' });
  expect(screen.getByLabelText('Password', { exact: true })).toHaveValue(''); expect(screen.getByLabelText('Authenticator or backup code')).toHaveValue('');
});
test('enrollment is password-confirmed and explicitly confirmed with code; secrets and backup codes stay out of browser storage', async () => {
  api.mfaChange.mockResolvedValueOnce(seed).mockResolvedValueOnce({ backupCodes: ['ABCDE-12345-ABCDE-12345'] });
  mount(<MfaSettings />); const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
  await user.type(screen.getByLabelText('Account password'), 'A private passphrase'); await user.click(screen.getByRole('button', { name: 'Create setup key' }));
  expect(await screen.findByText(secret)).toBeInTheDocument(); expect(screen.getByAltText('Private authenticator enrollment QR code')).toHaveAttribute('src', seed.qrDataUrl);
  expect(screen.getByLabelText('Account password')).toHaveValue(''); expect(api.mfaChange).toHaveBeenCalledTimes(1);
  await user.type(screen.getByLabelText('Account password'), 'A private passphrase'); await user.type(screen.getByLabelText('Six-digit authenticator code'), '123456'); await user.click(screen.getByRole('button', { name: 'Enable two-step verification', exact: true }));
  await screen.findByRole('heading', { name: 'Save your backup codes' }); expect(api.mfaChange.mock.calls[1].slice(0, 2)).toEqual(['confirm', { password: 'A private passphrase', enrollmentId, code: '123456' }]);
  expect(screen.queryByText(secret)).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Done saving codes' })).toBeDisabled();
  await user.click(screen.getByLabelText('I saved my backup codes')); await user.click(screen.getByRole('button', { name: 'Done saving codes' }));
  expect(screen.queryByText('ABCDE-12345-ABCDE-12345')).not.toBeInTheDocument(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
test('cancelling setup forgets the displayed seed and never enables MFA', async () => {
  api.mfaChange.mockResolvedValue(seed); mount(<MfaSettings />); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Set up authenticator' })); await user.type(screen.getByLabelText('Account password'), 'A private passphrase'); await user.click(screen.getByRole('button', { name: 'Create setup key' }));
  await screen.findByText(secret); await user.click(screen.getByRole('button', { name: 'Cancel setup or change' })); expect(screen.queryByText(secret)).not.toBeInTheDocument(); expect(api.mfaChange).toHaveBeenCalledTimes(1);
});
test('setup refuses non-PNG or externally hosted QR content', async () => {
  api.mfaChange.mockResolvedValue({ ...seed, qrDataUrl: 'https://attacker.example/qr.svg' }); mount(<MfaSettings />); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Set up authenticator' })); await user.type(screen.getByLabelText('Account password'), 'A private passphrase'); await user.click(screen.getByRole('button', { name: 'Create setup key' }));
  await screen.findByText('Setup could not be displayed. Start a new setup.'); expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.queryByText(secret)).not.toBeInTheDocument();
});
test.each([['Disable two-step verification', 'Confirm disable', 'disable'], ['Replace backup codes', 'Confirm replacement', 'backup-codes']])('%s requires explicit password and factor submission', async (open, button, action) => {
  api.get.mockResolvedValue({ enabled: true, backupCodesRemaining: 8 }); api.mfaChange.mockRejectedValue(new Error('Authentication failed'));
  mount(<MfaSettings />); const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: open })); expect(api.mfaChange).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Account password'), 'A private passphrase'); await user.type(screen.getByLabelText('Authenticator or backup code'), '123456'); await user.click(screen.getByRole('button', { name: button }));
  await screen.findByText('Authentication failed'); expect(api.mfaChange.mock.calls[0].slice(0, 2)).toEqual([action, { password: 'A private passphrase', code: '123456' }]); expect(screen.getByLabelText('Account password')).toHaveValue(''); expect(screen.getByLabelText('Authenticator or backup code')).toHaveValue('');
});
