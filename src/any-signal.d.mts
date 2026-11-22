/**
 * AbortSignal.any() without the Node 24.15 per-call leak; `timeoutMs` adds an AbortSignal.timeout()-style deadline
 * (passed to setTimeout unchecked). With a timeout the result stays linked to its sources until it aborts; without one
 * it is unlinked once garbage-collected, so keep the returned signal reachable for as long as its abort matters: read it
 * after an await, capture it in a live closure, or hand it to a consumer that holds it in flight (fetch, http.request).
 * A listener on the result alone does not keep it.
 */
export function anySignal(sources: readonly (AbortSignal | null | undefined)[], timeoutMs?: number): AbortSignal;
