# Post-Screen Add-On: Closing the Remaining 30% Overpayment Detection Gap

## Context

The Cushion Gov intake tool uses a **PII-free pre-screen model** — we collect only first name + last initial, no SSNs or full names. Our consistency checker analyzes self-reported intake data and currently catches ~65-70% of common SNAP overpayment patterns using 11 heuristic checks.

The remaining ~30% of overpayment errors require verification against external data systems that depend on PII (SSN, full legal name, date of birth). **This tool does not and should not perform those matches.** That is the caseworker's responsibility inside Georgia Gateway after reviewing the intake packet.

This document describes what those matches are, what they catch, and how caseworkers should use our pre-screen flags to prioritize which cases need the most careful verification.

---

## What the Pre-Screen Catches (This Tool)

| Check | Severity | Detection Rate |
|-------|----------|:--------------:|
| Income/expense mismatch (shelter > 80% income) | HIGH | ~10% of errors |
| Zero income with shelter costs | HIGH | ~5% |
| Multiple working-age adults with no income | HIGH | ~10% |
| Ineligible deduction claims | HIGH | ~5% |
| Single adult with no income | MEDIUM | ~8% |
| Threshold proximity | MEDIUM | ~8% |
| Self-employment high expense ratio | MEDIUM | ~5% |
| Pay frequency plausibility | MEDIUM | ~5% |
| Medical expense reasonableness | MEDIUM | ~3% |
| Shelter/utility overlap | LOW | ~2% |

**Total pre-screen coverage: ~65-70% of common overpayment patterns**

---

## What the Pre-Screen Cannot Catch (Requires PII-Based Verification)

### 1. Unreported Employment (~10-12% of remaining errors)

**What it is:** Applicant has a job they didn't disclose. Common with second part-time jobs, recent hires, and under-the-table work that happens to be reported by the employer.

**How it's caught:** Georgia DOL New Hire Directory and Quarterly Wage Records. When a caseworker enters the applicant's SSN into Georgia Gateway, the system cross-matches against employer-reported wage data. A mismatch between reported income sources and wage records flags the case.

**Caseworker action after our pre-screen:**
- If our tool flags `INCOME_EXPENSE_MISMATCH` or `ZERO_INCOME_WITH_SHELTER`, the caseworker should prioritize running the wage match immediately
- If our tool flags `HOUSEHOLD_MEMBER_NO_INCOME` for an adult member, the caseworker should verify that member's SSN against wage records before approving

### 2. Incorrect Benefit Amounts (~5-7% of remaining errors)

**What it is:** Applicant reports wrong SSI, SSDI, Social Security, or VA benefit amount. Often due to stale figures (pre-COLA adjustment), confusion between gross and net, or intentional underreporting.

**How it's caught:** SSA/SDX (SSI verification), BENDEX (Social Security/SSDI), and VA benefit verification systems. These are automated federal matches that return the actual current monthly benefit amount for a given SSN.

**Caseworker action after our pre-screen:**
- For any unearned income source, the caseworker should verify the exact amount through the federal match system rather than relying on the applicant's stated figure
- Our tool's `THRESHOLD_PROXIMITY` flag means even a small amount discrepancy could flip eligibility — extra verification urgency

### 3. Hidden Household Members (~5-8% of remaining errors)

**What it is:** An adult lives in the household but isn't listed on the application. Common with unmarried partners, adult children, and non-relative boarders who purchase and prepare food together.

**How it's caught:** Cross-referencing address records across TANF, Medicaid, and SNAP applications. If another adult at the same address has an active benefits case, it may indicate an unreported household member. Utility account holder records can also reveal additional adults.

**Caseworker action after our pre-screen:**
- If our tool flags `INCOME_EXPENSE_MISMATCH` (rent seems too high for stated income), this is often the signal that a hidden earner is covering part of the rent
- The caseworker should check Georgia Gateway for other active cases at the same address
- During the in-person interview, ask specifically about all adults who sleep at the address

### 4. Unreported Child Support Received (~3-5% of remaining errors)

**What it is:** Applicant receives child support payments but doesn't report them as income. Child support received counts as unearned income for SNAP.

**How it's caught:** Georgia Child Support Enforcement (CSE/IV-D) system tracks all court-ordered payments. Cross-matching the applicant's case against CSE records reveals active payment streams.

**Caseworker action after our pre-screen:**
- For any single-parent household, the caseworker should run a CSE match before finalizing the case
- If the other parent's information is available, check for active support orders

### 5. Phantom Household Members (~3-5% of remaining errors)

**What it is:** Applicant lists a child or other member who doesn't actually live in the household (e.g., child lives with other parent). This inflates household size, raising income limits and maximum allotment.

**How it's caught:** Cross-referencing household members against other SNAP/TANF/Medicaid cases. If a child is already listed on another household's active case at a different address, it indicates possible duplication.

**Caseworker action after our pre-screen:**
- For households where benefit amount is sensitive to household size (near threshold), verify each member's residence
- Check if any listed children appear on another active SNAP case

---

## Recommended Caseworker Workflow

```
1. APPLICANT completes AI-guided intake (this tool)
         ↓
2. PRE-SCREEN runs automatically (11 consistency checks)
         ↓
3. CASEWORKER reviews intake packet + risk score
         ↓
   ┌─────────────────────────────────────────────┐
   │  HIGH risk → Immediate federal match before  │
   │              approval. Interview each flagged │
   │              issue with applicant.            │
   │                                               │
   │  MEDIUM risk → Run standard federal matches.  │
   │                Follow up on flagged items     │
   │                during interview.              │
   │                                               │
   │  LOW risk → Run standard federal matches.     │
   │             Proceed with normal processing.   │
   └─────────────────────────────────────────────┘
         ↓
4. CASEWORKER enters data into Georgia Gateway
         ↓
5. GATEWAY runs automated federal matches:
   - DOL New Hire / Wage Records
   - SSA/SDX (SSI verification)
   - BENDEX (Social Security/SSDI)
   - CSE/IV-D (Child Support)
   - TANF/Medicaid cross-match
         ↓
6. CASEWORKER reviews match results against intake
         ↓
7. FINAL DETERMINATION issued
```

---

## Why We Don't Do This In-Tool

This tool is designed for the **intake interview step** — before the applicant's identity is verified and before PII enters the system. Our architectural decision to avoid collecting SSNs, full names, and dates of birth means:

- No risk of PII breach from the intake tool
- No compliance burden under IRS 6103 or Privacy Act for this system
- The tool can be deployed on kiosk hardware without federal security certification
- Caseworkers maintain full control over the identity verification and federal match process

The pre-screen catches the patterns that are visible from the self-reported data alone. The caseworker closes the loop by running the PII-based matches in Gateway, using our risk score to prioritize which cases need the closest scrutiny.

---

## Detection Coverage Summary

| Layer | What It Uses | Overpayment Patterns Caught |
|-------|-------------|:---------------------------:|
| **Pre-screen (this tool)** | Self-reported intake data | ~65-70% |
| **Post-screen (Gateway matches)** | SSN-based federal databases | ~25-30% |
| **Caseworker interview** | In-person verification | ~5-10% |
| **Combined** | All layers | ~95%+ |

The 5% that slips through is primarily unreported cash income with no employer filing and no visible lifestyle inconsistency — the hardest category for any system to detect.
