import { toJson } from '../infra/db.types.js';
import { newId } from './ids.js';

export async function writeOutbox(trx, event) {
  const id = newId();
  await trx
    .insertInto('outbox_events')
    .values({
      id,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      event_type: event.eventType,
      payload: toJson(event.payload),
    })
    .execute();
  return id;
}
