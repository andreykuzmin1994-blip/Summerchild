# Cushion Gov - Product Improvement Plan

> Analysis conducted by a cross-functional team: System Architect, Frontend Developer, and Backend Developer.
> Date: April 2, 2026

---

## Current State Summary

**Cushion Gov** is an AI-powered SNAP (Supplemental Nutrition Assistance Program) intake platform deployed for county government use. It replaces traditional paper-based intake with a conversational chat interface that guides applicants through eligibility screening, collects household/income/expense data, calculates SNAP benefits, and routes cases to caseworkers for review.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite 6 + Tailwind CSS 3.4 |
| Backend | Express.js 4.21 (Node.js) |
| Database | PostgreSQL + Prisma ORM 6.4 |
| AI | Claude (primary) + OpenAI (fallback) with circuit breaker |
| Auth | JWT (8h expiry) + bcrypt |
| Testing | Vitest 3.2 (20 backend test files) |

### Current Capabilities

| Capability | Status | Details |
|-----------|--------|---------|
| Conversational intake | Done | Chat-based flow with English/Spanish support |
| AI data collection | Done | PII stripping + injection guards |
| SNAP calculator | Done | 6-step federal deduction logic |
| Consistency checker | Done | 14-rule risk scoring (LOW/MEDIUM/HIGH) |
| Role-based dashboards | Done | Caseworker, Supervisor, Admin |
| Audit trail | Done | Immutable logging for government compliance |
| AI failover | Done | Circuit breaker (Claude -> OpenAI) |
| Accessibility | Done | WCAG 2.1 AA compliance |
| Kiosk mode | Done | Staff PIN authentication |
| Data export | Done | CSV export + basic analytics |

---

## All Improvement Recommendations (Master Table)

