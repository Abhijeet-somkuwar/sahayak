import { useCallback, useRef } from 'react';

// One key per attempt: the same key is reused if the request is retried, and reset after success (§6.5).
export function useIdempotencyKey() {
  const ref = useRef(null);
  const get = useCallback(() => {
    if (!ref.current) ref.current = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    return ref.current;
  }, []);
  const reset = useCallback(() => {
    ref.current = null;
  }, []);
  return { get, reset };
}
