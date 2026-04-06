# Cushion Gov — Incident Response Playbook

**Version 1.0 | April 2026**
**Compliance:** NIST 800-61, Georgia O.C.G.A. § 10-1-912

---

## 1. Severity Levels

| Level | Description | Response Time | Example |
|-------|-------------|---------------|---------|
| P1 — Critical | Data breach, full system compromise, unauthorized access to intake records | Contain within 1 hour | Database breach, credential theft, API key exposure |
| P2 — High | Partial outage, security vulnerability discovered, suspicious access patterns | Contain within 4 hours | AI provider failure, rate limiter bypass, injection attempt |
| P3 — Medium | Degraded performance, non-critical vulnerability, isolated errors | Address within 24 hours | High error rate, session store issues, slow queries |
| P4 — Low | Minor issues, informational alerts | Address within 72 hours | Log anomalies, non-critical config issues |

---

## 2. Incident Discovery & Alerting

### Automated Detection
- **Failed logins**: >10 failed attempts from a single IP within 15 minutes
- **Injection attempts**: Any blocked injection pattern logged by `injectionGuard.js`
- **AI provider failover**: Circuit breaker state changes logged by `aiProvider.js`
- **Session anomalies**: Unusual session creation rates (>50/minute)
- **Database errors**: Transient errors exceeding retry threshold

### Alert Channels
- Primary: On-call engineer (PagerDuty / phone)
- Secondary: Engineering Slack channel
- Escalation: County IT security officer (P1 only)

### Who Monitors
- Engineering team: System health, AI provider status, error rates
- County IT: Network access logs, firewall alerts
- Compliance officer: Audit log reviews (weekly)

---

## 3. Containment Procedures

### P1 — Critical (First Hour)

1. **Isolate**: Take affected systems offline (kiosk terminals, API server)
2. **Snapshot**: Capture current system state (disk, memory, logs) before any changes
3. **Revoke**: Rotate all API keys (Anthropic, OpenAI, JWT_SECRET)
4. **Notify**: Call county IT security officer within 30 minutes
5. **Preserve**: Export audit logs from past 30 days to read-only storage

### P2 — High (First 4 Hours)

1. **Investigate**: Review audit logs and application logs for the alert timeframe
2. **Mitigate**: Apply temporary fix (IP block, rate limit adjustment, feature flag)
3. **Notify**: Email county IT security officer
4. **Document**: Create incident ticket with timeline and findings

### P3/P4 — Medium/Low

1. **Investigate**: Review logs during next business day
2. **Fix**: Apply patch in next release cycle
3. **Document**: Log in incident tracker

---

## 4. Assessment & Investigation

### Evidence Preservation
- Export all application logs from incident window (±24 hours)
- Take database snapshot (point-in-time recovery)
- Save audit log entries related to affected intakes
- Capture network access logs from county firewall
- Store all evidence on read-only, encrypted storage

### Scope Determination
Answer these questions within 24 hours:

1. **What data was accessed?** (intake records, conversation logs, audit logs)
2. **Time window?** (when did unauthorized access start and end)
3. **How many applicants affected?** (count intakes in the window)
4. **Was data modified?** (compare against backup)
5. **Root cause?** (brute force, injection, misconfiguration, credential theft)

### Data Sensitivity Assessment
Cushion Gov collects **minimal PII by design**:
- First name + last initial (e.g., "Maria G.")
- Household financial data (income, expenses, shelter costs)
- NOT collected: SSN, DOB, full address, phone, email

Even in a full breach, exposure is limited to household-level financial data.

---

## 5. Notification Procedures

### Timeline
- **Internal notification**: Within 2 hours of confirmed P1 incident
- **County notification**: Within 4 hours of confirmed P1 incident
- **Affected individuals**: Within 24 hours per Georgia law (O.C.G.A. § 10-1-912)
- **Georgia Attorney General**: If >500 GA residents affected

### Internal Notification List
1. Engineering lead
2. Compliance officer
3. CEO / Product owner
4. County DFCS IT security officer
5. County DFCS director (P1 only)

### Affected Individual Notification Template

