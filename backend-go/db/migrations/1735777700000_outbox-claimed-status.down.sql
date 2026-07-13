-- Reverts 1735777700000_outbox-claimed-status.up.sql. Any row still
-- sitting in 'claimed' at rollback time is reset to 'pending' first, so
-- the old two-state (pending/dispatched/failed) constraint can be
-- re-applied without failing on data outside the pre-migration enum.
UPDATE outbox SET status = 'pending', claimed_at = NULL WHERE status = 'claimed';
ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending', 'dispatched', 'failed'));
ALTER TABLE outbox DROP COLUMN claimed_at;
