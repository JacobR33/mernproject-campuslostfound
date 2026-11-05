import { waitFor } from '@testing-library/react';
import { openConversation, mergeMessages } from '../src/api/chat';
import { api } from '../src/api';
jest.mock('../src/api', () => ({ api: { socketCredentials: jest.fn(), socketOrigin: undefined } }));
jest.mock('socket.io-client', () => ({ io: jest.fn() }));
function socketFixture() {
  const handlers = {};
  const socket = { connected: false, on: jest.fn((event, callback) => { handlers[event] = callback; return socket; }), timeout: jest.fn(() => socket), emitWithAck: jest.fn().mockResolvedValue({ ok: true, conversation: { id: 'conversation' } }), connect: jest.fn(() => { socket.connected = true; handlers.connect?.(); }), removeAllListeners: jest.fn(), disconnect: jest.fn(() => { socket.connected = false; }) };
  Object.defineProperty(socket, 'volatile', { get: () => socket });
  return { socket, handlers, factory: jest.fn(() => socket) };
}
const callbacks = () => ({ onStatus: jest.fn(), onReady: jest.fn(), onMessage: jest.fn(), onError: jest.fn() });
beforeEach(() => { jest.clearAllMocks(); api.socketCredentials.mockResolvedValue({ csrfToken: 'csrf-only-no-JWT' }); });
test('socket handshake contains only CSRF proof, uses credentialed WebSocket and disables automatic replay/reconnection', async () => {
  const fixture = socketFixture(), cb = callbacks(); const connection = openConversation('conversation', cb, fixture.factory);
  await waitFor(() => expect(cb.onReady).toHaveBeenCalled());
  expect(fixture.factory).toHaveBeenCalledWith(undefined, expect.objectContaining({ auth: { csrfToken: 'csrf-only-no-JWT' }, transports: ['websocket'], withCredentials: true, reconnection: false, forceNew: true }));
  expect(fixture.factory.mock.calls[0][1]).not.toHaveProperty('query'); connection.close(); expect(fixture.socket.disconnect).toHaveBeenCalled();
});
test('closed pages never open a delayed socket and disconnected sends are not buffered', async () => {
  let resolve; api.socketCredentials.mockReturnValue(new Promise(done => { resolve = done; }));
  const fixture = socketFixture(), connection = openConversation('conversation', callbacks(), fixture.factory); connection.close(); resolve({ csrfToken: 'proof' });
  await Promise.resolve(); expect(fixture.factory).not.toHaveBeenCalled(); await expect(connection.send({ body: 'private' })).rejects.toThrow('Reconnect');
});
test('history and live replay merge by server ID and sequence instead of duplicating messages', () => {
  const one = { id: 'one', sequence: 1 }, two = { id: 'two', sequence: 2 };
  expect(mergeMessages([two], [one, two])).toEqual([one, two]);
});
test('timeout does not automatically resend; explicit retry preserves the supplied message UUID', async () => {
  const fixture = socketFixture(), cb = callbacks(); const connection = openConversation('conversation', cb, fixture.factory); await waitFor(() => expect(cb.onReady).toHaveBeenCalled());
  fixture.socket.emitWithAck.mockRejectedValueOnce(new Error('transport private detail'));
  const envelope = { clientMessageId: 'same-UUID', body: 'private draft' };
  await expect(connection.send(envelope)).rejects.toThrow('Delivery was not confirmed');
  expect(fixture.socket.emitWithAck).toHaveBeenCalledTimes(2); // join plus one send
  fixture.socket.emitWithAck.mockResolvedValueOnce({ ok: true, message: { id: 'saved' } }); await connection.send(envelope);
  expect(fixture.socket.emitWithAck.mock.calls[1][1]).toEqual(fixture.socket.emitWithAck.mock.calls[2][1]); connection.close();
});
test('wrong-conversation events and late private responses after close are discarded', async () => {
  const fixture = socketFixture(), cb = callbacks(); const connection = openConversation('conversation', cb, fixture.factory); await waitFor(() => expect(cb.onReady).toHaveBeenCalled());
  fixture.handlers['message:new']({ conversationId: 'other', body: 'private wrong conversation' }); expect(cb.onMessage).not.toHaveBeenCalled();
  let complete; fixture.socket.emitWithAck.mockReturnValue(new Promise(resolve => { complete = resolve; })); const pending = connection.send({ clientMessageId: 'one', body: 'draft' }); connection.close(); complete({ ok: true, message: { id: 'private old response' } }); await expect(pending).rejects.toThrow('closed');
});
