/** One source read can have multiple IPC or local consumers. The last consumer leaving cancels the upstream request. */
export function sharedRead(load) {
  const upstream = new AbortController();
  let readers = 0, finished = false, pending;
  return {
    signal: upstream.signal,
    wait(signal) {
      signal?.throwIfAborted();
      readers++;
      pending ??= Promise.resolve().then(() => load(upstream.signal)).finally(() => { finished = true; });
      return new Promise((resolve, reject) => {
        let waiting = true;
        const leave = () => {
          if (!waiting) return;
          waiting = false; signal?.removeEventListener('abort', cancel);
          if (--readers === 0 && !finished) upstream.abort();
        };
        const cancel = () => { leave(); reject(signal.reason); };
        signal?.addEventListener('abort', cancel, { once: true });
        pending.then(value => { leave(); resolve(value); }, error => { leave(); reject(error); });
      });
    },
  };
}

export function readSignal(lifetime, request) {
  return lifetime && request ? AbortSignal.any([lifetime, request]) : lifetime ?? request;
}
