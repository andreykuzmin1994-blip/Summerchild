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

### What We Have Today
- Conversational intake flow with English/Spanish support
- AI-assisted data collection with PII stripping and injection guards
- SNAP benefit calculator with 6-step federal deduction logic
- 14-rule consistency checker with risk scoring (LOW/MEDIUM/HIGH)
- Role-based dashboards (Caseworker, Supervisor, Admin)
- Immutable audit trail for government compliance
- Circuit breaker pattern for AI provider failover
- WCAG 2.1 AA accessibility compliance
- Kiosk-mode with staff PIN authentication
- CSV export and basic analytics

---

## Team Analysis & Improvement Recommendations

### 1. SYSTEM ARCHITECT PERSPECTIVE

#### 1.1 Move from In-Memory Sessions to Redis (Priority: CRITICAL)

**Problem**: Intake sessions are stored in a JavaScript `Map()` in server memory. Any server restart loses all active sessions. This is a single point of failure and prevents horizontal scaling.

**Recommendation**:
- Introduce Redis for session storage, system prompt caching, and rate limiting
- Use `connect-redis` or `ioredis` for Express session middleware
- Enable sticky sessions or shared session store for multi-instance deployments
- Estimated effort: 2-3 days

#### 1.2 Add Structured Logging & Observability (Priority: HIGH)

**Problem**: All logging is `console.log`/`console.error` to stdout with no structure. No APM, no external error tracking, no performance metrics.

**Recommendation**:
- Adopt **Pino** or **Winston** for structured JSON logging with log levels
- Integrate **Sentry** for error tracking and alerting
- Add response time middleware to track API performance
- Instrument AI API calls with latency/token-usage metrics
- Add Prometheus-compatible `/metrics` endpoint for monitoring
- Estimated effort: 3-4 days

#### 1.3 Implement API Versioning (Priority: MEDIUM)

**Problem**: Routes have no version prefix. Any breaking change affects all clients immediately.

**Recommendation**:
- Prefix all routes with `/api/v1/`
- Document a deprecation policy for future API changes
- Estimated effort: 1 day

#### 1.4 Container Orchestration & CI/CD (Priority: MEDIUM)

**Problem**: Docker files exist but there's no CI/CD pipeline configuration. Deployment is likely manual.

**Recommendation**:
- Add GitHub Actions workflow for: lint, test, build, deploy
- Implement staging environment that mirrors production
- Add database migration step to deployment pipeline
- Consider health check-based rolling deployments
- Estimated effort: 3-5 days

#### 1.5 Database Connection Pooling & Optimization (Priority: MEDIUM)

**Problem**: No explicit connection pooling configuration. Under load, database connections could exhaust.

**Recommendation**:
- Configure Prisma connection pool limits (`connection_limit` in DATABASE_URL)
- Add PgBouncer for production connection pooling
- Add database query logging in development for performance profiling
- Estimated effort: 1-2 days

---

### 2. FRONTEND DEVELOPER PERSPECTIVE

#### 2.1 Add Global State Management (Priority: HIGH)

**Problem**: Every page independently fetches data. No shared state between components. Auth state is checked via `localStorage` in every component's `useEffect`. User context (role, county, name) is duplicated across pages.

**Recommendation**:
- Introduce **React Context** for auth state (token, user profile, role)
- Create an `AuthProvider` that wraps the app and handles login/logout/token refresh
- Consider **TanStack Query (React Query)** for server state management with caching, refetching, and optimistic updates
- Estimated effort: 2-3 days

#### 2.2 Add Route Guards (Priority: HIGH)

**Problem**: Route protection is done via `useEffect` checks in each dashboard component. No centralized protection. A user could briefly see protected content before being redirected.

**Recommendation**:
- Create a `<ProtectedRoute>` wrapper component that checks auth before rendering
- Implement role-based route guards: `<RequireRole roles={["ADMIN", "SUPERVISOR"]}>`
- Add a loading state during auth verification to prevent content flash
- Estimated effort: 1 day

#### 2.3 Implement Code Splitting & Lazy Loading (Priority: MEDIUM)

**Problem**: All pages are bundled into a single chunk. Users download the entire app even if they only use the intake form.

**Recommendation**:
- Use `React.lazy()` + `Suspense` for route-level code splitting
- Lazy-load dashboard pages (caseworker, supervisor, admin) since most users are applicants
- Add loading fallback components for better perceived performance
- Estimated effort: 1 day

