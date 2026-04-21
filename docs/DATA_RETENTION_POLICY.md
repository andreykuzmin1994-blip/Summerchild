# Cushion Gov — Data Retention & Deletion Policy

**Version 1.0 | April 2026**
**Compliance:** 7 CFR 272.1 (SNAP records), 7 CFR 275.12 (QC reviews), O.C.G.A. § 10-1-912

---

## 1. Data Classification

| Data Category | Sensitivity | Contains PII? | Examples |
|--------------|-------------|---------------|----------|
| Intake Records | Confidential | Minimal (first name + initial) | Applicant display name, household size, income, expenses |
| Conversation Logs | Confidential | Minimal | AI chat transcripts (PII-stripped) |
| Audit Logs | Internal | No | System events, caseworker actions, timestamps |
| Session Data | Transient | Minimal | Active intake state, conversation history |
| Caseworker Accounts | Confidential | Yes (email) | Staff names, emails, hashed passwords |
| System Configuration | Internal | No | SNAP rules, deduction tables, county config |

---

## 2. Retention Schedules

| Data Type | Retention Period | Justification | Deletion Method |
|-----------|-----------------|---------------|-----------------|
| **Intake Records** (completed/reviewed) | 7 years after case closure | 7 CFR 275.12 — SNAP QC review retention | Automated purge job |
| **Intake Records** (abandoned/timed out) | 90 days | No case action taken; data minimization | Automated purge job |
| **Conversation Logs** | 90 days after intake review | Operational use only; not needed after caseworker review | Automated purge job |
| **Audit Logs** | 7 years minimum | Regulatory compliance; CJIS 5.4.1.2 | NEVER deleted; archived after 7 years |
| **Session Data** | 30 minutes (TTL) | Automatically expires via session store TTL | Auto-expiration |
| **Caseworker Accounts** (active) | Duration of employment | Operational need | Deactivated (soft delete) on departure |
| **Caseworker Accounts** (deactivated) | 3 years after deactivation | Audit trail integrity | Hard delete after 3 years |
| **Database Backups** | 30 days (snapshots), 90 days (exports) | DR recovery window | Auto-rotation |

---

## 3. Deletion Procedures

### Automated Purge Jobs

Implementation: `src/services/retentionScheduler.js` (daily at `RETENTION_CRON_EXPRESSION`, default `0 2 * * * UTC`). Governed by `RETENTION_ENABLED` and `RETENTION_DRY_RUN` env vars. All runs emit `DATA_RETENTION_STARTED` / `DATA_RETENTION_POLICY_EXECUTED` (with `dryRun` flag and counts) / `DATA_RETENTION_COMPLETED` audit events (fail-closed: if the audit write fails, the deletion is rolled back in the same transaction).

**Conversation Log Cleanup** — IMPLEMENTED. Policy: delete rows whose parent intake is `REVIEWED` and whose *last* `IntakeReview.reviewedAt` is older than `CONVERSATION_LOG_RETENTION_DAYS` (default 90). The last-review check (rather than `intake.updated_at`) means re-opening a reviewed case resets the clock correctly.

```js
// Logical equivalent (see retentionJob.js:findConversationLogCandidates for the Prisma call)
SELECT c.*
FROM conversation_logs c
JOIN intakes i ON c.intake_id = i.id
WHERE i.status = 'REVIEWED'
  AND NOT EXISTS (
    SELECT 1 FROM intake_reviews r
    WHERE r.intake_id = i.id
      AND r.reviewed_at >= NOW() - INTERVAL '90 days'
  );
```

**Abandoned Intake Cleanup** — IMPLEMENTED. Rule: `status IN ('ABANDONED', 'TIMED_OUT') AND createdAt < cutoff AND caseworkerId IS NULL AND NOT EXISTS any IntakeReview`. **IN_PROGRESS is NOT purged** — a stuck session is not an abandoned one; a separate (not yet built) state-transition cron is responsible for moving idle IN_PROGRESS rows to TIMED_OUT before this job sees them. Implementation: `runAbandonedIntakePolicy` + `purgeOneIntakeInTx` in `src/services/retentionJob.js`. Explicit ordered child delete (no FK cascade) — AuditLog rows survive with `intakeId` set to NULL so the 7-year audit evidence is preserved per 7 CFR 275.12.

