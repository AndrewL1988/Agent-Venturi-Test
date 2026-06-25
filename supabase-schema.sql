-- ═══════════════════════════════════════════════════════════
-- ACE VENTURI: CONTROLS DETECTIVE — Supabase Database Schema
-- Run this entire file in your Supabase SQL Editor
-- Dashboard → SQL Editor → New Query → paste → Run
-- ═══════════════════════════════════════════════════════════

-- Enable UUID extension (usually already enabled)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── CHATS TABLE ──────────────────────────────────────────
-- Stores full conversation history per user
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,             -- client-generated ID (makeId())
  user_id     TEXT NOT NULL,               -- Clerk user ID (e.g. "user_2abc...")
  title       TEXT NOT NULL DEFAULT 'New chat',
  messages    JSONB NOT NULL DEFAULT '[]', -- array of {role, content, images, apiContent}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast user chat lookups
CREATE INDEX IF NOT EXISTS chats_user_id_idx ON chats(user_id);
CREATE INDEX IF NOT EXISTS chats_updated_at_idx ON chats(updated_at DESC);

-- ─── ALARM LOGS TABLE ─────────────────────────────────────
-- Stores field alarm log entries per user
CREATE TABLE IF NOT EXISTS alarm_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  date        TEXT,
  location    TEXT,
  device      TEXT,
  alarm_type  TEXT,
  description TEXT,
  resolution  TEXT,
  status      TEXT DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alarm_logs_user_id_idx ON alarm_logs(user_id);

-- ─── ASSETS TABLE ─────────────────────────────────────────
-- Stores equipment registry entries per user
CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  building     TEXT,
  floor        TEXT,
  room         TEXT,
  hood         TEXT,
  model        TEXT,
  serial       TEXT,
  firmware     TEXT,
  min_cfm      TEXT,
  max_cfm      TEXT,
  comm_date    TEXT,
  tech         TEXT,
  notes        TEXT,
  status       TEXT DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS assets_user_id_idx ON assets(user_id);

-- ─── ROW LEVEL SECURITY (RLS) ─────────────────────────────
-- CRITICAL: This ensures users can only see their own data

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarm_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

-- Chats policies
CREATE POLICY "Users can view own chats"
  ON chats FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "Users can insert own chats"
  ON chats FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "Users can update own chats"
  ON chats FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "Users can delete own chats"
  ON chats FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

-- Alarm logs policies
CREATE POLICY "Users can manage own alarms"
  ON alarm_logs FOR ALL
  USING (user_id = current_setting('app.current_user_id', true));

-- Assets policies
CREATE POLICY "Users can manage own assets"
  ON assets FOR ALL
  USING (user_id = current_setting('app.current_user_id', true));

-- ─── UPDATED_AT TRIGGER ───────────────────────────────────
-- Automatically updates updated_at on row changes
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_chats_updated_at
  BEFORE UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_alarm_logs_updated_at
  BEFORE UPDATE ON alarm_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_assets_updated_at
  BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── DONE ─────────────────────────────────────────────────
-- Your database is ready.
-- Next: add REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY to your .env

-- Response feedback table for thumbs up/down training data
CREATE TABLE IF NOT EXISTS response_feedback (
  id bigserial PRIMARY KEY,
  rating text NOT NULL CHECK (rating IN ('up', 'down')),
  question text,
  response text,
  user_id text,
  created_at timestamptz DEFAULT now()
);

-- Index for querying negative feedback (most useful for training)
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON response_feedback(rating);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON response_feedback(created_at DESC);

-- View for easy review of thumbs-down responses
CREATE OR REPLACE VIEW feedback_review AS
SELECT
  id,
  rating,
  created_at,
  user_id,
  left(question, 200) AS question_preview,
  left(response, 300) AS response_preview
FROM response_feedback
ORDER BY created_at DESC;
