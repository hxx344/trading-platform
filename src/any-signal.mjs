// Replaces AbortSignal.any() and AbortSignal.any([..., AbortSignal.timeout(ms)]) on the server.
//
// On Node 24.15, every AbortSignal.any() call that includes a long-lived signal (a service's stop signal, a connection
// lifetime) keeps memory that garbage collection never returns: about 1.7 KB per call when a timeout signal is among the
// sources, about 170 B without one, measured with forced GC after the timeouts had fired. The trading service calls it on
// every market read, so the heap grew for hours until full collections stalled the event loop past the writer lease.
//
// Here each source gets a single 'abort' listener that forwards to the results currently linked to it, so unlinking stays
// O(1) however many requests share a source. How long a source holds a result depends on its deadline:
// - With `timeoutMs`, the result is held strongly until it aborts (a source aborted or the timer fired), as Node holds an
//   AbortSignal.timeout() signal; the timer bounds the hold.
// - Without one, the source holds the result weakly and a FinalizationRegistry unlinks it once collected, so a result whose
//   request ended without any source aborting does not pin memory on a long-lived source. The result must stay reachable
//   for as long as its abort matters: read after an await, captured by a live closure, or handed to a consumer that holds
//   it while in flight (fetch, http.request, untilAborted). A listener on the result alone does not hold it, nor does a
//   local that optimized code no longer reads after the await. test/any-signal.test.ts checks fetch and http.request.
// Unlike the native implementation, a result aborts from its source's listener: source listeners registered before the
// first anySignal() call on that source see the result still pending, and one calling stopImmediatePropagation() would
// stop the forwarding (no code here does).

/** @typedef {{ sources: AbortSignal[]; timer: ReturnType<typeof setTimeout> | null; held: AbortController | null; result: WeakRef<AbortSignal> | null }} Link */

/** @type {WeakMap<AbortSignal, Set<Link>>} The results linked to each source, forwarded by its one listener. */
const hubs = new WeakMap();
/** @type {WeakMap<AbortSignal, AbortController>} Keeps a weakly held result's controller alive exactly as long as its signal. */
const owners = new WeakMap();

/** @param {Link} link */
function unlink(link) {
  for (const source of link.sources) hubs.get(source)?.delete(link);
  if (link.timer) clearTimeout(link.timer);
  link.sources = []; link.timer = null;
}
const collected = new FinalizationRegistry(unlink);

/** @param {Link} link @param {unknown} reason */
function finish(link, reason) {
  if (!link.sources.length && !link.timer) return;
  unlink(link);
  const held = link.held, live = link.result?.deref();
  link.held = null; link.result = null;
  if (live) { collected.unregister(link); owners.get(live)?.abort(reason); }
  else held?.abort(reason);
}

/** @param {AbortSignal} source */
function hubOf(source) {
  let hub = hubs.get(source);
  if (!hub) {
    const links = hub = new Set();
    hubs.set(source, links);
    source.addEventListener('abort', () => { for (const link of [...links]) finish(link, source.reason); }, { once: true });
  }
  return hub;
}

/**
 * A signal that aborts with the reason of the first source to abort, or, when `timeoutMs` is given, with a TimeoutError
 * DOMException after that many milliseconds (as AbortSignal.timeout would; the value is passed to setTimeout unchecked).
 * Missing sources are skipped.
 * @param {readonly (AbortSignal | null | undefined)[]} sources
 * @param {number} [timeoutMs]
 * @returns {AbortSignal}
 */
export function anySignal(sources, timeoutMs) {
  const controller = new AbortController(), signal = controller.signal;
  const list = /** @type {AbortSignal[]} */ (sources.filter(Boolean));
  const early = list.find(source => source.aborted);
  if (early) { controller.abort(early.reason); return signal; }
  const timed = timeoutMs !== undefined;
  /** @type {Link} */
  const link = { sources: list, timer: null, held: timed ? controller : null, result: timed ? null : new WeakRef(signal) };
  if (timed) {
    link.timer = setTimeout(() => finish(link, new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs);
    link.timer.unref?.();
  } else if (list.length) {
    owners.set(signal, controller);
    collected.register(signal, link, link);
  }
  for (const source of list) hubOf(source).add(link);
  return signal;
}
