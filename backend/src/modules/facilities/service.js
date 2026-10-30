import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { cacheGet, cacheSet, cacheDel } from '../../infra/cache.js';
import { redisCore, keys } from '../../infra/redis.js';
import { toJson } from '../../infra/db.types.js';
import { parseOpdConfig } from '../../config/flags.js';
import { AppError } from '../../shared/errors.js';
import { facilitiesRepo } from './repo.js';

export async function getFacilityConfig(facilityId) {
  const key = keys.cfgFacility(facilityId);
  const hit = await cacheGet(key);
  if (hit) return hit;
  const cfg = await withScope(STATE_SCOPE, async (trx) => {
    const f = await facilitiesRepo.byId(trx, facilityId);
    if (!f || f.status !== 'active') throw AppError.notFound('facility');
    const [departments, servicePoints] = await Promise.all([
      facilitiesRepo.departments(trx, facilityId),
      facilitiesRepo.servicePoints(trx, facilityId),
    ]);
    return {
      facility: {
        id: f.id,
        code: f.code,
        name: f.name,
        name_i18n: f.name_i18n,
        kind: f.kind,
        state_code: f.state_code,
        district_code: f.district_code,
        timezone: f.timezone,
        address: f.address,
        pincode: f.pincode,
      },
      opd: parseOpdConfig(f.opd_config),
      departments,
      servicePoints,
    };
  });
  await cacheSet(key, cfg, { ttlSeconds: 600 });
  return cfg;
}

export async function invalidateFacilityConfig(facilityId) {
  await cacheDel(keys.cfgFacility(facilityId), keys.waitboard(facilityId));
  try {
    await redisCore.publish(keys.chConfigInvalidate, facilityId);
  } catch {
    /* best-effort */
  }
}

export function roomLabel(cfg, servicePointId, language = 'en') {
  if (!servicePointId) return '';
  const sp = cfg.servicePoints.find((s) => s.id === servicePointId);
  if (!sp) return '';
  return sp.label_i18n[language] ?? sp.label;
}

export const facilitiesService = {
  getConfig: getFacilityConfig,
  invalidate: invalidateFacilityConfig,

  async createFacility(input) {
    return withScope(STATE_SCOPE, (trx) =>
      facilitiesRepo.create(trx, {
        code: input.code,
        name: input.name,
        name_i18n: toJson(input.name_i18n),
        kind: input.kind,
        state_code: input.state_code,
        district_code: input.district_code,
        hfr_id: input.hfr_id,
        address: input.address,
        pincode: input.pincode,
        latitude: input.latitude,
        longitude: input.longitude,
        opd_config: toJson(input.opd_config),
      }),
    );
  },

  async updateFacility(facilityId, input) {
    const row = await withScope(STATE_SCOPE, async (trx) => {
      const current = await facilitiesRepo.byId(trx, facilityId);
      if (!current) throw AppError.notFound('facility');
      const patch = {};
      if (input.name !== undefined) patch['name'] = input.name;
      if (input.name_i18n !== undefined) patch['name_i18n'] = toJson(input.name_i18n);
      if (input.address !== undefined) patch['address'] = input.address;
      if (input.pincode !== undefined) patch['pincode'] = input.pincode;
      if (input.latitude !== undefined) patch['latitude'] = input.latitude;
      if (input.longitude !== undefined) patch['longitude'] = input.longitude;
      if (input.opd_config !== undefined) patch['opd_config'] = toJson({ ...current.opd_config, ...input.opd_config });
      return facilitiesRepo.update(trx, facilityId, patch);
    });
    if (!row) throw AppError.notFound('facility');
    await invalidateFacilityConfig(facilityId);
    return row;
  },

  async createDepartment(trx, facilityId, input) {
    const row = await facilitiesRepo.createDepartment(trx, { ...input, facility_id: facilityId, name_i18n: toJson(input.name_i18n) });
    return row;
  },
  async updateDepartment(trx, facilityId, id, input) {
    const patch = { ...input };
    if (input.name_i18n) patch['name_i18n'] = toJson(input.name_i18n);
    const row = await facilitiesRepo.updateDepartment(trx, id, facilityId, patch);
    if (!row) throw AppError.notFound('department');
    return row;
  },
  async createServicePoint(trx, facilityId, input) {
    return facilitiesRepo.createServicePoint(trx, {
      ...input,
      facility_id: facilityId,
      label_i18n: toJson(input.label_i18n),
      wayfinding_i18n: toJson(input.wayfinding_i18n),
    });
  },
  async updateServicePoint(trx, facilityId, id, input) {
    const patch = { ...input };
    if (input.label_i18n) patch['label_i18n'] = toJson(input.label_i18n);
    if (input.wayfinding_i18n) patch['wayfinding_i18n'] = toJson(input.wayfinding_i18n);
    const row = await facilitiesRepo.updateServicePoint(trx, id, facilityId, patch);
    if (!row) throw AppError.notFound('service point');
    return row;
  },
  async createSchedule(trx, facilityId, input) {
    const dept = await facilitiesRepo.departmentById(trx, input.department_id);
    if (!dept || dept.facility_id !== facilityId) throw AppError.validation('department does not belong to this facility');
    return facilitiesRepo.createSchedule(trx, { ...input, facility_id: facilityId });
  },
  async createOverride(trx, facilityId, input, createdBy) {
    return facilitiesRepo.createOverride(trx, { ...input, facility_id: facilityId, created_by: createdBy });
  },
};
