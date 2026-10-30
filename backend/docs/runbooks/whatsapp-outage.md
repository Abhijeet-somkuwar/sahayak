# WhatsApp outage

- 5xx / 429 from the Cloud API: `wa-outbound` retries with exponential backoff + jitter (8 attempts). `wa_outbound_total{status="retry"}` rises; `bullmq_waiting{queue="wa-outbound"}` grows. Critical messages (your turn, emergency) fall back to SMS after a permanent failure or when no approved template exists outside the 24-hour window.
- Inbound: the webhook keeps accepting (signature-verified, deduped) as long as redis-core is up; processing resumes when the API recovers.
- Template rejected by Meta: `template-sync` sets `message_templates.provider_status`; fix the template text, resubmit, keep the same `code`.
- Walk-ins are unaffected: kiosk / counter check-in and displays never depend on WhatsApp.
