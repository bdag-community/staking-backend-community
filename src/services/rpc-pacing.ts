/** Shared process-level request pacing keeps application backfills below node limits. */
export function createRpcPacer(interval: number, now = Date.now, sleep = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms))) {
  if (!Number.isFinite(interval) || interval < 0) throw new Error('Invalid RPC pacing interval');
  let tail = Promise.resolve(), last: number | undefined;
  return () => {
    const next = tail.then(async () => {
      if (last !== undefined) await sleep(Math.max(0, last + interval - now()));
      last = now();
    });
    tail = next.catch(() => {});
    return next;
  };
}