```
Dear [Applicant First Name],

On [date], our SNAP intake assistance system detected [brief incident description].

WHAT DATA MAY HAVE BEEN AFFECTED:
- Your first name and last initial
- Household size and composition
- Income and expense information

NOT AFFECTED (we do not collect these):
- Social Security Number
- Date of birth
- Home address
- Phone number or email

WHAT WE ARE DOING:
- System has been secured and the issue resolved
- All access logs have been reviewed
- Security measures have been strengthened

WHAT YOU SHOULD DO:
- No immediate action is required from you
- Monitor your financial accounts for unusual activity
- Contact [County DFCS hotline] if you have questions

Contact: [County compliance officer email/phone]
```

### Regulatory Notifications
- **Georgia AG**: Required if >500 residents affected
  - Contact: Georgia Attorney General Consumer Protection Division
  - Method: Written notification
- **Credit bureaus**: Only if SSNs exposed (unlikely — system does not collect SSNs)

---

## 6. Remediation

### Immediate (Within 72 Hours)
- [ ] Patch the vulnerability
- [ ] Rotate all API keys and secrets
- [ ] Reset all caseworker passwords
- [ ] Re-enable system with enhanced monitoring
- [ ] Notify affected users that system is restored

### Short-Term (Within 2 Weeks)
- [ ] Conduct root cause analysis
- [ ] Implement additional security controls to prevent recurrence
- [ ] Update security testing checklist
- [ ] Brief county IT on findings and changes

### Long-Term
- [ ] Update this playbook based on lessons learned
- [ ] Schedule penetration test if not already planned
- [ ] Review and update data governance policies

---

## 7. Post-Incident Review

### Timeline
- Conduct within 2 weeks of incident resolution
- Attendees: Engineering, compliance, county IT (for P1/P2)

### Review Agenda
1. Timeline of events (detection → containment → resolution)
2. Root cause analysis
3. What worked well
4. What needs improvement
5. Action items with owners and deadlines

### Metrics to Track
- Time to detect (TTD)
- Time to contain (TTC)
- Time to resolve (TTR)
- Time to notify (TTN)
- Number of applicants affected
- Data exposure scope

---

## 8. Incident Scenarios

### Scenario A: Brute Force Login Attack
- **Detection**: Rate limiter blocks >10 failed logins from single IP
- **Containment**: IP added to block list
- **Assessment**: Verify no successful logins from attacker IP
- **Notification**: None required if no data accessed
- **Remediation**: Monitor for distributed brute force patterns

### Scenario B: Prompt Injection Attempt
- **Detection**: Injection guard blocks and logs malicious payload
- **Containment**: Rate limit the source IP
- **Assessment**: Verify no data exfiltrated; check AI response logs
- **Notification**: None required if blocked before processing
- **Remediation**: Add new injection pattern to guard if novel

### Scenario C: API Key Compromise
- **Detection**: Unusual API usage patterns or cost spike
- **Containment**: Rotate API key immediately
- **Assessment**: Review API usage logs for unauthorized calls
- **Notification**: County IT if county-funded API key
- **Remediation**: Migrate to secrets manager; implement key rotation schedule

### Scenario D: Database Breach (P1)
- **Detection**: Unauthorized database access detected in logs
- **Containment**: Take database offline; revoke all credentials
- **Assessment**: Determine scope (which tables, which records, time window)
- **Notification**: All affected applicants within 24 hours; county director; GA AG if >500
- **Remediation**: Restore from clean backup; enable encryption at rest; implement DB activity monitoring

---

## 9. Regular Drills

| Drill | Frequency | Scope |
|-------|-----------|-------|
| Tabletop exercise | Quarterly | Walk through a scenario with the team |
| Backup restoration test | Quarterly | Restore from backup to test environment |
| Full incident simulation | Annually | End-to-end drill with county IT |
| Key rotation drill | Semi-annually | Practice API key and JWT secret rotation |

---

## 10. Contact Information

| Role | Contact | Method |
|------|---------|--------|
| Engineering Lead | [TBD] | Phone + Slack |
| Compliance Officer | [TBD] | Phone + Email |
| County IT Security | [TBD] | Phone |
| County DFCS Director | [TBD] | Phone (P1 only) |
| Georgia AG Consumer Protection | (404) 651-8600 | Written notification |

---

*This playbook is reviewed and updated quarterly or after any P1/P2 incident.*