#### 2.4 Add Frontend Testing (Priority: HIGH)

**Problem**: Zero frontend test files. No test configuration. Critical user flows (intake chat, session timeout, login) are untested.

**Recommendation**:
- Set up **Vitest** + **React Testing Library** in the client package
- Priority test targets:
  - `IntakePage.jsx` - Chat message flow, section transitions, session timeout
  - `LoginPage.jsx` - Auth flow, error handling, role-based redirect
  - `ChatInterface.jsx` - Message rendering, input handling, quick replies
  - `ReviewSummary.jsx` - Data display accuracy
  - `SessionTimeoutWarning.jsx` - Timer logic, warning display
- Add **Playwright** or **Cypress** for end-to-end testing of the complete intake flow
- Estimated effort: 5-7 days

#### 2.5 Add Error Boundaries (Priority: MEDIUM)

**Problem**: No React Error Boundary components. An unhandled JavaScript error in any component crashes the entire app with a white screen.

**Recommendation**:
- Add a top-level `<ErrorBoundary>` that catches render errors and shows a friendly fallback
- Add route-level error boundaries so a crash in one page doesn't affect others
- Log caught errors to the backend for tracking
- Estimated effort: 1 day

#### 2.6 Adopt TypeScript (Priority: MEDIUM)

**Problem**: The frontend is vanilla JavaScript despite TypeScript being available in the project root. Complex state shapes (intake summary, household members, income sources) are error-prone without types.

**Recommendation**:
- Incrementally adopt TypeScript starting with shared types/interfaces
- Define types for API responses, intake state, and component props
- Use `// @ts-check` JSDoc comments as a bridge during migration
- Estimated effort: 3-5 days (incremental)

#### 2.7 Improve Mobile Experience (Priority: MEDIUM)

**Problem**: While Tailwind responsive classes are used, the intake chat interface could be better optimized for kiosk/tablet use in government offices.

**Recommendation**:
- Add touch-optimized gesture support for chat scrolling
- Increase button/input sizes for kiosk touch screens
- Test and optimize for common government-issued tablets (iPad, Samsung Galaxy Tab)
- Add PWA support (service worker, manifest) for offline resilience
- Estimated effort: 3-4 days

#### 2.8 Add Skeleton Loading States (Priority: LOW)

**Problem**: Loading states use simple text ("Loading...") rather than skeleton screens. Dashboards show blank white space while data loads.

**Recommendation**:
- Add skeleton components for dashboard cards, intake lists, and detail views
- Improves perceived performance significantly
- Estimated effort: 1-2 days

---

### 3. BACKEND DEVELOPER PERSPECTIVE

#### 3.1 Generate OpenAPI/Swagger Documentation (Priority: HIGH)

**Problem**: No API documentation exists. New developers must read route handlers to understand endpoints. No request/response schema documentation.

**Recommendation**:
- Add **swagger-jsdoc** + **swagger-ui-express** to auto-generate API docs
- Document all endpoints with request/response schemas, error codes, and auth requirements
- Serve interactive docs at `/api/docs`
- Estimated effort: 2-3 days

#### 3.2 Add Background Job Processing (Priority: MEDIUM)

**Problem**: CSV export runs synchronously and blocks the request. Large exports could timeout. No infrastructure for future async needs (email notifications, report generation).

**Recommendation**:
- Introduce **BullMQ** with Redis for background job processing
- Move CSV export to async job with progress tracking
- Prepare infrastructure for future needs: email notifications, scheduled reports, intake reminders
- Estimated effort: 3-4 days

#### 3.3 Improve Test Coverage for API Routes (Priority: HIGH)

**Problem**: Tests focus on business logic (calculator, consistency checks) but don't test HTTP endpoints. No integration tests that exercise the full request/response cycle.

**Recommendation**:
- Add **Supertest** for HTTP endpoint testing
- Test auth flows: login, token validation, role enforcement, session expiry
- Test intake lifecycle: start → message → summary → complete
- Test error scenarios: rate limiting, injection blocking, invalid input
- Test admin operations: user management, audit log, CSV export
- Estimated effort: 4-5 days

#### 3.4 Add Request Validation Middleware (Priority: MEDIUM)

**Problem**: Input validation is scattered across route handlers. No centralized schema validation for request bodies.

**Recommendation**:
- Use **Zod** (already a dependency) for request body validation middleware
- Create schemas for each endpoint's expected input
- Return structured validation errors with field-level detail
- Estimated effort: 2-3 days

