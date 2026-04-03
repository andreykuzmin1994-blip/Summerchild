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

The following scheduled jobs run daily at 02:00 UTC:

**Abandoned Intake Cleanup** (90-day retention):
```sql
-- Intakes that were never completed, older than 90 days
DELETE FROM intakes
WHERE status IN ('IN_PROGRESS', 'ABANDONED', 'TIMED_OUT')
  AND created_at < NOW() - INTERVAL '90 days';
```

**Conversation Log Cleanup** (90-day post-review retention):
```sql
-- Conversation logs for reviewed intakes older than 90 days
DELETE FROM conversation_logs
WHERE intake_id IN (
  SELECT id FROM intakes
  WHERE status = 'REVIEWED'
    AND updated_at < NOW() - INTERVAL '90 days'
);
```

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
