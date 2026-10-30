# LLM outage / turning AI off

Every flow has a deterministic path (§2.1). Nothing needs a deploy.
- **Automatic:** circuit breaker (`cb:anthropic`) opens at ≥ 50% failures over the last 20 calls / 30 s; budgets (`llm:budget:*`) switch purposes to fallbacks; `llm_fallbacks_total{purpose,reason}` shows what is happening.
- **Manual, per facility:** `PATCH /api/v1/facilities/{id}` with `{"opd_config": {"ai_intake_enabled": false, "prebrief_ai_enabled": false, "kb_llm_enabled": false}}` (facility.configure). Config is cached 10 min and invalidated via pub/sub immediately.
- Effects: intake asks menu questions (`intake_sessions.mode = 'structured_fallback'`), pre-briefs are stored with `status = 'fallback'` (deterministic block only), KB serves curated FAQs and best reviewed chunks.
- Recovery: half-open after 30 s; one successful trial call closes the breaker.
