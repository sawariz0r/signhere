import { useEffect, useRef } from 'react';

/** Refresh visible workspaces without interrupting an unfinished comment. */
export function useBackgroundRefresh(refresh: () => Promise<unknown>, enabled = true) {
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let pending = false, stopped = false;
    const run = async () => {
      if (stopped || pending || document.visibilityState === 'hidden' || !navigator.onLine) return;
      if (Array.from(document.querySelectorAll<HTMLTextAreaElement>('.rd-discussion textarea')).some(input => input.value.trim())) return;
      pending = true;
      try { await callback.current(); } catch { /* Keep the current document during a temporary outage. */ }
      finally { pending = false; }
    };
    const resume = () => { void run(); };
    const timer = window.setInterval(resume, 10_000);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true; window.clearInterval(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [enabled]);
}
