# Pilot Metrics Tracking Plan

**Target:** 90-day pilot at one Georgia DFCS county office

## Key Performance Indicators

### Intake Efficiency
| Metric | How Measured | Target | API Endpoint |
|---|---|---|---|
| Intake completion rate | Completed / Started | >85% | `GET /api/admin/stats` |
| Average completion time | `updatedAt - createdAt` for completed intakes | <20 min | `GET /api/caseworker/dashboard` → `avgCompletionTimeMinutes` |
| Questions asked per intake | Count of ASSISTANT turns in conversation log | <30 | `GET /api/caseworker/intake/:id` → `auditTrail.questionsAsked` |

### Accuracy & Flags
| Metric | How Measured | Target | API Endpoint |
|---|---|---|---|
| Consistency flag rate | % of intakes with MEDIUM or HIGH risk | Track trend | `GET /api/caseworker/dashboard` → `flagRate` |
| Flag-to-correction rate | % of flags where caseworker confirmed correction | Track trend | `GET /api/admin/stats` → `correctionRate` |
| Expedited identification rate | % of intakes correctly flagged expedited | 100% | `GET /api/admin/stats` → `expeditedCount` |

### Caseworker Impact
| Metric | How Measured | Target |
|---|---|---|
| Caseworker interview time | Self-reported before/after Cushion | Reduction |
| Document completeness | Caseworker feedback — did applicant bring all docs? | Improvement |

### System Health
| Metric | How Measured | Target |
|---|---|---|
| Injection attempts blocked | Audit log event count (`INJECTION_BLOCKED`) | Track |
| AI API latency | Token usage logged per call | <3s response |
| Session timeout rate | Expired sessions / Total sessions | <10% |

## Weekly Review Cadence

Every Friday during pilot:
1. Pull aggregate stats from `/api/admin/stats`
2. Review flags caseworkers consistently override (false positives → tune checker)
3. Review errors caseworkers catch that Cushion missed (gaps → add new checks)
4. Collect qualitative feedback on applicant experience
5. Iterate system prompt based on conversation quality issues

## Mid-Pilot Report (Week 7)

Compile:
- Total intakes processed
- Key metrics: flag rate, correction rate, completion time trend
- Projected error rate impact
- Caseworker feedback summary
- Product adjustments for second half
