-- Migration 21: Add step_order to interactions for matching sent messages to sequence steps
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS step_order INTEGER;
