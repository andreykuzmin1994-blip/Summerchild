# Tabletop Exercise — 2026 Q2

- **Date planned:** 2026-05-14 (tentative — to be confirmed by facilitator)
- **Date conducted:** _pending_
- **Version:** 1.0 (template; no run has occurred yet)
- **Classification:** Internal — Cushion Gov engineering + compliance
- **Duration:** 90 minutes
- **Format:** Discussion-based tabletop (NIST SP 800-84 §3.4)

Template and control coverage modeled on CISA CTEP (Situation Manual + Discussion Questions + After-Action Report) and NIST SP 800-84 §5. This file is the authoritative record of the exercise; findings and action items must be transcribed here at the end of the session.

---

## 1. Objectives

Maps to NIST 800-53 **IR-3** (Incident Response Testing) and **IR-4** (Incident Handling). Flips `docs/SECURITY_REGULATIONS.md` IR-4 from PARTIAL to OK once the first dated run is filed with findings.

1. Validate `docs/INCIDENT_RESPONSE_PLAYBOOK.md` §3 (Containment) through §7 (Post-Incident Review) under time pressure.
2. Exercise the PII breach notification path required by 7 CFR 272.1(c) and O.C.G.A. § 10-1-912 (24-hour window).
3. Confirm on-call escalation across engineering → compliance officer → county DFCS IT security officer → county DFCS director.
4. Identify at least three concrete gaps and assign owners + due dates.

---

## 2. Participants

| Name | Role in exercise | Org role |
|------|------------------|----------|
| _TBD_ | Facilitator | Security lead |
| _TBD_ | Scribe | Compliance officer |
| _TBD_ | Player — on-call engineer | Engineering |
| _TBD_ | Player — supervisor caseworker | County DFCS |
| _TBD_ | Player — compliance | Compliance officer |
| _TBD_ | Evaluator (non-participating observer) | External reviewer / audit |
| _TBD_ | Observer | County DFCS IT (optional) |

Required roles per NIST 800-84 §3.4: **facilitator, players, evaluator, scribe**. Do not proceed without all four.

---

## 3. Scope & assumptions

- In-scope: application layer (Cushion Gov Node/Express/Prisma app), audit log pipeline, on-call rotation, notification path to county and to applicants.
- Out-of-scope: county network infrastructure, Anthropic platform incidents, physical security of county offices.
- Assumptions: staging environment mirrors production; Redis session store is up; current `fieldCrypto` key version is `v1`; latest retention job run completed ≤24h ago.

---

## 4. Scenario

A caseworker in County X (Clayton) files a ticket at **09:14** stating the intake assistant, when asked to "summarize my last case," returned what appears to be **another applicant's monthly income breakdown and household-member first names**. The caseworker is unsure if the data is real or hallucinated.

