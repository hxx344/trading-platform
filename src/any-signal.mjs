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
// - Without one, the result is held strongly while it has 'abort' listeners of its own and weakly otherwise, as Node
//   does for AbortSignal.any(): a consumer that only listens (a promise settled by the abort alone) still sees the abort,
//   and once the listeners are gone (fetch removes its listener when the request is collected, readers in finally) a
//   result whose request ended without any source aborting is unlinked when collected instead of pinning ~1.6 KB on a
//   long-lived source. The forwarding listener of a result used as another call's source does not count. Listeners are
//   seen through the instance's addEventListener/removeEventListener (fetch, http.request, events.once, addAbortListener
//   and `onabort =` all go through them; EventTarget.prototype.addEventListener.call does not), and a listener left on
//   a result pins it with its sources until a source aborts, so remove listeners on success (`onabort = null` does not).
//   A result with no listener must stay reachable for as long as its abort matters: referenced from a frame or closure
//   that live I/O or a timer still reaches. test/any-signal.test.ts checks fetch, http.request and listener-only waits.
// Unlike the native implementation, a result aborts from its source's listener: source listeners registered before the
// first anySignal() call on that source see the result still pending, and one calling stopImmediatePropagation() would
// stop the forwarding (no code here does).

import { getEventListeners } from 'node:events';

/** @typedef {{ sources: AbortSignal[]; timer: ReturnType<typeof setTimeout> | null; held: AbortController | null; result: WeakRef<AbortSignal> | null }} Link */

/** @type {WeakMap<AbortSignal, Set<Link>>} The results linked to each source, forwarded by its one listener. */
const hubs = new WeakMap();
/** @type {WeakMap<AbortSignal, AbortController>} Keeps a weakly held result's controller alive exactly as long as its signal. */
const owners = new WeakMap();

/** Holds an untimed result strongly exactly while it has 'abort' listeners besides its own forwarding one. @param {Link} link @param {AbortSignal} signal */
function track(link, signal) {
  if (!link.result) return;
  const own = getEventListeners(signal, 'abort').length - (hubs.has(signal) ? 1 : 0);
  link.held = own > 0 ? owners.get(signal) ?? null : null;
}

/** @param {Link} link @param {AbortSignal} signal */
function watchListeners(link, signal) {
  const add = signal.addEventListener, remove = signal.removeEventListener;
  Object.defineProperties(signal, {
    addEventListener: { configurable: true, writable: true, value(/** @type {[string, ...unknown[]]} */ ...args) {
      const result = Reflect.apply(add, this, args);
      if (args[0] === 'abort') track(link, signal);
      return result;
    } },
    removeEventListener: { configurable: true, writable: true, value(/** @type {[string, ...unknown[]]} */ ...args) {
      const result = Reflect.apply(remove, this, args);
      if (args[0] === 'abort') track(link, signal);
      return result;
    } },
  });
}

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
    watchListeners(link, signal);
  }
  for (const source of list) hubOf(source).add(link);
  return signal;
}
