-- Run this once in Supabase SQL Editor.
-- These columns store the custom question name/category metadata,
-- lock state, and a SHA-256 PIN hash (never the plain PIN).

alter table public.questions
  add column if not exists question_name text default '',
  add column if not exists subcategory text default 'General',
  add column if not exists lesson text default 'General',
  add column if not exists locked boolean not null default false,
  add column if not exists pin_hash text;

-- Optional safety checks.
alter table public.questions
  drop constraint if exists questions_pin_hash_check;

alter table public.questions
  add constraint questions_pin_hash_check
  check (pin_hash is null or length(pin_hash) between 64 and 70);
