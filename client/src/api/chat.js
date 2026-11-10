import { io } from 'socket.io-client';
import { api } from './index';
export function mergeMessages(previous, added) {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of added) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}
export function openConversation(
  conversationId,
  { onStatus, onReady, onMessage, onError },
  socketFactory = io
) {
  let live = true;
  let socket;
  let joined = false;
  (async () => {
    onStatus('connecting');
    const auth = await api.socketCredentials();
    if (!live) {
      return;
    }
    socket = socketFactory(api.socketOrigin, {
      path: '/socket.io/',
      auth,
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false,
      reconnection: false,
      forceNew: true,
    });
    socket.on('connect', async () => {
      try {
        const result = await socket
          .timeout(7000)
          .emitWithAck('conversation:join', { conversationId });
        if (!live) {
          return;
        }
        if (!result.ok) {
          throw new Error('This conversation is unavailable.');
        }
        joined = true;
        onStatus('connected');
        onReady(result.conversation);
      } catch {
        if (live) {
          onStatus('disconnected');
          onError('Unable to open this conversation. Reconnect to try again.');
        }
      }
    });
    socket.on('message:new', (message) => {
      if (live && joined && message.conversationId === conversationId) {
        onMessage(message);
      }
    });
    socket.on('disconnect', () => {
      joined = false;
      if (live) {
        onStatus('disconnected');
      }
    });
    socket.on('session:expired', () => {
      if (live) {
        onError('Your chat session ended. Reconnect to continue.');
      }
    });
    socket.on('connect_error', () => {
      if (live) {
        onStatus('disconnected');
        onError('Unable to connect. Check your session and try reconnecting.');
      }
    });
    socket.connect();
  })().catch(() => {
    if (live) {
      onStatus('disconnected');
      onError('Unable to connect. Please sign in again or reconnect.');
    }
  });
  return {
    async send(value) {
      if (!live || !joined || !socket?.connected) {
        throw new Error('Reconnect before sending a message.');
      }
      let result;
      try {
        result = await socket.volatile
          .timeout(7000)
          .emitWithAck('message:send', { ...value, conversationId });
      } catch {
        throw new Error('Delivery was not confirmed. Check history or retry this same draft.');
      }
      if (!live) {
        throw new Error('This conversation was closed.');
      }
      if (!result.ok) {
        throw new Error(
          result.status === 429
            ? 'You are sending too quickly. Wait a minute before retrying.'
            : result.status === 401
              ? 'Your session ended. Reconnect to continue.'
              : result.status === 409
                ? 'This draft changed. Discard it before writing a new message.'
                : 'This message could not be sent. Check your conversation access.'
        );
      }
      return result.message;
    },
    close() {
      live = false;
      joined = false;
      socket?.removeAllListeners();
      socket?.disconnect();
    },
  };
}
