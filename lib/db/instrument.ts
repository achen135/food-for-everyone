/**
 * Every database call in the app goes through `tracked()`. Right now it just
 * counts reads; M7 hangs timing, a read-through cache, and per-label logging off
 * this one seam without touching call sites. See Spec §9 (measurement protocol).
 *
 * The counter is process-local and best-effort — fine for the single-instance
 * local runs the M7 benchmark uses. It is NOT a cross-request metric in prod.
 */

let readCount = 0;

export function getReadCount(): number {
  return readCount;
}

export function resetReadCount(): void {
  readCount = 0;
}

/**
 * Wrap a single logical database operation. `run` is a thunk so the query isn't
 * issued until we're inside the tracker.
 */
export async function tracked<T>(
  label: string,
  run: () => PromiseLike<T>,
): Promise<T> {
  void label; // M7: bucket timings by label
  readCount += 1;
  return await run();
}
