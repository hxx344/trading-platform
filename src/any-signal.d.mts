/**
 * AbortSignal.any() without the Node 24.15 per-call leak; `timeoutMs` adds an AbortSignal.timeout()-style deadline
 * (passed to setTimeout unchecked). With a timeout the result stays linked to its sources until it aborts; without one
 * it stays linked while it has 'abort' listeners, as with AbortSignal.any() (remove them on success), and otherwise only
 * while a frame or closure that live I/O or a timer still reaches references it.
 */
export function anySignal(sources: readonly (AbortSignal | null | undefined)[], timeoutMs?: number): AbortSignal;
