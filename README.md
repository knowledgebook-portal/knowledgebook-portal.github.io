# KnowledgeBox

A fast, beautiful, searchable knowledge base. Markdown docs, instant search with highlights, real-time sync across all your devices, version history, public share links, and a command palette. Free to host. Real accounts via email+password (or magic link).

## Features

- **Real accounts**: email/password, magic-link sign-in, password reset
- **Multi-device sync**: edit on phone, see it instantly on laptop (Supabase realtime)
- **Markdown editor** with formatting toolbar, live preview, autosave
- **Literal full-text search** across every doc — type it, find it, highlights jump on click
- **Version history** — every save is a rollback point
- **Public share links** — turn any doc into a read-only URL anyone can open
- **Command palette** (Ctrl+Shift+P) — jump to any doc or command
- **Tags + pinning + sorting + filtering**
- **Dark mode** (Ctrl+Shift+L)
- **JSON export/import** for full backups
- **PWA-ready** print stylesheet for runbooks → PDF
- **Per-user data isolation** via Postgres row-level security — no one can see anyone else's docs

## Stack

- **Frontend**: plain HTML/CSS/JS (ES modules) — no build step
- **Backend**: Supabase (Postgres + Auth + Realtime)
- **Libraries (CDN)**: `marked` (markdown), `DOMPurify` (sanitize), `@supabase/supabase-js`

## One-time setup (~5 minutes)

### 1. Create a free Supabase project

1. Go to **https://app.supabase.com** → sign up (use GitHub or Google to skip the email step).
2. **New project**. Pick any name, set a strong DB password (you won't need it), pick the region closest to you.
3. Wait ~1 minute for it to provision.

### 2. Run the SQL schema

1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open `supabase-schema.sql` from this folder → copy all of it → paste into the SQL Editor.
3. Click **Run** (or `Ctrl+Enter`). You should see "Success. No rows returned."

This creates the `docs`, `doc_versions`, and `profiles` tables with Row-Level Security policies that keep every user's data private.

### 3. Wire the app to your project

1. In Supabase: **Settings** (left sidebar) → **API**.
2. Copy these two values:
   - **Project URL** (looks like `https://abcdefg.supabase.co`)
   - **anon public** API key (long string starting with `eyJ…`)
3. Open `config.js` in this folder. Paste the two values:
   ```javascript
   export const SUPABASE_URL  = 'https://abcdefg.supabase.co';
   export const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR…';
   ```
4. Save.

> **These two values are safe to commit publicly.** The anon key only allows operations permitted by the RLS policies you just ran. Every user has to log in with a real account; the database enforces who sees what.

### 4. Run the app

Just open `index.html` in any modern browser. No server needed.

For sharing with friends or using from your phone, host the static files on **Netlify** (free) or **Vercel** (free) — see "Deploy" below.

### 5. Create your first account

1. Open the app → click **Create account** tab.
2. Enter email + password + display name → **Create account**.
3. Check your inbox for a confirmation link (Supabase sends it). Click it.
4. Come back → **Sign in** → you're in.

## Daily use

| Action | How |
|---|---|
| Create doc | `Ctrl+N` or the **+ New** button |
| Save | `Ctrl+S` (or just stop typing — autosave kicks in after 1.5s) |
| Search every doc | `Ctrl+K`, then type — results appear instantly with highlights |
| Open a result | Click it; the doc opens with every match highlighted; `Enter` jumps to next |
| Edit doc | `Ctrl+E` toggles edit / view |
| Pin a doc | Pin icon in toolbar — goes to top of sidebar |
| Share publicly | Share icon → toggle on → copy the read-only link |
| Restore old version | History icon → pick → Restore |
| Command palette | `Ctrl+Shift+P` — jump to any doc or run any action |
| Toggle theme | `Ctrl+Shift+L` |
| Print / PDF | Print icon or `Ctrl+P` — clean print layout |

## Deploy (so you can use it from your phone too)

Pick one — both are free, both take 2 minutes:

### Netlify (recommended for simplicity)

1. https://app.netlify.com/start
2. Sign in with GitHub.
3. Drag-and-drop this folder OR connect a GitHub repo.
4. Done. You get a URL like `https://your-name.netlify.app`.

### Vercel

1. https://vercel.com/new
2. Import this folder (no build settings needed — it's static).
3. Deploy. URL like `https://your-name.vercel.app`.

### After deploying

In Supabase: **Authentication** → **URL Configuration** → add your deployed URL to **Site URL** and **Redirect URLs** so password-reset / magic-link emails point users back to your live app.

## Adding more users

Anyone you want to give access to just signs up themselves on your deployed URL. They get their own account, their own docs, their own login.

You **don't share** anything. Each user has private isolation enforced by Postgres RLS. If you want to share a *specific doc* with someone outside the app, use the **Share** button to generate a public read-only link.

## Free tier limits (you won't hit these)

| Resource | Free tier | What it means for you |
|---|---|---|
| Supabase DB | 500 MB | ~50,000 average-sized runbooks |
| Supabase MAU | 50,000 | active monthly users |
| Supabase API calls | unlimited | |
| Netlify bandwidth | 100 GB / mo | ~500,000 page loads |
| Netlify build minutes | 300 / mo | no build needed anyway |

> Supabase free projects pause after **7 days of inactivity**. Unpause in one click — no data loss. If you use this daily, you'll never see it.

## Troubleshooting

| Problem | Fix |
|---|---|
| "One-time setup needed" screen | Fill in `config.js` with your URL + anon key |
| Sign-in fails | Confirm you clicked the confirmation email |
| Magic link doesn't work after deploy | In Supabase → Authentication → URL Configuration → add your deployed URL |
| Realtime pill stuck on "Connecting" | Check that Realtime is enabled in Supabase (it is by default) |
| Forgot password | Click "Forgot password?" on the sign-in screen |

## Files

- `index.html` — app shell
- `style.css` — all styling (light + dark)
- `app.js` — all logic (auth, CRUD, search, editor, realtime, palette)
- `config.js` — your Supabase URL + anon key (you fill in)
- `supabase-schema.sql` — database setup (run once)

Built as a single static page that talks directly to Supabase via the JS client. No build step, no backend code, no servers to maintain.
