import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { api } from '../src/api';

jest.mock('../src/api', () => ({
  api: {
    session: jest.fn(),
    subscribe: jest.fn(() => () => {}),
    get: jest.fn(),
    login: jest.fn(),
  },
}));
jest.mock('../src/pages/Browse', () => ({
  Browse: () => <h1>Campus board</h1>,
}));

beforeEach(() => {
  jest.clearAllMocks();
  api.subscribe.mockImplementation(() => () => {});
  api.get.mockResolvedValue({ pagination: { total: 0 } });
});

function openHomepage() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>
  );
}

test('a signed-out homepage visitor sees Login with a registration option', async () => {
  api.session.mockResolvedValue(null);
  openHomepage();

  expect(await screen.findByRole('heading', { name: 'Welcome back, Knight.' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
    'href',
    '/register'
  );
  expect(screen.queryByRole('heading', { name: 'Campus board' })).not.toBeInTheDocument();
});

test('an authenticated homepage visitor sees the main application', async () => {
  api.session.mockResolvedValue({ id: 'demo-user', role: 'user' });
  openHomepage();

  expect(await screen.findByRole('heading', { name: 'Campus board' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('wrong credentials show a generic failure on Login without opening the board', async () => {
  api.session.mockResolvedValue(null);
  api.login.mockRejectedValue(Object.assign(new Error('Private server detail'), { status: 401 }));
  openHomepage();

  await screen.findByRole('heading', { name: 'Welcome back, Knight.' });
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('UCF email'), 'demo@ucf.edu');
  await user.type(screen.getByLabelText('Password'), 'Incorrect demo passphrase 47!');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed.');
  expect(screen.queryByText('Private server detail')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Campus board' })).not.toBeInTheDocument();
});
