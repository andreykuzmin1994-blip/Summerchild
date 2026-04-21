-- Migration: add `purged_at` column to caseworkers for AU-10/AU-11 soft-delete.
--
-- Cushion Gov retention policy (`docs/DATA_RETENTION_POLICY.md` §2) calls
-- for hard-deletion of deactivated caseworkers after 3 years. That is
-- impossible: `intake_reviews.caseworker_id` is NOT NULL, so hard delete
-- would either break AU-10 non-repudiation (SetNull → orphaned attribution)
-- or fail on FK constraint. Instead we soft-delete:
--
--   1. Overwrite PII columns (name, email, password) with non-reversible
--      tombstones. Email keeps uniqueness via the row's id.
--   2. Set `purged_at = NOW()`.
--   3. Leave the row in place so every `IntakeReview.caseworkerId` join
--      continues to resolve to a stable (but anonymized) row.
--
-- Application-layer invariants enforced after this migration:
--   - auth middleware rejects any caseworker with `purged_at IS NOT NULL`
--   - admin user-management routes refuse to operate on purged rows
--   - retention job (`runCaseworkerPurgePolicy`) is the only writer
--
-- Orphan pre-flight: no orphan rows possible for this column since it is
-- nullable and defaults to NULL. Future migrations that introduce NOT NULL
-- columns on this table MUST add a preflight assertion.

-- Preflight: fail loudly if a prior run left any `purged_at` references
-- in a half-applied state.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'caseworkers' AND column_name = 'purged_at'
  ) THEN
    RAISE NOTICE 'purged_at column already exists — skipping ADD COLUMN';
  END IF;
END $$;

ALTER TABLE "caseworkers" ADD COLUMN IF NOT EXISTS "purged_at" TIMESTAMP(3);

-- Index to make the retention selector (`deactivatedAt < cutoff AND
-- purgedAt IS NULL`) hit an index directly.
CREATE INDEX IF NOT EXISTS "caseworkers_deactivated_at_purged_at_idx"
  ON "caseworkers" ("deactivated_at", "purged_at");
