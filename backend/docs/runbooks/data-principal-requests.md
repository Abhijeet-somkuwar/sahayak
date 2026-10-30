# Data-principal requests and break-glass review (DPO)

- **Access ("who accessed my record")**: `GET /audit/patients/{id}/access-log` (Q14). Patients see their household's log at `GET /me/access-log/{patientId}`.
- **Correction**: record the decision with `POST /audit/data-requests {kind:"correction", ...}`; corrections to clinical facts are made by clinicians (status `entered_in_error` + new row), never by editing history.
- **Erasure**: `POST /audit/data-requests {kind:"erasure"}` anonymises contact points, conversations and messages. 🔒 Clinical records the hospital must legally keep are **not** deleted; the decision is recorded in the audit row.
- **Break-glass review**: `GET /audit/breakglass?status=pending` lists grants without a review; `POST /audit/breakglass/{id}/review` records the outcome.
- **Consent ledger**: `GET /audit/consents/{contactPointId}`.
