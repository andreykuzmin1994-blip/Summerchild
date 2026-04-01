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
|  | (Kiosk)   |<----| Server            |<----|  (NO PII stored)  |    |
|  +-----------+     +-------------------+     +-------------------+    |
|                           |      ^                                    |
|                           |      |                                    |
|                  Financial|      |  AI Response                       |
|                  data only|      |  (calculations)                    |
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

    PII (full name, SSN, DOB, address, phone) is NEVER collected by Cushion.
    The caseworker enters PII directly into Georgia Gateway after reviewing
    the Cushion intake calculation packet.
```

### Core Design Principle: We Don't Collect PII

Cushion Gov collects **only the financial and household data needed for SNAP calculations**. Personally identifiable information is entered by the caseworker directly into Georgia Gateway — it never touches our system.

| Data Type | Collected by Cushion? | In Our Database? | Sent to AI? |
|-----------|----------------------|------------------|-------------|
| Full Name | NO | NO | NO |
| SSN | NO | NO | NO |
| Date of Birth | NO | NO | NO |
| Street Address | NO | NO | NO |
| Phone Number | NO | NO | NO |
| Email Address | NO | NO | NO |
| First Name + Last Initial | YES (lobby ID only) | YES ("Maria G.") | First name only |
| Queue Number | YES (auto-generated) | YES ("A-0247") | NO |
| Income Amounts | YES | YES | YES (needed for calculations) |
| Employer Names | YES | YES | YES (needed for income categorization) |
| Household Size | YES | YES | YES (needed for eligibility) |
| Age Ranges | YES (e.g., "30-39") | YES | YES (needed for elderly/disabled checks) |
| Expense Amounts | YES | YES | YES (needed for deductions) |
| Relationship Types | YES | YES | YES (needed for household composition) |

### How the Workflow Works

1. **Applicant enters first name + last initial** on the kiosk welcome screen (e.g., "Maria G.")
2. **System assigns a queue number** (e.g., "A-0247")
3. **AI collects financial data** — income, expenses, household composition, disability/elderly status
4. **AI explicitly does NOT ask for** SSN, full name, DOB, address, phone, or email
5. **If applicant volunteers PII**, AI redirects: "I don't need that — the caseworker will collect your personal details separately"
6. **Safety-net PII stripper** catches any accidentally-typed SSNs, phones, or addresses before they reach the AI
7. **Caseworker receives** a pre-calculated packet: "Maria G. (A-0247) — HH of 4, $2,295/mo gross, estimated benefit $487"
8. **Caseworker calls** "Maria G., number A-0247" from the waiting room
9. **Caseworker enters PII** (full name, SSN, DOB, address) directly into Georgia Gateway

### Why This Matters

- **No PII breach risk** — if our database is compromised, no SSNs, addresses, or full names are exposed
- **No PII leaves the county network** — only financial figures (income, expenses) reach the AI
- **Dramatically reduced compliance burden** — we are not a PII custodian
- **Complements Gateway** instead of duplicating it — caseworkers still enter identity data where they always have

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

### What Cushion Gov Stores

| Data Element | Stored | Sensitivity | Sent to AI |
|-------------|--------|-------------|------------|
| First name + last initial | Yes ("Maria G.") | Low | First name only |
| Queue number | Yes ("A-0247") | None | No |
| Income amounts | Yes | Low (no identity attached) | Yes |
| Employer names | Yes | Low (no identity attached) | Yes |
| Household size & relationships | Yes | Low | Yes |
| Age ranges | Yes ("30-39", "60+") | Low | Yes |
| Disability/elderly status | Yes | Low (no identity attached) | Yes |
| Expense amounts | Yes | Low | Yes |

### What Cushion Gov Does NOT Collect

- Full names (only first name + last initial)
- Social Security Numbers (not even last 4)
- Dates of birth (only age ranges)
- Street addresses
- Phone numbers
- Email addresses
- Citizenship/immigration status
- Bank account numbers
- Credit card information
- Biometric data
- Photographs or images

**All PII is entered by the caseworker directly into Georgia Gateway.** Cushion Gov is a calculation and data collection tool, not an identity system.

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
2. *"Does applicant PII leave our network?"* — We don't collect PII at all. No SSNs, no full names, no addresses, no dates of birth. Only financial data (income, expenses) reaches the AI. The caseworker enters PII directly into Gateway.
3. *"Who owns the data?"* — You do. Full export and deletion available at any time.
4. *"What happens if Cushion goes out of business?"* — Your data is in your database. The application is self-contained.
5. *"Can your employees see our data?"* — Not without explicit access granted by the county. No standing access. And even if they could, there's no PII to see — only income figures and household compositions.
6. *"Is the AI making eligibility decisions?"* — No. The AI collects financial information. Calculations use deterministic code. Caseworkers make final determinations.
7. *"What if the AI gives wrong information?"* — Consistency checks flag discrepancies. Caseworkers review all intakes. The AI is an intake assistant, not a decision-maker.
8. *"What if the database is breached?"* — The attacker would find income amounts, expense figures, and entries like "Maria G., household of 4" — no SSNs, no addresses, no full names. There is no PII to steal.
