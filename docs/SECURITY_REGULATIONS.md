# Security Regulations — Cushion Gov

Authoritative list of the security and privacy regimes Cushion Gov must comply with, the current posture of each control family, and the outstanding remediation backlog.

**This document is the source of truth for compliance scope.** Any change that touches authentication, authorization, cryptography, logging, PII handling, data retention, network boundaries, dependency management, or incident response MUST be checked against this file before merging, and this file MUST be updated in the same commit if the posture changes.

Last reviewed: 2026-04-20
Owner: Security / platform engineering
Review cadence: on every security-relevant PR, and at minimum quarterly

---

## 1. Regulatory Scope

Cushion Gov handles SNAP applicant PII, income, and household data on behalf of state and county agencies. The following regimes apply:

| Regime | Why it applies | Baseline |
|---|---|---|
| **NIST SP 800-53 Rev. 5** | Federal baseline referenced by FedRAMP and state SNAP systems. | Moderate |
| **NIST SP 800-171 Rev. 3** | Required when processing Controlled Unclassified Information (CUI) for federal or state agencies. | All 110 requirements |
| **FedRAMP Moderate** | Any SaaS serving federal/state benefits programs must demonstrate FedRAMP-equivalent controls. | Moderate baseline |
| **FISMA** | Applies through the state agencies we contract with. | Moderate |
| **IRS Publication 1075** | Triggers if tax-return data (e.g., AGI verification) is ever handled. | Aspirational / future |
| **7 CFR Part 272 / FNS 101** | USDA FNS SNAP confidentiality and safeguarding of applicant data. | Mandatory |
| **State privacy laws** | CCPA/CPRA, Virginia CDPA, etc., depending on county deployment. | Per jurisdiction |
| **CIS Controls v8 IG1** | Free self-assessment framework; used as a floor for county IT questionnaires. | IG1 |

Classification of data we hold: **CUI / Moderate confidentiality, Moderate integrity, Moderate availability.**

---

## 2. Control Family Posture

Legend: **OK** = implemented and tested · **PARTIAL** = implemented but gaps remain · **TODO** = not implemented · **OPS** = covered by deployment/ops, not application code.

### Access Control (AC) — 800-53 AC / 800-171 §3.1

| Control | Status | Evidence / Gap |
|---|---|---|
| AC-2 Account management | PARTIAL | RBAC + SoD in `src/routes/caseworker.js:45-49`; soft-delete via `deactivatedAt`. Mid-session token revocation on deactivation: **TODO**. |
| AC-3 Least privilege | OK | `requireVerifiedAuth` + `requireRole` in `src/middleware/auth.js:138-181`; mandatory `countyId` scoping on intake queries. |
| AC-5 Separation of duties | OK | Admin-only role escalation and stats endpoints. |
| AC-6 Least privilege per role | OK | AUDITOR read-only role in `prisma/schema.prisma:241-246`. |
| AC-7 Unsuccessful logon attempts | **TODO** | No `loginFailedCount` / `lockedUntil` on Caseworker; login endpoint `src/routes/caseworker.js:54-99` never increments a counter. |
| AC-11 Session lock / idle timeout | **TODO** | Only an 8h absolute token TTL; no idle timeout. |
| AC-12 Session termination | **TODO** | No concurrent session cap; `src/services/sessionStore.js` has no per-user cardinality check. |
| AC-17 Remote access | OPS | TLS + IP allowlist via `src/middleware/ipAllowlist.js`. Deployment-enforced VPN ranges. |

### Identification & Authentication (IA) — 800-53 IA / 800-171 §3.5

| Control | Status | Evidence / Gap |
|---|---|---|
| IA-2(1) MFA for privileged accounts | **TODO** | JWT + staff PIN only. No TOTP/FIDO2. Required by 800-171 §3.5.3. |
| IA-2(2) MFA for non-privileged | **TODO** | Same. |
| IA-4 Identifier management | OK | Unique email constraint; county-scoped IDs. |
| IA-5(1) Password-based auth | OK | bcrypt cost 12 (`src/middleware/auth.js:105`); ≥12 chars + complexity (`src/routes/caseworker.js:23-35`); common-password blocklist. |
| IA-5 Reset flow | PARTIAL | Admin can reset password directly; no email OTP confirmation (`src/routes/caseworker.js:515-550`). |
| IA-11 Re-authentication | **TODO** | No re-auth required for sensitive actions (role changes, exports). |

