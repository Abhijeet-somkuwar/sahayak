import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe, getSocket, onSocketChange } from '../services/websocketService';
import { useSocketStatus } from '../context/SocketContext';

/**
 * Loads a resource, then keeps it fresh from realtime events on one namespace.
 * While the socket is down it polls every `pollMs`; on reconnect it refetches.
 *
 *   const { data, loading, error, setData, refetch } = useLiveResource({
 *     fetcher: () => getQueueNext(id),
 *     ns: 'staff',
 *     rooms: [{ kind: 'queue', id }],
 *     events: { 'queue.updated': (payload, current) => newValueOrUndefined },
 *   });
 * A handler returns the new value, or `undefined` to leave the data unchanged (use `refetch` inside if needed).
 */
export function useLiveResource({ fetcher, ns = 'staff', rooms = [], events = {}, enabled = true, pollMs = 15000, initialData }) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled && initialData == null);
  const [updatedAt, setUpdatedAt] = useState(initialData ? Date.now() : 0);
  const { status } = useSocketStatus(ns);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const roomsKey = rooms.map((r) => `${r.kind}:${r.id}`).join('|');

  const refetch = useCallback(async () => {
    if (!enabled) return undefined;
    try {
      const d = await fetcherRef.current();
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
      return d;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    refetch();
  }, [refetch, roomsKey]);

  // realtime events → state (re-subscribes when the namespace socket is replaced, e.g. after login)
  useEffect(() => {
    if (!enabled) return undefined;
    const roomList = roomsKey ? roomsKey.split('|').map((k) => ({ kind: k.split(':')[0], id: k.slice(k.indexOf(':') + 1) })) : [];
    const handlers = {};
    for (const name of Object.keys(eventsRef.current)) {
      handlers[name] = (payload) => {
        setData((current) => {
          const next = eventsRef.current[name](payload, current, refetch);
          return next === undefined ? current : next;
        });
        setUpdatedAt(Date.now());
      };
    }
    let unsub = getSocket(ns) ? subscribe(ns, roomList, handlers) : () => {};
    const stop = onSocketChange((changedNs, s) => {
      if (changedNs !== ns) return;
      unsub();
      unsub = s ? subscribe(ns, roomList, handlers) : () => {};
    });
    return () => {
      stop();
      unsub();
    };
  }, [enabled, ns, roomsKey, refetch]);

  // polling while disconnected; refetch on reconnect
  const wasDown = useRef(false);
  useEffect(() => {
    if (!enabled) return undefined;
    if (status !== 'connected') {
      wasDown.current = true;
      const id = setInterval(refetch, pollMs);
      return () => clearInterval(id);
    }
    if (wasDown.current) {
      wasDown.current = false;
      refetch();
    }
    return undefined;
  }, [status, enabled, pollMs, refetch]);

  return { data, setData, error, loading, refetch, updatedAt };
}
