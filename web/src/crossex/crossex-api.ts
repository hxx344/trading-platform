// CrossEx endpoints of this service. The workbench module served /api/state, /api/bootstrap, /api/settings and
// /api/live/*; here they sit under /api/crossex/ with the same bodies. Every request goes through api.ts (session
// cookie, x-pa-executor on writes, { code, message } errors), so there is no CSRF token. Writes are POST except the
// settings save (PUT); there is no DELETE.
import { ApiError } from '../api.ts';

export const CROSSEX_API = '/api/crossex';
export const CROSSEX_STATE_PATH = `${CROSSEX_API}/state`;
export const CROSSEX_BOOTSTRAP_PATH = `${CROSSEX_API}/bootstrap`;
export const CROSSEX_SETTINGS_PATH = `${CROSSEX_API}/settings`;

/** The server proved a write never left it (workbench: requestStatus "not_submitted" on the error body). */
export function writeNotSubmitted(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const body = error.body as { requestStatus?: unknown } | null | undefined;
  return error.code === 'not_submitted' || body?.requestStatus === 'not_submitted';
}

export const sessionExpired = (error: unknown): boolean => error instanceof ApiError && error.status === 401;
