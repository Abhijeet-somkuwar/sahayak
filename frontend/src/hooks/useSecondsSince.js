import { useEffect, useState } from 'react';

// Seconds elapsed since a timestamp, ticking.
export function useSecondsSince(iso, tickMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  if (!iso) return 0;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Math.max(0, Math.floor((now - t) / 1000));
}
