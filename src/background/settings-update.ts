// Keep related storage reads and writes ordered across extension pages and pairing.
let pending: Promise<unknown> = Promise.resolve();

export function updateSettings<T>(write: () => Promise<T>): Promise<T> {
  const result = pending.then(write);
  pending = result.catch(() => undefined);
  return result;
}
