-- Migration: add assignee column to deal_metadata (assignation d'un deal à une personne)
-- Run this SQL in your Supabase SQL Editor (https://supabase.com/dashboard)

ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS assignee TEXT;

-- Valeurs attendues : 'Guillaume', 'Vincent', 'Nathan' ou NULL (non assigné)