| # | Improvement | Team | Priority | Problem | Recommendation | Effort |
|---|------------|------|----------|---------|---------------|--------|
| 1 | Redis Session Store | Architect | CRITICAL | Sessions stored in JS `Map()` in memory. Server restart = all active sessions lost. Blocks horizontal scaling. | Introduce Redis via `ioredis` for session storage, system prompt caching, and rate limiting. Enable shared session store for multi-instance deployments. | 2-3 days |
| 2 | Structured Logging & Observability | Architect | HIGH | All logging is `console.log`/`console.error` to stdout. No APM, error tracking, or performance metrics. | Adopt Pino or Winston for structured JSON logging. Integrate Sentry for error tracking. Add response time middleware + Prometheus `/metrics` endpoint. | 3-4 days |
| 3 | API Versioning | Architect | MEDIUM | Routes have no version prefix. Any breaking change affects all clients immediately. | Prefix all routes with `/api/v1/`. Document deprecation policy. | 1 day |
| 4 | CI/CD Pipeline | Architect | MEDIUM | Docker files exist but no CI/CD config. Deployment is likely manual. | Add GitHub Actions for lint, test, build, deploy. Implement staging environment. Add DB migration step to pipeline. | 3-5 days |
| 5 | Database Connection Pooling | Architect | MEDIUM | No explicit connection pooling config. Under load, DB connections could exhaust. | Configure Prisma `connection_limit`. Add PgBouncer for production. Add query logging in dev. | 1-2 days |
| 6 | Global State Management | Frontend | HIGH | Every page independently fetches data. Auth checked via `localStorage` in every component's `useEffect`. User context duplicated across pages. | Introduce React Context for auth state. Create `AuthProvider` for login/logout/token refresh. Consider TanStack Query for server state with caching. | 2-3 days |
| 7 | Route Guards | Frontend | HIGH | Route protection is per-component `useEffect` checks. No centralized protection. Users briefly see protected content before redirect. | Create `<ProtectedRoute>` wrapper. Implement `<RequireRole>` for role-based guards. Add loading state during auth verification. | 1 day |
| 8 | Code Splitting & Lazy Loading | Frontend | MEDIUM | All pages bundled into single chunk. Users download entire app even if they only use intake form. | Use `React.lazy()` + `Suspense` for route-level splitting. Lazy-load dashboard pages. Add loading fallback components. | 1 day |
| 9 | Frontend Testing | Frontend | HIGH | Zero frontend test files. No test config. Critical flows (intake chat, session timeout, login) untested. | Set up Vitest + React Testing Library. Test IntakePage, LoginPage, ChatInterface, ReviewSummary, SessionTimeoutWarning. Add Playwright for E2E. | 5-7 days |
| 10 | Error Boundaries | Frontend | MEDIUM | No React Error Boundary components. Unhandled JS error crashes entire app with white screen. | Add top-level `<ErrorBoundary>` with friendly fallback. Add route-level boundaries. Log caught errors to backend. | 1 day |
| 11 | TypeScript Migration | Frontend | MEDIUM | Frontend is vanilla JS despite TS in project root. Complex state shapes are error-prone without types. | Incrementally adopt TS starting with shared types/interfaces. Define types for API responses, intake state, component props. | 3-5 days |
| 12 | Mobile/Kiosk Optimization | Frontend | MEDIUM | Chat interface could be better optimized for kiosk/tablet use in government offices. | Add touch-optimized gestures. Increase button/input sizes for touch screens. Add PWA support for offline resilience. | 3-4 days |
| 13 | Skeleton Loading States | Frontend | LOW | Loading states use simple "Loading..." text. Dashboards show blank white space during data fetch. | Add skeleton components for dashboard cards, intake lists, detail views. | 1-2 days |
| 14 | OpenAPI/Swagger Documentation | Backend | HIGH | No API documentation. Developers must read route handlers to understand endpoints. | Add swagger-jsdoc + swagger-ui-express. Document all endpoints with schemas, error codes, auth. Serve at `/api/docs`. | 2-3 days |
| 15 | Background Job Processing | Backend | MEDIUM | CSV export runs synchronously and blocks request. No infra for async needs (email, reports). | Introduce BullMQ with Redis. Move CSV export to async job. Prepare for email notifications, scheduled reports. | 3-4 days |
| 16 | API Route Integration Tests | Backend | HIGH | Tests cover business logic but don't test HTTP endpoints. No full request/response cycle tests. | Add Supertest. Test auth flows, intake lifecycle, error scenarios, admin operations. | 4-5 days |
| 17 | Request Validation Middleware | Backend | MEDIUM | Input validation scattered across route handlers. No centralized schema validation. | Use Zod (already a dependency) for request body validation middleware. Create schemas per endpoint. Return structured field-level errors. | 2-3 days |
| 18 | Webhook/Event System | Backend | LOW | No way to notify external systems on intake events. County IT may need integration points. | Add webhook registration for key events. Use event emitter pattern internally. Document payload schemas. | 3-4 days |
| 19 | Database Soft Deletes | Backend | LOW | Caseworker deactivation uses hard deletes. Government compliance may require retention. | Add `deletedAt` field. Filter soft-deleted records by default. Add admin purge endpoint after retention period. | 1-2 days |
| 20 | Per-User Rate Limiting | Backend | MEDIUM | Rate limiting is IP-based. Shared kiosk IPs affect all users. No per-session throttling. | Add session-token-based limiting for intake. Add user-ID-based limiting for auth endpoints. Use Redis-backed limiter. | 1-2 days |

---

## Prioritized Implementation Roadmap

### Phase 1: Stability & Security (Weeks 1-2)

| # | Item | Owner | Effort | Dependencies | Risk if Skipped |
|---|------|-------|--------|-------------|----------------|
| 1 | Redis session store | Architect + Backend | 2-3 days | Redis infrastructure | Session loss on restart, no horizontal scaling |
| 7 | Auth context + route guards | Frontend | 2 days | None | Content flash, duplicated auth logic |
| 10 | Error boundaries | Frontend | 1 day | None | White screen crashes in production |
| 2 | Structured logging (Pino + Sentry) | Backend | 3 days | Sentry account | Blind to production errors |

### Phase 2: Quality & Testing (Weeks 3-4)