### Audit & Accountability (AU) — 800-53 AU / 800-171 §3.3

| Control | Status | Evidence / Gap |
|---|---|---|
| AU-2 Audit events | OK | 15+ event types in `src/services/auditLogger.js`. |
| AU-3 Content of audit records | OK | Actor, IP, timestamp, correlation ID logged. |
| AU-6 Audit review / tamper | OK | `verifyAuditLogImmutability()` checks DB perms; audit table DELETE revoked at deploy time (OPS). |
| AU-5 Response to audit failures | **TODO** | No alerting when log writes fail; no PagerDuty/CloudWatch integration. |
| AU-8 Time stamps | OK app-side | ISO 8601 from server clock. NTP sync is **OPS**. |
| AU-11 Retention | PARTIAL | `CONVERSATION_LOG_RETENTION_DAYS=90` env-configurable; no in-app enforcement job. |
| AU-12 Audit generation | OK | Structured JSON logger with correlation IDs. |

### System & Communications Protection (SC) — 800-53 SC / 800-171 §3.13

| Control | Status | Evidence / Gap |
|---|---|---|
| SC-7 Boundary protection | OK | Helmet + strict CSP + HSTS (`src/app.js:32-47`); CORS HTTPS-only in prod; CIDR allowlist. |
| SC-8 Transmission confidentiality | OPS | TLS required at the edge (nginx/ALB/CloudFront). Cookies Secure + httpOnly + SameSite=strict. |
| SC-12 Crypto key establishment | PARTIAL | Key ring in `src/lib/fieldCrypto.js` supports rotation; production rejects dev keys. KMS envelope encryption: **TODO**. |
| SC-13 Crypto use | OK | AES-256-GCM with AAD; HS256 JWT; bcrypt cost 12. |
| SC-28 Protection at rest | PARTIAL | `ConversationLog.content` encrypted. Other PII relies on DB-level encryption (OPS) and field minimization. |
| SC-23 Session authenticity | OK | SameSite=strict cookies + CSRF tokens. |

### System & Information Integrity (SI) — 800-53 SI / 800-171 §3.14

| Control | Status | Evidence / Gap |
|---|---|---|
| SI-2 Flaw remediation | **TODO** | No `npm audit` gate in CI; no Dependabot; no SBOM. |
| SI-3 Malicious code protection | OK (app layer) | Multi-layer prompt-injection defense in `src/middleware/injectionGuard.js`. |
| SI-4 System monitoring | PARTIAL | Events logged, but no alerting/anomaly detection. |
| SI-7 Software / info integrity | OK | Output guardrails (`src/middleware/outputGuardrails.js`), PII scanner on AI responses, exfiltration blocker. |
| SI-10 Information input validation | OK | `dataValidator.js`, intake form validators, body-size caps. |
| SI-11 Error handling | OK | Generic error responses; no stack traces in prod. |

### Configuration Management (CM) — 800-53 CM / 800-171 §3.4

| Control | Status | Evidence / Gap |
|---|---|---|
| CM-2 Baseline configuration | OK | Startup validation of all secrets/keys; production refuses weak defaults. |
| CM-6 Configuration settings | OK | Helmet/CSP/HSTS baseline; rate limiters per endpoint. |
| CM-7 Least functionality | OK | 10KB JSON body cap; health endpoint gated. |
| CM-8 System component inventory | **TODO** | No SBOM generated. |

### Risk Assessment (RA) — 800-53 RA / 800-171 §3.11

| Control | Status | Evidence / Gap |
|---|---|---|
| RA-3 Risk assessment | **TODO** | No documented risk register. |
| RA-5 Vulnerability scanning | **TODO** | No scheduled dependency or container scans. |

### Incident Response (IR) — 800-53 IR / 800-171 §3.6

| Control | Status | Evidence / Gap |
|---|---|---|
| IR-4 Incident handling | PARTIAL | `docs/INCIDENT_RESPONSE_PLAYBOOK.md` exists; not wired to code-level alerts. |
| IR-6 Incident reporting | **TODO** | No automated paging on injection/CSRF spikes. |

### Media Protection (MP) — 800-53 MP / 800-171 §3.8

| Control | Status | Evidence / Gap |
|---|---|---|
| MP-6 Media sanitization | PARTIAL | Session TTL cleanup in `src/services/sessionStore.js`; no explicit zeroization before free. |

