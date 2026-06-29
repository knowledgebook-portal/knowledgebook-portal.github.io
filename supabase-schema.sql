-- ============================================================================
--  KnowledgeBox — Supabase schema (v3: admin-only, no self-signup)
--
--  ⚠️ DANGER: this is the CLEAN-SLATE installer. It DROPS all existing data
--  (docs, doc_versions, profiles) before recreating the schema.
--
--  Use this ONLY for:
--    1. First-time setup on a fresh Supabase project, OR
--    2. After downloading a backup and wanting to wipe + restore
--
--  To ADD the storage-stats + backup helper functions to an EXISTING database
--  WITHOUT losing data, run `supabase-schema-update.sql` instead.
--
--  Run in: SQL Editor -> New query -> paste -> Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Clean slate: drop legacy objects so we start fresh.
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created   on auth.users;
drop trigger if exists docs_touch_updated_at  on public.docs;
drop trigger if exists docs_snapshot_version  on public.docs;

drop function if exists public.handle_new_user        cascade;
drop function if exists public.touch_updated_at       cascade;
drop function if exists public.snapshot_doc_version   cascade;
drop function if exists public.is_active_user         cascade;
drop function if exists public.is_admin               cascade;
drop function if exists public.can_write              cascade;

drop table if exists public.doc_versions cascade;
drop table if exists public.docs         cascade;
drop table if exists public.profiles     cascade;
drop table if exists public.invites      cascade;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- profiles: identity + role
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text not null,
  display_name         text,
  avatar_url           text,
  role                 text not null default 'viewer' check (role in ('admin','editor','viewer')),
  status               text not null default 'active' check (status in ('active','disabled')),
  must_change_password boolean not null default true,
  created_at           timestamptz not null default now()
);

create index profiles_role_idx   on public.profiles(role);
create index profiles_status_idx on public.profiles(status);

-- ---------------------------------------------------------------------------
-- docs
-- ---------------------------------------------------------------------------
create table public.docs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'Untitled',
  content     text not null default '',
  tags        text[] not null default '{}',
  pinned      boolean not null default false,
  is_public   boolean not null default false,
  share_token text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index docs_owner_id_idx     on public.docs(owner_id);
create index docs_updated_at_idx   on public.docs(updated_at desc);
create index docs_title_trgm_idx   on public.docs using gin (title gin_trgm_ops);
create index docs_content_trgm_idx on public.docs using gin (content gin_trgm_ops);
create index docs_tags_gin_idx     on public.docs using gin (tags);
create index docs_share_token_idx  on public.docs(share_token) where share_token is not null;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger docs_touch_updated_at
  before update on public.docs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- doc_versions
-- ---------------------------------------------------------------------------
create table public.doc_versions (
  id         uuid primary key default gen_random_uuid(),
  doc_id     uuid not null references public.docs(id) on delete cascade,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  content    text not null,
  tags       text[] not null default '{}',
  saved_at   timestamptz not null default now(),
  saved_by   uuid references auth.users(id)
);

create index doc_versions_doc_idx on public.doc_versions(doc_id, saved_at desc);

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

create trigger docs_snapshot_version
  before update on public.docs
  for each row execute function public.snapshot_doc_version();

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active');
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active' and role = 'admin');
$$;

create or replace function public.can_write()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active' and role in ('admin','editor'));
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS
-- ---------------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.docs         enable row level security;
alter table public.doc_versions enable row level security;

-- ---- profiles ----
create policy "profiles_select_active" on public.profiles
  for select using (public.is_active_user() or id = auth.uid());

-- Users update their own display_name/avatar but NOT role/status (admins do that)
create policy "profiles_update_self_safe" on public.profiles
  for update using (id = auth.uid())
              with check (
                id = auth.uid()
                and role = (select role from public.profiles where id = auth.uid())
                and status = (select status from public.profiles where id = auth.uid())
              );

-- Admins can update any profile, including role/status
create policy "profiles_admin_update" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

create policy "profiles_admin_delete" on public.profiles
  for delete using (public.is_admin());

-- ---- docs ----
create policy "docs_select_active" on public.docs
  for select using (public.is_active_user());

-- Public read for share links (no auth required)
create policy "docs_select_public_share" on public.docs
  for select using (is_public = true and share_token is not null);

create policy "docs_insert_writers" on public.docs
  for insert with check (public.can_write() and auth.uid() = owner_id);

create policy "docs_update_writers" on public.docs
  for update using (public.can_write() and (auth.uid() = owner_id or public.is_admin()))
              with check (public.can_write() and (auth.uid() = owner_id or public.is_admin()));

create policy "docs_delete_writers" on public.docs
  for delete using (public.can_write() and (auth.uid() = owner_id or public.is_admin()));

-- ---- doc_versions ----
create policy "versions_select_active" on public.doc_versions
  for select using (public.is_active_user());

create policy "versions_insert_writers" on public.doc_versions
  for insert with check (public.can_write());

-- ---------------------------------------------------------------------------
-- Helper: db stats (used by db-stats Edge Function for the storage indicator)
-- ---------------------------------------------------------------------------
create or replace function public.kb_db_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_total bigint;
  v_tables jsonb;
begin
  -- Only admins can call this
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  select pg_database_size(current_database()) into v_total;

  select coalesce(jsonb_agg(jsonb_build_object(
    'name',  t.table_name,
    'rows',  c.reltuples::bigint,
    'bytes', pg_total_relation_size(format('public.%I', t.table_name)::regclass),
    'pretty_size', pg_size_pretty(pg_total_relation_size(format('public.%I', t.table_name)::regclass))
  ) order by pg_total_relation_size(format('public.%I', t.table_name)::regclass) desc), '[]'::jsonb)
  into v_tables
  from information_schema.tables t
  join pg_class c on c.relname = t.table_name
  where t.table_schema = 'public'
    and t.table_type = 'BASE TABLE';

  return jsonb_build_object(
    'total_bytes', v_total,
    'tables', v_tables
  );
end $$;

revoke all on function public.kb_db_stats() from public;
grant execute on function public.kb_db_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- Helper: full data backup (used by db-backup Edge Function)
-- Returns every row from every public table as a single JSON blob.
-- ---------------------------------------------------------------------------
create or replace function public.kb_db_backup()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_out  jsonb := '{}'::jsonb;
  v_docs jsonb;
  v_vers jsonb;
  v_prof jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at), '[]'::jsonb) into v_docs from public.docs d;
  select coalesce(jsonb_agg(to_jsonb(v) order by v.saved_at),  '[]'::jsonb) into v_vers from public.doc_versions v;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at),'[]'::jsonb) into v_prof from public.profiles p;

  return jsonb_build_object(
    'exported_at',  now(),
    'app',          'knowledgebox',
    'schema_version', 'v3',
    'docs',         v_docs,
    'doc_versions', v_vers,
    'profiles',     v_prof
  );
end $$;

revoke all on function public.kb_db_backup() from public;
grant execute on function public.kb_db_backup() to authenticated;

-- ===========================================================================
-- DISABLE SUPABASE'S BUILT-IN SIGNUP
-- ===========================================================================
-- App-level: don't render signup UI (already done in app.js).
-- API-level: the Edge Function 'admin-users' creates accounts with the service
-- role, bypassing public signup. To FULLY block public signup, also turn off
-- "Allow new users to sign up" in Supabase Dashboard:
--   Authentication -> Providers -> Email -> Enable email signups: OFF
-- This is the most important manual step. The app only does sign-in.
-- ===========================================================================
