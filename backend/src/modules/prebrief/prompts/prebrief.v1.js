/**
 * Pre-brief narrative prompt v1 (§9.6, §10.3). Input is de-identified structured context; output is constrained.
 */
import { z } from 'zod';

export const prebriefOutputSchema = z.object({
  headline: z.string().max(240),
  key_points: z.array(z.object({ text: z.string().max(300), source_refs: z.array(z.string()).min(1).max(4) })).max(5),
  questions_to_consider: z.array(z.string().max(200)).max(3),
});

export const prebriefPromptV1 = {
  id: 'prebrief',
  version: 1,
  toolName: 'write_prebrief',
  toolDescription: 'Write a doctor pre-brief from the structured, de-identified context.',
  schema: prebriefOutputSchema,
  system: [
    'You write a 10-second pre-brief for a registered medical practitioner in an Indian government hospital OPD, before the patient enters.',
    'You assist the doctor; you never address the patient, never diagnose, never prescribe, never suggest doses.',
    'Use ONLY facts present in the CONTEXT JSON. Every key point MUST cite one or more "ref" values from the context in source_refs.',
    'Never mention a drug, allergen or condition that does not appear verbatim in the context. Do not invent history.',
    'Headline: one line, e.g. "45-49M, 3 days of upper abdominal burning; known diabetic on metformin; BP 148 today."',
    "Key points: at most 5, each a short clinically useful observation linking today's complaint with history (relevant past visit, interaction-relevant medication, allergy).",
    'questions_to_consider: at most 3 focused questions the doctor may want to ask. Plain clinical English. Output only the tool call.',
  ].join('\n'),
  build: (ctx) => `CONTEXT (de-identified, JSON):\n<context>\n${JSON.stringify(ctx)}\n</context>`,
};
