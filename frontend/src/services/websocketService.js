import { io } from 'socket.io-client';
import { API_URL } from '../api/axiosConfig';

/**
 * Socket.IO namespaces of the realtime service:
 *   /staff   auth { token }       rooms queue:<sessionId>, facility:<id>, ed:<id>, doctor:<userId> (auto)
 *   /display auth { deviceKey }   rooms queue:<sessionId>, display:<deviceId> (auto), facility (auto)
 *   /patient auth { publicRef }   auto-joined to the token's room and its queue
 * Join with socket.emit('subscribe', { kind, id }, ack). Events: queue.snapshot, queue.updated, token.called,
 * token.status, prebrief.ready, doctor.status, ed.prealert.
 */
const sockets = { staff: null, display: null, patient: null };
const listeners = new Set(); // (namespace, socket) => void, so status hooks can attach to replacements

const opts = (auth) => ({ auth, transports: ['websocket', 'polling'], reconnectionDelayMax: 5000, withCredentials: true });

function replace(ns, auth) {
  if (sockets[ns]) sockets[ns].disconnect();
  sockets[ns] = io(`${API_URL}/${ns}`, opts(auth));
  listeners.forEach((fn) => fn(ns, sockets[ns]));
  return sockets[ns];
}

export const connectStaff = (token) => (token ? replace('staff', { token }) : disconnect('staff'));
export const connectDisplay = (deviceKey) => (deviceKey ? replace('display', { deviceKey }) : disconnect('display'));
export const connectPatient = (publicRef) => (publicRef ? replace('patient', { publicRef }) : disconnect('patient'));

export function disconnect(ns) {
  if (sockets[ns]) sockets[ns].disconnect();
  sockets[ns] = null;
  listeners.forEach((fn) => fn(ns, null));
  return null;
}

export const getSocket = (ns) => sockets[ns];

/** Be told whenever a namespace socket is created or dropped. Returns an unsubscribe function. */
export function onSocketChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Join rooms on a namespace and listen for events. rooms: [{ kind, id }]. handlers: { eventName: fn }.
 * Returns a function that leaves the rooms and removes the listeners.
 */
export function subscribe(ns, rooms, handlers) {
  const s = sockets[ns];
  if (!s) return () => {};
  const join = () => rooms.forEach((room) => s.emit('subscribe', room));
  if (s.connected) join();
  s.on('connect', join);
  Object.entries(handlers).forEach(([event, fn]) => s.on(event, fn));
  return () => {
    rooms.forEach((room) => s.emit('unsubscribe', room));
    s.off('connect', join);
    Object.entries(handlers).forEach(([event, fn]) => s.off(event, fn));
  };
}
