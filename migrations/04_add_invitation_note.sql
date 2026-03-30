-- Add note fields to sequence_steps for send_invitation steps
ALTER TABLE sequence_steps 
ADD COLUMN IF NOT EXISTS has_note BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS note_content TEXT DEFAULT NULL;
