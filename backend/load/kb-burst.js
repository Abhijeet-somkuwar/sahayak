// k6: knowledge bot burst — curated FAQ hits must stay under 150 ms p99; retrieval+LLM under 4 s p95 (§3.3).
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
const BASE = __ENV.BASE || 'http://localhost:3000';
const faq = new Trend('kb_faq_ms', true), rag = new Trend('kb_rag_ms', true);
export const options = { scenarios: { burst: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: __ENV.DURATION || '2m', preAllocatedVUs: 100, maxVUs: 500 } }, thresholds: { kb_faq_ms: ['p(99)<150'], kb_rag_ms: ['p(95)<4000'] } };
const faqQs = ['What are the OPD timings?', 'documents for ayushman card', 'where is the x-ray room'];
const ragQs = ['When is the cataract camp held?', 'can I collect my report in the evening', 'which floor is the plaster room'];
export default function () {
  const isFaq = Math.random() < 0.7;
  const question = (isFaq ? faqQs : ragQs)[Math.floor(Math.random() * 3)];
  const res = http.post(`${BASE}/api/v1/kb/ask`, JSON.stringify({ question, facility_code: __ENV.FACILITY || 'GJ-DEMO-DH', language: 'en' }), { headers: { 'content-type': 'application/json' } });
  (isFaq ? faq : rag).add(res.timings.duration);
  check(res, { 'kb 200': (r) => r.status === 200 });
}
