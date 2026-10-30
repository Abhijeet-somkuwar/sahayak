# LLM evals

`npm run eval -- intake_extract | department_route | kb_answer | prebrief`

Sets live in `evals/<purpose>/*.jsonl`. The seed sets here are **starter sets** (40 / 20 / 10 / 2 cases). §10.7 requires at least
300 labelled complaints, 200 routing cases, the full `kb_eval_cases` table and 50 clinician-scored pre-brief contexts before go-live;
growing them is a clinical data-labelling task (open decision 6, clinical governance). CI runs the evals whenever a file under
`src/**/prompts/` or `LLM_MODEL_*` changes.