### Contingency Planning (CP) — 800-53 CP / 800-171 §3.11

| Control | Status | Evidence / Gap |
|---|---|---|
| CP-9 System backup | OPS / PARTIAL | `docs/BACKUP_AND_RECOVERY_PLAN.md` defines policy; no in-app backup-health check. |
| CP-10 Recovery | OPS | Deployment-level. |

### Security Assessment (CA) — 800-53 CA / 800-171 §3.12

| Control | Status | Evidence / Gap |
|---|---|---|
| CA-2 Control assessments | PARTIAL | Vitest covers injection/PII/authz; no scheduled self-assessment run. |
| CA-7 Continuous monitoring | **TODO** | No dashboard / scheduled control self-test. |
| CA-8 Penetration testing | **TODO** | No formal pen-test cadence documented. |

### System & Services Acquisition (SA) — 800-53 SA

| Control | Status | Evidence / Gap |
|---|---|---|
| SA-10 Developer config mgmt | OK | Lockfile committed; branch protection via harness. |
| SA-11 Developer testing | PARTIAL | Security-focused tests exist; coverage thresholds not enforced in CI. |

### Physical / Personnel (PE / PS)

OPS. Not addressed by this codebase.

---

## 3. Open Remediation Backlog

Ordered by priority. Each item should be delivered as its own PR on a `claude/<topic>-<id>` branch using the Coder/Reviewer/Implementer stack in CLAUDE.md.

1. **Account lockout (AC-7, IA-5)** — Add `loginFailedCount` + `lockedUntil` to Caseworker; lock after 5 failures × 30 min; reset on success; negative test in `tests/`.
2. **Concurrent session cap + idle timeout (AC-11, AC-12)** — Per-user max-1 active session; 30-min idle; revoke sessions on deactivation.
3. **MFA for caseworker accounts (IA-2(1), IA-2(2))** — TOTP via `speakeasy`, secret encrypted with `fieldCrypto`; enrollment + recovery codes; gate privileged actions.
4. **Password-reset email OTP (IA-5)** — Async email OTP before `hashPassword()` in admin reset flow.
5. **`npm audit` + Dependabot in CI (SI-2, RA-5, CM-8)** — Fail build on high/critical; generate SBOM (CycloneDX); weekly dep-update PRs.
6. **Audit-log retention enforcement (AU-11)** — Scheduled job prunes beyond `CONVERSATION_LOG_RETENTION_DAYS`; emits audit event on prune.
7. **Alerting hook interface (AU-5, IR-6, SI-4)** — Pluggable sink (PagerDuty/CloudWatch) for INJECTION_BLOCKED/CSRF_BLOCKED/LOGIN_FAILED spikes.
8. **KMS envelope encryption (SC-12, SC-28)** — Replace static env keys with KMS-wrapped DEKs; rotation without redeploy.
9. **Session memory zeroization (MP-6)** — Overwrite session objects before cleanup.
10. **Continuous self-assessment (CA-7)** — Scripted run that tests each implemented control and emits a JSON report to `docs/compliance/`.
11. **Risk register + pen-test cadence (RA-3, CA-8)** — Markdown risk register; documented annual pen-test.
12. **Re-authentication for sensitive actions (IA-11)** — Require password re-entry for role change, data export, admin reset.

---

## 4. Review Process

- Every PR that touches any file listed in the Evidence column above MUST:
  1. Confirm the control posture in this doc is still accurate.
  2. Update the Status/Evidence rows in the same commit if it changed.
  3. If a remediation item in §3 is delivered, move it out of the backlog and flip the matching row to OK.
- Quarterly: full walk-through of §2; archive the previous version under `docs/compliance/history/` before editing.
- Any new regulatory regime that applies (new state, new data type) must be added to §1 before code lands.

---

## 5. References

- NIST SP 800-53 Rev. 5: https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
- NIST SP 800-171 Rev. 3: https://csrc.nist.gov/pubs/sp/800/171/r3/final
- FedRAMP Moderate Baseline: https://www.fedramp.gov/documents-templates/
- CIS Controls v8 IG1: https://www.cisecurity.org/controls/v8
- Related internal docs: `SECURITY_AND_DATA_GOVERNANCE.md`, `DATA_RETENTION_POLICY.md`, `INCIDENT_RESPONSE_PLAYBOOK.md`, `BACKUP_AND_RECOVERY_PLAN.md`, `security-testing-checklist.md`.
