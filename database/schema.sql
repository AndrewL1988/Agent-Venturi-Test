-- ============================================================
-- Ace Venturi: Controls Detective — Supabase Database Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── Users table (mirrors Clerk users) ────────────────────────
create table if not exists public.users (
  id            text primary key,          -- Clerk user ID (e.g. user_2abc...)
  email         text unique not null,
  full_name     text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  is_active     boolean default true
);

-- ── Chats table ───────────────────────────────────────────────
create table if not exists public.chats (
  id            uuid primary key default uuid_generate_v4(),
  user_id       text not null references public.users(id) on delete cascade,
  title         text not null default 'New chat',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Messages table ────────────────────────────────────────────
create table if not exists public.messages (
  id            uuid primary key default uuid_generate_v4(),
  chat_id       uuid not null references public.chats(id) on delete cascade,
  user_id       text not null references public.users(id) on delete cascade,
  role          text not null check (role in ('user', 'assistant')),
  content       text not null,
  images        jsonb,                      -- array of base64 preview URLs
  created_at    timestamptz default now()
);

-- ── Alarm logs table ──────────────────────────────────────────
create table if not exists public.alarm_logs (
  id            uuid primary key default uuid_generate_v4(),
  user_id       text not null references public.users(id) on delete cascade,
  date          text,
  location      text,
  device        text,
  alarm_type    text,
  description   text,
  resolution    text,
  status        text default 'open',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Equipment registry table ──────────────────────────────────
create table if not exists public.equipment (
  id            uuid primary key default uuid_generate_v4(),
  user_id       text not null references public.users(id) on delete cascade,
  building      text,
  floor         text,
  room          text,
  hood          text,
  model         text,
  serial        text,
  firmware      text,
  min_cfm       text,
  max_cfm       text,
  comm_date     text,
  tech          text,
  notes         text,
  status        text default 'active',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Indexes for performance ───────────────────────────────────
create index if not exists idx_chats_user_id     on public.chats(user_id);
create index if not exists idx_chats_updated_at  on public.chats(updated_at desc);
create index if not exists idx_messages_chat_id  on public.messages(chat_id);
create index if not exists idx_messages_user_id  on public.messages(user_id);
create index if not exists idx_alarm_logs_user   on public.alarm_logs(user_id);
create index if not exists idx_equipment_user    on public.equipment(user_id);

-- ── Row Level Security (RLS) — users only see their own data ──
alter table public.users       enable row level security;
alter table public.chats       enable row level security;
alter table public.messages    enable row level security;
alter table public.alarm_logs  enable row level security;
alter table public.equipment   enable row level security;

-- Users: only server (service role) can read/write
-- RLS is bypassed by service_role key — we'll use that in the server

-- ── Updated_at trigger function ───────────────────────────────
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger on_users_updated
  before update on public.users
  for each row execute procedure public.handle_updated_at();

create trigger on_chats_updated
  before update on public.chats
  for each row execute procedure public.handle_updated_at();

create trigger on_alarm_logs_updated
  before update on public.alarm_logs
  for each row execute procedure public.handle_updated_at();

create trigger on_equipment_updated
  before update on public.equipment
  for each row execute procedure public.handle_updated_at();

-- ============================================================
-- Done! Your schema is ready.
-- ============================================================
