# Pre-Pilot Security Testing Checklist

Complete all items before any real applicant uses the system.

## Cross-Session Data Isolation

- [ ] Start intake A, complete 10 turns with sample data
- [ ] Start intake B on same tablet — verify zero data from intake A appears
- [ ] Query the API with intake B's session token but intake A's intake_id — verify rejection
- [ ] Verify conversation_log table has no cross-intake entries

## PII Stripping

- [ ] Run 10 sample intakes with realistic PII through the stripper
- [ ] Log the actual API payloads sent to Claude
- [ ] Manually review every payload — verify zero names, SSNs, addresses, phones, emails
- [ ] Verify PII restoration works correctly in the AI's response display

## Prompt Injection

- [ ] Test all patterns in the injection guard regex list
- [ ] Test 10 additional novel injection attempts (role-play requests, encoded instructions, multi-language injection)
- [ ] Test excessive length inputs (5000+ characters)
- [ ] Test inputs with code-like syntax, JSON, XML
- [ ] Verify the AI refuses to output its system prompt under any framing
- [ ] Verify the AI refuses to change its role under any framing
- [ ] Verify that even if AI text output is manipulated, the calculation engine produces correct results independently

## AI Hallucination

- [ ] Run 10 intakes and verify every data point in the output packet traces to an explicit applicant statement
- [ ] Test an intake where the applicant provides minimal information — verify AI asks for clarification rather than assuming
- [ ] Test eligibility Q&A with a question not covered by the system prompt — verify AI defers to caseworker
- [ ] Verify data validation catches impossible values (negative income, expenses > $50,000)

## Access Control

- [ ] Create two caseworker accounts with different county_ids
- [ ] Verify each can only see their own county's intakes
- [ ] Attempt to access intake detail via direct URL with another county's intake_id — verify rejection
- [ ] Verify session timeout at 60 minutes (applicant) and 8 hours (caseworker JWT)
- [ ] Verify JWT token cannot be reused after expiry
- [ ] Verify deactivated caseworker cannot log in

## Encryption & Network

- [ ] Verify TLS 1.2+ on all connections (test with ssllabs.com or equivalent)
- [ ] Verify HSTS headers present
- [ ] Verify RDS encryption enabled (production)
- [ ] Verify no unencrypted endpoints accessible

## Audit Logging

- [ ] Verify every event type produces an audit log entry:
  - Intake session started / completed / abandoned / timed out
  - Each AI API call (model used, token count, no content)
  - Injection attempt detected and blocked
  - Caseworker login / logout
  - Caseworker viewed intake detail
  - Caseworker submitted review / correction
  - Data export requested
  - Admin user created / modified / deactivated
- [ ] Verify audit_log table cannot be updated or deleted by the application database user
- [ ] Verify injection attempts are logged with details