| # | Item | Owner | Effort | Dependencies | Risk if Skipped |
|---|------|-------|--------|-------------|----------------|
| 9 | Frontend test setup + critical tests | Frontend | 5-7 days | None | Regressions in intake flow |
| 16 | API route integration tests | Backend | 4-5 days | None | Broken endpoints undetected |
| 14 | OpenAPI documentation | Backend | 2-3 days | None | Slow onboarding, integration friction |
| 17 | Zod request validation middleware | Backend | 2-3 days | None | Inconsistent validation, poor error messages |

### Phase 3: Performance & DX (Weeks 5-6)

| # | Item | Owner | Effort | Dependencies | Risk if Skipped |
|---|------|-------|--------|-------------|----------------|
| 8 | Code splitting + lazy loading | Frontend | 1 day | None | Slow initial load for applicants |
| 15 | Background job processing (BullMQ) | Backend | 3-4 days | Redis (from Phase 1) | Export timeouts, no async infra |
| 4 | CI/CD pipeline (GitHub Actions) | Architect | 3-5 days | Test suites (from Phase 2) | Manual deployment, no quality gates |
| 5 | Database connection pooling | Architect | 1-2 days | None | Connection exhaustion under load |

### Phase 4: Polish & Scale (Weeks 7-8)

| # | Item | Owner | Effort | Dependencies | Risk if Skipped |
|---|------|-------|--------|-------------|----------------|
| 11 | TypeScript migration (incremental) | Frontend | 3-5 days | None | Type errors in complex state shapes |
| 12 | Mobile/kiosk optimization + PWA | Frontend | 3-4 days | None | Poor kiosk experience |
| 3 | API versioning | Architect | 1 day | None | Breaking changes affect all clients |
| 13 | Skeleton loading states | Frontend | 1-2 days | None | Poor perceived performance |
| 20 | Per-user rate limiting | Backend | 1-2 days | Redis (from Phase 1) | Kiosk IP collisions |
| 18 | Webhook/event system | Backend | 3-4 days | None | No external system integration |

---

## What's Working Well (Keep Doing)

| Strength | Details |
|----------|---------|
| Security-first design | PII stripping, injection guards, audit trail - excellent for government context |
| Accessibility | WCAG 2.1 AA with skip links, ARIA, focus management, reduced motion support |
| AI resilience | Circuit breaker with automatic Claude-to-OpenAI failover is production-ready |
| Conversational UX | Chat-based intake is more engaging than traditional multi-step forms |
| SNAP calculation accuracy | Well-tested with persona-based scenarios and 380-line calculator |
| Consistency checking | 14-rule risk scoring catches data integrity issues before caseworker review |
| Minimal PII collection | Only first name + last initial stored - strong privacy posture |
| Bilingual support | English/Spanish language selection from day one |

---

## Key Metrics to Track Post-Improvements

| Metric | Current Baseline | Target | Owner | Tracking Method |
|--------|-----------------|--------|-------|----------------|
| Intake completion rate | Unknown | >85% | Frontend + Backend | Analytics dashboard |
| Average intake duration | Unknown | <15 min | Backend | Audit log timestamps |
| Frontend error rate | Unknown (no tracking) | <0.1% | Frontend | Sentry (Phase 1) |
| API p95 latency | Unknown (no APM) | <500ms | Backend | Prometheus metrics (Phase 1) |
| AI failover frequency | Logged but not tracked | <1% of requests | Architect | Health endpoint + alerts |
| Test coverage (backend) | ~60% business logic | >80% overall | Backend | CI pipeline (Phase 3) |
| Test coverage (frontend) | 0% | >50% critical paths | Frontend | CI pipeline (Phase 3) |
| Accessibility score | High (manual) | 100 Lighthouse | Frontend | CI Lighthouse audit |
| Uptime | Unknown | 99.9% | Architect | External monitoring |

---

## Effort Summary by Team

| Team | Total Items | Total Effort (days) | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|------|------------|--------------------:|---------|---------|---------|---------|
| System Architect | 5 | 11-16 | 2-3 | — | 4-7 | 1 |
| Frontend Developer | 8 | 17-24 | 3 | 5-7 | 1 | 8-12 |
| Backend Developer | 7 | 18-24 | 3 | 9-11 | 3-4 | 4-6 |
| **Total** | **20** | **46-64** | **8-9** | **14-18** | **8-12** | **13-19** |
