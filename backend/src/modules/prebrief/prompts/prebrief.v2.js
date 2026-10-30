/**
 * Pre-brief narrative prompt v2 (§9.6, §10.3). Adds a history summary across months of visits and up to three
 * "considerations" (a differential the doctor may want to rule in or out). 🔒 Doctor-facing only, never shown to
 * the patient; considerations are suggestions for a registered medical practitioner, not a diagnosis.
 *
 * The schema sent to the provider is deliberately loose (no length or count limits, citations optional): some
 * providers (Groq) reject the whole answer when a tool call misses a schema limit. Caps, citation checks and the
 * drug/allergen dictionary check are applied afterwards in validateNarrative().
 */
import { z } from 'zod';

export const prebriefOutputSchemaV2 = z.object({
  headline: z.string(),
  history_summary: z.string().optional(),
  key_points: z.array(z.object({ text: z.string(), source_refs: z.array(z.string()).optional() })).optional(),
  considerations: z
    .array(z.object({ condition: z.string(), reasoning: z.string().optional(), source_refs: z.array(z.string()).optional() }))
    .optional(),
  questions_to_consider: z.array(z.string()).optional(),
});

export const prebriefPromptV2 = {
  id: 'prebrief',
  version: 2,
  toolName: 'write_prebrief',
  toolDescription: 'Write a doctor pre-brief from the structured, de-identified context.',
  schema: prebriefOutputSchemaV2,
  system: [
    'You write the pre-brief a registered medical practitioner reads in the 20 seconds before an OPD patient enters, in an Indian government hospital.',
    'You assist the doctor only: never address the patient, never prescribe, never suggest doses or new medicines.',
    'Use ONLY facts present in the CONTEXT JSON. Never mention a drug or allergen that is not in the context. Do not invent history.',
    'headline: one line with age band and sex, today\'s complaint and duration, and the most relevant history. Example: "55-59F, headache today; seen 3 days ago for fever, given paracetamol 500 mg."',
    'history_summary: 1 to 3 sentences summarising recent_visits from oldest to newest. Start each visit with its "when" value written naturally ("Today", "3 days ago", "5 months ago"), then why the patient came, the diagnoses and the medicines given. Example: "5 months ago: burning in stomach, diagnosed gastritis, given pantoprazole 40 mg OD. Today: fever, diagnosed viral fever." Empty string when recent_visits is empty.',
    'key_points: at most 5 short observations linking today\'s complaint with history, medicines, allergies or vitals. Put the "ref" values each point relies on in source_refs; use "today" for today\'s complaint.',
    'considerations: at most 3 possible conditions the doctor may want to consider for today\'s complaint (a differential), each with one line of reasoning from the context and its source_refs. Prefer conditions common in Indian OPD practice; include a serious condition to rule out when the context warrants it. These are suggestions to verify, not a diagnosis.',
    'questions_to_consider: at most 3 focused history or examination questions.',
    'Plain clinical English. Output only the tool call.',
  ].join('\n'),
  build: (ctx) => `CONTEXT (de-identified, JSON):\n<context>\n${JSON.stringify(ctx)}\n</context>`,
};
