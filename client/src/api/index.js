import { createApiClient } from './client';
export const api = createApiClient({
  origin: import.meta.env.VITE_API_ORIGIN || '',
  channel:
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ucf-session-events') : null,
});
