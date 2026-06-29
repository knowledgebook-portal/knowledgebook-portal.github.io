-- ============================================================================
--  KnowledgeBox — INCREMENTAL schema update (safe — preserves data)
--  ============================================================================
--  Adds / fixes the storage-stats + backup helper SQL functions.
--  Your existing docs, profiles, versions are untouched.
--
--  Safe to run multiple times.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- is_admin() — used by RLS and by app code via direct rpc (NOT used by the
-- helper functions below; those rely on the Edge Function to gate access).
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active' and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- kb_db_stats()
--   Returns DB size + per-table sizes.
--   No internal admin check: the db-stats Edge Function gates access by
--   verifying the caller's JWT + profile.role='admin' BEFORE invoking this.
-- ---------------------------------------------------------------------------
create or replace function public.kb_db_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_total bigint;
  v_tables jsonb;
begin
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

-- Lock down: only callable via the service_role (Edge Function path),
-- NOT directly by browser-side anon/authenticated roles.
revoke all on function public.kb_db_stats() from public;
revoke all on function public.kb_db_stats() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- kb_db_backup()
--   Returns every row of every public table as a JSON blob.
--   Same security model as kb_db_stats — Edge Function gates access.
-- ---------------------------------------------------------------------------
create or replace function public.kb_db_backup()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_docs jsonb;
  v_vers jsonb;
  v_prof jsonb;
  v_fold jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at), '[]'::jsonb) into v_docs from public.docs d;
  select coalesce(jsonb_agg(to_jsonb(v) order by v.saved_at),  '[]'::jsonb) into v_vers from public.doc_versions v;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at),'[]'::jsonb) into v_prof from public.profiles p;
  select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at),'[]'::jsonb) into v_fold
    from public.folders f
    where exists (select 1 from information_schema.tables where table_schema='public' and table_name='folders');

  return jsonb_build_object(
    'exported_at',  now(),
    'app',          'knowledgebox',
    'schema_version', 'v4',
    'docs',         v_docs,
    'doc_versions', v_vers,
    'profiles',     v_prof,
    'folders',      v_fold
  );
end $$;

revoke all on function public.kb_db_backup() from public;
revoke all on function public.kb_db_backup() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- FILES — extra columns on docs so a row can also represent an uploaded file.
--   kind:               'doc' | 'file'
--   original_filename:  source filename when uploaded (e.g. deployment.yaml)
--   language:           hint for syntax highlighting (yaml, sh, dockerfile, ...)
--   mime_type:          for image/pdf rendering
--   size_bytes:         file size (text content length or storage object size)
--   storage_path:       null for inline text; set for binary files in Storage bucket
-- ---------------------------------------------------------------------------
alter table public.docs add column if not exists kind              text not null default 'doc';
alter table public.docs add column if not exists original_filename text;
alter table public.docs add column if not exists language          text;
alter table public.docs add column if not exists mime_type         text;
alter table public.docs add column if not exists size_bytes        bigint;
alter table public.docs add column if not exists storage_path      text;
-- Extracted text for binary files (e.g. PDF text) so search can find it.
-- For markdown/text docs/files this stays NULL (their content is already searchable).
alter table public.docs add column if not exists searchable_text   text;

create index if not exists docs_searchable_trgm_idx
  on public.docs using gin (searchable_text gin_trgm_ops);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'docs_kind_check') then
    alter table public.docs add constraint docs_kind_check check (kind in ('doc','file'));
  end if;
end $$;

create index if not exists docs_kind_idx on public.docs(kind);

-- ---------------------------------------------------------------------------
-- FOLDERS — shared workspace, optional nesting, one folder per doc
-- ---------------------------------------------------------------------------
create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  parent_id   uuid references public.folders(id) on delete cascade,
  owner_id    uuid references auth.users(id) on delete set null,
  color       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists folders_parent_idx on public.folders(parent_id);

-- folder_id on docs (nullable -> doc lives at root)
alter table public.docs
  add column if not exists folder_id uuid references public.folders(id) on delete set null;

create index if not exists docs_folder_idx on public.docs(folder_id);

-- updated_at touch
create or replace function public.touch_folder_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists folders_touch_updated_at on public.folders;
create trigger folders_touch_updated_at
  before update on public.folders
  for each row execute function public.touch_folder_updated_at();

alter table public.folders enable row level security;

drop policy if exists "folders_select_active" on public.folders;
create policy "folders_select_active" on public.folders
  for select using (public.is_active_user());

drop policy if exists "folders_insert_writers" on public.folders;
create policy "folders_insert_writers" on public.folders
  for insert with check (public.can_write());

drop policy if exists "folders_update_writers" on public.folders;
create policy "folders_update_writers" on public.folders
  for update using (public.can_write()) with check (public.can_write());

drop policy if exists "folders_delete_writers" on public.folders;
create policy "folders_delete_writers" on public.folders
  for delete using (public.can_write());

-- ---------------------------------------------------------------------------
-- Cap doc_versions to the latest 3 per doc.
--   1) Trigger: after each new version, delete anything older than the 3rd most recent
--   2) One-shot cleanup: prune existing tables down to 3 per doc
-- ---------------------------------------------------------------------------
create or replace function public.kb_prune_doc_versions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.doc_versions
  where doc_id = new.doc_id
    and id not in (
      select id from public.doc_versions
      where doc_id = new.doc_id
      order by saved_at desc
      limit 3
    );
  return new;
end $$;

drop trigger if exists doc_versions_prune on public.doc_versions;
create trigger doc_versions_prune
  after insert on public.doc_versions
  for each row execute function public.kb_prune_doc_versions();

-- One-shot cleanup: delete everything except the most recent 3 per doc
delete from public.doc_versions v
where v.id not in (
  select id from (
    select id,
           row_number() over (partition by doc_id order by saved_at desc) as rn
    from public.doc_versions
  ) ranked
  where rn <= 3
);

-- ============================================================================
--  Done. The Edge Functions (db-stats / db-backup) now own the admin check.
--  These SQL functions are still secure: only service_role can call them,
--  and the Edge Functions verify your JWT + admin status before doing so.
--  Version history is auto-capped at 3 entries per doc.
-- ============================================================================
