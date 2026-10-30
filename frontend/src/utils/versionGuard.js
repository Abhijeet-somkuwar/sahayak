// Apply a realtime update only if it is newer than what the screen already has (§6.4).
export function applyVersioned(current, incoming) {
  if (!current) return incoming;
  return incoming.version > current.version ? incoming : current;
}
