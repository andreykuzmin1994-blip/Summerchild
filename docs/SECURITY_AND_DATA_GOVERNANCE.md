# Cushion Gov — Security & Data Governance

**Version 1.0 | April 2026**
**For: County Government IT Review**

---

## 1. Data Flow Overview

```
+----------------------------------------------------------------------+
|                     COUNTY NETWORK (Your Control)                     |
|                                                                       |
|  +-----------+     +-------------------+     +-------------------+    |
|  | Applicant |---->| Cushion Gov       |---->| County PostgreSQL |    |
|  | on Tablet |     | Application       |     | Database          |    |
|  | (Kiosk)   |<----| Server            |<----| (All PII here)    |    |
|  +-----------+     +-------------------+     +-------------------+    |
|                           |      ^                                    |
|                           |      |                                    |
|                    PII    |      |  AI Response                       |
|                  STRIPPED |      |  (no PII)                          |
|                           |      |                                    |
+---------------------------|------|------------------------------------+
                            |      |
                    TLS 1.2+|      | TLS 1.2+
                            v      |
                    +-------------------+
                    | Anthropic Claude  |
                    | API               |
                    | (No PII received) |
                    | (Zero retention)  |
                    +-------------------+
```

### What Leaves the County Network

Only de-identified conversational text is sent to Anthropic's Claude API:

| Data Type | Sent to AI? | Example |
|-----------|-------------|---------|
| Full SSN | NEVER collected | Not stored anywhere |
| SSN Last 4 | NO | Stored in county DB only |
| Real Names | NO — replaced with placeholders | "John Smith" becomes "Applicant A" |
| Phone Numbers | NO — stripped before AI | Stored in county DB only |
| Email Addresses | NO — stripped before AI | Stored in county DB only |
| Street Addresses | NO — stripped before AI | Stored in county DB only |
| Dates of Birth | PARTIAL — month/year only | Day is redacted |
| Income Amounts | YES (no PII) | "$1,147.50 biweekly" (needed for calculations) |
| Employer Names | YES (de-contextualized) | Needed for income categorization |
| Household Size | YES (no PII) | "4 people" (needed for eligibility) |
| Expense Amounts | YES (no PII) | "$950 rent" (needed for deductions) |

### PII Protection Pipeline

1. Applicant types message containing PII
2. **PII Stripper** intercepts: replaces names, SSNs, phones, emails, addresses with placeholders
3. De-identified message sent to Claude API over TLS 1.2+
4. Claude returns response (contains no PII — it never received any)
5. **PII Restorer** re-inserts original names/details for display to applicant
6. Full conversation (with PII) stored in county database only

### Anthropic API Data Policy

- Anthropic's API has a **zero-retention policy**: inputs and outputs are not stored after the API response is returned
- API data is **never used for model training**
- See: Anthropic's Enterprise API Terms of Service

---

## 2. Data Ownership & Residency

### County Owns All Data

- All intake data, applicant PII, conversation logs, and audit trails are **owned by the county**
- Cushion Gov is a software tool — it processes data on behalf of the county
- The county retains full rights to export, delete, or transfer all data at any time

### Deployment Options

| Option | Data Location | County Control | Recommended For |
|--------|--------------|----------------|-----------------|
| **On-Premises** | County data center | Full control | Counties with existing server infrastructure |
| **County Cloud Tenant** | County's Azure Gov / AWS GovCloud | County-managed cloud | Counties with cloud-first policy |
| **Managed Hosting** | Cushion-operated, county-isolated tenant | Contractual controls | Counties preferring SaaS model |

In all options:
- Each county's data is logically isolated (enforced in code via `countyId` on every query)
- Database credentials are county-controlled
- Cushion staff have no standing access to production data

### Data Portability

Counties can export all their data at any time via:
- Admin API endpoint: `GET /api/admin/export` (JSON format)
- Direct database access with county-held credentials
- Standard PostgreSQL `pg_dump` backup tooling

---

## 3. Security Controls

### Authentication & Access Control

