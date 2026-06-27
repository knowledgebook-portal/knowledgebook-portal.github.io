-- ============================================================================
--  KnowledgeBox — Supabase schema (v2: roles + admin-managed access)
--  Idempotent: safe to re-run on an existing project.
--  Run in: SQL Editor -> New query -> paste -> Run
-- ============================================================================

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- BOOTSTRAP ADMIN
-- After your account signs up, set it as admin by running ONE line:
--   update public.profiles set role = 'admin', status = 'active' where id = (select id from auth.users where email = 'YOUR-EMAIL');
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- profiles: per-user metadata, role, status
--   role:   'admin' | 'editor' | 'viewer'
--   status: 'pending' (default after signup) | 'active' | 'disabled'
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  display_name  text,
  avatar_url    text,
  role          text not null default 'viewer'  check (role in ('admin','editor','viewer')),
  status        text not null default 'pending' check (status in ('pending','active','disabled')),
  created_at    timestamptz not null default now()
);

-- Idempotent: add columns to an older profiles table that lacked them
alter table public.profiles add column if not exists email     text;
alter table public.profiles add column if not exists role      text not null default 'viewer';
alter table public.profiles add column if not exists status    text not null default 'pending';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_check'
  ) then
    alter table public.profiles add constraint profiles_role_check check (role in ('admin','editor','viewer'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_status_check'
  ) then
    alter table public.profiles add constraint profiles_status_check check (status in ('pending','active','disabled'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- invites: admins pre-approve emails. When someone signs up with that email,
-- they auto-receive the role+status from the invite.
-- ---------------------------------------------------------------------------
create table if not exists public.invites (
  email      text primary key,
  role       text not null default 'editor' check (role in ('admin','editor','viewer')),
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- docs: the documents. Owned by their creator. Visible to all active users.
-- ---------------------------------------------------------------------------
create table if not exists public.docs (
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

create index if not exists docs_owner_id_idx     on public.docs(owner_id);
create index if not exists docs_updated_at_idx   on public.docs(updated_at desc);
create index if not exists docs_title_trgm_idx   on public.docs using gin (title gin_trgm_ops);
create index if not exists docs_content_trgm_idx on public.docs using gin (content gin_trgm_ops);
create index if not exists docs_tags_gin_idx     on public.docs using gin (tags);
create index if not exists docs_share_token_idx  on public.docs(share_token) where share_token is not null;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists docs_touch_updated_at on public.docs;
create trigger docs_touch_updated_at
  before update on public.docs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- doc_versions: every save snapshots prior state for rollback
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
-- New-user handler:
--   1) Create a profile row.
--   2) If their email exists in invites, auto-apply role + activate.
--   3) Otherwise, leave them pending (admin must approve).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role text := 'viewer';
  v_status text := 'pending';
  v_invite invites%rowtype;
begin
  select * into v_invite from public.invites where lower(email) = lower(new.email) limit 1;
  if found then
    v_role := v_invite.role;
    v_status := 'active';
    delete from public.invites where email = v_invite.email;
  end if;

  insert into public.profiles (id, email, display_name, role, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    v_role,
    v_status
  )
  on conflict (id) do update
    set email = excluded.email,
        role = case when public.profiles.role = 'viewer' and public.profiles.status = 'pending'
                    then excluded.role else public.profiles.role end,
        status = case when public.profiles.status = 'pending'
                      then excluded.status else public.profiles.status end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Helpers used by RLS
-- ---------------------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active'
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active' and role = 'admin'
  );
$$;

create or replace function public.can_write()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and status = 'active'
      and role in ('admin','editor')
  );
$$;

-- ===========================================================================
-- RLS
-- ===========================================================================
alter table public.docs         enable row level security;
alter table public.doc_versions enable row level security;
alter table public.profiles     enable row level security;
alter table public.invites      enable row level security;

-- ---- docs ----
drop policy if exists "docs_select_owner"        on public.docs;
drop policy if exists "docs_select_public_share" on public.docs;
drop policy if exists "docs_select_active"       on public.docs;
drop policy if exists "docs_insert_owner"        on public.docs;
drop policy if exists "docs_insert_writers"      on public.docs;
drop policy if exists "docs_update_owner"        on public.docs;
drop policy if exists "docs_update_writers"      on public.docs;
drop policy if exists "docs_delete_owner"        on public.docs;
drop policy if exists "docs_delete_writers"      on public.docs;

-- Any active user can READ any doc (the team shares a knowledge base)
create policy "docs_select_active" on public.docs
  for select using (public.is_active_user());

-- Anyone (even unauthenticated) can read docs that have been explicitly shared
create policy "docs_select_public_share" on public.docs
  for select using (is_public = true and share_token is not null);

-- Only editors/admins create docs; owner must be themselves
create policy "docs_insert_writers" on public.docs
  for insert with check (public.can_write() and auth.uid() = owner_id);

-- Editors/admins update their own docs; admin can update anything
create policy "docs_update_writers" on public.docs
  for update using (public.can_write() and (auth.uid() = owner_id or public.is_admin()))
              with check (public.can_write() and (auth.uid() = owner_id or public.is_admin()));

-- Same for delete
create policy "docs_delete_writers" on public.docs
  for delete using (public.can_write() and (auth.uid() = owner_id or public.is_admin()));

-- ---- doc_versions ----
drop policy if exists "versions_select_owner"   on public.doc_versions;
drop policy if exists "versions_insert_owner"   on public.doc_versions;
drop policy if exists "versions_select_active"  on public.doc_versions;
drop policy if exists "versions_insert_writers" on public.doc_versions;

create policy "versions_select_active" on public.doc_versions
  for select using (public.is_active_user());

create policy "versions_insert_writers" on public.doc_versions
  for insert with check (public.can_write());

-- ---- profiles ----
drop policy if exists "profiles_select_all"    on public.profiles;
drop policy if exists "profiles_update_self"   on public.profiles;
drop policy if exists "profiles_select_active" on public.profiles;
drop policy if exists "profiles_update_self_safe" on public.profiles;
drop policy if exists "profiles_admin_all"     on public.profiles;

-- Active users see all profiles (so the doc author names render)
create policy "profiles_select_active" on public.profiles
  for select using (public.is_active_user() or id = auth.uid());

-- Users can update their own display name + avatar but NOT their role/status
create policy "profiles_update_self_safe" on public.profiles
  for update using (id = auth.uid())
              with check (
                id = auth.uid()
                and role   = (select role   from public.profiles where id = auth.uid())
                and status = (select status from public.profiles where id = auth.uid())
              );

-- Admins can change anything (role, status) on any profile
create policy "profiles_admin_all" on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- invites (admin only) ----
drop policy if exists "invites_admin_all" on public.invites;
create policy "invites_admin_all" on public.invites
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- IMPORTANT: bootstrap your admin account.
-- After you sign up in the app the first time, run this once in SQL Editor:
--
--   update public.profiles
--   set role = 'admin', status = 'active'
--   where email = 'YOUR-EMAIL@example.com';
--
-- (Replace with your real email.)
-- ---------------------------------------------------------------------------
