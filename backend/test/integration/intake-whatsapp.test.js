/**
 * M4 + M5 acceptance: a full structured intake (no LLM) reaches a booking; emergency pre-screen → casualty pre-alert;
 * WhatsApp webhook signature, 3× replay → one job, status callbacks; KB FAQ fast path and not_found gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyEnv, startInfra } from './setup.js';

let infra;
let maint;
let app;
let webhook;
let redis;
const ids = {};
const q = async (text, params = []) => (await maint.query(text, params)).rows;

beforeAll(async () => {
  infra = await startInfra();
  applyEnv(infra);
  maint = new pg.Pool({ connectionString: infra.maintUrl });
  const [f1] = await q(
    "INSERT INTO facilities (code,name,kind,state_code,district_code,opd_config) VALUES ('GJ-T','Test Hospital','district_hospital','GJ','1','{\"ai_intake_enabled\": false}') RETURNING id",
  );
  ids['f1'] = f1.id;
  const [d1] = await q(
    "INSERT INTO departments (facility_id,code,specialty_code,name,token_prefix) VALUES ($1,'MED','general_medicine','Medicine','MED') RETURNING id",
    [f1.id],
  );
  ids['d1'] = d1.id;
  const [cas] = await q(
    "INSERT INTO departments (facility_id,code,specialty_code,name,token_prefix,is_emergency,accepts_routing) VALUES ($1,'CAS','emergency','Casualty','EMR',true,false) RETURNING id",
    [f1.id],
  );
  ids['cas'] = cas.id;
  await q(
    "INSERT INTO service_points (facility_id,department_id,kind,label) VALUES ($1,$2,'consult_room','Room 1'),($1,$3,'emergency_bay','Casualty')",
    [f1.id, d1.id, cas.id],
  );
  const [u1] = await q("INSERT INTO users (display_name,email) VALUES ('R1','r1@t') RETURNING id");
  const [u2] = await q("INSERT INTO users (display_name,email) VALUES ('R2','r2@t') RETURNING id");
  const rules = JSON.parse(readFileSync(new URL('../../db/seeds/data/rules.json', import.meta.url), 'utf8'));
  await q(
    "INSERT INTO triage_rule_sets (version,status,rules,test_cases,checksum,authored_by,approved_by,published_at) VALUES (1,'published',$1,$2,decode('00','hex'),$3,$4,now())",
    [JSON.stringify(rules.rules), JSON.stringify(rules.test_cases), u1.id, u2.id],
  );
  const symptoms = JSON.parse(readFileSync(new URL('../../db/seeds/data/symptoms.json', import.meta.url), 'utf8'));
  for (const [code, system, spec, red, en, hi, gu, syn] of symptoms.items)
    await q(
      'INSERT INTO symptom_catalog (code,body_system,labels,synonyms,default_specialty_code,is_red_flag) VALUES ($1,$2,$3,$4,$5,$6)',
      [code, system, JSON.stringify({ en, hi, gu }), syn.map((s) => s.toLowerCase()), spec, red],
    );
  const questions = JSON.parse(readFileSync(new URL('../../db/seeds/data/questions.json', import.meta.url), 'utf8'));
  for (const [code, type, fact, applies, priority, prompts, options] of questions.items)
    await q(
      'INSERT INTO intake_questions (code,answer_type,prompts,options,sets_fact,applies_to_symptoms,priority) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [code, type, JSON.stringify(prompts), JSON.stringify(options), fact, applies, priority],
    );
  const tpl = JSON.parse(readFileSync(new URL('../../db/seeds/data/templates.json', import.meta.url), 'utf8'));
  for (const [code, t] of Object.entries(tpl.templates))
    await q(
      "INSERT INTO message_templates (code,channel,language,version,body,is_medical,clinically_reviewed_by,status) VALUES ($1,'web','en',1,$2,$3,$4,'active')",
      [code, t.en, !!t.medical, t.medical ? u1.id : null],
    );
  // one FAQ with a mock embedding of the exact question, so the fast path hits
  const { MockEmbeddings } = await import('../../src/infra/embeddings/index.js');
  const emb = await new MockEmbeddings().embed(['what are the opd timings']);
  const [fq] = await q(
    'INSERT INTO faq_entries (facility_id,topic,answer_i18n) VALUES ($1,\'timings\',\'{"en":"OPD is open 9 AM to 1 PM."}\') RETURNING id',
    [f1.id],
  );
  await q(
    "INSERT INTO faq_variants (faq_id,facility_id,language,question,embedding,embedding_model) VALUES ($1,$2,'en','what are the opd timings',$3,'mock-1024')",
    [fq.id, f1.id, `[${emb[0].join(',')}]`],
  );
  const [dev] = await q(
    "INSERT INTO devices (facility_id,kind,label,api_key_hash) VALUES ($1,'kiosk','Kiosk',decode($2,'hex')) RETURNING id",
    [f1.id, createHash('sha256').update('kiosk-key').digest('hex')],
  );
  ids['dev'] = dev.id;

  const { buildServer } = await import('../../src/server.js');
  const { registerApiRoutes } = await import('../../src/apps/routes.js');
  const { whatsappWebhookRoutes } = await import('../../src/modules/whatsapp/routes.js');
  redis = await import('../../src/infra/redis.js');
  await redis.redisCore.flushall();
  app = await buildServer({ role: 'api', withDocs: false });
  await registerApiRoutes(app);
  await app.ready();
  webhook = await buildServer({ role: 'webhook', withAuth: false, withDocs: false });
  await webhook.register(whatsappWebhookRoutes);
  await webhook.ready();
}, 300_000);
afterAll(async () => {
  await app?.close();
  await webhook?.close();
  const { closeQueues } = await import('../../src/infra/queues.js');
  await closeQueues();
  await redis?.closeRedis();
  const dbm = await import('../../src/infra/db.js');
  await dbm.closeDatabase();
  await maint?.end();
  await infra?.stop();
});

const kiosk = { 'x-device-key': 'kiosk-key' };

const answer = async (sid, body) => {
  const r = await app.inject({ method: 'POST', url: `/api/v1/intake/sessions/${sid}/answers`, headers: kiosk, payload: body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const pick = (r, prefix) =>
  r.messages.flatMap((m) => [...(m.buttons ?? []), ...(m.list?.rows ?? [])]).find((b) => b.id.startsWith(prefix))?.id;

describe('intake engine in structured mode (M4: a full intake reaches a booking without any LLM)', () => {
  it('kiosk: language → consent → new patient → purpose → complaint (synonym match) → clarify → risk → triage → OPD booking', async () => {
    let r = (await app.inject({ method: 'POST', url: '/api/v1/intake/sessions', headers: kiosk, payload: { language: 'en' } })).json();
    expect(r.state).toBe('consent');
    r = await answer(r.session_id, { kind: 'choice', id: 'consent:yes' });
    expect(r.state).toBe('who_for_name'); // AI disabled for this facility → straight to the patient; kiosk has no household
    r = await answer(r.session_id, { kind: 'text', text: 'Ramesh Patel' });
    expect(r.state).toBe('who_for_sex');
    r = await answer(r.session_id, { kind: 'choice', id: 'sex:male' });
    expect(r.state).toBe('who_for_age');
    r = await answer(r.session_id, { kind: 'text', text: '35' });
    expect(r.state).toBe('purpose');
    expect(r.encounter_id).toBeTruthy();
    r = await answer(r.session_id, { kind: 'choice', id: 'purpose:new_problem' });
    expect(r.state).toBe('complaint');
    r = await answer(r.session_id, { kind: 'text', text: 'pet mein jalan hai 3 din se' });
    expect(r.state).toBe('clarify');
    let guard = 0;
    while (r.state === 'clarify' && guard++ < 8) {
      const id = pick(r, 'q:');
      r = await answer(r.session_id, id ? { kind: 'choice', id: id.replace(/:[^:]+$/, ':no') } : { kind: 'text', text: '3 din' });
    }
    guard = 0;
    while (r.state === 'risk' && guard++ < 5) {
      const id = pick(r, 'q:RISK_CHRONIC:');
      r = await answer(r.session_id, { kind: 'choice', id: id ? 'q:RISK_CHRONIC:none' : pick(r, 'q:').replace(/:[^:]+$/, ':no') });
    }
    expect(r.state).toBe('idle');
    expect(r.messages.some((m) => m.templateCode === 'outcome.opd_booking')).toBe(true);
    const [enc] = await q('SELECT status, triage_level, department_id FROM encounters ORDER BY id DESC LIMIT 1');
    expect(enc.status).toBe('booked');
    expect(enc.department_id).toBe(ids['d1']);
    const [ta] = await q(
      'SELECT rule_level, final_level, mode, routing_method, symptoms FROM triage_assessments ORDER BY encounter_id DESC LIMIT 1',
    );
    expect(ta.mode).toBe('structured_fallback');
    expect(ta.final_level).toBe(ta.rule_level);
    expect(ta.symptoms.map((s) => s.code)).toContain('SYM_ABD_BURN');
    expect((await q('SELECT count(*)::int AS n FROM llm_calls'))[0].n).toBe(0);
  });

  it('🔒 emergency phrase in the complaint goes straight to casualty with a pre-alert and never gets a queue token', async () => {
    let r = (await app.inject({ method: 'POST', url: '/api/v1/intake/sessions', headers: kiosk, payload: { language: 'en' } })).json();
    r = await answer(r.session_id, { kind: 'choice', id: 'consent:yes' });
    r = await answer(r.session_id, { kind: 'text', text: 'Suresh' });
    r = await answer(r.session_id, { kind: 'choice', id: 'sex:male' });
    r = await answer(r.session_id, { kind: 'text', text: '58' });
    r = await answer(r.session_id, { kind: 'choice', id: 'purpose:new_problem' });
    r = await answer(r.session_id, { kind: 'text', text: 'seene mein dard aur pasina aa raha hai' });
    expect(r.state).toBe('idle');
    expect(r.messages[0].templateCode).toBe('triage.emergency_go_now');
    const [enc] = await q('SELECT status, triage_level FROM encounters ORDER BY id DESC LIMIT 1');
    expect(enc.status).toBe('emergency_redirected');
    expect(enc.triage_level).toBe('emergency');
    const [pa] = await q('SELECT summary FROM emergency_prealerts ORDER BY id DESC LIMIT 1');
    expect(JSON.stringify(pa.summary)).not.toContain('Suresh');
  });

  it('🔒 self-harm mention gets the crisis response and a staff alert', async () => {
    let r = (await app.inject({ method: 'POST', url: '/api/v1/intake/sessions', headers: kiosk, payload: { language: 'en' } })).json();
    r = await answer(r.session_id, { kind: 'choice', id: 'consent:yes' });
    r = await answer(r.session_id, { kind: 'text', text: 'Asha' });
    r = await answer(r.session_id, { kind: 'choice', id: 'sex:female' });
    r = await answer(r.session_id, { kind: 'text', text: '30' });
    r = await answer(r.session_id, { kind: 'choice', id: 'purpose:new_problem' });
    r = await answer(r.session_id, { kind: 'text', text: 'mujhe jeena nahi hai, khudkushi karna chahti hoon' });
    expect(r.messages[0].templateCode).toBe('triage.self_harm');
    expect((await q("SELECT count(*)::int AS n FROM emergency_prealerts WHERE summary->>'self_harm' = 'true'"))[0].n).toBe(1);
  });

  it('reprocessing the same message id is a no-op', async () => {
    let r = (await app.inject({ method: 'POST', url: '/api/v1/intake/sessions', headers: kiosk, payload: { language: 'en' } })).json();
    const a = await app.inject({
      method: 'POST',
      url: `/api/v1/intake/sessions/${r.session_id}/answers`,
      headers: { ...kiosk, 'idempotency-key': 'msg-dup-1' },
      payload: { kind: 'choice', id: 'consent:yes' },
    });
    const b = await app.inject({
      method: 'POST',
      url: `/api/v1/intake/sessions/${r.session_id}/answers`,
      headers: { ...kiosk, 'idempotency-key': 'msg-dup-1' },
      payload: { kind: 'choice', id: 'consent:yes' },
    });
    expect(a.json().messages.length).toBeGreaterThan(0);
    expect(b.json().messages.length).toBe(0);
    r = b.json();
    expect(r.state).toBe('who_for_name');
  });
});

describe('knowledge bot (M8 paths that need no LLM)', () => {
  it('curated FAQ fast path answers without an LLM; unknown questions hit the confidence gate', async () => {
    const hit = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/ask',
      payload: { question: 'What are the OPD timings?', facility_id: ids['f1'], language: 'en' },
    });
    expect(hit.statusCode, hit.body).toBe(200);
    expect(hit.json().path).toBe('faq');
    expect(hit.json().answer).toContain('9 AM');
    const miss = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/ask',
      payload: { question: 'zxqv blorp quantum parking', facility_id: ids['f1'], language: 'en' },
    });
    expect(miss.json().path).toBe('not_found');
    expect((await q('SELECT count(*)::int AS n FROM llm_calls'))[0].n).toBe(0);
  });
});

describe('WhatsApp webhook (M5)', () => {
  const body = (id) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ wa_id: '919876543210', profile: { name: 'R' } }],
                messages: [
                  { id, from: '919876543210', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } },
                ],
              },
            },
          ],
        },
      ],
    });
  const sig = (raw) => `sha256=${createHmac('sha256', 'test-secret').update(raw).digest('hex')}`;
  it('verifies the handshake, rejects bad signatures, dedupes 3× replays into one job', async () => {
    const hs = await webhook.inject({
      method: 'GET',
      url: '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=12345',
    });
    expect(hs.statusCode).toBe(200);
    expect(hs.body).toBe('12345');
    const raw = body('wamid.TEST1');
    const bad = await webhook.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: raw,
    });
    expect(bad.statusCode).toBe(401);
    for (let i = 0; i < 3; i++) {
      const ok = await webhook.inject({
        method: 'POST',
        url: '/api/v1/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(raw) },
        payload: raw,
      });
      expect(ok.statusCode).toBe(200);
    }
    const { getQueue } = await import('../../src/infra/queues.js');
    const jobs = await getQueue('wa-inbound').getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(jobs.filter((j) => j.id === 'wamid.TEST1').length).toBe(1);
    expect(await redis.redisCore.exists('dedupe:wa:wamid.TEST1')).toBe(1);
    const data = jobs[0].data;
    expect(data.enc).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain('919876543210'); // 🔒 job data is encrypted
  });
  it('processing the inbound job once drives the state machine and replies exactly once', async () => {
    const { getQueue } = await import('../../src/infra/queues.js');
    const { runWaInbound } = await import('../../src/modules/whatsapp/jobs.js');
    const job = (await getQueue('wa-inbound').getJobs(['waiting']))[0];
    await runWaInbound(job);
    await runWaInbound(job); // replay → idempotent on message id
    const out = await q("SELECT count(*)::int AS n FROM messages WHERE direction='outbound'");
    const inb = await q("SELECT count(*)::int AS n FROM messages WHERE direction='inbound'");
    expect(out[0].n).toBe(1);
    expect(inb[0].n).toBe(2); // every delivery is stored; the state machine ran once
    const [conv] = await q("SELECT state, language FROM conversations WHERE channel='whatsapp'");
    expect(['language', 'facility']).toContain(conv.state);
  });
});
