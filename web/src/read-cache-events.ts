/** A server response has rejected the page's login. Drop retained display data across subscribers. */
export const READ_SESSION_EXPIRED = 'tp:read-session-expired';

export function notifyReadSessionExpired(): void {
  (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent?.(new Event(READ_SESSION_EXPIRED));
}