| Control | Implementation |
|---------|---------------|
| Password Hashing | bcrypt with 12 salt rounds |
| Session Tokens | JWT with 8-hour expiry |
| Login Rate Limiting | Max 10 attempts per 15 minutes per IP |
| Role-Based Access | CASEWORKER, SUPERVISOR, ADMIN roles |
| County Isolation | Every database query scoped to `countyId` |
| Session Timeout | 30-minute inactivity timeout for applicant sessions |

### Network Security

| Control | Implementation |
|---------|---------------|
| TLS/HTTPS | Enforced via HSTS (1-year max-age) |
| Security Headers | Helmet.js: CSP, X-Frame-Options, X-Content-Type-Options |
| CORS | Restricted to configured origin only |
| Body Size Limit | 10KB max request body |
| API Rate Limiting | 100 requests per 15 minutes per IP |

### AI Security

| Control | Implementation |
|---------|---------------|
| PII Stripping | Regex-based detection of SSN, phone, email, address, name patterns |
| Prompt Injection Guard | Pattern detection for jailbreak attempts, blocked with audit log |
| Message Length Limit | 2,000 character max per message |
| Special Character Filter | Messages with >15% special characters blocked |
| System Prompt Validation | Startup check ensures no PII in cached system prompt |

### Audit Trail

Every action is logged with:
- Event type (login, intake created, data viewed, review completed, etc.)
- Actor (applicant session, caseworker ID, system)
- Timestamp (UTC)
- IP address
- Affected intake ID
- Detailed metadata (JSON)

Audit logs are append-only by design. Database user permissions should restrict UPDATE and DELETE on audit tables.

---

## 4. Data Handled

### Personally Identifiable Information (PII)

| Data Element | Stored | Encrypted at Rest | Sent to AI |
|-------------|--------|-------------------|------------|
| First/Last Name | Yes | Field-level encryption recommended | No (placeholder used) |
| Date of Birth | Yes | Field-level encryption recommended | Partial (month/year only) |
| SSN (last 4 only) | Yes | Field-level encryption recommended | No |
| Street Address | Yes | No (planned) | No |
| Phone Number | Yes | No (planned) | No |
| Email Address | Yes | No (planned) | No |
| Citizenship Status | Yes | No | No |
| Income Details | Yes | No | Yes (de-identified, needed for calculations) |
| Employer Names | Yes | No | Yes (needed for income categorization) |

### Data NOT Collected

- Full Social Security Numbers (only last 4 digits, for caseworker display)
- Bank account numbers
- Credit card information
- Biometric data
- Photographs or images

---

## 5. Compliance Roadmap

| Framework | Status | Timeline |
|-----------|--------|----------|
| NIST 800-53 Controls Mapping | In progress | Pilot contract |
| SOC 2 Type II | Planned | Pre-production |
| ADA / Section 508 (Accessibility) | In progress | Pilot contract |
| Georgia Data Breach Notification | Documented | Pilot contract |
| FedRAMP / StateRAMP | Evaluated | Scale phase |

---

## 6. Incident Response

### Data Breach Procedure

1. **Detection**: Automated monitoring + audit log alerts
2. **Containment**: Isolate affected systems within 1 hour
3. **Assessment**: Determine scope of exposed data within 24 hours
4. **Notification**: Notify county IT within 24 hours, support county's notification obligations per Georgia law (O.C.G.A. § 10-1-912)
5. **Remediation**: Root cause analysis and fix within 72 hours
6. **Post-Incident Review**: Written report to county within 2 weeks

---

## 7. Questions County IT Should Ask Us

We welcome security scrutiny. Here are questions we expect and are prepared to answer:

1. *"Can we deploy this on our own servers?"* — Yes. Docker container, your PostgreSQL, your network.
2. *"Does applicant PII leave our network?"* — No. Only de-identified text reaches the AI API.
3. *"Who owns the data?"* — You do. Full export and deletion available at any time.
4. *"What happens if Cushion goes out of business?"* — Your data is in your database. The application is self-contained.
5. *"Can your employees see our data?"* — Not without explicit access granted by the county. No standing access.
6. *"Is the AI making eligibility decisions?"* — No. The AI collects information. Calculations use deterministic code. Caseworkers make final determinations.
7. *"What if the AI gives wrong information?"* — Consistency checks flag discrepancies. Caseworkers review all intakes. The AI is an intake assistant, not a decision-maker.
