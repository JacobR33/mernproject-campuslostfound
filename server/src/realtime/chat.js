const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const { z } = require('zod');
const { resolveAuth, cookies } = require('../middleware/auth');
const { validCsrf, equal } = require('../lib/authCrypto');
const { consumeRate } = require('../middleware/rateLimit');
const { accessConversation, conversationDTO, saveMessage } = require('../services/conversations');
const { joinPayload, messagePayload } = require('../validation/chat');
const { clientAddress } = require('../lib/clientAddress');
const authSchema = z.object({ csrfToken: z.string().max(200) }).strict();
const parseCookies = (request) =>
  new Promise((resolve, reject) =>
    cookieParser()(request, {}, (error) => (error ? reject(error) : resolve(request.cookies)))
  );
function attachChat(server, config, logger) {
  const address = clientAddress(config);
  const reservations = new Map();
  const io = new Server(server, {
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: 16384,
    perMessageDeflate: false,
    connectTimeout: 10000,
    cors: { origin: config.CLIENT_ORIGIN, credentials: true },
    allowRequest: (req, done) => {
      const entries = [...new URL(req.url, 'http://localhost').searchParams];
      const query = Object.fromEntries(entries);
      if (
        req.headers.origin !== config.CLIENT_ORIGIN ||
        (req.headers.cookie?.length || 0) > 8192 ||
        entries.length !== Object.keys(query).length ||
        !z
          .object({ EIO: z.literal('4'), transport: z.literal('websocket') })
          .strict()
          .safeParse(query).success
      ) {
        return done('Request rejected', false);
      }
      consumeRate('socket-connect', address(req), 30)
        .then(() => done(null, true))
        .catch(() => done('Request rejected', false));
    },
  });
  async function identity(socket) {
    return resolveAuth(config, socket.data.accessToken);
  }
  io.use(async (socket, next) => {
    try {
      const values = await parseCookies(socket.request);
      const payload = authSchema.parse(socket.handshake.auth);
      if (
        !equal(values[cookies.csrf], payload.csrfToken) ||
        !validCsrf(payload.csrfToken, config.JWT_SECRET)
      ) {
        throw new Error('Request rejected');
      }
      const auth = await resolveAuth(config, values[cookies.access]);
      const userId = String(auth.user._id);
      if ((reservations.get(userId) || 0) >= 5) {
        throw new Error('Connection limit');
      }
      reservations.set(userId, (reservations.get(userId) || 0) + 1);
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = (reservations.get(userId) || 1) - 1;
        if (remaining) {
          reservations.set(userId, remaining);
        } else {
          reservations.delete(userId);
        }
      };
      socket.conn.once('close', release);
      socket.once('disconnect', release);
      socket.data.accessToken = values[cookies.access];
      socket.data.userId = String(auth.user._id);
      socket.data.expires = auth.claims.exp;
      next();
    } catch {
      next(new Error('Authentication required'));
    }
  });
  async function distribute(message) {
    for (const peer of io.of('/').sockets.values()) {
      if (peer.data.conversationId !== message.conversationId) {
        continue;
      }
      try {
        const auth = await identity(peer);
        await accessConversation(auth.user._id, message.conversationId);
        if (peer.connected) {
          peer.emit('message:new', message);
        }
      } catch {
        peer.disconnect(true);
      }
    }
  }
  io.on('connection', (socket) => {
    let window = Date.now();
    let count = 0;
    let inflight = 0;
    const expiry = setTimeout(
      () => {
        socket.emit('session:expired');
        socket.disconnect(true);
      },
      Math.max(1, socket.data.expires * 1000 - Date.now())
    ).unref();
    socket.on('disconnect', () => clearTimeout(expiry));
    socket.onAny((event, ...args) => {
      const ack = args.at(-1);
      if (Date.now() - window >= 60000) {
        window = Date.now();
        count = 0;
      }
      if (++count > 100) {
        if (typeof ack === 'function') {
          ack({ ok: false, status: 429 });
        }
        socket.disconnect(true);
        return;
      }
      if (inflight >= 2) {
        if (typeof ack === 'function') {
          ack({ ok: false, status: 429 });
        }
        return;
      }
      if (typeof ack !== 'function' || args.length !== 2) {
        return;
      }
      inflight++;
      (async () => {
        const schema =
          event === 'conversation:join'
            ? joinPayload
            : event === 'message:send'
              ? messagePayload
              : event === 'conversation:leave'
                ? z.object({}).strict()
                : null;
        const parsed = schema?.safeParse(args[0]);
        if (!parsed?.success) {
          ack({ ok: false, status: 400 });
          return;
        }
        const auth = await identity(socket);
        if (event === 'conversation:leave') {
          socket.data.conversationId = null;
          ack({ ok: true });
          return;
        }
        if (event === 'conversation:join') {
          await consumeRate('chat-join', socket.data.userId, 60);
          const access = await accessConversation(auth.user._id, parsed.data.conversationId);
          socket.data.conversationId = parsed.data.conversationId;
          ack({ ok: true, conversation: conversationDTO(access) });
          return;
        }
        await consumeRate('chat-send-user', socket.data.userId, 60);
        await consumeRate(
          'chat-send-conversation',
          `${socket.data.userId}:${parsed.data.conversationId}`,
          20
        );
        const result = await saveMessage(auth, parsed.data);
        logger('audit_chat_send', {
          actorId: socket.data.userId,
          outcome: result.created ? 'created' : 'reused',
        });
        if (result.created) {
          await distribute(result.message);
        }
        ack({ ok: true, message: result.message });
      })()
        .catch((error) => {
          const status =
            error.authStatus === 401
              ? 401
              : [404, 409, 429].includes(error.httpStatus)
                ? error.httpStatus
                : 500;
          ack({ ok: false, status });
          logger('chat_event_rejected', { actorId: socket.data.userId, code: status });
          if (status === 401) {
            socket.disconnect(true);
          }
        })
        .finally(() => {
          inflight--;
        });
    });
  });
  let checking = false;
  const sweep = setInterval(async () => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      for (const socket of io.of('/').sockets.values()) {
        try {
          const auth = await identity(socket);
          if (socket.data.conversationId) {
            await accessConversation(auth.user._id, socket.data.conversationId);
          }
        } catch {
          socket.disconnect(true);
        }
      }
    } finally {
      checking = false;
    }
  }, 15000).unref();
  return {
    io,
    close: async () => {
      clearInterval(sweep);
      await new Promise((resolve) => io.close(resolve));
    },
  };
}
module.exports = { attachChat };
