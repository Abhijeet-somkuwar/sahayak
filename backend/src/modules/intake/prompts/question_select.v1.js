import { z } from 'zod';

export const questionSelectSchema = z.object({ code: z.string() });

export const questionSelectPromptV1 = {
  id: 'intake.question_select',
  version: 1,
  toolName: 'select_question',
  toolDescription: 'Select the single most useful next vetted question by code.',
  schema: questionSelectSchema,
  system:
    'You pick the next clarifying question for a triage intake. Choose the ONE candidate code whose answer most changes urgency or routing (red-flag facts first, then duration, then severity). Return only a code from CANDIDATES. Do not write questions yourself.',
  build: (i) =>
    `SYMPTOMS: ${i.symptoms.join(', ')}\nKNOWN FACTS: ${JSON.stringify(i.known_facts)}\nMISSING FACTS: ${i.missing_facts.join(', ')}\nCANDIDATES:\n${i.candidates.map((c) => `${c.code} | sets ${c.sets_fact} | ${c.prompt}`).join('\n')}`,
};
