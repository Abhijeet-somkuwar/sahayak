import { useCallback, useEffect, useRef } from 'react';

// Warns before timing out (WCAG 2.2.1). Any pointer/keyboard activity resets both timers.
export function useIdleTimer({ idleMs, warnMs, onWarn, onTimeout, enabled = true }) {
  const warnRef = useRef(onWarn);
  const timeoutRef = useRef(onTimeout);
  warnRef.current = onWarn;
  timeoutRef.current = onTimeout;
  const timers = useRef({});

  const reset = useCallback(() => {
    clearTimeout(timers.current.w);
    clearTimeout(timers.current.t);
    if (!enabled) return;
    timers.current.w = setTimeout(() => warnRef.current(), Math.max(0, idleMs - warnMs));
    timers.current.t = setTimeout(() => timeoutRef.current(), idleMs);
  }, [idleMs, warnMs, enabled]);

  useEffect(() => {
    reset();
    const events = ['pointerdown', 'keydown', 'touchstart', 'mousemove', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      clearTimeout(timers.current.w);
      clearTimeout(timers.current.t);
    };
  }, [reset]);

  return reset;
}
