/**
 * M1–M3 acceptance through the HTTP API: login + MFA + refresh rotation/reuse detection, audit rows written before the
 * response, cross-facility fail-closed, idempotent check-in, 50 parallel check-ins → gapless unique token numbers,
 * 10 doctors × 100 tokens → no double calls, Redis flush + rebuild → identical positions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { authenticator } from 'otplib';
import argon2 from 'argon2';
import { applyEnv, startInfra } from './setup.js';

let infra;
let maint;
let app;
let redis;
const ids = {};
const q = async (text, params = []) => (await maint.query(text, params)).rows;

const totpSecrets = new Map(); // TOTP is enrolled once per user; later logins reuse the authenticator secret
let ipCounter = 0;
const nextIp = () => `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
async function login(email) {
  const r1 = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/staff/login',
    remoteAddress: nextIp(),
    payload: { identifier: email, password: 'Demo@12345678' },
  });
  expect(r1.statusCode, r1.body).toBe(200);
  const body = r1.json();
  if (!body.mfa_required) return { access: body.access_token, refresh: body.refresh_token };
  let secret = totpSecrets.get(email);
  if (!secret) {
    expect(body.enrol_required).toBe(true);
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/staff/mfa/enrol',
      remoteAddress: nextIp(),
      payload: { mfa_token: body.mfa_token },
    });
    expect(enrol.statusCode, enrol.body).toBe(200);
    secret = new URL(enrol.json().otpauth_url).searchParams.get('secret');
    totpSecrets.set(email, secret);
  }
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/staff/mfa/verify',
    remoteAddress: nextIp(),
    payload: { mfa_token: body.mfa_token, code: authenticator.generate(secret) },
  });
  expect(r2.statusCode, r2.body).toBe(200);
  const t = r2.json();
  return { access: t.access_token, refresh: t.refresh_token };
}
const auth = (token) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  infra = await startInfra();
  applyEnv(infra);
  maint = new pg.Pool({ connectionString: infra.maintUrl });
  const hash = await argon2.hash('Demo@12345678', { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 });
  const [f1] = await q(
    "INSERT INTO facilities (code,name,kind,state_code,district_code) VALUES ('A','Fac A','district_hospital','GJ','1') RETURNING id",
  );
  ids['f1'] = f1.id;
  const [f2] = await q("INSERT INTO facilities (code,name,kind,state_code,district_code) VALUES ('B','Fac B','chc','GJ','2') RETURNING id");
  ids['f2'] = f2.id;
  const [d1] = await q(
    "INSERT INTO departments (facility_id,code,specialty_code,name,token_prefix) VALUES ($1,'MED','general_medicine','Medicine','MED') RETURNING id",
    [f1.id],
  );
  ids['d1'] = d1.id;
  const [d2] = await q(
    "INSERT INTO departments (facility_id,code,specialty_code,name,token_prefix) VALUES ($1,'PED','paediatrics','Paeds','PED') RETURNING id",
    [f1.id],
  );
  ids['d2'] = d2.id;
  const [sp] = await q(
    "INSERT INTO service_points (facility_id,department_id,kind,label) VALUES ($1,$2,'consult_room','Room 1') RETURNING id",
    [f1.id, d1.id],
  );
  ids['sp'] = sp.id;
  const mk = async (email, role, facility, dept) => {
    const [u] = await q('INSERT INTO users (display_name,email,password_hash) VALUES ($1,$1,$2) RETURNING id', [email, hash]);
    await q('INSERT INTO staff_memberships (user_id,facility_id,role,department_id) VALUES ($1,$2,$3,$4)', [u.id, facility, role, dept]);
    return u.id;
  };
  ids['clerk'] = await mk('clerk@a', 'registration_clerk', f1.id, null);
  ids['clerkB'] = await mk('clerk@b', 'registration_clerk', f2.id, null);
  for (let i = 0; i < 10; i++) ids[`doc${i}`] = await mk(`doc${i}@a`, 'doctor', f1.id, d1.id);
  ids['dpo'] = await mk('dpo@state', 'dpo', null, null);
  for (let i = 0; i < 120; i++) {
    const [p] = await q(
      "INSERT INTO patients (display_name,name_search,sex,birth_year,district_code) VALUES ($1,$1,'male',$2,'1') RETURNING id",
      [`pt${i}`, 1990 - (i % 60)],
    );
    ids[`p${i}`] = p.id;
  }
  const [qs] = await q(
    "INSERT INTO queue_sessions (facility_id,department_id,session_date,shift,token_prefix,starts_at,ends_at,status) VALUES ($1,$2,(now() AT TIME ZONE 'Asia/Kolkata')::date,'morning','MED',now()-interval '1 hour',now()+interval '4 hours','open') RETURNING id",
    [f1.id, d1.id],
  );
  ids['qs'] = qs.id;
  await q(
    "INSERT INTO message_templates (code,channel,language,version,body,status) VALUES ('queue.checked_in','web','en',1,'Token {{token}}','active'),('queue.your_turn','web','en',1,'Turn {{token}}','active')",
  );
  const { buildServer } = await import('../../src/server.js');
  const { registerApiRoutes } = await import('../../src/apps/routes.js');
  redis = await import('../../src/infra/redis.js');
  await redis.redisCore.flushall();
  app = await buildServer({ role: 'api', withDocs: false });
  await registerApiRoutes(app);
  await app.ready();
}, 300_000);
afterAll(async () => {
  await app?.close();
  await redis?.closeRedis();
  const dbm = await import('../../src/infra/db.js');
  await dbm.closeDatabase();
  await maint?.end();
  await infra?.stop();
});

describe('auth (§9.1)', () => {
  it('clerk logs in without MFA; doctor needs TOTP; refresh rotates and reuse revokes the family', async () => {
    const clerk = await login('clerk@a');
    expect(clerk.access).toBeTruthy();
    const doc = await login('doc0@a');
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: nextIp(),
      payload: { refresh_token: doc.refresh },
    });
    expect(r1.statusCode).toBe(200);
    const rotated = r1.json().refresh_token;
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: nextIp(),
      payload: { refresh_token: doc.refresh },
    }); // old token again
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('token_revoked');
    const afterRevoke = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: nextIp(),
      payload: { refresh_token: rotated },
    }); // whole family dead
    expect(afterRevoke.statusCode).toBe(401);
    const failed = await q("SELECT count(*)::int AS n FROM audit_events WHERE action='auth.refresh_reuse_detected'");
    expect(failed[0].n).toBe(1);
  });
  it('login is rate-limited to 10 per IP per minute with a problem+json 429', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/staff/login',
        remoteAddress: '192.0.2.77',
        payload: { identifier: 'nobody@x', password: 'whatever-pass' },
      });
      last = r.statusCode;
      if (i === 10) {
        expect(r.statusCode).toBe(429);
        expect(r.json().code).toBe('rate_limited');
        expect(r.headers['content-type']).toContain('problem+json');
      }
    }
    expect(last).toBe(429);
  });
  it('5 failed logins lock the account for 15 minutes', async () => {
    for (let i = 0; i < 5; i++)
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/staff/login',
        remoteAddress: nextIp(),
        payload: { identifier: 'clerk@b', password: 'wrong-password-1' },
      });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/staff/login',
      remoteAddress: nextIp(),
      payload: { identifier: 'clerk@b', password: 'Demo@12345678' },
    });
    expect(r.statusCode).toBe(423);
    await q("UPDATE users SET failed_login_count=0, locked_until=NULL WHERE email='clerk@b'");
  });
});

describe('🔒 facility isolation and audit', () => {
  it('a clerk at facility B cannot read or write facility A queues; audit rows are written before the response', async () => {
    const b = await login('clerk@b');
    const r = await app.inject({ method: 'GET', url: `/api/v1/facilities/${ids['f1']}/queues/today`, headers: auth(b.access) });
    expect(r.statusCode).toBe(403);
    const w = await app.inject({
      method: 'POST',
      url: `/api/v1/queues/${ids['qs']}/checkins`,
      headers: { ...auth(b.access), 'idempotency-key': 'b-attempt-0001' },
      payload: { patient_id: ids['p0'], source: 'counter' },
    });
    expect(w.statusCode).toBe(404); // RLS hides the session → not found, nothing written
    expect((await q('SELECT count(*)::int AS n FROM opd_tokens'))[0].n).toBe(0);
    const a = await login('clerk@a');
    const s = await app.inject({ method: 'GET', url: `/api/v1/patients/search?phone=9876543210`, headers: auth(a.access) });
    expect(s.statusCode).toBe(200);
    expect(
      (await q("SELECT count(*)::int AS n FROM audit_events WHERE action='patient.search' AND actor_id=$1", [ids['clerk']]))[0].n,
    ).toBe(1);
  });
  it('state-level DPO reads audit; clerk cannot', async () => {
    const dpo = await login('dpo@state');
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/audit/patients/${ids['p0']}/access-log`, headers: auth(dpo.access) })).statusCode,
    ).toBe(200);
    const clerk = await login('clerk@a');
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/audit/patients/${ids['p0']}/access-log`, headers: auth(clerk.access) })).statusCode,
    ).toBe(403);
  });
});

describe('queue engine (M3 acceptance)', () => {
  let clerkToken;
  beforeAll(async () => {
    clerkToken = (await login('clerk@a')).access;
  });

  it('check-in requires Idempotency-Key and replays the same token for the same key', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/queues/${ids['qs']}/checkins`,
      headers: auth(clerkToken),
      payload: { patient_id: ids['p0'], source: 'counter' },
    });
    expect(missing.statusCode).toBe(422);
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/queues/${ids['qs']}/checkins`,
      headers: { ...auth(clerkToken), 'idempotency-key': 'kiosk-retry-0001' },
      payload: { patient_id: ids['p0'], source: 'counter' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/queues/${ids['qs']}/checkins`,
      headers: { ...auth(clerkToken), 'idempotency-key': 'kiosk-retry-0001' },
      payload: { patient_id: ids['p0'], source: 'counter' },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().token.id).toBe(first.json().token.id);
    const reused = await app.inject({
      method: 'POST',
      url: `/api/v1/queues/${ids['qs']}/checkins`,
      headers: { ...auth(clerkToken), 'idempotency-key': 'kiosk-retry-0001' },
      payload: { patient_id: ids['p1'], source: 'counter' },
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('idempotency_key_reused');
    expect(first.json().public_ref).toMatch(/^[a-z2-7]{10}$/);
  });

  it('50 parallel check-ins → unique, gapless token numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/queues/${ids['qs']}/checkins`,
          headers: { ...auth(clerkToken), 'idempotency-key': `par-${i}-xxxx` },
          payload: { patient_id: ids[`p${i + 1}`], source: 'counter' },
        }),
      ),
    );
    for (const r of results) expect(r.statusCode, r.body).toBe(201);
    const nums = (await q('SELECT token_no FROM opd_tokens WHERE queue_session_id=$1 ORDER BY token_no', [ids['qs']])).map(
      (r) => r.token_no,
    );
    expect(nums.length).toBe(51);
    expect(nums).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    const [c] = await q('SELECT last_token_no FROM queue_sessions WHERE id=$1', [ids['qs']]);
    expect(c.last_token_no).toBe(51);
  });

  it('public status link shows position without PHI', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/queues/${ids['qs']}/checkins`,
      headers: { ...auth(clerkToken), 'idempotency-key': 'status-link-0001' },
      payload: { patient_id: ids['p60'], source: 'counter' },
    });
    const ref = r.json().public_ref;
    const s = await app.inject({ method: 'GET', url: `/api/v1/t/${ref}` });
    expect(s.statusCode).toBe(200);
    const body = s.json();
    // 51 waiting tokens are spread over the protected and general lanes (patients aged 36–95), so 'ahead' follows the lane-share formula.
    expect(body['token']).toMatch(/^MED-/);
    expect(body['people_ahead']).toBeGreaterThan(0);
    expect(body['people_ahead']).toBeLessThanOrEqual(51);
    expect(body['eta']).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('pt60');
  });

  it('10 doctors calling on 100 tokens → no double calls; lane 0 first; Redis flush + rebuild restores identical positions', async () => {
    // 48 more tokens (total 100), a few in the urgent lane
    const more = await Promise.all(
      Array.from({ length: 48 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/queues/${ids['qs']}/checkins`,
          headers: { ...auth(clerkToken), 'idempotency-key': `more-${i}-xxxx` },
          payload: { patient_id: ids[`p${i + 61}`], source: 'counter', triage_level: i < 5 ? 'priority' : 'routine' },
        }),
      ),
    );
    for (const r of more) expect(r.statusCode, r.body).toBe(201);
    expect((await q("SELECT count(*)::int AS n FROM opd_tokens WHERE queue_session_id=$1 AND status='waiting'", [ids['qs']]))[0].n).toBe(
      100,
    );

    // snapshot positions, flush Redis, rebuild, compare
    const { rebuildSession, laneCounts, tokenPosition } = await import('../../src/modules/queue/projection.js');
    const waiting = await q("SELECT id, lane FROM opd_tokens WHERE queue_session_id=$1 AND status='waiting'", [ids['qs']]);
    const before = new Map();
    for (const t of waiting) before.set(t.id, (await tokenPosition(ids['qs'], t.id)).ahead);
    const countsBefore = await laneCounts(ids['qs']);
    expect(countsBefore[0]).toBe(5);
    expect(countsBefore[0] + countsBefore[1] + countsBefore[2]).toBe(100);
    await redis.redisCore.flushall();
    expect(await laneCounts(ids['qs'])).toEqual([0, 0, 0]);
    await rebuildSession(ids['qs']);
    expect(await laneCounts(ids['qs'])).toEqual(countsBefore);
    for (const t of waiting) expect((await tokenPosition(ids['qs'], t.id)).ahead).toBe(before.get(t.id));

    const doctors = await Promise.all(Array.from({ length: 10 }, (_, i) => login(`doc${i}@a`)));
    const called = [];
    const rounds = 10;
    for (let r = 0; r < rounds; r++) {
      const res = await Promise.all(
        doctors.map((d) =>
          app.inject({
            method: 'POST',
            url: `/api/v1/queues/${ids['qs']}/call-next`,
            headers: auth(d.access),
            payload: { service_point_id: ids['sp'] },
          }),
        ),
      );
      for (const x of res) {
        expect([200, 204]).toContain(x.statusCode);
        if (x.statusCode === 200) called.push(x.json().token.id);
      }
    }
    expect(called.length).toBe(100);
    expect(new Set(called).size).toBe(100); // no double calls
    const firstRound = await q('SELECT lane FROM opd_tokens WHERE id = ANY($1::uuid[])', [called.slice(0, 10)]);
    expect(firstRound.filter((x) => x.lane === 0).length).toBe(5); // all 5 urgent tokens were served in the first parallel round
    expect((await q("SELECT count(*)::int AS n FROM opd_tokens WHERE queue_session_id=$1 AND status='called'", [ids['qs']]))[0].n).toBe(
      100,
    );
    expect((await q("SELECT count(*)::int AS n FROM queue_events WHERE queue_session_id=$1 AND kind='called'", [ids['qs']]))[0].n).toBe(
      100,
    );
    expect((await q("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='token.called'"))[0].n).toBe(100);
  });

  it('token transitions enforce If-Match and the state machine', async () => {
    const doc = await login('doc0@a');
    const [t] = await q("SELECT id, version FROM opd_tokens WHERE queue_session_id=$1 AND status='called' AND served_by=$2 LIMIT 1", [
      ids['qs'],
      ids['doc0'],
    ]);
    const noMatch = await app.inject({ method: 'POST', url: `/api/v1/tokens/${t.id}/start`, headers: auth(doc.access) });
    expect(noMatch.statusCode).toBe(428);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/tokens/${t.id}/start`,
      headers: { ...auth(doc.access), 'if-match': '"0"' },
    });
    expect(stale.statusCode).toBe(412);
    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/tokens/${t.id}/start`,
      headers: { ...auth(doc.access), 'if-match': `"${t.version}"` },
    });
    expect(start.statusCode, start.body).toBe(200);
    const v2 = Number(String(start.headers['etag']).replace(/"/g, ''));
    const badSkip = await app.inject({
      method: 'POST',
      url: `/api/v1/tokens/${t.id}/skip`,
      headers: { ...auth(doc.access), 'if-match': `"${v2}"` },
    });
    expect(badSkip.statusCode).toBe(409); // cannot skip an in_consult token
    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/tokens/${t.id}/complete`,
      headers: { ...auth(doc.access), 'if-match': `"${v2}"` },
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const [enc] = await q(
      'SELECT e.status, e.consult_seconds, e.wait_seconds FROM encounters e JOIN opd_tokens t ON t.encounter_id=e.id WHERE t.id=$1',
      [t.id],
    );
    expect(enc.status).toBe('completed');
    expect(enc.consult_seconds).toBeGreaterThanOrEqual(0);
  });

  it('closing the session cancels waiting tokens and marks skipped ones no-show', async () => {
    const doc = await login('doc1@a');
    const [t] = await q("SELECT id, version FROM opd_tokens WHERE queue_session_id=$1 AND status='called' AND served_by=$2 LIMIT 1", [
      ids['qs'],
      ids['doc1'],
    ]);
    const skip = await app.inject({
      method: 'POST',
      url: `/api/v1/tokens/${t.id}/skip`,
      headers: { ...auth(doc.access), 'if-match': `"${t.version}"` },
    });
    expect(skip.statusCode).toBe(200);
    const close = await app.inject({ method: 'POST', url: `/api/v1/queues/${ids['qs']}/close`, headers: auth(doc.access) });
    expect(close.statusCode, close.body).toBe(200);
    const body = close.json();
    expect(body.noShows).toBeGreaterThanOrEqual(1);
    expect((await q("SELECT count(*)::int AS n FROM encounters WHERE status='no_show'"))[0].n).toBe(body.noShows);
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/queues/${ids['qs']}/checkins`,
      headers: { ...auth(clerkToken), 'idempotency-key': 'after-close-0001' },
      payload: { patient_id: ids['p110'], source: 'counter' },
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe('queue_unavailable');
  });
});
