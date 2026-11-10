export class ApiError extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export function validateOrigin(value = '') {
  if (!value) {
    return '';
  }
  const url = new URL(value);
  if (
    url.origin !== value ||
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))
  ) {
    throw new Error('Invalid API origin');
  }
  return url.origin;
}
export function createApiClient({
  origin = '',
  fetchImpl = (...args) => fetch(...args),
  locks = globalThis.navigator?.locks,
  channel = null,
} = {}) {
  origin = validateOrigin(origin);
  let csrf = null;
  let csrfExpiresAt = 0;
  let pendingCsrfRequest;
  let pendingSessionRefresh;
  let pendingSessionRestore;
  let user = null;
  // Each account change advances this number so stale requests cannot update a new session.
  let generation = 0;
  const listeners = new Set();
  const lock = (work) => (locks?.request ? locks.request('ucf-auth-session', work) : work());
  function publish(next, hard = false, broadcast = false) {
    if (hard || user?.id !== next?.id) {
      generation++;
    }
    user = next;
    for (const listener of listeners) listener({ user, generation });
    if (broadcast) {
      channel?.postMessage({ type: 'session-changed' });
    }
  }
  // Handle transport and response errors here; session recovery happens in request().
  async function sendRequest(path, { method = 'GET', body, signal, csrfToken } = {}) {
    const pathname = typeof path === 'string' ? path.split('?')[0] : '';
    if (!/^\/api\/[a-z0-9/_-]+$/i.test(pathname) || /[\s#\\]/.test(path)) {
      throw new ApiError(0, 'Invalid request path.');
    }
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = {};
    if (body !== undefined && !multipart) {
      headers['Content-Type'] = 'application/json';
    }
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        headers,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ApiError(
        0,
        method === 'GET'
          ? 'Unable to connect. Please try again.'
          : 'The request could not be confirmed. Check your posts or claims before trying again.'
      );
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const messages = {
        400: 'Check the form details and try again.',
        401: 'Please sign in again.',
        403: 'This request was not allowed.',
        404: 'This record is unavailable or you do not have access.',
        409: 'This record changed. Reload it before trying again.',
        413: 'Choose an image smaller than 5 MiB.',
        415: 'This file or request format is not supported.',
        429: 'Too many requests. Please wait and try again.',
        503: 'The service is busy. Please try again shortly.',
      };
      const retryAfter = Number(response.headers?.get('Retry-After')) || 0;
      let message = messages[response.status] || 'Something went wrong. Please try again.';
      if (response.status === 409 && data?.code === 'REQUEST_DENIED') {
        message = 'Request was denied.';
      } else if (response.status === 429 && data?.code === 'CLAIM_ATTEMPT_LIMIT') {
        message = 'The three-attempt limit for this claim was reached.';
      } else if (response.status === 429 && retryAfter > 0) {
        message = `Too many requests. Try again in ${Math.ceil(retryAfter)} seconds.`;
      }
      const error = new ApiError(response.status, message, retryAfter);
      error.csrfRejected = response.status === 403 && data?.error === 'Request rejected';
      throw error;
    }
    return data;
  }
  async function getCsrf(force = false) {
    if (force) {
      csrf = null;
      csrfExpiresAt = 0;
    }
    if (csrf && Date.now() < csrfExpiresAt) {
      return csrf;
    }
    if (!pendingCsrfRequest) {
      pendingCsrfRequest = sendRequest('/api/auth/csrf')
        .then((data) => {
          if (
            typeof data?.csrfToken !== 'string' ||
            !/^[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/.test(data.csrfToken)
          ) {
            throw new ApiError(0, 'Unable to secure the request.');
          }
          csrf = data.csrfToken;
          csrfExpiresAt = Date.now() + 55 * 60 * 1000;
          return csrf;
        })
        .finally(() => {
          pendingCsrfRequest = null;
        });
    }
    return pendingCsrfRequest;
  }
  async function sendRequestWithCsrf(path, options = {}, csrfRetry = true, expectedGeneration) {
    const mutation = options.method && !['GET', 'HEAD'].includes(options.method);
    const csrfToken = mutation ? await getCsrf() : undefined;
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (expectedGeneration !== undefined && expectedGeneration !== generation) {
      throw new ApiError(401, 'Your session changed. Please reload.');
    }
    try {
      return await sendRequest(path, { ...options, csrfToken });
    } catch (error) {
      // A rejected CSRF check occurs before any mutation; retry at most once. Never retry network failures.
      if (mutation && csrfRetry && error.csrfRejected) {
        await getCsrf(true);
        return sendRequestWithCsrf(path, options, false, expectedGeneration);
      }
      throw error;
    }
  }
  async function refresh() {
    if (!pendingSessionRefresh) {
      pendingSessionRefresh = (async () => {
        if (!locks?.request) {
          throw new ApiError(401, 'Your session expired. Please sign in again.');
        }
        return lock(async () => {
          // Another tab may have renewed shared cookies while this tab waited for the lock.
          try {
            const data = await sendRequest('/api/auth/me');
            publish(data.user);
            return data.user;
          } catch (error) {
            if (error.status !== 401) {
              throw error;
            }
          }
          const data = await sendRequestWithCsrf('/api/auth/refresh', { method: 'POST', body: {} });
          publish(data.user);
          return data.user;
        });
      })()
        .catch((error) => {
          if (error.status === 401) {
            publish(null, true);
          }
          throw error;
        })
        .finally(() => {
          pendingSessionRefresh = null;
        });
    }
    return pendingSessionRefresh;
  }
  async function request(path, options = {}) {
    const initial = generation;
    let result;
    try {
      result = await sendRequestWithCsrf(path, options, true, options.auth ? initial : undefined);
    } catch (error) {
      if (error.status !== 401 || !options.auth || initial !== generation) {
        throw error;
      }
      await refresh();
      if (initial !== generation) {
        throw new ApiError(401, 'Your session changed. Please sign in again.');
      }
      result = await sendRequestWithCsrf(path, options, true, initial);
    }
    if (options.auth && initial !== generation) {
      throw new ApiError(401, 'Your session changed. Please reload.');
    }
    return result;
  }
  const api = {
    socketOrigin: origin || undefined,
    async socketCredentials() {
      if (!(await api.session())) {
        throw new ApiError(401, 'Please sign in again.');
      }
      const observed = generation;
      const csrfToken = await getCsrf(true);
      if (observed !== generation) {
        throw new ApiError(401, 'Your session changed. Reconnect after signing in.');
      }
      return { csrfToken };
    },
    request,
    get: (path, options) => request(path, options),
    post: (path, body = {}, options = {}) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body = {}, options = {}) => request(path, { ...options, method: 'PATCH', body }),
    delete: (path, body = {}, options = {}) =>
      request(path, { ...options, method: 'DELETE', body }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    session() {
      const observed = generation;
      if (!pendingSessionRestore) {
        pendingSessionRestore = sendRequest('/api/auth/me')
          .then((data) => {
            if (observed === generation) {
              publish(data.user);
            }
            return user;
          })
          .catch(async (error) => {
            if (observed !== generation) {
              return user;
            }
            if (error.status !== 401) {
              throw error;
            }
            try {
              return await refresh();
            } catch (failure) {
              if (failure.status === 401) {
                return null;
              }
              throw failure;
            }
          })
          .finally(() => {
            pendingSessionRestore = null;
          });
      }
      return pendingSessionRestore;
    },
    login(body, signal) {
      return lock(async () => {
        const data = await sendRequestWithCsrf('/api/auth/login', { method: 'POST', body, signal });
        publish(data.user, true, true);
        return data;
      });
    },
    logout() {
      const observed = generation;
      return lock(async () => {
        await sendRequestWithCsrf('/api/auth/logout', { method: 'POST', body: {} }, true, observed);
        publish(null, true, true);
      });
    },
    deleteAccount(body, signal) {
      const observed = generation;
      return lock(async () => {
        await sendRequestWithCsrf(
          '/api/account',
          { method: 'DELETE', body, signal },
          true,
          observed
        );
        publish(null, true, true);
      });
    },
    adminDeleteAccount(userId, body, signal) {
      if (!/^[a-f0-9]{24}$/.test(userId)) {
        return Promise.reject(new ApiError(0, 'Invalid account.'));
      }
      const observed = generation;
      return lock(async () => {
        // A bad administrator password must not trigger automatic refresh/replay.
        const result = await sendRequestWithCsrf(
          `/api/admin/users/${userId}`,
          { method: 'DELETE', body, signal },
          true,
          observed
        );
        if (observed !== generation) {
          throw new ApiError(401, 'Your session changed. Reload the admin panel.');
        }
        return result;
      });
    },
    mfaChange(action, body, signal) {
      if (!['enrollment', 'confirm', 'backup-codes', 'disable'].includes(action)) {
        return Promise.reject(new ApiError(0, 'Invalid security action.'));
      }
      const observed = generation;
      return lock(async () => {
        const data = await sendRequestWithCsrf(
          `/api/mfa/${action}`,
          { method: 'POST', body, signal },
          true,
          observed
        );
        if (observed !== generation) {
          throw new ApiError(401, 'Your session changed. Reload Settings.');
        }
        if (data.user) {
          publish(data.user, false, true);
        }
        return data;
      });
    },
    resetPassword(body, signal) {
      return lock(async () => {
        const data = await sendRequestWithCsrf('/api/auth/reset-password', {
          method: 'POST',
          body,
          signal,
        });
        publish(null, true, true);
        return data;
      });
    },
    asset(path) {
      return /^\/api\/uploads\/[a-f0-9]{24}(?:\/preview)?$/.test(path || '')
        ? `${origin}${path}`
        : '';
    },
  };
  if (channel) {
    channel.onmessage = (event) => {
      if (event.data?.type !== 'session-changed') {
        return;
      }
      publish(null, true);
      const observed = generation;
      sendRequest('/api/auth/me')
        .then((data) => {
          if (generation === observed) {
            publish(data.user);
          }
        })
        .catch(() => {
          if (generation === observed) {
            publish(null);
          }
        });
    };
  }
  return api;
}
