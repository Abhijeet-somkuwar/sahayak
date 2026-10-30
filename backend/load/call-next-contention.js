// k6: call-next contention — 10 doctors calling on one queue as fast as they can; expects no 5xx and p99 < 300 ms (§3.3).
// Run: k6 run -e BASE=http://localhost:3000 -e SESSION=<qs> -e TOKENS=<jwt1,jwt2,...> load/call-next-contention.js
import http from 'k6/http';
import { check } from 'k6';
const BASE = __ENV.BASE || 'http://localhost:3000';
const tokens = (__ENV.TOKENS || '').split(',');
export const options = { vus: tokens.length || 10, duration: __ENV.DURATION || '2m', thresholds: { http_req_duration: ['p(99)<300'], http_req_failed: ['rate<0.001'] } };
export default function () {
  const jwt = tokens[(__VU - 1) % tokens.length];
  const res = http.post(`${BASE}/api/v1/queues/${__ENV.SESSION}/call-next`, JSON.stringify({}), { headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` } });
  check(res, { 'call-next 200/204': (r) => r.status === 200 || r.status === 204 });
}
