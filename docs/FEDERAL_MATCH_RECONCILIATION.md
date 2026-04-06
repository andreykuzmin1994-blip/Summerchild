# Cushion Gov — Federal Match Reconciliation Procedure

**Version 1.0 | April 2026**
**Compliance:** 7 CFR 273.2(f)(9), Georgia DHS Policy

---

## 1. Overview

Cushion Gov is a **pre-screen intake tool** — it collects self-reported income and household data from applicants before the caseworker interview. After the caseworker reviews the intake packet, they must run federal database matches in Georgia Gateway to verify the applicant's information.

This document defines the procedure for reconciling discrepancies between Cushion Gov intake data and federal match results.

---

## 2. Federal Match Systems

Caseworkers verify intake data against these federal databases (accessed through Georgia Gateway):

| Match System | Data Verified | Typical Discrepancies |
|-------------|---------------|----------------------|
| **DOL New Hire Directory** | Employment status, employer name | Unreported new employment |
| **SSA/SDX** | SSI/SSDI benefits | Unreported or understated benefits |
| **BENDEX** | Social Security benefits | Unreported retirement/survivor benefits |
| **VA Benefits** | Veterans benefits | Unreported VA pension or compensation |
| **CSE/IV-D** | Child support payments | Unreported child support received |
| **TANF/Medicaid Cross-Match** | Other benefits | Unreported TANF cash assistance |
| **IRS/IEVS** | Wage and income data | Unreported employment income |

---

## 3. Reconciliation Workflow

### Step 1: Caseworker Reviews Intake Packet
1. Open the intake in the Caseworker Dashboard
2. Review all AI-extracted data (income sources, household members, shelter expenses)
3. Note any consistency flags raised by the system
4. Confirm understanding of the applicant's reported situation

### Step 2: Run Federal Matches in Georgia Gateway
1. Enter the applicant's **full PII** (SSN, DOB, full name) in Gateway
2. Run all applicable matches (DOL, SSA, BENDEX, VA, CSE)
3. Review match results for discrepancies

### Step 3: Identify Discrepancies
Common discrepancy types:

| Discrepancy | Example | Impact |
|-------------|---------|--------|
| **Unreported income** | Wage records show $3,500/mo; applicant reported $2,000/mo | Overstatement of benefits |
| **Unreported benefits** | SSI match shows $914/mo; not in intake | Missing unearned income |
| **Unreported employment** | New hire record found; applicant reported unemployed | Missing earned income |
| **Household member discrepancy** | CSE records show child support for 3 children; intake shows 2 | Household composition error |
| **Benefit overlap** | TANF match shows active case; not reported | Program interaction error |

### Step 4: Reconcile in Cushion Gov
When a discrepancy is found:

1. **Document the discrepancy** in the review notes field
2. **Correct the intake data** using the correction workflow:
   - Set `correctionsMade: true`
   - Set `correctionType` to the appropriate category (INCOME, HOUSEHOLD, DEDUCTION, OTHER)
   - Provide `correctionDetails` with before/after values:
     ```json
     {
       "field": "income_source",
       "source": "DOL_WAGE_RECORDS",
       "before": { "employer": "Target", "monthly": 2000 },
       "after": { "employer": "Target", "monthly": 3500 },
       "reason": "DOL wage records show higher income than self-reported"
     }
     ```
3. **Confirm the review** with `reviewerConfirmsAllData: true`

### Step 5: Recalculate Eligibility
After corrections are entered:
1. The system recalculates SNAP eligibility with corrected figures
2. New consistency flags may appear based on corrected data
3. Updated benefit estimate is generated
4. All changes are logged in the audit trail

### Step 6: Applicant Notification
If corrections significantly change the eligibility determination:
1. Inform the applicant of the discrepancy during the interview
2. Give the applicant an opportunity to explain
3. Document the applicant's response in review notes
4. If the applicant disputes, document for Fair Hearing record

---

## 4. Fair Hearing Support

If an applicant is denied benefits or receives a reduced amount due to federal match data:

1. **Preserve the record**: Do not delete or modify the intake after determination
2. **Document the evidence**: The audit trail captures:
   - Original self-reported data
   - Federal match results (documented in correction details)
   - Caseworker's reconciliation decision
   - Timestamp of each action
3. **Export the case file**: Use the admin export to generate a complete record
4. **Provide to Fair Hearing officer**: The intake packet serves as the applicant's initial statement

---

## 5. Audit Trail Requirements

Every federal match reconciliation generates these audit events:

| Event | Logged Data |
|-------|-------------|
| `CASEWORKER_REVIEW_CONFIRMED` | Reviewer ID, timestamp, confirmation flag |
| `CASEWORKER_CORRECTION` | Field corrected, before/after values, source (which match system), reason |
| `FEDERAL_MATCH_CORRECTION` | Match system, discrepancy type, resolution |

These audit events are immutable and retained for 7 years per SNAP QC requirements.

---

## 6. Quality Control

### Monthly QC Review
The supervisor should review a random sample of corrected intakes:
- Select 10% of intakes with corrections
- Verify corrections match federal match documentation
- Check that audit trail is complete
- Flag any patterns (e.g., same discrepancy type recurring)

### Error Patterns to Monitor
- High correction rate (>30%) may indicate intake questions need improvement
- Specific income types frequently unreported may need additional prompting
- Caseworkers who rarely make corrections may need training on federal match review

---

*Owner: County DFCS Supervisor*
*Review frequency: Quarterly*
