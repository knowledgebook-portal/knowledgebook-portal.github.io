-- ============================================================================
--  KnowledgeBox — Supabase schema
--  Run this once in your Supabase project: SQL Editor → New query → paste → Run
-- ============================================================================

-- Enable pg_trgm so we get fast full-text-style search via GIN indexes
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- docs: the markdown documents
-- ---------------------------------------------------------------------------
create table if not exists public.docs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'Untitled',
  content     text not null default '',
  tags        text[] not null default '{}',
  pinned      boolean not null default false,
  is_public   boolean not null default false,         -- public read link
  share_token text unique,                            -- random slug for share links
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists docs_owner_id_idx       on public.docs(owner_id);
create index if not exists docs_updated_at_idx     on public.docs(owner_id, updated_at desc);
create index if not exists docs_title_trgm_idx     on public.docs using gin (title gin_trgm_ops);
create index if not exists docs_content_trgm_idx   on public.docs using gin (content gin_trgm_ops);
create index if not exists docs_tags_gin_idx       on public.docs using gin (tags);
create index if not exists docs_share_token_idx    on public.docs(share_token) where share_token is not null;

-- Auto-update updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists docs_touch_updated_at on public.docs;
create trigger docs_touch_updated_at
  before update on public.docs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- doc_versions: every save creates a row so users can revert
-- ---------------------------------------------------------------------------
create table if not exists public.doc_versions (
  id         uuid primary key default gen_random_uuid(),
  doc_id     uuid not null references public.docs(id) on delete cascade,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  content    text not null,
  tags       text[] not null default '{}',
  saved_at   timestamptz not null default now(),
  saved_by   uuid references auth.users(id)
);

create index if not exists doc_versions_doc_idx on public.doc_versions(doc_id, saved_at desc);

-- Trigger: on every UPDATE of docs.content/title/tags, snapshot a version
create or replace function public.snapshot_doc_version()
returns trigger language plpgsql as $$
begin
  if (new.title is distinct from old.title
      or new.content is distinct from old.content
      or new.tags is distinct from old.tags) then
    insert into public.doc_versions (doc_id, owner_id, title, content, tags, saved_by)
    values (old.id, old.owner_id, old.title, old.content, old.tags, auth.uid());
  end if;
  return new;
end $$;

drop trigger if exists docs_snapshot_version on public.docs;
create trigger docs_snapshot_version
  before update on public.docs
  for each row execute function public.snapshot_doc_version();

-- ---------------------------------------------------------------------------
-- profiles: lightweight user info (display name, avatar etc.)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- Row Level Security: lock everything down to owners (+ public share tokens)
-- ===========================================================================
alter table public.docs          enable row level security;
alter table public.doc_versions  enable row level security;
alter table public.profiles      enable row level security;

-- docs: owner can do everything with their own rows
drop policy if exists "docs_select_owner" on public.docs;
create policy "docs_select_owner" on public.docs
  for select using (auth.uid() = owner_id);

drop policy if exists "docs_insert_owner" on public.docs;
create policy "docs_insert_owner" on public.docs
  for insert with check (auth.uid() = owner_id);

drop policy if exists "docs_update_owner" on public.docs;
create policy "docs_update_owner" on public.docs
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "docs_delete_owner" on public.docs;
create policy "docs_delete_owner" on public.docs
  for delete using (auth.uid() = owner_id);

-- Public read via share_token (anyone unauthenticated with the link can view)
drop policy if exists "docs_select_public_share" on public.docs;
create policy "docs_select_public_share" on public.docs
  for select using (is_public = true and share_token is not null);

-- doc_versions: owner only
drop policy if exists "versions_select_owner" on public.doc_versions;
create policy "versions_select_owner" on public.doc_versions
  for select using (auth.uid() = owner_id);

drop policy if exists "versions_insert_owner" on public.doc_versions;
create policy "versions_insert_owner" on public.doc_versions
  for insert with check (auth.uid() = owner_id);

-- profiles: everyone can read, only owner can write their row
drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select using (true);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using (auth.uid() = id);
