/**
 * M0 acceptance: migrations up/down; Q1–Q16 run on seeded data; constraints & triggers; RLS fail-closed;
 * partition co-location and expired-partition listing (§16, Appendix B).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { applyEnv, startInfra } from './setup.js';
import { migrateDown, migrateUp } from '../../src/infra/migrate.js';

let infra;
let maint;
let app;
const ids = {};
const q = async (pool, text, params = []) => (await pool.query(text, params)).rows;
const scoped = async (pool, scope, text, params = []) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (scope === 'state') await c.query("SELECT set_config('app.scope','state',true)");
    else if (scope)
      await c.query("SELECT set_config('app.scope','facility',true), set_config('app.facility_ids',$1,true)", [scope.join(',')]);
    const r = await c.query(text, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
};

beforeAll(async () => {
  infra = await startInfra();
  applyEnv(infra);
  maint = new pg.Pool({ connectionString: infra.maintUrl });
  app = new pg.Pool({ connectionString: infra.appUrl });
  // seed minimal data as the owner
  const [f1] = await q(
    maint,
    "INSERT INTO facilities (code,name,kind,state_code,district_code) VALUES ('T-A','Fac A','district_hospital','GJ','1') RETURNING id",
  );
  const [f2] = await q(
    maint,
    "INSERT INTO facilities (code,name,kind,state_code,district_code) VALUES ('T-B','Fac B','chc','GJ','2') RETURNING id",
  );
  ids['f1'] = f1.id;
  ids['f2'] = f2.id;
  const [d1] = await q(
    maint,
    "INSERT INTO departments (facility_id,code,specialty_code,name,token_prefix) VALUES ($1,'MED','general_medicine','Medicine','MED') RETURNING id",
    [f1.id],
  );
  ids['d1'] = d1.id;
  const [u1] = await q(maint, "INSERT INTO users (display_name,email) VALUES ('Dr A','a@t.io') RETURNING id");
  ids['u1'] = u1.id;
  const [u2] = await q(maint, "INSERT INTO users (display_name,email) VALUES ('Dr B','b@t.io') RETURNING id");
  ids['u2'] = u2.id;
  const [cp] = await q(
    maint,
    "INSERT INTO contact_points (kind,value_hash,value_enc,key_version) VALUES ('phone',decode('aa','hex'),decode('bb','hex'),1) RETURNING id",
  );
  ids['cp'] = cp.id;
  const [p] = await q(
    maint,
    "INSERT INTO patients (display_name,name_search,sex,birth_year,district_code) VALUES ('Ramesh Patel','ramesh patel','male',1980,'1') RETURNING id",
  );
  ids['p'] = p.id;
  await q(maint, "INSERT INTO patient_contacts (contact_point_id,patient_id,relationship,is_primary) VALUES ($1,$2,'self',true)", [
    cp.id,
    p.id,
  ]);
  await q(
    maint,
    "INSERT INTO patient_identifiers (patient_id,kind,value_hash,value_enc,key_version) VALUES ($1,'abha_number',decode('cc','hex'),decode('dd','hex'),1)",
    [p.id],
  );
  const [rs] = await q(
    maint,
    "INSERT INTO triage_rule_sets (version,status,rules,test_cases,checksum,authored_by,approved_by,published_at) VALUES (1,'published','{}','[]',decode('00','hex'),$1,$2,now()) RETURNING id",
    [u1.id, u2.id],
  );
  ids['rs'] = rs.id;
  const [qs] = await q(
    maint,
    "INSERT INTO queue_sessions (facility_id,department_id,session_date,shift,token_prefix,starts_at,ends_at,status) VALUES ($1,$2,current_date,'morning','MED',now(),now()+interval '4 hours','open') RETURNING id",
    [f1.id, d1.id],
  );
  ids['qs'] = qs.id;
  const [e] = await q(
    maint,
    "INSERT INTO encounters (facility_id,patient_id,contact_point_id,channel,status,session_date,department_id) VALUES ($1,$2,$3,'counter','completed',current_date,$4) RETURNING id",
    [f1.id, p.id, cp.id, d1.id],
  );
  ids['e'] = e.id;
  await q(
    maint,
    "INSERT INTO encounter_diagnoses (encounter_id,facility_id,patient_id,code_system,display_text,recorded_by) VALUES ($1,$2,$3,'local','Gastritis',$4)",
    [e.id, f1.id, p.id, u1.id],
  );
  await q(
    maint,
    "INSERT INTO prescription_items (encounter_id,facility_id,patient_id,drug_name,dose,frequency,prescribed_by) VALUES ($1,$2,$3,'Pantoprazole','40 mg','OD',$4)",
    [e.id, f1.id, p.id, u1.id],
  );
  const [e2] = await q(
    maint,
    "INSERT INTO encounters (facility_id,patient_id,channel,status,session_date,department_id) VALUES ($1,$2,'counter','triaged',current_date,$3) RETURNING id",
    [f1.id, p.id, d1.id],
  );
  ids['e2'] = e2.id;
  const [t] = await q(
    maint,
    "INSERT INTO opd_tokens (queue_session_id,encounter_id,facility_id,session_date,token_no,display_code,lane,queue_entry_at,source) VALUES ($1,$2,$3,current_date,1,'MED-001',2,now(),'counter') RETURNING id",
    [qs.id, e2.id, f1.id],
  );
  ids['t'] = t.id;
  const [kd] = await q(
    maint,
    "INSERT INTO kb_documents (facility_id,doc_type,title,language,storage_key,checksum,status) VALUES ($1,'timings','OPD timings','en','k',decode('ee','hex'),'active') RETURNING id",
    [f1.id],
  );
  ids['kd'] = kd.id;
  const vec = `[${new Array(1024)
    .fill(0)
    .map((_, i) => (i === 0 ? 1 : 0))
    .join(',')}]`;
  await q(
    maint,
    "INSERT INTO kb_chunks (document_id,facility_id,doc_type,language,is_active,chunk_index,heading_path,content,token_count,embedding,embedding_model) VALUES ($1,$2,'timings','en',true,0,'OPD timings','Medicine OPD runs 9 AM to 1 PM in Room 7',20,$3,'mock')",
    [kd.id, f1.id, vec],
  );
  const [fq] = await q(
    maint,
    'INSERT INTO faq_entries (facility_id,topic,answer_i18n) VALUES ($1,\'timings\',\'{"en":"9 to 1"}\') RETURNING id',
    [f1.id],
  );
  await q(
    maint,
    "INSERT INTO faq_variants (faq_id,facility_id,language,question,embedding,embedding_model) VALUES ($1,$2,'en','opd timings',$3,'mock')",
    [fq.id, f1.id, vec],
  );
  await q(
    maint,
    "INSERT INTO symptom_catalog (code,body_system,labels,synonyms,default_specialty_code,embedding,embedding_model) VALUES ('SYM_T','general','{\"en\":\"t\"}','{\"pet mein jalan\"}','general_medicine',$1,'mock')",
    [vec],
  );
  await q(maint, "INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload) VALUES ('x',$1,'t.e','{}')", [e.id]);
  await q(
    maint,
    "INSERT INTO followups (encounter_id,facility_id,patient_id,contact_point_id,kind,due_at,template_code) VALUES ($1,$2,$3,$4,'symptom_checkin',now()-interval '1 minute','followup.symptom_checkin')",
    [e.id, f1.id, p.id, cp.id],
  );
  const [conv] = await q(maint, "INSERT INTO conversations (channel,contact_point_id) VALUES ('whatsapp',$1) RETURNING id", [cp.id]);
  await q(
    maint,
    "INSERT INTO messages (conversation_id,direction,channel,provider_message_id,content_type,status) VALUES ($1,'outbound','whatsapp','wamid.1','text','sent')",
    [conv.id],
  );
  await q(
    maint,
    "INSERT INTO audit_events (actor_kind,actor_id,facility_id,action,resource_type,patient_id,purpose) VALUES ('staff',$1,$2,'patient.read','patient',$3,'treatment')",
    [u1.id, f1.id, p.id],
  );
}, 300_000);
afterAll(async () => {
  await maint?.end();
  await app?.end();
  await infra?.stop();
});

const bound = (monthsAgo) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return `${Math.floor(d.getTime())
    .toString(16)
    .padStart(12, '0')
    .replace(/^(.{8})(.{4})$/, '$1-$2')}-0000-0000-000000000000`;
};

describe('migrations', () => {
  it('roll down and up cleanly', async () => {
    const c = new pg.Client({ connectionString: infra.maintUrl });
    await c.connect();
    const dir = fileURLToPath(new URL('../../db/migrations', import.meta.url));
    const down = await migrateDown(c, dir, 2);
    expect(down.length).toBe(2);
    const up = await migrateUp(c, dir);
    expect(up.length).toBe(2);
    await c.end();
  });
});

describe('hot queries Q1–Q16 run on seeded data', () => {
  it('Q1 household lookup', async () => {
    expect(
      (
        await q(
          maint,
          "SELECT p.id FROM contact_points cp JOIN patient_contacts pc ON pc.contact_point_id = cp.id JOIN patients p ON p.id = pc.patient_id AND p.status='active' AND p.merged_into_id IS NULL WHERE cp.kind='phone' AND cp.value_hash=decode('aa','hex') ORDER BY pc.is_primary DESC, p.display_name LIMIT 20",
        )
      ).length,
    ).toBe(1);
  });
  it('Q2 ABHA lookup', async () => {
    expect(
      (
        await q(
          maint,
          "SELECT p.id FROM patient_identifiers pi JOIN patients p ON p.id = pi.patient_id WHERE pi.kind='abha_number' AND pi.facility_id IS NULL AND pi.value_hash=decode('cc','hex')",
        )
      ).length,
    ).toBe(1);
  });
  it('Q3 fuzzy search uses the trigram index threshold', async () => {
    const c = await maint.connect();
    await c.query('BEGIN');
    await c.query('SET LOCAL pg_trgm.similarity_threshold = 0.35');
    const r = await c.query(
      "SELECT id, similarity(name_search,$1) AS score FROM patients WHERE name_search % $1 AND district_code=$2 AND birth_year BETWEEN $3-3 AND $3+3 AND status='active' AND merged_into_id IS NULL ORDER BY score DESC LIMIT 20",
      ['ramesh patl', '1', 1981],
    );
    await c.query('COMMIT');
    c.release();
    expect(r.rows.length).toBe(1);
  });
  it('Q4 allocates token numbers under the session lock and refuses when closed', async () => {
    const r = await q(
      maint,
      "UPDATE queue_sessions SET last_token_no = last_token_no + 1 WHERE id=$1 AND status IN ('scheduled','open') AND (capacity IS NULL OR last_token_no < capacity) RETURNING last_token_no AS token_no, token_prefix",
      [ids['qs']],
    );
    expect(r[0].token_no).toBe(1);
    expect(r[0].token_prefix).toBe('MED');
    await q(maint, "UPDATE queue_sessions SET status='paused' WHERE id=$1", [ids['qs']]);
    expect(
      (
        await q(
          maint,
          "UPDATE queue_sessions SET last_token_no = last_token_no + 1 WHERE id=$1 AND status IN ('scheduled','open') RETURNING last_token_no",
          [ids['qs']],
        )
      ).length,
    ).toBe(0);
    await q(maint, "UPDATE queue_sessions SET status='open' WHERE id=$1", [ids['qs']]);
  });
  it('Q5 call next with SKIP LOCKED', async () => {
    const r = await q(
      maint,
      `WITH next AS (SELECT id FROM opd_tokens WHERE queue_session_id=$1 AND status='waiting' AND lane=$2 AND (preferred_doctor_id IS NULL OR preferred_doctor_id=$3) ORDER BY queue_entry_at, token_no LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE opd_tokens t SET status='called', called_at=now(), call_count=t.call_count+1, served_by=$3, service_point_id=$4, version=t.version+1 FROM next WHERE t.id=next.id RETURNING t.id, t.display_code, t.version`,
      [ids['qs'], 2, ids['u1'], null],
    );
    expect(r[0].display_code).toBe('MED-001');
    expect(r[0].version).toBe(1);
  });
  it('Q6 recent visits prunes partitions and aggregates children', async () => {
    const r = await q(
      maint,
      `SELECT e.id, (SELECT coalesce(jsonb_agg(jsonb_build_object('code',d.code,'text',d.display_text) ORDER BY d.is_primary DESC),'[]'::jsonb) FROM encounter_diagnoses d WHERE d.encounter_id=e.id) AS diagnoses,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('drug',p.drug_name,'dose',p.dose,'frequency',p.frequency,'days',p.duration_days)),'[]'::jsonb) FROM prescription_items p WHERE p.encounter_id=e.id) AS prescriptions
      FROM encounters e WHERE e.patient_id=$1 AND e.id >= $2 AND e.status IN ('completed','referred') ORDER BY e.id DESC LIMIT $3`,
      [ids['p'], bound(24), 5],
    );
    expect(r.length).toBe(1);
    expect(r[0].diagnoses[0].text).toBe('Gastritis');
    expect(r[0].prescriptions[0].drug).toBe('Pantoprazole');
  });
  it('Q7 hybrid retrieval with RRF, Q8 FAQ fast path, Q9 symptom candidates, Q10 patient docs', async () => {
    const vec = `[${new Array(1024)
      .fill(0)
      .map((_, i) => (i === 0 ? 1 : 0))
      .join(',')}]`;
    const c = await maint.connect();
    await c.query('BEGIN');
    await c.query('SET LOCAL hnsw.ef_search = 100');
    await c.query('SET LOCAL hnsw.iterative_scan = relaxed_order');
    const q7 = await c.query(
      `WITH vec AS (SELECT id, row_number() OVER (ORDER BY dist) AS rnk FROM (SELECT id, embedding <=> $1::halfvec(1024) AS dist FROM kb_chunks WHERE is_active AND (facility_id=$3 OR facility_id IS NULL) AND language = ANY($4) ORDER BY embedding <=> $1::halfvec(1024) LIMIT 40) v),
      fts AS (SELECT id, row_number() OVER (ORDER BY rank DESC) AS rnk FROM (SELECT c.id, ts_rank_cd(c.content_tsv,q) AS rank FROM kb_chunks c, websearch_to_tsquery('simple',$2) q WHERE c.is_active AND c.content_tsv @@ q AND (c.facility_id=$3 OR c.facility_id IS NULL) AND c.language = ANY($4) ORDER BY rank DESC LIMIT 40) f),
      fused AS (SELECT id, sum(1.0/(60+rnk)) AS rrf FROM (SELECT id,rnk FROM vec UNION ALL SELECT id,rnk FROM fts) u GROUP BY id)
      SELECT c.id, c.content, f.rrf, 1-(c.embedding <=> $1::halfvec(1024)) AS cosine_similarity FROM fused f JOIN kb_chunks c ON c.id=f.id ORDER BY f.rrf DESC LIMIT $5`,
      [vec, 'Room 7 timings', ids['f1'], ['en'], 6],
    );
    await c.query('COMMIT');
    c.release();
    expect(q7.rows.length).toBe(1);
    expect(Number(q7.rows[0].rrf)).toBeCloseTo(2 / 61, 4);
    expect(Number(q7.rows[0].cosine_similarity)).toBeCloseTo(1, 3);
    const q8 = await q(
      maint,
      "SELECT v.faq_id, f.answer_i18n, 1-(v.embedding <=> $1::halfvec(1024)) AS similarity FROM faq_variants v JOIN faq_entries f ON f.id=v.faq_id AND f.status='active' WHERE v.is_active AND (v.facility_id=$2 OR v.facility_id IS NULL) AND v.language=$3 ORDER BY v.embedding <=> $1::halfvec(1024) LIMIT 3",
      [vec, ids['f1'], 'en'],
    );
    expect(Number(q8[0].similarity)).toBeCloseTo(1, 3);
    const q9 = await q(
      maint,
      `SELECT code, max(similarity) AS similarity FROM (SELECT code, 1.0::float8 AS similarity FROM symptom_catalog WHERE status='active' AND synonyms @> ARRAY[$1]::text[] UNION ALL (SELECT code, 1-(embedding <=> $2::halfvec(1024)) FROM symptom_catalog WHERE status='active' AND embedding IS NOT NULL ORDER BY embedding <=> $2::halfvec(1024) LIMIT 5)) c GROUP BY code ORDER BY similarity DESC`,
      ['pet mein jalan', vec],
    );
    expect(q9[0].code).toBe('SYM_T');
    expect(
      (
        await q(
          maint,
          'SELECT c.document_id FROM patient_doc_chunks c WHERE c.patient_id=$1 ORDER BY c.embedding <=> $2::halfvec(1024) LIMIT 8',
          [ids['p'], vec],
        )
      ).length,
    ).toBe(0);
  });
  it('Q11 outbox batch, Q12 due follow-ups, Q13 status update, Q14 access log, Q15 snapshot, Q16 rollup', async () => {
    expect(
      (await q(maint, 'SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED')).length,
    ).toBe(1);
    expect(
      (
        await q(
          maint,
          "SELECT id FROM followups WHERE status='scheduled' AND due_at <= now() AND encounter_id >= $1 ORDER BY due_at LIMIT 500 FOR UPDATE SKIP LOCKED",
          [bound(6)],
        )
      ).length,
    ).toBe(1);
    const upd = await maint.query(
      "UPDATE messages SET status=$2, status_updated_at=now() WHERE provider_message_id=$1 AND direction='outbound' AND id >= $3 AND status < $2",
      ['wamid.1', 'read', bound(1)],
    );
    expect(upd.rowCount).toBe(1);
    const late = await maint.query(
      "UPDATE messages SET status=$2 WHERE provider_message_id=$1 AND direction='outbound' AND id >= $3 AND status < $2",
      ['wamid.1', 'delivered', bound(1)],
    );
    expect(late.rowCount).toBe(0); // a late 'delivered' never overwrites 'read'
    expect(
      (await q(maint, 'SELECT action FROM audit_events WHERE patient_id=$1 AND id >= $2 ORDER BY id DESC LIMIT 100', [ids['p'], bound(12)]))
        .length,
    ).toBe(1);
    expect(
      (await q(maint, "SELECT id FROM opd_tokens WHERE queue_session_id=$1 AND status IN ('waiting','called','in_consult')", [ids['qs']]))
        .length,
    ).toBe(1);
    await q(
      maint,
      `INSERT INTO facility_daily_stats AS s (facility_id,department_id,stat_date,checked_in,seen,no_shows,wait_p50_seconds,wait_p90_seconds,consult_p50_seconds,computed_at,is_final)
      SELECT qs.facility_id, qs.department_id, qs.session_date, count(*), count(*) FILTER (WHERE t.status='completed'), count(*) FILTER (WHERE t.status='no_show'),
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.queue_entry_at))::int, percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.queue_entry_at))::int,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.consult_ended_at - t.consult_started_at))::int, now(), $2 FROM opd_tokens t JOIN queue_sessions qs ON qs.id=t.queue_session_id WHERE t.session_date=$1 GROUP BY 1,2,3
      ON CONFLICT (facility_id,department_id,stat_date) DO UPDATE SET checked_in=EXCLUDED.checked_in, is_final=EXCLUDED.is_final WHERE NOT s.is_final`,
      [new Date().toISOString().slice(0, 10), false],
    );
    expect((await q(maint, 'SELECT checked_in FROM facility_daily_stats'))[0].checked_in).toBe(1);
  });
});

describe('🔒 constraints and triggers', () => {
  it('triage safety invariant: final level cannot be less urgent than rules without override + reason', async () => {
    await expect(
      q(
        maint,
        "INSERT INTO triage_assessments (encounter_id,facility_id,rule_set_id,rule_level,final_level,symptoms,facts,routing_method,mode) VALUES ($1,$2,$3,'emergency','routine','[]','{}','rule','ai_assisted')",
        [ids['e'], ids['f1'], ids['rs']],
      ),
    ).rejects.toThrow(/final_not_less_urgent_than_rules/);
    await q(
      maint,
      "INSERT INTO triage_assessments (encounter_id,facility_id,rule_set_id,rule_level,final_level,symptoms,facts,routing_method,mode,overridden_by,override_reason,overridden_at) VALUES ($1,$2,$3,'emergency','routine','[]','{}','rule','ai_assisted',$4,'examined: stable',now())",
      [ids['e'], ids['f1'], ids['rs'], ids['u1']],
    );
    await q(
      maint,
      "INSERT INTO triage_assessments (encounter_id,facility_id,rule_set_id,rule_level,final_level,symptoms,facts,routing_method,mode) VALUES ($1,$2,$3,'routine','priority','[]','{}','rule','ai_assisted')",
      [ids['e2'], ids['f1'], ids['rs']],
    ); // escalation is always allowed
  });
  it('four-eyes: author cannot approve own rule set; published sets are immutable; retired cannot be re-published', async () => {
    await expect(
      q(
        maint,
        "INSERT INTO triage_rule_sets (version,status,rules,test_cases,checksum,authored_by,approved_by,published_at) VALUES (2,'draft','{}','[]',decode('01','hex'),$1,$1,now())",
        [ids['u1']],
      ),
    ).rejects.toThrow(/four_eyes/);
    await expect(q(maint, 'UPDATE triage_rule_sets SET rules=\'{"x":1}\' WHERE id=$1', [ids['rs']])).rejects.toThrow(/cannot be edited/);
    await expect(
      q(
        maint,
        "INSERT INTO triage_rule_sets (version,status,rules,test_cases,checksum,authored_by) VALUES (3,'published','{}','[]',decode('02','hex'),$1)",
        [ids['u1']],
      ),
    ).rejects.toThrow(/published_needs_approval/);
  });
  it('append-only tables reject updates and deletes even for the owner', async () => {
    await expect(q(maint, "UPDATE audit_events SET action='x'")).rejects.toThrow(/append-only/);
    await expect(q(maint, 'DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    await q(
      maint,
      "INSERT INTO consents (contact_point_id,patient_id,purpose,granted,notice_version,language,channel) VALUES ($1,$2,'care_coordination',true,'v1','hi','whatsapp')",
      [ids['cp'], ids['p']],
    );
    await expect(q(maint, 'DELETE FROM consents')).rejects.toThrow(/append-only/);
  });
  it('medical templates and self-care leaflets need clinical review; one live token per encounter', async () => {
    await expect(
      q(
        maint,
        "INSERT INTO message_templates (code,channel,language,version,body,is_medical,status) VALUES ('t.med','web','en',1,'x',true,'active')",
      ),
    ).rejects.toThrow(/medical_templates_reviewed/);
    await expect(
      q(
        maint,
        "INSERT INTO kb_documents (facility_id,doc_type,title,language,storage_key,checksum,status) VALUES ($1,'self_care_leaflet','L','en','k',decode('ff','hex'),'active')",
        [ids['f1']],
      ),
    ).rejects.toThrow(/leaflets_reviewed/);
    await expect(
      q(
        maint,
        "INSERT INTO opd_tokens (queue_session_id,encounter_id,facility_id,session_date,token_no,display_code,lane,queue_entry_at,source) VALUES ($1,$2,$3,current_date,2,'MED-002',2,now(),'counter')",
        [ids['qs'], ids['e2'], ids['f1']],
      ),
    ).rejects.toThrow(/opd_tokens_one_live_per_encounter/);
  });
});

describe('🔒 row-level security (fail closed)', () => {
  it('unset scope returns nothing; own facility visible; other facility hidden; cross-facility writes rejected; partitions not reachable', async () => {
    expect((await scoped(app, null, 'SELECT id FROM encounters')).rows.length).toBe(0);
    expect((await scoped(app, [ids['f1']], 'SELECT id FROM encounters')).rows.length).toBe(2);
    expect((await scoped(app, [ids['f2']], 'SELECT id FROM encounters')).rows.length).toBe(0);
    expect((await scoped(app, 'state', 'SELECT id FROM encounters')).rows.length).toBe(2);
    await expect(
      scoped(app, [ids['f2']], "INSERT INTO encounters (facility_id,channel,session_date) VALUES ($1,'counter',current_date)", [ids['f1']]),
    ).rejects.toThrow(/row-level security/);
    const part = (
      await q(
        maint,
        "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='encounters'::regclass LIMIT 1",
      )
    )[0].relname;
    // eslint-disable-next-line sahayak/no-string-built-sql -- partition name comes from pg_class in this test
    await expect(app.query(`SELECT count(*) FROM ${part}`)).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE queue_events SET payload='{}'")).rejects.toThrow(/permission denied/);
  });
});

describe('partitioning on UUIDv7', () => {
  it('child rows land in the encounter month; future partitions exist; expired partitions are listed', async () => {
    const r = (
      await q(
        maint,
        'SELECT tableoid::regclass::text AS enc, (SELECT tableoid::regclass::text FROM encounter_diagnoses d WHERE d.encounter_id=e.id LIMIT 1) AS diag FROM encounters e WHERE e.id=$1',
        [ids['e']],
      )
    )[0];
    expect(r.enc.slice(-7)).toBe(r.diag.slice(-7)); // same _pYYYYMM suffix
    const future = await q(
      maint,
      "SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='encounters'::regclass AND to_date(right(c.relname,6),'YYYYMM') > date_trunc('month', now() AT TIME ZONE 'UTC')::date",
    );
    expect(future[0].n).toBeGreaterThanOrEqual(2);
    await q(maint, "SELECT create_month_partition('llm_calls'::regclass, (date_trunc('month', now()) - interval '8 months')::date)");
    const expired = await q(maint, 'SELECT * FROM list_expired_partitions()');
    expect(expired.some((x) => x.parent_table === 'llm_calls')).toBe(true);
    expect(expired.some((x) => x.parent_table === 'encounters')).toBe(false); // NULL retention never expires
  });
});
