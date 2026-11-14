// What the CrossEx page does after a confirm or cancel write comes back (CrossexPage.tsx mutate). Not in the workbench
// (modules/crossex/src/App.tsx, commit 7745181, decided inline and kept every request id until the connection changed):
// split out so the safety rules are unit-tested. The pending-request and review-dialog rules are the workbench's; the
// request-id rule follows docs/frontend.md rule 5: only an explicit server rejection ends the id, an unknown result
// keeps it so a retry of the same action reuses it.
import { ApiError } from '../api.ts';
import { sessionExpired, writeNotSubmitted } from './crossex-api.ts';
import { stateIsUncertain } from './live-display.ts';

export type WriteOutcome = {
  /** The request id is finished: the next attempt of this action gets a new one. */
  retireRequestId: boolean;
  /** Whether the sessionStorage pending request is removed; while it stays, new trades are blocked until it is queried. */
  clearPending: boolean;
  /** The review dialog stays open for an immediate re-preview: the server proved the write was never submitted. */
  keepReview: boolean;
  /** The session ended: show the login prompt at once. */
  expired: boolean;
};

/** An explicit refusal from the server: the "not submitted" proof, or a 4xx other than 401 (session) and 408 (timeout). */
export function writeRefused(error: unknown): boolean {
  if (writeNotSubmitted(error)) return true;
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 408;
}

/** The status a successful answer reports: the execution's state, else the order's status, else the body's own. */
export function writeResultState(data: unknown): string | undefined {
  const body = (data && typeof data === 'object' ? data : {}) as { execution?: { state?: unknown; status?: unknown }; order?: { status?: unknown }; state?: unknown; status?: unknown };
  const result = body.execution && typeof body.execution === 'object' ? body.execution : body;
  for (const value of [result.state, body.order?.status, result.status]) if (typeof value === 'string' && value) return value;
  return undefined;
}

/** The decision after a write's answer (`ok`) or failure (`error`: an ApiError, a timeout, a network loss). */
export function writeOutcome(answer: { ok: true; state?: string } | { ok: false; error: unknown }): WriteOutcome {
  if (answer.ok) return { retireRequestId: true, clearPending: !!answer.state && !stateIsUncertain(answer.state), keepReview: false, expired: false };
  const { error } = answer;
  // The server proved nothing was sent: forget the pending request and let the user re-preview from the open dialog.
  if (writeNotSubmitted(error)) return { retireRequestId: true, clearPending: true, keepReview: true, expired: false };
  // Any other refusal ends the id, but whether an earlier attempt went through stays open: the pending request is kept
  // until "查询最新状态" resolves it (workbench behaviour), and the dialog closes.
  if (writeRefused(error)) return { retireRequestId: true, clearPending: false, keepReview: false, expired: false };
  // 401, 5xx, timeout or network loss: the result is unknown, keep the id for the retry and the pending request.
  return { retireRequestId: false, clearPending: false, keepReview: false, expired: sessionExpired(error) };
}
