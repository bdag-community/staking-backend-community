import { AppError } from '../helpers/appError.helper';

/** Share only unfinished identical reads. Never retain a completed voting epoch. */
export function createReadSingleFlight<T>(maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid in-flight read limit');
  const pending = new Map<string, Promise<T>>();
  return (key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= maximum) return Promise.reject(new AppError('Voting reads are busy. Please retry shortly.', 503));
    const request = Promise.resolve().then(operation).finally(() => { pending.delete(key); });
    pending.set(key, request);
    return request;
  };
}
