# Local / self-hosted setup

If Supabase's free tier fills up, or you want full ownership of the data, you can move KnowledgeBox off the hosted Supabase onto:

- **Path A** — Self-hosted Supabase via Docker (recommended, app works unchanged)
- **Path B** — Plain PostgreSQL (local laptop or Azure) — requires a thin backend wrapper

Pick one. Path A is what most people should do.

---

## Path A — Self-hosted Supabase (recommended)

You'll run the whole Supabase stack (Postgres + Auth + APIs + Realtime + Storage) on your laptop using Docker. The KnowledgeBox app then talks to `http://localhost:8000` instead of `https://xxx.supabase.co` — **nothing else changes in the app code**.

### What you need

- A laptop with at least 4 GB free RAM
- Free disk space (~2 GB for Docker images)
- Your downloaded backup ZIP (from the in-app **Database & backup** modal)

### Step 1 — Install Docker Desktop

1. Download: **https://docs.docker.com/desktop/install/windows-install/**
2. Run installer (~5 min). Reboot when asked.
3. Open Docker Desktop. Sign in or skip. Make sure the green "Docker Desktop is running" status appears at bottom-left.

### Step 2 — Clone the Supabase stack

Open **PowerShell** in any folder, run:

```powershell
git clone --depth 1 https://github.com/supabase/supabase
cd supabase/docker
copy .env.example .env
```

Open the new `.env` file in Notepad. The defaults work for local-only use. Save and close.

### Step 3 — Start Supabase

```powershell
docker compose up -d
```

First time takes ~3 minutes (Docker downloads ~1.5 GB of images). When done, you'll see something like:

```
Creating supabase-db ... done
Creating supabase-kong ... done
Creating supabase-studio ... done
...
```

Open **http://localhost:8000** in your browser. You should see the Supabase Studio dashboard — exactly like the hosted one, but running on your laptop.

### Step 4 — Apply the schema

1. Studio → **SQL Editor** → **New query**
2. Open `supabase-schema.sql` from your KnowledgeBox project folder → copy all → paste
3. **Run**

Tables are now created.

### Step 5 — Restore your data

Two options — pick one:

#### Option 5a — Via SQL editor (simplest)

1. Open your backup JSON file (`knowledgebook-backup-*.json`) in Notepad
2. Copy the entire content
3. In Studio SQL Editor, run:
   ```sql
   create temp table _kb_restore (data jsonb);
   ```
4. Then run (replace `PASTE_HERE` with the JSON):
   ```sql
   insert into _kb_restore values ('PASTE_HERE'::jsonb);

   insert into public.docs (id, owner_id, title, content, tags, pinned, is_public, share_token, created_at, updated_at)
   select (d->>'id')::uuid, (d->>'owner_id')::uuid, d->>'title', d->>'content',
          array(select jsonb_array_elements_text(d->'tags')),
          (d->>'pinned')::boolean, (d->>'is_public')::boolean, d->>'share_token',
          (d->>'created_at')::timestamptz, (d->>'updated_at')::timestamptz
   from _kb_restore r, jsonb_array_elements(r.data->'docs') d
   on conflict (id) do nothing;

   insert into public.doc_versions (id, doc_id, owner_id, title, content, tags, saved_at, saved_by)
   select (v->>'id')::uuid, (v->>'doc_id')::uuid, (v->>'owner_id')::uuid,
          v->>'title', v->>'content',
          array(select jsonb_array_elements_text(v->'tags')),
          (v->>'saved_at')::timestamptz,
          nullif(v->>'saved_by','')::uuid
   from _kb_restore r, jsonb_array_elements(r.data->'doc_versions') v
   on conflict (id) do nothing;
   ```

#### Option 5b — Via psql

```powershell
# Connect to the local Supabase Postgres
docker exec -it supabase-db psql -U postgres
```

Inside psql, run `\i /path/to/restore.sql` with a file containing the SQL above.

### Step 6 — Create users in the new instance

You need at least one admin to sign in. In Studio:

1. **Authentication** → **Users** → **Add user → Create new user**
2. Email + password → ✅ Auto Confirm User → **Create**
3. SQL Editor:
   ```sql
   insert into public.profiles (id, email, display_name, role, status, must_change_password)
   select id, email, split_part(email,'@',1), 'admin', 'active', false
   from auth.users where email = 'your-email@example.com'
   on conflict (id) do update set role='admin', status='active';
   ```

Repeat for each user you want. Their existing role + display_name from the backup auto-link by email (the profiles row from the restore already has them).

> Alternatively, after creating users in Studio, run:
> ```sql
> -- Re-link new auth.users IDs to existing profiles by email
> update public.profiles p
>    set id = u.id
>   from auth.users u
>  where p.email = u.email and p.id != u.id;
> ```

### Step 7 — Deploy the Edge Functions

In a NEW PowerShell window:

```powershell
cd C:\path\to\supabase\docker
docker exec -it supabase-edge-functions sh
# (or use Studio: Edge Functions UI in newer versions)
```

Or use the Studio web UI:
1. Studio → **Edge Functions** → **Deploy a new function**
2. For each of: `admin-users`, `db-stats`, `db-backup`:
   - Name: exact match
   - Verify JWT: unchecked
   - Paste contents of the matching file from `edge-functions/`
   - **Deploy**

