# Cushion Gov — Backup & Recovery Plan

**Version 1.0 | April 2026**
**Compliance:** NIST 800-53 CP-9, CP-10

---

## 1. Recovery Objectives

| Metric | Target | Description |
|--------|--------|-------------|
| **RTO** (Recovery Time Objective) | 4 hours | Maximum acceptable downtime |
| **RPO** (Recovery Point Objective) | 6 hours | Maximum acceptable data loss |

### Impact Analysis
If the database fails at 14:00 UTC:
- System restored by 18:00 UTC (4 hours max downtime)
- Data loss limited to intakes completed between last backup and failure
- Active kiosk sessions will be lost (applicants must restart intake)

---

## 2. Backup Strategy

### Database Backups

| Component | Frequency | Retention | Location | Encryption |
|-----------|-----------|-----------|----------|------------|
| Full database snapshot | Every 6 hours | 30 days rolling | Primary region + secondary region | AES-256 (KMS) |
| Transaction logs (WAL) | Continuous | 7 days | Primary region | AES-256 (KMS) |
| Daily export (SQL dump) | Daily at 02:00 UTC | 90 days | S3 / county storage | AES-256 |

### AWS RDS Configuration (Recommended)
```
Automated Backups: Enabled
Backup Retention: 30 days
Backup Window: 02:00-03:00 UTC (low-traffic period)
Multi-AZ: Enabled (synchronous replica in different AZ)
Cross-Region Snapshots: Daily to standby region
Storage Encryption: Enabled (AWS KMS customer-managed key)
```

### Application Logs
- Stream to CloudWatch / log aggregation service
- Retention: 90 days in hot storage, 1 year in cold storage (S3 Glacier)
- Encryption: AES-256 at rest

### Audit Logs
- Retained in database (immutable — no DELETE/UPDATE permitted)
- Minimum retention: 7 years per SNAP QC requirements (7 CFR 275.12)
- Backed up with database snapshots

---

## 3. Recovery Procedures

### Scenario A: Automatic Failover (Multi-AZ)
If the primary database instance fails and Multi-AZ is enabled:
1. RDS automatically promotes standby replica (~60 seconds)
2. Application reconnects automatically via DNS endpoint
3. No manual intervention required
4. Verify: Check `/api/health` endpoint returns `database: ok`

### Scenario B: Manual Restore from Snapshot
If both primary and standby are lost:

1. **Assess**: Confirm both instances are unrecoverable
2. **Select snapshot**: Choose most recent snapshot (check timestamp)
3. **Restore**:
   ```bash
   aws rds restore-db-instance-from-db-snapshot \
     --db-instance-identifier cushion-gov-restored \
     --db-snapshot-identifier cushion-gov-2026-04-03-02-00 \
     --db-instance-class db.t3.medium \
     --multi-az \
     --storage-encrypted
   ```
4. **Wait**: Instance restoration takes 5-15 minutes
5. **Update DNS**: Point application DATABASE_URL to new instance endpoint
6. **Verify data**: Run integrity checks
   ```sql
   SELECT COUNT(*) FROM intakes;
   SELECT COUNT(*) FROM audit_logs;
   SELECT MAX(created_at) FROM intakes;  -- Should be close to backup time
   ```
7. **Notify**: Inform county IT and caseworkers of any data gap

### Scenario C: Point-in-Time Recovery
If data corruption is detected (e.g., bad migration, accidental deletion):

1. **Identify**: Determine the exact time before corruption
2. **Restore**:
   ```bash
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier cushion-gov-prod \
     --target-db-instance-identifier cushion-gov-pitr \
     --restore-time 2026-04-03T12:00:00Z
   ```
3. **Compare**: Verify restored data matches expected state
4. **Switch**: Update application to use restored instance

---

## 4. User Communication During Outage

| Outage Duration | Action |
|-----------------|--------|
| < 15 minutes | No notification needed |
| 15-60 minutes | Notify county IT; display "temporarily unavailable" on kiosk |
| > 60 minutes | Notify caseworkers and county director; post estimated restoration time |

### Kiosk Message During Outage
```
We're experiencing a brief technical issue.
Please speak with the front desk staff for assistance.
We apologize for the inconvenience.
```

---

## 5. Backup Testing

| Test | Frequency | Procedure |
|------|-----------|-----------|
| Snapshot restoration | Quarterly | Restore 1-week-old backup to test DB; verify all tables and row counts |
| Point-in-time recovery | Semi-annually | Restore to specific timestamp; verify data integrity |
| Full DR simulation | Annually | Simulate primary region failure; activate secondary region |
| Data export verification | Monthly | Download SQL dump; import to local DB; run integrity checks |

### Quarterly Backup Test Checklist
- [ ] Select backup snapshot from 7 days ago
- [ ] Restore to test environment
- [ ] Verify table counts match expected values
- [ ] Verify most recent intake record matches known data
- [ ] Verify audit logs are intact and sequential
- [ ] Document restoration time (target: < 15 minutes)
- [ ] Record any issues in the backup testing log

---

## 6. Data Export for County Portability

Counties own their data. An export tool is available for data portability:

```bash
# Export all intakes for a county (JSON format)
node scripts/export-county-data.js --county=dekalb-ga-001 --output=export.json

# Export audit logs
node scripts/export-county-data.js --county=dekalb-ga-001 --type=audit --output=audit.json
```

Export includes: intakes, applicants, household members, income sources, shelter expenses, deductions, document checklists, conversation logs, audit logs.

---

## 7. Responsibilities

| Role | Responsibility |
|------|----------------|
| Engineering Lead | Configure and maintain backup infrastructure |
| DevOps / SRE | Monitor backup jobs; run quarterly restore tests |
| Compliance Officer | Verify backup retention meets SNAP requirements |
| County IT | Approve backup locations; hold encryption keys (if county-managed) |

---

*This plan is reviewed quarterly and after any data loss incident.*
