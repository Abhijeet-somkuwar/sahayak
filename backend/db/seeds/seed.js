/**
 * Demo seeds (§19): one "Demo District Hospital" with 6 OPD departments + casualty, rooms, 8 doctors' schedules, staff,
 * devices, ~160 symptoms (en/hi/gu + Hinglish synonyms), 60 vetted questions, a DEMO rule set (not for clinical use),
 * message templates in en/hi/gu, FAQ entries, KB documents with eval cases. Idempotent: safe to re-run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import argon2 from 'argon2';
import { maintDb, closeDatabase } from '../../src/infra/db.js';
import { blindIndex, encrypt, randomToken, sha256 } from '../../src/infra/crypto.js';
import { embeddings } from '../../src/infra/embeddings/index.js';
import { toJson, toVector } from '../../src/infra/db.types.js';
import { newId } from '../../src/shared/ids.js';
import { ruleSetChecksum, ruleSetSchema, runTestCases, testCaseSchema } from '../../src/modules/triage/engine.js';
import { chunkText, normaliseText } from '../../src/modules/kb/ingest.js';
import { ensureBucket, putObject, storageKeys } from '../../src/infra/storage.js';
import { closeRedis, redisCore, keys } from '../../src/infra/redis.js';
import { z } from 'zod';

const dataDir = fileURLToPath(new URL('./data/', import.meta.url));
const read = (f) => JSON.parse(readFileSync(`${dataDir}${f}`, 'utf8'));
const PASSWORD = process.env['SEED_STAFF_PASSWORD'] ?? 'Demo@12345678';
const ARGON = { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 };
const log = (m, extra = '') => console.log(`[seed] ${m}`, extra);

async function main() {
  const db = maintDb;
  const out = {};

  // ---- facility ----
  const facilityCode = 'GJ-DEMO-DH';
  let facility = await db.selectFrom('facilities').selectAll().where('code', '=', facilityCode).executeTakeFirst();
  if (!facility) {
    facility = await db
      .insertInto('facilities')
      .values({
        id: newId(),
        code: facilityCode,
        name: 'Demo District Hospital',
        name_i18n: toJson({ en: 'Demo District Hospital', hi: 'डेमो ज़िला अस्पताल', gu: 'ડેમો જિલ્લા હોસ્પિટલ' }),
        kind: 'district_hospital',
        state_code: 'GJ',
        district_code: '474',
        address: 'Station Road, Demo Nagar',
        pincode: '382001',
        latitude: 23.0225,
        longitude: 72.5714,
        opd_config: toJson({
          ai_intake_enabled: true,
          prebrief_ai_enabled: true,
          kb_llm_enabled: true,
          remote_booking_enabled: true,
          offline_blocks_enabled: true,
          help_desk_phone: '079-2000-0000',
          lane_ratio: [1, 2],
          max_wait_minutes: 120,
        }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  const fid = facility.id;
  out['facility_id'] = fid;
  out['facility_code'] = facilityCode;

  // ---- departments ----
  const depts = [
    ['GEN_MED', 'general_medicine', 'Medicine OPD', { hi: 'मेडिसिन ओपीडी', gu: 'મેડિસિન OPD' }, 'MED', false, 1],
    ['PAED', 'paediatrics', 'Paediatrics OPD', { hi: 'बच्चों की ओपीडी', gu: 'બાળકોની OPD' }, 'PED', false, 2],
    ['OBGYN', 'obgyn', "Women's OPD (Gynaecology & Obstetrics)", { hi: 'महिला ओपीडी', gu: 'મહિલા OPD' }, 'OBG', false, 3],
    ['ORTHO', 'orthopaedics', 'Orthopaedics OPD', { hi: 'हड्डी ओपीडी', gu: 'હાડકાં OPD' }, 'ORT', false, 4],
    ['OPHTH', 'ophthalmology', 'Eye OPD', { hi: 'आंख ओपीडी', gu: 'આંખ OPD' }, 'EYE', false, 5],
    ['ENT', 'ent', 'ENT OPD', { hi: 'कान-नाक-गला ओपीडी', gu: 'કાન-નાક-ગળું OPD' }, 'ENT', false, 6],
    ['CASUALTY', 'emergency', 'Casualty (Emergency)', { hi: 'कैज़ुअल्टी (आपातकाल)', gu: 'કેઝ્યુઅલ્ટી (કટોકટી)' }, 'EMR', true, 99],
  ];
  const deptIds = {};
  for (const [code, spec, name, i18n, prefix, isEmergency, order] of depts) {
    const row = await db
      .insertInto('departments')
      .values({
        id: newId(),
        facility_id: fid,
        code,
        specialty_code: spec,
        name,
        name_i18n: toJson({ en: name, ...i18n }),
        token_prefix: prefix,
        is_emergency: isEmergency,
        accepts_routing: !isEmergency,
        display_order: order,
      })
      .onConflict((oc) => oc.columns(['facility_id', 'code']).doUpdateSet({ name, specialty_code: spec }))
      .returningAll()
      .executeTakeFirstOrThrow();
    deptIds[code] = row.id;
  }

  // ---- service points ----
  const rooms = [
    [
      'Room 1',
      'consult_room',
      'GEN_MED',
      'Ground',
      { hi: 'कमरा 1', gu: 'રૂમ 1' },
      'Ground floor, corridor behind the registration counters',
    ],
    ['Room 2', 'consult_room', 'PAED', 'Ground', { hi: 'कमरा 2', gu: 'રૂમ 2' }, 'Ground floor, next to Room 1'],
    ['Room 3', 'consult_room', 'OBGYN', 'First', { hi: 'कमरा 3', gu: 'રૂમ 3' }, 'First floor, take the lift next to the help desk'],
    ['Room 4', 'consult_room', 'ORTHO', 'First', { hi: 'कमरा 4', gu: 'રૂમ 4' }, 'First floor, next to the plaster room'],
    ['Room 5', 'consult_room', 'OPHTH', 'First', { hi: 'कमरा 5', gu: 'રૂમ 5' }, 'First floor'],
    ['Room 6', 'consult_room', 'ENT', 'First', { hi: 'कमरा 6', gu: 'રૂમ 6' }, 'First floor, end of the corridor'],
    ['Counter 1', 'registration_counter', null, 'Ground', { hi: 'काउंटर 1', gu: 'કાઉન્ટર 1' }, 'Main hall, straight from the main gate'],
    ['Counter 2', 'registration_counter', null, 'Ground', { hi: 'काउंटर 2', gu: 'કાઉન્ટર 2' }, 'Main hall, next to Counter 1'],
    [
      'Help Desk',
      'help_desk',
      null,
      'Ground',
      { hi: 'हेल्प डेस्क', gu: 'હેલ્પ ડેસ્ક' },
      'Entrance of the main hall, right of the main gate',
    ],
    [
      'Casualty Bay',
      'emergency_bay',
      'CASUALTY',
      'Ground',
      { hi: 'कैज़ुअल्टी', gu: 'કેઝ્યુઅલ્ટી' },
      'Separate building to the right of the main gate, red sign',
    ],
    ['Lab Counter', 'lab', null, 'Ground', { hi: 'लैब काउंटर', gu: 'લેબ કાઉન્ટર' }, 'End of the ground-floor corridor'],
    ['Pharmacy', 'pharmacy', null, 'Ground', { hi: 'दवाखाना', gu: 'ફાર્મસી' }, 'End of the ground-floor corridor'],
  ];
  const spIds = {};
  for (const [label, kind, dept, floor, i18n, way] of rooms) {
    const row = await db
      .insertInto('service_points')
      .values({
        id: newId(),
        facility_id: fid,
        department_id: dept ? deptIds[dept] : null,
        kind: kind,
        label,
        label_i18n: toJson({ en: label, ...i18n }),
        floor,
        wayfinding_i18n: toJson({ en: way }),
      })
      .onConflict((oc) => oc.columns(['facility_id', 'label']).doUpdateSet({ floor }))
      .returningAll()
      .executeTakeFirstOrThrow();
    spIds[label] = row.id;
  }

  // ---- users & memberships ----
  const passwordHash = await argon2.hash(PASSWORD, ARGON);
  async function user(email, name, phone, hpr) {
    const existing = await db
      .selectFrom('users')
      .select('id')
      .where(sql`lower(email)`, '=', email)
      .executeTakeFirst();
    if (existing) return existing.id;
    const enc = phone ? encrypt('pii', phone) : null;
    return (
      await db
        .insertInto('users')
        .values({
          id: newId(),
          display_name: name,
          email,
          phone_hash: phone ? blindIndex('phone', phone) : null,
          phone_enc: enc?.ciphertext ?? null,
          key_version: enc?.keyVersion ?? null,
          password_hash: passwordHash,
          hpr_id: hpr,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }
  async function member(userId, role, dept, facilityId = fid) {
    await db
      .insertInto('staff_memberships')
      .values({ id: newId(), user_id: userId, facility_id: facilityId, role: role, department_id: dept ? deptIds[dept] : null })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  const doctors = [
    ['dr.mehta@demo.sahayak.health', 'Dr. Anil Mehta', 'GEN_MED', 'Room 1'],
    ['dr.shah@demo.sahayak.health', 'Dr. Ritu Shah', 'GEN_MED', 'Room 1'],
    ['dr.patel@demo.sahayak.health', 'Dr. Kiran Patel', 'PAED', 'Room 2'],
    ['dr.desai@demo.sahayak.health', 'Dr. Meera Desai', 'OBGYN', 'Room 3'],
    ['dr.joshi@demo.sahayak.health', 'Dr. Vikram Joshi', 'ORTHO', 'Room 4'],
    ['dr.parikh@demo.sahayak.health', 'Dr. Nita Parikh', 'OPHTH', 'Room 5'],
    ['dr.trivedi@demo.sahayak.health', 'Dr. Sunil Trivedi', 'ENT', 'Room 6'],
    ['dr.rao@demo.sahayak.health', 'Dr. Lakshmi Rao', 'CASUALTY', 'Casualty Bay'],
  ];
  const doctorIds = [];
  for (const [i, [email, name, dept, room]] of doctors.entries()) {
    const id = await user(email, name, null, `HPR-DEMO-${1000 + i}`);
    doctorIds.push(id);
    await member(id, 'doctor', dept);
    if (dept !== 'CASUALTY') {
      for (let weekday = 1; weekday <= 6; weekday++) {
        const exists = await db
          .selectFrom('doctor_schedules')
          .select('id')
          .where('user_id', '=', id)
          .where('weekday', '=', weekday)
          .where('shift', '=', 'morning')
          .executeTakeFirst();
        if (!exists)
          await db
            .insertInto('doctor_schedules')
            .values({
              id: newId(),
              facility_id: fid,
              department_id: deptIds[dept],
              user_id: id,
              service_point_id: spIds[room],
              weekday,
              shift: 'morning',
              starts_at: '09:00',
              ends_at: dept === 'OPHTH' ? '12:30' : '13:00',
              effective_from: '2026-01-01',
            })
            .execute();
      }
    }
  }
  const admin = await user('admin@demo.sahayak.health', 'Facility Admin', null, null);
  await member(admin, 'facility_admin', null);
  const clerk = await user('clerk@demo.sahayak.health', 'Registration Clerk', '+919800000001', null);
  await member(clerk, 'registration_clerk', null);
  const nurse = await user('nurse@demo.sahayak.health', 'Staff Nurse', null, 'HPR-DEMO-2001');
  await member(nurse, 'nurse', 'GEN_MED');
  const helpdesk = await user('helpdesk@demo.sahayak.health', 'Help Desk', null, null);
  await member(helpdesk, 'help_desk', null);
  const reviewer1 = await user('reviewer1@demo.sahayak.health', 'Dr. Clinical Reviewer One', null, 'HPR-DEMO-3001');
  await member(reviewer1, 'clinical_reviewer', null);
  const reviewer2 = await user('reviewer2@demo.sahayak.health', 'Dr. Clinical Reviewer Two', null, 'HPR-DEMO-3002');
  await member(reviewer2, 'clinical_reviewer', null);
  const dpo = await user('dpo@demo.sahayak.health', 'Data Protection Officer', null, null);
  await member(dpo, 'dpo', null, null);
  const stateAdmin = await user('state@demo.sahayak.health', 'State Admin', null, null);
  await member(stateAdmin, 'state_admin', null, null);
  out['staff_password'] = PASSWORD;
  out['staff_logins'] = [
    'admin@',
    'clerk@',
    'nurse@',
    'helpdesk@',
    'reviewer1@',
    'reviewer2@',
    'dpo@',
    'state@',
    ...doctors.map((d) => d[0].split('@')[0] + '@'),
  ].map((p) => `${p}demo.sahayak.health`);

  // ---- devices ----
  const deviceKeys = {};
  for (const [label, kind] of [
    ['Main Hall Display', 'queue_display'],
    ['Gate Kiosk', 'kiosk'],
    ['Counter 1 Terminal', 'counter_terminal'],
  ]) {
    const existing = await db
      .selectFrom('devices')
      .select('id')
      .where('facility_id', '=', fid)
      .where('label', '=', label)
      .executeTakeFirst();
    if (existing) continue;
    const key = `sk_dev_${randomToken(32)}`;
    await db
      .insertInto('devices')
      .values({
        id: newId(),
        facility_id: fid,
        kind,
        label,
        department_ids: kind === 'queue_display' ? [deptIds['GEN_MED'], deptIds['PAED'], deptIds['OBGYN']] : [],
        service_point_ids: kind === 'counter_terminal' ? [spIds['Counter 1']] : [],
        api_key_hash: sha256(key),
      })
      .execute();
    deviceKeys[label] = key;
  }
  if (Object.keys(deviceKeys).length) out['device_api_keys_shown_once'] = deviceKeys;

  // ---- symptom catalog (embeddings for Q9) ----
  const symptoms = read('symptoms.json').items;
  const provider = embeddings();
  const symVectors = await provider.embed(symptoms.map(([, , , , en, hi, gu, syn]) => `${en} ${hi} ${gu} ${syn.join(' ')}`));
  for (const [i, [code, system, spec, red, en, hi, gu, syn]] of symptoms.entries()) {
    await db
      .insertInto('symptom_catalog')
      .values({
        id: newId(),
        code,
        body_system: system,
        labels: toJson({ en, hi, gu }),
        synonyms: [...new Set(syn.map((s) => s.toLowerCase()))],
        default_specialty_code: spec,
        is_red_flag: red,
        embedding: toVector(symVectors[i]),
        embedding_model: provider.model,
        clinically_reviewed_by: reviewer1,
      })
      .onConflict((oc) =>
        oc
          .column('code')
          .doUpdateSet({
            body_system: system,
            labels: toJson({ en, hi, gu }),
            synonyms: [...new Set(syn.map((s) => s.toLowerCase()))],
            default_specialty_code: spec,
            is_red_flag: red,
            embedding: toVector(symVectors[i]),
            embedding_model: provider.model,
          }),
      )
      .execute();
  }
  log(`symptoms: ${symptoms.length}`);

  // ---- questions ----
  const questions = read('questions.json').items;
  for (const [code, type, fact, applies, priority, prompts, options] of questions) {
    await db
      .insertInto('intake_questions')
      .values({
        id: newId(),
        code,
        answer_type: type,
        prompts: toJson(prompts),
        options: toJson(options),
        sets_fact: fact,
        applies_to_symptoms: applies,
        priority,
        clinically_reviewed_by: reviewer1,
      })
      .onConflict((oc) =>
        oc
          .column('code')
          .doUpdateSet({
            answer_type: type,
            prompts: toJson(prompts),
            options: toJson(options),
            sets_fact: fact,
            applies_to_symptoms: applies,
            priority,
          }),
      )
      .execute();
  }
  log(`questions: ${questions.length}`);

  // ---- DEMO rule set (author ≠ approver, tests must pass) ----
  const rulesFile = read('rules.json');
  const rules = ruleSetSchema.parse(rulesFile.rules);
  const cases = z.array(testCaseSchema).parse(rulesFile.test_cases);
  const tr = runTestCases(rules, cases);
  if (!tr.passed) {
    console.error(tr.results.filter((r) => !r.passed));
    throw new Error('demo rule set test cases failed');
  }
  const published = await db.selectFrom('triage_rule_sets').select(['id', 'checksum']).where('status', '=', 'published').executeTakeFirst();
  const checksum = ruleSetChecksum(rules);
  if (!published || !published.checksum.equals(checksum)) {
    if (published)
      await db.updateTable('triage_rule_sets').set({ status: 'retired', retired_at: new Date() }).where('id', '=', published.id).execute();
    const v =
      Number(
        (
          await db
            .selectFrom('triage_rule_sets')
            .select((eb) => eb.fn.max('version').as('v'))
            .executeTakeFirst()
        )?.v ?? 0,
      ) + 1;
    await db
      .insertInto('triage_rule_sets')
      .values({
        id: newId(),
        version: v,
        status: 'published',
        rules: toJson(rules),
        test_cases: toJson(cases),
        checksum,
        authored_by: reviewer1,
        approved_by: reviewer2,
        published_at: new Date(),
        notes: rulesFile.notes,
      })
      .execute();
    await redisCore.incr(keys.rulesver).catch(() => {});
    log(`rule set v${v} published (DEMO — not for clinical use)`);
  }

  // ---- message templates ----
  const tpl = read('templates.json').templates;
  let tplCount = 0;
  for (const [code, t] of Object.entries(tpl)) {
    for (const lang of ['en', 'hi', 'gu']) {
      const body = t[lang];
      if (!body) continue;
      const vars = t.vars ?? [...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
      for (const channel of t.wa_template ? ['web', 'whatsapp'] : ['web']) {
        const exists = await db
          .selectFrom('message_templates')
          .select('id')
          .where('code', '=', code)
          .where('channel', '=', channel)
          .where('language', '=', lang)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (exists) continue;
        await db
          .insertInto('message_templates')
          .values({
            id: newId(),
            code,
            channel,
            language: lang,
            version: 1,
            body,
            variables: vars,
            provider_template_name: channel === 'whatsapp' ? (t.wa_template ?? null) : null,
            provider_status: channel === 'whatsapp' ? 'PENDING' : null,
            is_medical: !!t.medical,
            clinically_reviewed_by: t.medical ? reviewer1 : null,
            status: 'active',
          })
          .execute();
        tplCount++;
      }
    }
  }
  log(`templates inserted: ${tplCount}`);

  // ---- KB documents (stored, chunked, embedded, published) ----
  await ensureBucket().catch(() => log('object storage unavailable; KB originals not stored'));
  const kbFiles = readdirSync(`${dataDir}kb`).filter((f) => f.endsWith('.md'));
  const docIdByKey = {};
  for (const f of kbFiles) {
    const key = f.replace(/\.md$/, '');
    const lang = key.endsWith('.hi') ? 'hi' : key.endsWith('.gu') ? 'gu' : 'en';
    const text = readFileSync(`${dataDir}kb/${f}`, 'utf8');
    const title = text.split('\n')[0].replace(/^#\s*/, '').trim();
    const docType = key.startsWith('self-care')
      ? 'self_care_leaflet'
      : key.startsWith('pmjay')
        ? 'scheme'
        : key.startsWith('wayfinding')
          ? 'wayfinding'
          : 'timings';
    const checksum = sha256(text);
    let doc = await db
      .selectFrom('kb_documents')
      .selectAll()
      .where('facility_id', '=', fid)
      .where('checksum', '=', checksum)
      .executeTakeFirst();
    if (!doc) {
      const id = newId();
      const storageKey = storageKeys.kbDocument(fid, id, 'md');
      await putObject(storageKey, text, 'text/markdown').catch(() => undefined);
      doc = await db
        .insertInto('kb_documents')
        .values({
          id,
          facility_id: fid,
          doc_type: docType,
          title,
          language: lang,
          storage_key: storageKey,
          checksum,
          status: 'draft',
          symptom_codes: docType === 'self_care_leaflet' ? ['SYM_COLD', 'SYM_SORE_THROAT', 'SYM_BODY_ACHE'] : [],
          clinically_reviewed_by: docType === 'self_care_leaflet' ? reviewer1 : null,
          approved_by: admin,
          created_by: admin,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const chunks = chunkText(normaliseText(text), title);
      const vectors = await provider.embed(chunks.map((c) => `${c.headingPath}\n${c.content}`));
      await db
        .insertInto('kb_chunks')
        .values(
          chunks.map((c, i) => ({
            id: newId(),
            document_id: doc.id,
            facility_id: fid,
            doc_type: docType,
            language: lang,
            is_active: true,
            chunk_index: i,
            heading_path: c.headingPath,
            content: c.content,
            token_count: c.tokenCount,
            embedding: toVector(vectors[i]),
            embedding_model: provider.model,
          })),
        )
        .execute();
      await db.updateTable('kb_documents').set({ status: 'active' }).where('id', '=', doc.id).execute();
      log(`kb document ${key}: ${chunks.length} chunks`);
    }
    docIdByKey[key] = doc.id;
  }
  await redisCore.incr(keys.kbver(fid)).catch(() => {});

  // ---- FAQ ----
  const faqs = read('faq.json').items;
  for (const f of faqs) {
    let entry = await db
      .selectFrom('faq_entries')
      .selectAll()
      .where('facility_id', '=', fid)
      .where('topic', '=', f.topic)
      .executeTakeFirst();
    if (!entry)
      entry = await db
        .insertInto('faq_entries')
        .values({
          id: newId(),
          facility_id: fid,
          topic: f.topic,
          answer_i18n: toJson(f.answer),
          source_document_id: null,
          approved_by: admin,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    const variants = Object.entries(f.variants).flatMap(([lang, qs]) => qs.map((q) => ({ lang, q })));
    const existing = await db.selectFrom('faq_variants').select('id').where('faq_id', '=', entry.id).executeTakeFirst();
    if (!existing) {
      const vectors = await provider.embed(variants.map((v) => v.q.toLowerCase()));
      await db
        .insertInto('faq_variants')
        .values(
          variants.map((v, i) => ({
            id: newId(),
            faq_id: entry.id,
            facility_id: fid,
            language: v.lang,
            question: v.q,
            embedding: toVector(vectors[i]),
            embedding_model: provider.model,
          })),
        )
        .execute();
    }
  }
  log(`faq entries: ${faqs.length}`);

  // ---- KB eval cases ----
  const evals = read('eval_cases.json').items;
  const evalCount = Number(
    (
      await db
        .selectFrom('kb_eval_cases')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('facility_id', '=', fid)
        .executeTakeFirst()
    )?.n ?? 0,
  );
  if (evalCount === 0) {
    await db
      .insertInto('kb_eval_cases')
      .values(
        evals.map((e) => ({
          id: newId(),
          facility_id: fid,
          language: e.lang,
          question: e.q,
          expected_document_id: docIdByKey[e.doc] ?? null,
          expected_answer_contains: e.contains,
          created_by: admin,
        })),
      )
      .execute();
  }
  log(`kb eval cases: ${evals.length}`);

  // ---- today's and tomorrow's queue sessions ----
  const { createNextDaySessions } = await import('../../src/modules/queue/jobs.js');
  const { istDate } = await import('../../src/shared/time.js');
  await createNextDaySessions(istDate());
  await createNextDaySessions();

  console.log(JSON.stringify(out, null, 2));
}

main()
  .then(async () => {
    await closeDatabase();
    await closeRedis();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDatabase().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(1);
  });
