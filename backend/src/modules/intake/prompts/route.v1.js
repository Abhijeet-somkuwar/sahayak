import { z } from 'zod';

export const routeSchema = z.object({ specialty_code: z.string(), confidence: z.number().min(0).max(1) });

export const routePromptV1 = {
  id: 'intake.route',
  version: 1,
  toolName: 'route_department',
  toolDescription: 'Choose the OPD specialty for this presentation from the allowed list.',
  schema: routeSchema,
  system:
    'You route an OPD patient to a specialty. Choose exactly one specialty_code from SPECIALTIES (these are the departments open at this hospital). Prefer general_medicine when unsure. confidence is your calibrated probability that this is the right department. No diagnosis, no advice.',
  build: (i) =>
    `SPECIALTIES: ${i.specialties.join(', ')}\nSYMPTOMS: ${i.symptoms.map((s) => `${s.code} (${s.label})`).join('; ')}\nFACTS (age band, sex, flags): ${JSON.stringify(i.facts)}`,
};