**Caseworker Account Cleanup** — IMPLEMENTED as **soft-delete** (NOT hard-delete — `IntakeReview.caseworkerId` is non-nullable and AU-10 non-repudiation requires the row to survive). Rule: `deactivatedAt < cutoff AND purgedAt IS NULL`. Cutoff defaults to `CASEWORKER_PURGE_RETENTION_DAYS` = 1095 (3 years); floor is 730 per NIST IA-4 account identifier reuse. Purge action overwrites `name`, `email`, `password` with non-reversible tombstones and sets `purgedAt = NOW()`. The `password` tombstone is intentionally NOT bcrypt-shaped so `bcrypt.compare` returns `false`; the application-layer `purgedAt IS NULL` filter in `src/middleware/auth.js` and `src/routes/caseworker.js` admin routes is defense-in-depth.

### Manual Deletion (Authorized Only)

Manual deletion requires:
1. Written request from county compliance officer
2. Approval from system administrator
3. Audit log entry documenting: who requested, who approved, what was deleted, why
4. Soft delete (mark `deleted_at` timestamp) preferred; hard delete only if required by law

### Deletion Logging

Every deletion is logged to the immutable audit trail:
```javascript
await logAuditEvent({
  type: "DATA_DELETED",
  actorType: ACTORS.SYSTEM, // or ACTORS.ADMIN for manual
  actorId: "retention-job",
  details: {
    policy: "90-day abandoned intake cleanup",
    recordsDeleted: count,
    deletedBefore: cutoffDate.toISOString(),
  },
});
```

---

## 4. Data Minimization Principles

Cushion Gov follows data minimization by design:

1. **No SSN collection** — applicant identity verified at caseworker interview
2. **No full names** — only first name + last initial (e.g., "Maria G.")
3. **No addresses** — shelter costs collected without location
4. **No contact info** — no phone, email, or mailing address
5. **PII safety net** — `piiStripper.js` redacts accidentally-typed PII before AI processing
6. **Anthropic zero-retention** — AI API inputs/outputs are not stored by Anthropic

---

## 5. Right to Deletion

### Applicant Requests
If an applicant requests deletion of their intake data:
1. Verify identity through county DFCS office (in-person or phone with verification questions)
2. Locate intake by queue number and approximate date
3. Mark intake as `DELETED` (soft delete)
4. Retain audit log entries (cannot be deleted for compliance)
5. Confirm deletion to applicant within 5 business days

### County Requests
If a county requests bulk deletion (e.g., contract termination):
1. Export all county data using the data portability tool
2. Deliver export to county IT on encrypted storage
3. Delete all county records from production database
4. Retain audit logs for minimum retention period
5. Provide written confirmation of deletion

---

## 6. Encryption at Rest

All retained data must be encrypted at rest:

| Storage | Encryption | Key Management |
|---------|------------|----------------|
| PostgreSQL database | AES-256 | AWS KMS / county-managed keys |
| Database backups | AES-256 | Same as database |
| Log archives (S3/Glacier) | AES-256 | AWS KMS |
| Redis session store | TLS in-transit; encrypted volume | AWS ElastiCache encryption |

### Database Connection Security
```
DATABASE_URL="postgresql://user:password@host:5432/cushion_gov?sslmode=require"
```
- TLS 1.2+ required for all database connections
- Certificate validation enabled (`sslmode=require` or `verify-full`)

---

## 7. Compliance Mapping

| Requirement | Standard | Status |
|-------------|----------|--------|
| SNAP record retention (7 years) | 7 CFR 275.12 | Implemented |
| Data breach notification (24 hours) | O.C.G.A. § 10-1-912 | Documented (see Incident Response Playbook) |
| Audit log immutability | CJIS 5.4.1.2 | Implemented (DB permissions restrict UPDATE/DELETE) |
| Data minimization | Privacy by design | Implemented (no PII collection) |
| Encryption at rest | NIST 800-53 SC-28 | Required for production deployment |
| Key management | NIST 800-53 SC-12 | Requires secrets manager in production |

---

## 8. Annual Review

This policy is reviewed annually or when:
- SNAP regulations change
- Georgia data protection laws are updated
- A data breach occurs
- County requirements change

**Next review date:** April 2027

---

*Owner: Compliance Officer*
*Approved by: [County DFCS Director]*
