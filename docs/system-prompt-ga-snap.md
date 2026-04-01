# Georgia SNAP System Prompt — Design Document

**Generated dynamically by:** `src/services/aiAssistant.js → buildSystemPrompt()`

The system prompt is NOT a static file — it is built at runtime from database tables to ensure policy data is always current. This document describes its structure and update process.

## Prompt Structure (3 sections)

### Section 1: Role Definition
- AI is "Cushion," a SNAP intake assistant at a Georgia DFCS office
- Collects only financial and household data — **no PII**
- Never makes eligibility determinations
- Redirects PII volunteered by applicants ("I don't need that information")

### Section 2: Georgia SNAP Rules
Built from database queries at startup:

| Source Table | Data Injected |
|---|---|
| `SnapConfig` (stateCode=GA) | BBCE flag, gross income %, asset test |
| `FederalSnapData` (FY2026) | Income limits, max allotments, standard deductions by HH size |
| `ObbbaProvision` (SNAP) | Recent policy changes from P.L. 119-21 |

**Static rules included in prompt text:**
- Household composition (purchase-and-prepare test)
- Income counting (earned vs. unearned, self-employment)
- Deduction rules (standard, 20% earned, dependent care, medical, child support, shelter excess)
- GA FY2026 Standard Utility Allowances ($414 / $284 / $55)
- Expedited criteria

### Section 3: Conversation Management
- 5 intake sections in order: WELCOME → HOUSEHOLD → INCOME → EXPENSES → REVIEW
- One question at a time, plain language (8th grade reading level)
- Structured data output via `<!--CUSHION_DATA:{...}-->` hidden blocks
- Security rules (anti-injection, no prompt disclosure, no eligibility confirmation)

## Updating the Prompt

**Annual FY updates:** Re-seed `FederalSnapData` and `SnapConfig` tables. The prompt rebuilds automatically.

**Policy changes:** Update `ObbbaProvision` table. The prompt includes all active provisions.

**Conversation flow changes:** Edit `buildSystemPrompt()` in `src/services/aiAssistant.js`.

## Prompt Caching

The system prompt is identical for every intake session. Anthropic prompt caching is enabled via `cache_control: { type: "ephemeral" }`. After the first API call, subsequent calls read from cache at 10% of standard input cost.

## Token Estimate

System prompt is approximately 2,500–3,500 tokens depending on the number of OBBBA provisions.