At **09:26**, WAF logs show a spike of prompt-injection payloads — approximately 120 requests in 9 minutes from a single residential ISP IP (not in the county allowlist, but the allowlist permits the kiosk's upstream NAT range).

At **09:45**, a local reporter emails Cushion Gov's general inbox asking whether SNAP applicant data has been leaked, citing a Twitter post with a screenshot that matches the format of Cushion's intake summary card.

At **10:05**, a second caseworker in County Y (DeKalb) reports a similar "wrong household" response.

---

## 5. Injects (timeline)

| T+ | Inject | Expected player action | Playbook reference |
|----|--------|------------------------|---------------------|
| 0 min | Caseworker ticket filed (P1 suspect) | Classify severity; open incident channel | PLAYBOOK §1, §2 |
| +12 min | WAF correlation — injection spike | Consider containment: IP block, rate-limit tightening | PLAYBOOK §3 |
| +25 min | Reporter email | Decide on external comms hold; notify compliance | PLAYBOOK §5 |
| +40 min | Second caseworker report | Escalate to P1; page county DFCS IT | PLAYBOOK §3 (P1) |
| +55 min | Audit-log query returns 14 intakes possibly cross-contaminated in the window | Scope determination; quantify affected applicants | PLAYBOOK §4 |
| +70 min | Legal question: is FNS notification required? On what timeline? | Produce the answer, cite the regulation | 7 CFR 272.1(c) |
| +85 min | Hot-wash | Capture findings and action items in §7 below | PLAYBOOK §7 |

---

## 6. Discussion questions

Facilitator asks one set per inject. Scribe records the answers verbatim for each question (plain text is acceptable — do not paraphrase for tone).

**Per inject 1 (09:14 ticket):**
- What is the severity per PLAYBOOK §1? Who makes that call?
- What is the first contained action in the first 5 minutes?
- Which audit events are queried first, and what correlation ID is used?

**Per inject 2 (09:26 WAF spike):**
- Does `injectionGuard.js` have coverage for the observed payload class? Point to the file/line that would block it.
- Is rate-limit tightening applied globally or per-county? What's the rollback plan if it breaks a real caseworker?

**Per inject 3 (09:45 reporter):**
- Who owns external comms? Is the answer in the playbook, or is this a gap?
- What statement goes out first, before investigation is complete?

**Per inject 4 (10:05 second county):**
- At what point does this cross the threshold for county DFCS director notification?
- What's the call-script for the 30-minute PLAYBOOK §3 (P1) notification?

**Per inject 5 (14-intake scope):**
- What fields are potentially exposed? What does `src/lib/fieldCrypto.js` protect, and what does it not?
- How is the number 14 verified — what query, against what table? Is that query reproducible in 30 seconds?

**Per inject 6 (FNS notification):**
- Cite the regulation and the timeline.
- Who signs the notification? Who translates it (en/es per County X demographics)?

---

## 7. Findings

_To be filled in at the hot-wash. One bullet per finding, tagged Strength / Gap / Unknown._

- [Strength | Gap | Unknown] _finding text_

---

## 8. Action items

| ID | Finding | Owner | Due | Status | SECURITY_REGULATIONS row |
|----|---------|-------|-----|--------|---------------------------|
| TT-2026Q2-01 | _(finding from §7)_ | _TBD_ | _TBD_ | OPEN | IR-4 |
| TT-2026Q2-02 | _(finding from §7)_ | _TBD_ | _TBD_ | OPEN | _(e.g. AU-5)_ |
| TT-2026Q2-03 | _(finding from §7)_ | _TBD_ | _TBD_ | OPEN | _(e.g. SI-4)_ |

Each action item that closes a control-family gap must have its corresponding row in `docs/SECURITY_REGULATIONS.md` §2 or §3 updated in the same PR that delivers the fix.

---

## 9. Metrics captured

| Metric | Target | Observed |
|--------|--------|----------|
| Time to detect (TTD) from first inject | <15 min | _TBD_ |
| Time to contain (TTC) | <1 hour (P1 per PLAYBOOK §1) | _TBD_ |
| Time to notify county IT security | <30 min (P1) | _TBD_ |
| Number of playbook sections referenced unprompted | ≥4 | _TBD_ |

---

## 10. Signoff

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Facilitator | _TBD_ | | |
| Security lead | _TBD_ | | |
| Compliance officer | _TBD_ | | |

Once signed, this file is read-only. A follow-up PR filing the AAR results closes IR-4 for this cycle and schedules the next quarterly exercise as `docs/compliance/tabletop-2026-Q3-<scenario>.md`.

---

## 11. References

- `docs/INCIDENT_RESPONSE_PLAYBOOK.md` — operational playbook this exercise tests
- `docs/SECURITY_REGULATIONS.md` §2 IR-4 — control row updated by the AAR
- NIST SP 800-84, Guide to Test, Training, and Exercise Programs for IT Plans and Capabilities
- CISA Tabletop Exercise Packages (CTEP), https://www.cisa.gov/resources-tools/services/cisa-tabletop-exercise-packages
- 7 CFR 272.1(c) — SNAP applicant information safeguards
- O.C.G.A. § 10-1-912 — Georgia breach notification law