#### 3.5 Implement Webhook/Event System (Priority: LOW)

**Problem**: No way to notify external systems when intake events occur (completed, flagged, reviewed). County IT systems may need integration points.

**Recommendation**:
- Add webhook registration for key events (intake completed, high-risk flagged)
- Use an event emitter pattern internally for loose coupling
- Document webhook payload schemas
- Estimated effort: 3-4 days

#### 3.6 Add Database Soft Deletes (Priority: LOW)

**Problem**: Caseworker deactivation and data deletion are hard deletes. For government compliance, soft deletes with retention policies may be required.

**Recommendation**:
- Add `deletedAt` timestamp field to Caseworker and other applicable models
- Filter soft-deleted records in queries by default
- Add admin endpoint to permanently purge records after retention period
- Estimated effort: 1-2 days

#### 3.7 Implement Rate Limiting Per-User (Priority: MEDIUM)

**Problem**: Rate limiting exists but is IP-based. Shared kiosk IPs could affect all users. No per-user or per-session throttling.

**Recommendation**:
- Add session-token-based rate limiting for intake endpoints
- Add user-ID-based rate limiting for authenticated endpoints
- Use Redis-backed rate limiter for distributed deployments
- Estimated effort: 1-2 days

---

## Prioritized Implementation Roadmap

### Phase 1: Stability & Security (Weeks 1-2)
| # | Item | Owner | Effort |
|---|------|-------|--------|
| 1 | Redis session store | Architect + Backend | 2-3 days |
| 2 | Auth context + route guards | Frontend | 2 days |
| 3 | Error boundaries | Frontend | 1 day |
| 4 | Structured logging (Pino + Sentry) | Backend | 3 days |

### Phase 2: Quality & Testing (Weeks 3-4)
| # | Item | Owner | Effort |
|---|------|-------|--------|
| 5 | Frontend test setup + critical tests | Frontend | 5-7 days |
| 6 | API route integration tests | Backend | 4-5 days |
| 7 | OpenAPI documentation | Backend | 2-3 days |
| 8 | Zod request validation middleware | Backend | 2-3 days |

### Phase 3: Performance & DX (Weeks 5-6)
| # | Item | Owner | Effort |
|---|------|-------|--------|
| 9 | Code splitting + lazy loading | Frontend | 1 day |
| 10 | Background job processing (BullMQ) | Backend | 3-4 days |
| 11 | CI/CD pipeline (GitHub Actions) | Architect | 3-5 days |
| 12 | Database connection pooling | Architect | 1-2 days |

### Phase 4: Polish & Scale (Weeks 7-8)
| # | Item | Owner | Effort |
|---|------|-------|--------|
| 13 | TypeScript migration (incremental) | Frontend | 3-5 days |
| 14 | Mobile/kiosk optimization + PWA | Frontend | 3-4 days |
| 15 | API versioning | Architect | 1 day |
| 16 | Skeleton loading states | Frontend | 1-2 days |
| 17 | Per-user rate limiting | Backend | 1-2 days |
| 18 | Webhook/event system | Backend | 3-4 days |

---

## What's Working Well (Keep Doing)

- **Security-first design**: PII stripping, injection guards, audit trail - excellent for government context
- **Accessibility**: WCAG 2.1 AA compliance with skip links, ARIA, focus management, reduced motion
- **AI resilience**: Circuit breaker with automatic failover is production-ready
- **Conversational UX**: Chat-based intake is more engaging than traditional forms
- **SNAP calculation accuracy**: Well-tested with persona-based scenarios
- **Consistency checking**: 14-rule risk scoring catches data integrity issues before caseworker review
- **Minimal PII collection**: Only first name + last initial stored - strong privacy posture
- **Bilingual support**: English/Spanish from day one

---

## Key Metrics to Track Post-Improvements

| Metric | Current Baseline | Target |
|--------|-----------------|--------|
| Intake completion rate | Unknown | >85% |
| Average intake duration | Unknown | <15 min |
| Frontend error rate | Unknown (no tracking) | <0.1% |
| API p95 latency | Unknown (no APM) | <500ms |
| AI failover frequency | Logged but not tracked | <1% of requests |
| Test coverage (backend) | ~60% business logic | >80% overall |
| Test coverage (frontend) | 0% | >50% critical paths |
| Accessibility score | High (manual) | 100 Lighthouse |
| Uptime | Unknown | 99.9% |