### Step 8 — Point KnowledgeBox at the local Supabase

In your KnowledgeBox `config.js`:

```javascript
export const SUPABASE_URL  = 'http://localhost:8000';
export const SUPABASE_ANON = '<the ANON_KEY value from supabase/docker/.env>';
```

The anon key is in the `.env` you copied earlier — search for `ANON_KEY=`.

### Step 9 — Run the app

```powershell
cd C:\Users\aravi\OneDrive\Desktop\KnowledgeBox
python -m http.server 8001
```

Open http://localhost:8001. Sign in with the admin you created in Step 6.

✅ **Done — fully local, fully owned, identical app.**

### Stopping / starting Supabase

```powershell
cd C:\path\to\supabase\docker
docker compose down   # stop
docker compose up -d  # start again
```

Your data persists between starts (stored in Docker volumes).

---

## Path B — Plain Postgres (local or Azure)

This is harder because the KnowledgeBox app is written against the Supabase JS SDK. Without Supabase's auto-generated REST API, Auth service, and Realtime, the browser app can't talk to plain Postgres directly.

You have two sub-options:

### B1 — Plain Postgres + custom backend (most work)

You'd write a small Node/Python backend (Express or FastAPI) that:
- Exposes `/auth/signin`, `/auth/signup`, `/docs`, etc.
- Talks to Postgres via standard SQL
- Handles JWT issuing yourself

This is a real backend project — out of scope for this guide. The schema + data restore steps below still apply though.

### B2 — Local Postgres just for safekeeping (analytics / cold backup)

You're not running the app against it — just keeping a queryable copy of the data.

#### Step 1 — Install PostgreSQL

- **Windows:** https://www.postgresql.org/download/windows/
- During install, set a strong superuser password.
- Tick "pgAdmin" if you want a GUI.

#### Step 2 — Create the database

In **pgAdmin** or **psql**:

```sql
create database knowledgebox;
\c knowledgebox
create extension if not exists pg_trgm;
```

#### Step 3 — Apply schema (cleaned up for raw Postgres)

The full Supabase schema references `auth.users` and `auth.uid()` which don't exist outside Supabase. Use this **trimmed schema** for raw Postgres:

```sql
-- Profiles (without FK to auth.users)
create table public.profiles (
  id           uuid primary key,
  email        text not null,
  display_name text,
  role         text not null default 'viewer',
  status       text not null default 'active',
  created_at   timestamptz not null default now()
);

-- Docs (without FK to auth.users)
create table public.docs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null,
  title       text not null default 'Untitled',
  content     text not null default '',
  tags        text[] not null default '{}',
  pinned      boolean not null default false,
  is_public   boolean not null default false,
  share_token text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Doc versions
create table public.doc_versions (
  id         uuid primary key default gen_random_uuid(),
  doc_id     uuid not null references public.docs(id) on delete cascade,
  owner_id   uuid not null,
  title      text not null,
  content    text not null,
  tags       text[] not null default '{}',
  saved_at   timestamptz not null default now(),
  saved_by   uuid
);

-- Indexes
create index docs_owner_id_idx     on public.docs(owner_id);
create index docs_updated_at_idx   on public.docs(updated_at desc);
create index docs_title_trgm_idx   on public.docs using gin (title gin_trgm_ops);
create index docs_content_trgm_idx on public.docs using gin (content gin_trgm_ops);
create index docs_tags_gin_idx     on public.docs using gin (tags);
create index doc_versions_doc_idx  on public.doc_versions(doc_id, saved_at desc);
```

#### Step 4 — Load the data

Same SQL as Path A Step 5, but you paste your JSON differently — easiest is to use `\copy` or a small Python script. Quick script:

```powershell
# In PowerShell — assuming you have psql and the backup file
psql -d knowledgebox -c "create temp table _kb (d jsonb); \copy _kb from 'backup.json' csv quote E'\b';"
# (Above is illustrative; for production prefer the jsonb_populate_recordset approach in Path A)
```

#### Step 5 — Query / analyze

```sql
select count(*) from docs;
select role, count(*) from profiles group by role;
select title, length(content) from docs order by updated_at desc limit 10;
```

That's it for B2 — you have a queryable local copy of your data.

---

## Azure Postgres Flexible Server

Identical to Path B local Postgres, except:

1. Create flexible server in Azure Portal (~5 min)
2. Add your laptop's IP to firewall rules
3. Connect with:
   ```
   psql "host=<server>.postgres.database.azure.com port=5432 user=<admin> dbname=postgres password=<pw> sslmode=require"
   ```
4. Then follow Path B steps 2–4.

Same caveat as B: the app won't talk directly to it without a custom backend. For app continuity, use Path A.

---

## Which path should I pick?

| Goal | Path |
|---|---|
| Free tier filled, need to keep using app immediately | **A** (self-hosted Supabase) |
| Just want a queryable backup of the data | **B2** (local Postgres) |
| Moving to your own infrastructure long-term | **A** for app + **B** for analytics in parallel |
| Working with Azure team on shared infra | **B** + custom backend (real engineering project) |

For the typical user, **Path A solves everything**: app keeps working, data is yours, no code changes.
