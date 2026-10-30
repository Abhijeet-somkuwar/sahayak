import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getSocket, onSocketChange } from '../services/websocketService';

// Connection status of each realtime namespace, for banners, stale indicators and polling fallback.
const SocketContext = createContext({ status: {}, lastEventAt: null });

export function SocketProvider({ children }) {
  const [status, setStatus] = useState({ staff: 'disconnected', display: 'disconnected', patient: 'disconnected' });
  const [lastEventAt, setLastEventAt] = useState(null);

  useEffect(() => {
    const attach = (ns, s) => {
      if (!s) return setStatus((st) => ({ ...st, [ns]: 'disconnected' }));
      setStatus((st) => ({ ...st, [ns]: s.connected ? 'connected' : 'connecting' }));
      s.on('connect', () => setStatus((st) => ({ ...st, [ns]: 'connected' })));
      s.on('disconnect', () => setStatus((st) => ({ ...st, [ns]: 'disconnected' })));
      s.io.on('reconnect_attempt', () => setStatus((st) => ({ ...st, [ns]: 'connecting' })));
      s.onAny(() => setLastEventAt(Date.now()));
      return undefined;
    };
    ['staff', 'display', 'patient'].forEach((ns) => getSocket(ns) && attach(ns, getSocket(ns)));
    return onSocketChange(attach);
  }, []);

  const value = useMemo(() => ({ status, lastEventAt }), [status, lastEventAt]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

/** Status of one namespace: 'connected' | 'connecting' | 'disconnected'. */
export function useSocketStatus(ns = 'staff') {
  const { status, lastEventAt } = useContext(SocketContext);
  return { status: status[ns] || 'disconnected', connected: status[ns] === 'connected', lastEventAt };
}
