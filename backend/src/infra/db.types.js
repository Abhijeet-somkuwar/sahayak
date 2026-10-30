/** Kysely 0.29's Generated<S> is not nesting-aware; this version unwraps ColumnType aliases (Timestamp, JsonColumn, ...). */

/** Serialise a value for a jsonb column (pg would otherwise turn JS arrays into Postgres arrays). */
export function toJson(v) {
  return JSON.stringify(v);
}

/** Serialise a number vector for a halfvec/vector column. */
export function toVector(v) {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
}
