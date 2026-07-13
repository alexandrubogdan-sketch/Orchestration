-- 2026-07-10 (backend review, task: fix outbox relay dispatched-before-
-- attempted bug): splits the outbox relay's "claim" step from its
-- "actually dispatched" step, which the original 'pending' ->
-- 'dispatched' -> 'failed' status machine conflated.
--
-- Bug this fixes: internal/outbox/relay.go's DrainBatch used to flip a
-- claimed batch's status straight to 'dispatched' inside the SAME
-- claiming transaction that SELECT ... FOR UPDATE SKIP LOCKED'd it —
-- BEFORE the worker had even attempted the real dispatch call
-- (client.RunNoWait against Hatchet) for any row in that batch. If the
-- worker process crashed (or was killed/rescheduled) after that
-- transaction committed but before the per-row dispatch loop reached a
-- given row, that row was permanently marked 'dispatched' despite never
-- having been dispatched at all — and nothing ever revisits a
-- 'dispatched' row, since DrainBatch's WHERE clause only ever selects
-- status = 'pending'. The event was silently lost.
--
-- Fix: introduce a third, non-terminal 'claimed' status distinct from
-- both 'pending' and 'dispatched'. DrainBatch's claim transaction now
-- sets status = 'claimed' (not 'dispatched') and stamps claimed_at.
-- MarkDispatched now sets status = 'dispatched' itself (previously this
-- column update alone was enough, since DrainBatch had already set the
-- status column). A new reconciliation sweep
-- (internal/outbox.ReconcileStuckClaims, run at the start of every
-- outbox.relay tick — see internal/worker/tasks.go's
-- outboxRelayHandler) finds any row still 'claimed' after a staleness
-- window comfortably longer than one relay cycle and reverts it to
-- 'pending', so a crash mid-dispatch self-heals on the very next tick
-- instead of silently losing the event forever.
ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending', 'claimed', 'dispatched', 'failed'));
ALTER TABLE outbox ADD COLUMN claimed_at timestamptz;
