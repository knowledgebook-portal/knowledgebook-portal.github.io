# KnowledgeBox

A fast, beautiful, **admin-managed** knowledge base. Markdown docs, instant search with highlights, real-time sync, version history, share links, command palette. Free to host. Only admins create accounts — no public signup.

## Features

- **Admin-only user creation** — no self-signup, no spam, no surprises
- **Forced password change on first sign-in** — initial passwords are temporary
- **3 roles** — admin (everything), editor (read + write), viewer (read-only)
- **Multi-device realtime sync** — edit on phone, see it on laptop instantly
- **Literal full-text search** across every doc with highlights and match navigation
- **Version history** — every save snapshots prior state
- **Public share links** — toggle a doc to a read-only URL
- **Command palette** (`Ctrl+Shift+P`)
- **Tags, pinning, sorting, dark mode, JSON export/import**
- **Mobile-first** — drawer sidebar, big touch targets, safe-area aware

## Stack

- **Frontend:** plain HTML/CSS/JS (ES modules) — no build step
- **Backend:** Supabase (Postgres + Auth + Realtime + Edge Functions)
- **No CLI required** — everything via Supabase Dashboard web UI

## Files

| File | What |
|---|---|
| `index.html` | App shell |
| `style.css` | Styling, light + dark, mobile-first |
| `app.js` | All app logic |
| `config.js` | Your Supabase project URL + publishable key |
| `supabase-schema.sql` | Database schema (⚠️ drops + recreates — first-time setup only) |
| `supabase-schema-update.sql` | Idempotent helper-function update (safe to re-run, preserves data) |
| `edge-functions/admin-users.ts` | Server function for user create/reset/delete (deploy once) |
| `edge-functions/db-stats.ts` | Server function for storage usage indicator (deploy once) |
| `edge-functions/db-backup.ts` | Server function for full data backup download (deploy once) |
| `LOCAL-SETUP.md` | Step-by-step guide to move off hosted Supabase to local |

---

## One-time setup (~5 minutes, no terminal)

### Step 1 — Create a free Supabase project

1. https://app.supabase.com → **Sign up** (use GitHub/Google to skip email setup)
2. **New project** → name it `knowledgebook` → pick a strong DB password (save it) → region closest to you → **Create**
3. Wait ~1 minute for provisioning

### Step 2 — Run the database schema

1. Left sidebar → **SQL Editor** → **New query**
2. Open `supabase-schema.sql` from this folder → copy ALL of it → paste
3. Click **Run** → wait for **"Success. No rows returned."**

This creates the `profiles`, `docs`, `doc_versions` tables with row-level security.

> ⚠️ This SQL is a CLEAN SLATE. It drops existing tables. If you already had data, export first.

### Step 3 — Turn OFF public signup

1. Left sidebar → **Authentication** → **Sign In / Up** (or "Providers")
2. Find **Email** provider → click it
3. **Allow new users to sign up** → **OFF** → **Save**

This is the lockdown — only the Edge Function (which checks for admin) can create users.

### Step 4 — Deploy the Edge Functions (3 total)

For each function below, do this in Supabase:

1. Left sidebar → **Edge Functions** → **Deploy a new function**
2. **Verify JWT:** UNCHECK (the functions verify the JWT manually with admin checks)
3. **Name** + paste code from the matching file, then **Deploy function**:

| Function name | File to paste |
|---|---|
| `admin-users` | `edge-functions/admin-users.ts` |
| `db-stats`    | `edge-functions/db-stats.ts` |
| `db-backup`   | `edge-functions/db-backup.ts` |

`admin-users` powers user create/reset/delete. `db-stats` powers the storage usage indicator. `db-backup` powers the one-click full backup.

The `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY` env vars are auto-injected for all of them — no extra setup.

> If your Supabase dashboard doesn't let you create Edge Functions in the browser (some regions / older accounts require the CLI), see the "CLI fallback" at the bottom of this README.

### Step 5 — Wire the app to your project

1. Supabase → **Settings → API**
2. Copy:
   - **Project URL** (`https://xxxxxx.supabase.co`)
   - **anon / publishable key** (`sb_publishable_…` or `eyJ…`)
3. Open `config.js` in this folder. Paste both values:
   ```javascript
   export const SUPABASE_URL  = 'https://xxxxxx.supabase.co';
   export const SUPABASE_ANON = 'sb_publishable_xxx_xxx...';
   ```
4. Save.

### Step 6 — Create your admin account (manual, one-time)

Since public signup is off, your own account has to be created from the Supabase Auth dashboard:

