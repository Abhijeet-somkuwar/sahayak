# Security incident

1. Contain: rotate the affected device keys (`POST /facilities/{id}/devices/{deviceId}/rotate-key`), deactivate staff (`DELETE /facilities/{id}/staff/{membershipId}` → revocation list), rotate `WA_APP_SECRET`/`ANTHROPIC_API_KEY` in the secret manager.
2. Preserve evidence: audit partitions are append-only; hourly digests (`audit_digests`) and WORM exports prove integrity. Do not run retention during the investigation.
3. **CERT-In**: report within 6 hours of noticing (CERT-In directions, 2022). Logs are retained 180 days in India.
4. **DPDP**: notify the Data Protection Board and affected data principals as the Rules (2025) require; the `dpo` role owns the notification. Confirm exact obligations with the legal team (§20).
5. Post-incident: review `breakglass.open` events and `auth.login_failed` spikes for the window.
