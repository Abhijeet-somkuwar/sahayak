/**
 * Keyset pagination (§11.1): ?limit=50&cursor=<uuid> → { items, next_cursor }, WHERE id < $cursor ORDER BY id DESC.
 */
import { z } from 'zod';

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

/** Fetch limit+1 rows, then call this to build the page. `idOf` returns the keyset id of a row. */
export function toPage(rows, limit, idOf) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const next_cursor = rows.length > limit && last ? idOf(last) : null;
  return { items, next_cursor };
}