1. Left sidebar → **Authentication** → **Users** → **Add user → Create new user**
2. Fill:
   - **Email:** your email
   - **Password:** any password (you'll change it on first login)
   - **Auto Confirm User:** ✅ on
3. Click **Create**.

Now promote yourself to admin via SQL:

1. **SQL Editor** → **New query**:
   ```sql
   update public.profiles
   set role = 'admin', status = 'active', must_change_password = true
   where email = 'YOUR-EMAIL';
   ```
2. **Run**.

> Note: if the profiles row doesn't exist yet (because the user was just created and no trigger inserted it), insert it manually:
> ```sql
> insert into public.profiles (id, email, display_name, role, status, must_change_password)
> select id, email, split_part(email,'@',1), 'admin', 'active', true
> from auth.users where email = 'YOUR-EMAIL'
> on conflict (id) do update set role='admin', status='active';
> ```

### Step 7 — Sign in

1. Open `index.html` (or serve with `python -m http.server 8000` and visit http://localhost:8000)
2. Enter your email + password
3. App forces you to set a new password (one you actually want)
4. You land in the app as admin

---

## Adding users (the admin workflow)

### From inside the app (the only way)

1. Sign in as admin
2. Click your name (top-right) → **+ Add user · admin**
3. Fill in:
   - Email
   - Display name (optional)
   - Initial password (auto-generated; click ↻ to regenerate)
   - Role (admin / editor / viewer)
4. Click **Create user**
5. App shows the credentials in a modal — click **Copy**, share with the user securely (Signal, in-person, password manager, etc.)
6. User signs in with those credentials → app forces them to change password before letting them in

That's it. No emails sent, no confirmation links, no waiting.

## Managing existing users

User menu → **Manage users · admin**:

| Button | What it does |
|---|---|
| **Save** | Persist new role/status for that row |
| **Reset pw** | Issue a new temporary password (forces change on next sign-in) |
| **Delete** | Permanently remove user + all their docs |

You cannot delete yourself or change your own role from here.

## Database & backup (admin)

The admin user menu has a **Database & backup** entry that opens a panel showing:

- **Current storage usage** out of the 500 MB free tier, broken down per table
- **One-click full backup download** — JSON file with every row + schema SQL + RESTORE.md
- Quick restore-path summary inside the modal

A small progress bar in the **user dropdown header** also gives ambient awareness — turns amber at 70%, red at 90%.

When the free tier is getting full, see `LOCAL-SETUP.md` for moving to your own infrastructure:

- **Path A** — self-hosted Supabase via Docker (app works unchanged)
- **Path B** — plain Postgres (local or Azure) for cold backups + analytics

## Roles & permissions

| Action | Admin | Editor | Viewer |
|---|---|---|---|
| Read any doc | ✅ | ✅ | ✅ |
| Create docs | ✅ | ✅ | ❌ |
| Edit / delete own docs | ✅ | ✅ | ❌ |
| Edit / delete any doc | ✅ | ❌ | ❌ |
| Share publicly | ✅ | ✅ | ❌ |
| Manage users | ✅ | ❌ | ❌ |
| Add new users | ✅ | ❌ | ❌ |

Privacy is per-team — every active user reads everyone's docs (this is a shared knowledge base). The UI hides write controls from viewers, and the database also rejects the writes (defense in depth).

## Daily use

| Action | How |
|---|---|
| New doc | `Ctrl+N` or **+ New** |
| Save | `Ctrl+S` (autosaves after 1.5s of idle) |
| Search | `Ctrl+K`, then type — instant literal matches with highlights |
| Open result | Click — opens doc with every match highlighted; `Enter` jumps to next |
| Edit/View | `Ctrl+E` |
| Pin | Pin icon in toolbar |
| Share | Share icon → toggle on → Copy link |
| Restore old version | History icon → pick → Restore |
| Command palette | `Ctrl+Shift+P` |
| Toggle theme | `Ctrl+Shift+L` |
| Print / PDF | Print icon or `Ctrl+P` |

## Deploy (so the team can use it from anywhere)

### Netlify

1. https://app.netlify.com/start → **Import from GitHub** → pick your repo
2. Build command: leave blank. Publish directory: leave blank
3. Deploy. URL like `https://yourname.netlify.app`
4. In Supabase → **Authentication → URL Configuration** → add the deployed URL to **Site URL** and **Redirect URLs**

### Vercel

1. https://vercel.com/new → import the repo
2. Deploy (no build settings needed)

## Free tier limits (you won't hit these)

| Resource | Free tier |
|---|---|
| Supabase DB | 500 MB |
| Supabase MAU | 50,000 |
| Supabase API requests | unlimited |
| Supabase Edge Function invocations | 500,000 / month |
| Netlify bandwidth | 100 GB / month |

> Supabase free projects pause after 7 days of inactivity. Click "unpause" — no data loss.

## Troubleshooting

| Problem | Fix |
|---|---|
| "One-time setup needed" screen | Fill in `config.js` with your URL + key |
| Sign in works but "must change password" loops | After changing, check Supabase: `select must_change_password from public.profiles` — should be `false` after change |
| Add user fails with "Admin only" | Your profile.role must be `admin` AND status `active`. Run the SQL from Step 6. |
| Add user fails with "Function not found" | Edge Function name must be exactly `admin-users` |
| Add user fails with CORS | Edge Function code must include the CORS headers from `supabase-edge-function.ts` |
| Realtime stuck on "Connecting" | Check Supabase Auth → Realtime is enabled (on by default) |

## CLI fallback for Edge Function (only if dashboard doesn't allow inline editing)

If your Supabase dashboard requires the CLI for functions:

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
mkdir -p supabase/functions/admin-users
cp supabase-edge-function.ts supabase/functions/admin-users/index.ts
supabase functions deploy admin-users --no-verify-jwt
```

(`--no-verify-jwt` is required because we verify the JWT manually inside the function.)
