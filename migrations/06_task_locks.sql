-- Sprint 2 Part 3 — Task Locks for concurrent execution prevention

BEGIN;

-- ============================================================================
-- CREATE task_locks TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_locks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lock_type TEXT NOT NULL, -- 'linkedin_[slug]', 'chrome_automation', etc.
  task_name TEXT NOT NULL, -- 'task2', 'scheduler', etc.
  locked_by TEXT NOT NULL, -- worker/process name
  acquired_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, lock_type)
);

CREATE INDEX IF NOT EXISTS idx_task_locks_account_type ON task_locks(account_id, lock_type);
CREATE INDEX IF NOT EXISTS idx_task_locks_expires ON task_locks(expires_at);

COMMIT;
