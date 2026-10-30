/** 🔒 Branded: only deidentify() can produce one (§10.4). */

export function promptVersion(p) {
  return `${p.id}.v${p.version}`;
}
