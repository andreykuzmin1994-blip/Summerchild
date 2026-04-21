-- Migration: add ABANDONED and TIMED_OUT values to IntakeStatus enum.
--
-- NIST 800-53 AU-11. These values are already referenced by the application
-- (`src/services/auditLogger.js` emits INTAKE_ABANDONED / INTAKE_TIMED_OUT).
-- Until this migration lands the values were logical-only; now a row can be
-- persisted with either status so `src/services/retentionJob.js`
-- `runAbandonedIntakePolicy` has something to delete.
--
-- Split into its own migration intentionally. Postgres ≤13 refuses
-- `ALTER TYPE ... ADD VALUE` inside a transaction that later references
-- the new value. Keeping this DDL alone lets the ADD VALUE commit before
-- any subsequent migration uses it.
--
-- Rollback is a one-way door: Postgres does not support dropping enum
-- values. Reverting requires a full `CREATE TYPE ..._new`, UPDATE + cast,
-- DROP TYPE, RENAME dance under an ACCESS EXCLUSIVE lock. Documented
-- rollback procedure: contact DBA on-call.

ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'ABANDONED';
ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'TIMED_OUT';
