# CLAUDE.md — Cushion Gov

Guidance for Claude Code working in this repository. Cushion Gov is a SNAP-intake platform handling PII and benefits data; security and federal compliance (FedRAMP / NIST 800-53 / FISMA) take priority over feature velocity.

## Repository Layout

- `src/` — Node.js backend (Express, Prisma, JWT auth, AI services)
  - `routes/` — HTTP endpoints (intake, caseworker, admin, health)
  - `middleware/` — auth, rate limiting, injection guard, IP allowlist
  - `services/` — audit logger, SNAP calculator, AI assistant, PII stripper, guardrails
- `client/` — React SPA (Vite)
- `prisma/` — schema, migrations, seed
- `nemo-sidecar/` — Python NeMo Guardrails sidecar (AI safety layer)
- `tests/` — Vitest suite (injection, PII, SNAP rules, accessibility, accuracy)

## Scripts

- `npm test` — Vitest
- `npm run lint` / `npm run lint:fix`
- `npm run dev` — nodemon server
- `npm run db:generate` / `db:push` / `db:migrate` / `db:seed`

## Non-Negotiables

- Never use `$executeRawUnsafe` or string-concatenated SQL. Prefer `prisma.<model>.*`; if raw is required, use tagged `$queryRaw\`\``.
- Never log PII. Route applicant data through `PIIStripper` before LLM calls and through the output PII scanner on return.
- All state-changing caseworker routes must go through `requireVerifiedAuth` + `requireRole(...)`. County scoping (`countyId`) is mandatory on every query that touches intake data.
- Secrets (`JWT_SECRET`, `ANTHROPIC_API_KEY`, etc.) are validated at startup. Do not loosen those checks.
- Every new security-relevant branch needs a negative test (authz bypass, injection, rate-limit) in `tests/`.

## Compliance Source of Truth

`docs/SECURITY_REGULATIONS.md` is the authoritative list of regulatory scope (NIST 800-53, 800-171, FedRAMP, FISMA, FNS 101, CIS IG1) and the control-family posture/backlog.

Before editing any file touching authentication, authorization, cryptography, logging, PII handling, data retention, network boundaries, dependency management, or incident response:

1. Read the relevant section of `docs/SECURITY_REGULATIONS.md`.
2. Confirm the change does not regress an OK control.
3. If the change alters posture (new evidence, closed gap, new gap introduced), update the Status/Evidence row in the **same commit**.
4. If a backlog item is delivered, move it out of §3 and flip the §2 row to OK.
5. If a new regulatory regime applies (new state, new data type, new integration), add it to §1 before code lands.

## Implementation Agent Stack

When the user asks for non-trivial changes (security fixes, auth/authz, crypto, data handling), use this three-role workflow instead of jumping straight to edits:

### 1. Coder (proposer)
- Subagent: `general-purpose` (or `Plan` for pure design)
- Input: the problem statement, exact file paths and line numbers, relevant constraints from this file
- Output: a concrete fix proposal — exact code to add/change, rationale, trade-offs, risks the author sees
- Does **not** edit files

### 2. Reviewer (critic)
- Subagent: `general-purpose`, launched **in parallel** with Coder when possible
- Input: the Coder's proposal **and** the actual current code on disk
- Output: adversarial review — edge cases, regressions, auth/crypto/PII concerns, missing tests, better alternatives. Must cite file:line.
- Does **not** edit files

### 3. Implementer (decider)
- The main Claude Code loop
- Input: Coder proposal + Reviewer critique + actual source
- Responsibilities:
  1. Reconcile Coder vs. Reviewer — pick the safer option, or synthesize
  2. Apply edits with `Edit` / `Write`
  3. Add/update tests
  4. Run `npm run lint` and `npm test`
  5. Commit with a descriptive message on the designated feature branch
- If Coder and Reviewer disagree on something security-relevant, surface the disagreement to the user before committing

### Rules for the stack

- Run Coder and Reviewer in parallel in a single message with two `Agent` tool calls — they operate on the same inputs independently
- Keep agent prompts self-contained: include the file paths, line numbers, the exact finding being addressed, and relevant excerpts from this CLAUDE.md
- Ask agents for bounded output (≤400 words each) unless a larger design is needed
- Implementer never blindly accepts the Coder's code — always diffs it against actual source and the Reviewer's notes
- For trivial changes (typo, rename, single-line fix), skip the stack and edit directly

## Git Workflow

- Feature branches named `claude/<topic>-<id>` (already provisioned by the harness)
- Commit small, descriptive units; never `git push --force`, never `--no-verify`
- Only open PRs when the user explicitly asks

## Testing Expectations

- Security fixes → add a failing test first that exercises the vulnerability, then make it pass
- Do not mark a task complete with failing tests or lint errors
