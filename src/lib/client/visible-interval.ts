/**
 * setInterval for status polling: skips ticks while the browser tab is hidden (nothing is being looked at; the worker carries on regardless), never
 * starts a second tick while the first is still running, and refreshes at once when the tab becomes visible again. Returns a function that stops it.
 */
export function visibleInterval(tick: () => unknown, everyMs: number): () => void {
  let running = false;
  const run = async () => {
    if (running || (typeof document !== 'undefined' && document.hidden)) return;
    running = true;
    try { await tick(); } catch { /* the next tick tries again */ } finally { running = false; }
  };
  const timer = setInterval(() => void run(), everyMs);
  const onVisible = () => { if (!document.hidden) void run(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}
