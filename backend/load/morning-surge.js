// k6: morning surge (§16, §3.3). Ramp to 85 check-ins/s + 5,000 position reads/s + 1,000 webhook messages/s for 30 min.
// Run: k6 run -e BASE=http://localhost:3000 -e WEBHOOK=http://localhost:3002 -e TOKEN=<clerk jwt> -e SESSION=<queue session id> -e REFS=ref1,ref2 load/morning-surge.js
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import crypto from 'k6/crypto';

const BASE = __ENV.BASE || 'http://localhost:3000';
const WEBHOOK = __ENV.WEBHOOK || 'http://localhost:3002';
const refs = (__ENV.REFS || '').split(',').filter(Boolean);
const checkin = new Trend('checkin_ms', true), position = new Trend('position_ms', true), webhook = new Trend('webhook_ms', true);
const duration = __ENV.DURATION || '30m';

export const options = {
  scenarios: {
    checkins: { executor: 'ramping-arrival-rate', startRate: 5, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 1000, stages: [{ target: 85, duration: '5m' }, { target: 85, duration }, { target: 0, duration: '2m' }], exec: 'doCheckin' },
    positions: { executor: 'ramping-arrival-rate', startRate: 500, timeUnit: '1s', preAllocatedVUs: 500, maxVUs: 3000, stages: [{ target: 5000, duration: '5m' }, { target: 5000, duration }, { target: 0, duration: '2m' }], exec: 'doPosition' },
    webhooks: { executor: 'ramping-arrival-rate', startRate: 50, timeUnit: '1s', preAllocatedVUs: 300, maxVUs: 2000, stages: [{ target: 1000, duration: '5m' }, { target: 1000, duration }, { target: 0, duration: '2m' }], exec: 'doWebhook' },
  },
  thresholds: {
    checkin_ms: ['p(99)<300'],          // §3.3 token check-in p99 300 ms
    position_ms: ['p(99)<50'],          // queue position read p99 50 ms
    webhook_ms: ['p(99)<100'],          // webhook returns 200 in < 100 ms
    http_req_failed: ['rate<0.001'],    // 99.9% availability
  },
};

export function doCheckin() {
  const key = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(`${BASE}/api/v1/queues/${__ENV.SESSION}/checkins`, JSON.stringify({ patient_id: __ENV.PATIENT, source: 'counter' }), { headers: { 'content-type': 'application/json', authorization: `Bearer ${__ENV.TOKEN}`, 'idempotency-key': key } });
  checkin.add(res.timings.duration);
  check(res, { 'checkin 201/409': (r) => r.status === 201 || r.status === 409 });
}

export function doPosition() {
  const ref = refs[Math.floor(Math.random() * refs.length)] || 'aaaaaaaaaa';
  const res = http.get(`${BASE}/api/v1/t/${ref}`);
  position.add(res.timings.duration);
  check(res, { 'position 200/404': (r) => r.status === 200 || r.status === 404 });
}

export function doWebhook() {
  const id = `wamid.k6.${__VU}.${__ITER}.${Date.now()}`;
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messaging_product: 'whatsapp', contacts: [{ wa_id: '919800000000' }], messages: [{ id, from: '919800000000', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'bukhar hai' } }] } }] }] });
  const sig = 'sha256=' + crypto.hmac('sha256', __ENV.WA_APP_SECRET || 'dev-wa-app-secret', body, 'hex');
  const res = http.post(`${WEBHOOK}/api/v1/webhooks/whatsapp`, body, { headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  webhook.add(res.timings.duration);
  check(res, { 'webhook 200': (r) => r.status === 200 });
}
