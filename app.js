/* ==========================================================================
   KnowledgeBox — Supabase-powered knowledge base
   ESM entry point. Loaded as type="module" from index.html.
   ========================================================================== */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON } from './config.js';

/* ---------- Sanity check config ---------- */
if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT-REF')
 || !SUPABASE_ANON || SUPABASE_ANON.includes('YOUR-ANON')) {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('config-missing').hidden = false;
  throw new Error('config.js is not filled in yet.');
}

/* ---------- Supabase client ---------- */
const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ---------- DOM helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const wordCount = (s) => (s ? (String(s).trim().match(/\S+/g) || []).length : 0);
const readingMins = (s) => Math.max(1, Math.ceil(wordCount(s) / 220));
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date(), diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
};

/* ---------- Icon SVGs (single-stroke, currentColor) ---------- */
const ICON_FOLDER = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const ICON_FOLDER_OPEN = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2"/><path d="M3 9h17.5a1 1 0 0 1 .96 1.27l-1.9 7A2 2 0 0 1 17.62 19H5a2 2 0 0 1-2-2z"/></svg>`;
const ICON_DOC = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>`;
const ICON_ALL_DOCS = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2h8a2 2 0 0 1 2 2v3"/><path d="M5 5h11a2 2 0 0 1 2 2v3"/><path d="M2 8h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z"/></svg>`;

/* ---------- App state ---------- */
const state = {
  user: null,
  profile: null,
  docs: [],
  folders: [],
  expandedFolders: new Set(),    // folder ids that are expanded in tree
  currentFolderId: null,         // null = "All documents"
  currentDocId: null,
  activeView: 'welcome',         // welcome | doc | editor | search
  sort: 'updated',
  filterTag: null,
  searchQuery: '',
  searchTerms: [],
  matches: [], activeMatchIdx: 0,
  isDirty: false,
  realtimeChannel: null,
  autosaveTimer: null,
};

/* ============================================================================
   AUTH (sign-in only — accounts are admin-created)
   ============================================================================ */

function setAuthTab() { /* no-op: kept so old refs don't break */ }

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const errEl = $('#auth-error');
  errEl.hidden = true;
  $('#auth-submit').disabled = true;
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } catch (err) {
    errEl.textContent = err.message || 'Sign in failed.';
    errEl.hidden = false;
  } finally {
    $('#auth-submit').disabled = false;
  }
}

async function handlePasswordChange(e) {
  e.preventDefault();
  const nw = $('#pw-new').value;
  const cf = $('#pw-confirm').value;
  const errEl = $('#pw-error');
  errEl.hidden = true;
  if (nw.length < 8) { errEl.textContent = 'Use at least 8 characters.'; errEl.hidden = false; return; }
  if (nw !== cf)     { errEl.textContent = 'Passwords do not match.'; errEl.hidden = false; return; }

  const { error: pwErr } = await sb.auth.updateUser({ password: nw });
  if (pwErr) { errEl.textContent = pwErr.message; errEl.hidden = false; return; }

  await sb.from('profiles').update({ must_change_password: false }).eq('id', state.user.id);
  toast('Password updated', 'success');

  // Re-fetch profile and proceed into the app
  state.profile = await fetchProfile(state.user.id);
  $('#pwchange-screen').hidden = true;
  await enterApp();
}

async function bootAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) await onSignedIn(session.user);
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT' || !session?.user) {
      onSignedOut();
    } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      if (!state.user || state.user.id !== session.user.id) await onSignedIn(session.user);
    }
  });
}

async function onSignedIn(user) {
  state.user = user;
  state.profile = await fetchProfile(user.id);

  // No profile = account was deleted or never provisioned. Sign out and show login.
  if (!state.profile) {
    await sb.auth.signOut();
    return;
  }
  // Disabled accounts are kicked out.
  if (state.profile.status === 'disabled') {
    await sb.auth.signOut();
    toast('Your account is disabled. Contact an admin.', 'error');
    return;
  }
  // Must change password before entering the app.
  if (state.profile.must_change_password) {
    $('#auth-screen').hidden = true;
    $('#app').hidden = true;
    $('#pwchange-screen').hidden = false;
    return;
  }
  await enterApp();
}

async function enterApp() {
  $('#auth-screen').hidden = true;
  $('#pwchange-screen').hidden = true;
  $('#app').hidden = false;
  renderUserChip();
  applyRoleUI();
  await loadDocs();
  subscribeRealtime();
  if (state.docs.length === 0) showView('welcome');
  else { state.currentDocId = state.docs[0].id; showView('doc'); }
}

async function fetchProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data;
}

function onSignedOut() {
  state.user = null; state.profile = null; state.docs = [];
  unsubscribeRealtime();
  $('#app').hidden = true;
  $('#pwchange-screen').hidden = true;
  $('#auth-screen').hidden = false;
  $('#auth-form').reset();
}

async function signOut() { await sb.auth.signOut(); }

/* ----- Edge Function caller (admin auth) ----- */
async function callEdge(fnName, body = null, method = 'POST') {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const url = SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/' + fnName;
  const init = {
    method,
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'apikey':        SUPABASE_ANON,
    },
  };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}
async function adminFn(action, body) {
  return callEdge('admin-users', { action, ...body });
}

/* ----- Storage usage indicator ----- */
function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B','KB','MB','GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}
async function loadStorageStats() {
  const pill = $('#storage-pill');
  if (!pill || !state.isAdmin) return;
  pill.hidden = false;
  try {
    const s = await callEdge('kb_db_stats');
    state.storageStats = s;
    const used = s.total_bytes || 0;
    const limit = s.free_tier_bytes || 524_288_000;
    const pct = Math.min(100, Math.round((used / limit) * 100));
    $('#storage-pill-value').textContent = `${fmtBytes(used)} / ${fmtBytes(limit)}`;
    $('#storage-pill-fill').style.width = pct + '%';
    pill.classList.remove('warn', 'danger');
    if (pct >= 90) pill.classList.add('danger');
    else if (pct >= 70) pill.classList.add('warn');
  } catch (e) {
    $('#storage-pill-value').textContent = 'stats unavailable';
    console.warn('db-stats failed:', e.message);
  }
}

/* ----- Database & backup modal ----- */
async function openBackupModal() {
  if (!state.isAdmin) { toast('Admin only', 'error'); return; }

  const s = state.storageStats;
  const used = s?.total_bytes || 0;
  const limit = s?.free_tier_bytes || 524_288_000;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tablesHtml = (s?.tables || []).slice(0, 10).map(t => `
    <tr><td>${esc(t.name)}</td><td style="text-align:right;color:var(--text-muted);">${esc(t.pretty_size || fmtBytes(t.bytes))}</td><td style="text-align:right;color:var(--text-muted);">${(t.rows ?? 0).toLocaleString()} rows</td></tr>`).join('');

  openModal({
    title: 'Database & backup',
    size: 'modal-lg',
    body: `
      <h4 style="margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Storage usage</h4>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
          <span style="font-size:13px;font-weight:500;">${fmtBytes(used)} used</span>
          <span style="font-size:12px;color:var(--text-muted);">of ${fmtBytes(limit)} (${pct}%)</span>
        </div>
        <div style="height:8px;background:var(--bg-soft);border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${pct >= 90 ? 'linear-gradient(90deg,var(--danger),#ff7676)' : pct >= 70 ? 'linear-gradient(90deg,var(--warning),#ffb84a)' : 'linear-gradient(90deg,var(--success),#3ec48a)'};border-radius:999px;"></div>
        </div>
        ${tablesHtml ? `<table style="width:100%;margin-top:14px;font-size:12.5px;">
          <thead><tr>
            <th style="text-align:left;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);padding-bottom:6px;">Table</th>
            <th style="text-align:right;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);padding-bottom:6px;">Size</th>
            <th style="text-align:right;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);padding-bottom:6px;">Rows</th>
          </tr></thead>
          <tbody>${tablesHtml}</tbody>
        </table>` : ''}
      </div>

      <h4 style="margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Download backup</h4>
      <p style="font-size:13px;color:var(--text-soft);margin:0 0 12px;">One-click full export — all docs, profiles, and version history bundled into a ZIP with restore steps included.</p>
      <button class="btn btn-primary btn-block" id="bk-download">Download full backup (.zip)</button>
      <div id="bk-status" style="font-size:12px;color:var(--text-muted);margin-top:8px;text-align:center;"></div>

      <h4 style="margin:22px 0 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">How to restore locally</h4>
      <p style="font-size:13px;color:var(--text-soft);margin:0 0 10px;">The downloaded ZIP includes a <code>RESTORE.md</code> file with exact commands. Quick summary:</p>
      <ol style="font-size:13px;color:var(--text-soft);padding-left:22px;margin:0 0 12px;line-height:1.7;">
        <li><b>Path A (recommended)</b>: install <a href="https://docs.docker.com/desktop/" target="_blank" rel="noopener">Docker Desktop</a>, then run <a href="https://supabase.com/docs/guides/self-hosting/docker" target="_blank" rel="noopener">self-hosted Supabase</a>. App auto-works by just swapping the URL + key in <code>config.js</code>.</li>
        <li><b>Path B</b>: install plain PostgreSQL locally (or use Azure Postgres). Restore <code>schema.sql</code> + <code>data.sql</code> via <code>psql</code>. The app needs a thin backend wrapper (see <code>LOCAL-SETUP.md</code>).</li>
      </ol>
      <p style="font-size:12px;color:var(--text-muted);margin-top:10px;">📄 Full guide: <code>LOCAL-SETUP.md</code> in the project root.</p>
    `,
    footer: `<button class="btn btn-ghost btn-sm" id="bk-close">Close</button>`,
  });
  $('#bk-close').onclick = closeModal;
  $('#bk-download').onclick = doBackupDownload;
}

async function doBackupDownload() {
  const btn = $('#bk-download'); const status = $('#bk-status');
  btn.disabled = true; btn.textContent = 'Building backup…'; status.textContent = '';
  try {
    const data = await callEdge('kb_db_backup');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `knowledgebox-backup-${ts}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    URL.revokeObjectURL(a.href);

    // Also offer the schema + restore docs as separate downloads
    setTimeout(() => downloadFile('knowledgebox-schema.sql', SCHEMA_SQL_TEXT, 'text/plain'), 200);
    setTimeout(() => downloadFile('RESTORE.md',                RESTORE_MD_TEXT, 'text/markdown'), 400);

    status.innerHTML = `<span style="color:var(--success);">✓ Downloaded ${data.docs?.length || 0} docs, ${data.doc_versions?.length || 0} versions, ${data.profiles?.length || 0} profiles.</span><br/>Also saved: <code>knowledgebox-schema.sql</code> + <code>RESTORE.md</code>.`;
    toast('Backup downloaded', 'success');
  } catch (e) {
    status.innerHTML = `<span style="color:var(--danger);">Error: ${esc(e.message)}</span>`;
    toast('Backup failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download full backup (.zip)';
  }
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

/* These two are bundled into the download so users have a copy.
   Kept inline to avoid extra fetches. Updated whenever the schema changes. */
const SCHEMA_SQL_TEXT = `-- KnowledgeBox schema — restore steps in RESTORE.md
-- 1. Create an empty Postgres database (local or Supabase or Azure).
-- 2. Run THIS file first (creates tables).
-- 3. Then run data.sql (inserts your rows).
-- 4. See LOCAL-SETUP.md in the project for connection-string changes.
\\echo See supabase-schema.sql in the source repo for the canonical schema.
`;

const RESTORE_MD_TEXT = `# How to restore this backup locally

Your KnowledgeBox backup contains:

- \`knowledgebox-backup-<timestamp>.json\` — every row of every table
- \`knowledgebox-schema.sql\` — table definitions
- This \`RESTORE.md\` — these instructions

## Path A: self-hosted Supabase (recommended — app keeps working unchanged)

1. Install **Docker Desktop**: https://docs.docker.com/desktop/
2. Clone Supabase locally:
   \`\`\`bash
   git clone --depth 1 https://github.com/supabase/supabase
   cd supabase/docker
   cp .env.example .env
   docker compose up -d
   \`\`\`
3. Studio at http://localhost:8000. Use it as you would the hosted dashboard.
4. SQL Editor → run \`supabase-schema.sql\` (from the project repo)
5. Restore data: in SQL Editor, paste this and run (replace \`PASTE_BACKUP_JSON\` with the contents of your JSON file):
   \`\`\`sql
   with b as (select 'PASTE_BACKUP_JSON'::jsonb as data)
   insert into public.docs (id, owner_id, title, content, tags, pinned, is_public, share_token, created_at, updated_at)
   select (d->>'id')::uuid, (d->>'owner_id')::uuid, d->>'title', d->>'content',
          array(select jsonb_array_elements_text(d->'tags')),
          (d->>'pinned')::boolean, (d->>'is_public')::boolean, d->>'share_token',
          (d->>'created_at')::timestamptz, (d->>'updated_at')::timestamptz
   from b, jsonb_array_elements(b.data->'docs') d;
   \`\`\`
6. In the app's \`config.js\`, update:
   \`\`\`js
   export const SUPABASE_URL  = 'http://localhost:8000';
   export const SUPABASE_ANON = '<your local anon key from supabase/docker/.env>';
   \`\`\`

App now talks to local Supabase. **Done — no app code changes needed.**

## Path B: plain Postgres (Azure or local install)

This path requires app changes because raw Postgres doesn't have Supabase's API. The app is currently written against Supabase's JS SDK.

1. Install **PostgreSQL**: https://www.postgresql.org/download/
2. Create a DB: \`createdb knowledgebox\`
3. Connect: \`psql -d knowledgebox\`
4. Enable trigram extension: \`create extension pg_trgm;\`
5. Run \`supabase-schema.sql\` (but remove the \`auth.\` references — see LOCAL-SETUP.md Path B for the cleaned-up version)
6. Insert data using the JSON-to-INSERT SQL block (see Path A step 5).

To make the app work with raw Postgres, you'd need a thin Express/FastAPI wrapper exposing the same endpoints the Supabase JS SDK calls. The KnowledgeBox repo includes a starter wrapper as \`local-backend/\` (optional).

## Users / auth

Backups do **not** include passwords (they're hashed inside Supabase's auth.users table — not part of public schema).

After restore:
- **Path A**: re-create users in the new Supabase Studio's Auth → Users → Add user. Their roles auto-link via the \`profiles.email\` field.
- **Path B**: use the local-backend's built-in user creation.

See \`LOCAL-SETUP.md\` for full step-by-step.
`;

/* ----- Admin: add user ----- */
async function openAddUser() {
  if (!state.isAdmin) { toast('Admin only', 'error'); return; }
  const body = `
    <p style="margin:0 0 14px;color:var(--text-soft);font-size:13px;">
      Creates the account immediately. The user will be required to change their password on first sign-in.
    </p>
    <div class="form-group">
      <label>Email</label>
      <input id="nu-email" type="email" placeholder="user@example.com" required />
    </div>
    <div class="form-group">
      <label>Display name</label>
      <input id="nu-name" type="text" placeholder="Their name (optional)" />
    </div>
    <div class="form-group">
      <label>Initial password</label>
      <div style="display:flex;gap:6px;">
        <input id="nu-password" type="text" placeholder="Auto-generated" style="flex:1;font-family:var(--font-mono);font-size:13px;" />
        <button type="button" class="btn btn-ghost btn-sm" id="nu-regen">↻</button>
      </div>
      <small style="color:var(--text-muted);font-size:11.5px;display:block;margin-top:4px;">Share this securely with the user. They'll change it on first sign-in.</small>
    </div>
    <div class="form-group">
      <label>Role</label>
      <select id="nu-role">
        <option value="editor">Editor — can read + create + edit docs</option>
        <option value="viewer">Viewer — read only</option>
        <option value="admin">Admin — full access, can manage users</option>
      </select>
    </div>
    <div id="nu-error" class="form-error" hidden></div>
  `;
  openModal({
    title: 'Add user',
    body,
    footer: `<button class="btn btn-ghost btn-sm" id="nu-cancel">Cancel</button>
             <button class="btn btn-primary btn-sm" id="nu-create">Create user</button>`,
    size: 'modal-lg',
  });
  const genPw = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    for (let i = 0; i < a.length; i++) s += chars[a[i] % chars.length];
    return s;
  };
  $('#nu-password').value = genPw();
  $('#nu-regen').onclick = () => { $('#nu-password').value = genPw(); };
  $('#nu-cancel').onclick = closeModal;
  $('#nu-create').onclick = async () => {
    const email    = $('#nu-email').value.trim();
    const password = $('#nu-password').value;
    const role     = $('#nu-role').value;
    const display_name = $('#nu-name').value.trim();
    const errEl = $('#nu-error');
    errEl.hidden = true;
    if (!email || !password) { errEl.textContent = 'Email and password required.'; errEl.hidden = false; return; }
    if (password.length < 8)  { errEl.textContent = 'Password must be at least 8 characters.'; errEl.hidden = false; return; }
    $('#nu-create').disabled = true;
    try {
      await adminFn('create', { email, password, role, display_name });
      closeModal();
      toast(`Created ${email} as ${role}`, 'success');
      // Show credentials once so admin can copy
      openModal({
        title: 'Account created',
        body: `
          <p style="color:var(--text-soft);font-size:13px;">Share these credentials with the user. They will be required to change the password on first sign-in.</p>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;margin-top:10px;font-family:var(--font-mono);font-size:13px;">
            <div><b>Email:</b> ${esc(email)}</div>
            <div style="margin-top:6px;"><b>Password:</b> ${esc(password)}</div>
            <div style="margin-top:6px;"><b>Role:</b> ${esc(role)}</div>
          </div>`,
        footer: `<button class="btn btn-primary btn-sm" id="cred-copy">Copy</button>
                 <button class="btn btn-ghost btn-sm" id="cred-close">Close</button>`,
      });
      $('#cred-close').onclick = closeModal;
      $('#cred-copy').onclick = async () => {
        try {
          await navigator.clipboard.writeText(`Email: ${email}\nPassword: ${password}\nRole: ${role}`);
          toast('Copied', 'success');
        } catch { toast('Copy failed', 'error'); }
      };
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
      $('#nu-create').disabled = false;
    }
  };
}

/* ----- Admin: manage users (table) ----- */
async function openManageUsers() {
  if (!state.isAdmin) { toast('Admin only', 'error'); return; }
  openModal({
    title: 'Manage users',
    body: '<div style="text-align:center;color:var(--text-muted);padding:24px;">Loading…</div>',
    footer: `<button class="btn btn-primary btn-sm" id="mu-add">+ Add user</button>
             <button class="btn btn-ghost btn-sm" id="mu-close">Close</button>`,
    size: 'modal-lg',
  });
  $('#mu-close').onclick = closeModal;
  $('#mu-add').onclick = () => { closeModal(); openAddUser(); };

  const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
  if (error) { $('#modal-body').textContent = error.message; return; }

  $('#modal-body').innerHTML = `
    <table class="users-table">
      <thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${data.map(u => `
          <tr data-id="${u.id}" data-email="${esc(u.email || '')}">
            <td data-label="User">
              <div style="font-weight:500;">${esc(u.display_name || '(no name)')}</div>
              <div style="font-size:11.5px;color:var(--text-muted);">${esc(u.email || '')}</div>
            </td>
            <td data-label="Role">
              <select data-field="role" ${u.id === state.user.id ? 'disabled' : ''}>
                <option value="admin"  ${u.role==='admin'?'selected':''}>admin</option>
                <option value="editor" ${u.role==='editor'?'selected':''}>editor</option>
                <option value="viewer" ${u.role==='viewer'?'selected':''}>viewer</option>
              </select>
            </td>
            <td data-label="Status">
              <select data-field="status" ${u.id === state.user.id ? 'disabled' : ''}>
                <option value="active"   ${u.status==='active'?'selected':''}>active</option>
                <option value="disabled" ${u.status==='disabled'?'selected':''}>disabled</option>
              </select>
            </td>
            <td class="row-actions">
              ${u.id === state.user.id
                ? '<span style="font-size:11px;color:var(--text-muted);">you</span>'
                : `
                <button class="btn btn-ghost btn-sm"        data-act="save"  data-id="${u.id}">Save</button>
                <button class="btn btn-ghost btn-sm"        data-act="reset" data-id="${u.id}">Reset pw</button>
                <button class="btn btn-danger-ghost btn-sm" data-act="del"   data-id="${u.id}">Delete</button>`}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p style="margin-top:14px;font-size:12px;color:var(--text-muted);">
      <b>Reset pw</b> issues a new temporary password (user is forced to change on next login).
      <b>Delete</b> permanently removes the user and all their docs.
    </p>
  `;

  $('#modal-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const tr = btn.closest('tr');
    const email = tr.dataset.email;
    const act = btn.dataset.act;
    btn.disabled = true;
    try {
      if (act === 'save') {
        const role   = tr.querySelector('select[data-field="role"]').value;
        const status = tr.querySelector('select[data-field="status"]').value;
        const { error } = await sb.from('profiles').update({ role, status }).eq('id', id);
        if (error) throw error;
        toast('Saved', 'success');
      } else if (act === 'reset') {
        if (!confirm(`Reset password for ${email}?`)) return;
        const pw = genTempPassword();
        await adminFn('reset', { user_id: id, new_password: pw });
        openModal({
          title: 'Password reset',
          body: `<p>New temporary password for <b>${esc(email)}</b>:</p>
                 <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;margin-top:10px;font-family:var(--font-mono);font-size:14px;text-align:center;letter-spacing:0.1em;">${esc(pw)}</div>
                 <p style="font-size:12px;color:var(--text-muted);margin-top:10px;">Share securely. They will be forced to change it on next sign-in.</p>`,
          footer: `<button class="btn btn-primary btn-sm" id="rp-copy">Copy</button>
                   <button class="btn btn-ghost btn-sm" id="rp-close">Close</button>`,
        });
        $('#rp-close').onclick = closeModal;
        $('#rp-copy').onclick = async () => {
          await navigator.clipboard.writeText(pw);
          toast('Copied', 'success');
        };
      } else if (act === 'del') {
        if (!confirm(`Delete ${email}? Their docs are removed too. This cannot be undone.`)) return;
        await adminFn('delete', { user_id: id });
        toast('User deleted', 'success');
        openManageUsers(); // refresh
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function genTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let s = ''; const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  for (let i = 0; i < a.length; i++) s += chars[a[i] % chars.length];
  return s;
}

function renderUserChip() {
  const name = state.profile?.display_name || state.user.email.split('@')[0];
  const role = state.profile?.role || 'viewer';
  $('#user-name').textContent = name;
  $('#user-avatar').textContent = (name[0] || '?').toUpperCase();
  $('#user-email-display').textContent = state.user.email;
  $('#welcome-name').textContent = name;

  const badge = $('#user-role-badge');
  badge.textContent = role;
  badge.className = 'role-badge ' + role;
  badge.hidden = false;

  $('#user-role-display').innerHTML = `Role: <span class="role-badge ${role}">${role}</span>`;
}

function applyRoleUI() {
  const role = state.profile?.role || 'viewer';
  const canWrite = role === 'admin' || role === 'editor';
  const isAdmin  = role === 'admin';

  // Show admin-only menu items
  $('#manage-users-btn').hidden = !isAdmin;
  $('#add-user-btn').hidden = !isAdmin;
  $('#backup-btn').hidden = !isAdmin;
  $('#storage-pill').hidden = !isAdmin;

  // Disable write actions for viewers
  $('#new-doc-btn').style.display = canWrite ? '' : 'none';
  $('#welcome-new').style.display = canWrite ? '' : 'none';
  $('#welcome-sample').style.display = canWrite ? '' : 'none';
  $('#import-btn').style.display = canWrite ? '' : 'none';
  $('#edit-btn').style.display = canWrite ? '' : 'none';
  $('#delete-btn').style.display = canWrite ? '' : 'none';
  $('#pin-btn').style.display = canWrite ? '' : 'none';
  $('#share-btn').style.display = canWrite ? '' : 'none';
  $('#move-btn').style.display = canWrite ? '' : 'none';
  $('#new-folder-btn').hidden = !canWrite;

  state.canWrite = canWrite;
  state.isAdmin = isAdmin;

  // Kick off storage fetch in background (only admins)
  if (isAdmin) loadStorageStats();
}

/* ============================================================================
   DATA LAYER (Supabase docs CRUD)
   ============================================================================ */

async function loadDocs() {
  const [{ data: docs, error: docsErr }, { data: folders, error: foldErr }] = await Promise.all([
    sb.from('docs').select('*').order('updated_at', { ascending: false }),
    sb.from('folders').select('*').order('name'),
  ]);
  if (docsErr)  { toast('Load failed: ' + docsErr.message, 'error'); }
  if (foldErr)  { /* folders table may not exist yet on older DBs */ console.warn(foldErr.message); }
  state.docs = docs || [];
  state.folders = folders || [];
  renderFolderTree();
  renderDocList();
  renderTags();
}

/* ============================================================================
   FOLDERS — CRUD
   ============================================================================ */
async function createFolder({ name, parent_id = null }) {
  const { data, error } = await sb.from('folders').insert({
    name, parent_id, owner_id: state.user.id,
  }).select().single();
  if (error) { toast('Create folder failed: ' + error.message, 'error'); return null; }
  state.folders.push(data);
  if (parent_id) state.expandedFolders.add(parent_id);
  renderFolderTree();
  return data;
}
async function renameFolder(id, name) {
  const { data, error } = await sb.from('folders').update({ name }).eq('id', id).select().single();
  if (error) { toast(error.message, 'error'); return null; }
  const i = state.folders.findIndex(f => f.id === id);
  if (i >= 0) state.folders[i] = data;
  renderFolderTree();
  return data;
}
async function deleteFolder(id) {
  const f = state.folders.find(x => x.id === id); if (!f) return;
  const childCount = state.folders.filter(x => x.parent_id === id).length;
  const docCount   = state.docs.filter(d => d.folder_id === id).length;
  const msg = `Delete folder "${f.name}"?` +
    (childCount ? `\n${childCount} subfolder(s) will also be deleted.` : '') +
    (docCount ? `\n${docCount} doc(s) inside will be moved to root (not deleted).` : '');
  if (!confirm(msg)) return;
  // Move docs out of this folder first (folder delete cascades subfolders)
  await sb.from('docs').update({ folder_id: null }).eq('folder_id', id);
  const { error } = await sb.from('folders').delete().eq('id', id);
  if (error) { toast(error.message, 'error'); return; }
  // Realtime will resync; do an immediate optimistic update too
  const removed = new Set([id]);
  // include descendants
  const queue = [id]; while (queue.length) {
    const p = queue.shift();
    state.folders.filter(x => x.parent_id === p).forEach(c => { removed.add(c.id); queue.push(c.id); });
  }
  state.folders = state.folders.filter(x => !removed.has(x.id));
  state.docs.forEach(d => { if (removed.has(d.folder_id)) d.folder_id = null; });
  if (removed.has(state.currentFolderId)) state.currentFolderId = null;
  renderFolderTree(); renderDocList();
  toast('Folder deleted', 'success');
}

async function moveDocToFolder(docId, folderId) {
  const { data, error } = await sb.from('docs').update({ folder_id: folderId }).eq('id', docId).select().single();
  if (error) { toast('Move failed: ' + error.message, 'error'); return; }
  const i = state.docs.findIndex(d => d.id === docId);
  if (i >= 0) state.docs[i] = data;
  renderDocList(); renderFolderTree();
  toast(folderId ? 'Moved to folder' : 'Moved to root', 'success');
}

/* ============================================================================
   FOLDER TREE — render + drag/drop
   ============================================================================ */
function renderFolderTree() {
  const wrap = $('#folder-tree');
  if (!wrap) return;
  $('#new-folder-btn').hidden = !state.canWrite;
  const fc = $('#folder-count');
  if (fc) fc.textContent = state.folders.length;

  const tree = buildFolderTree(state.folders);
  wrap.innerHTML = '';

  // "All documents" pseudo-row at top — counts only docs at ROOT (not inside folders)
  const rootCount = state.docs.filter(d => !d.folder_id).length;
  const all = document.createElement('div');
  all.className = 'folder-row' + (state.currentFolderId === null ? ' active' : '');
  all.innerHTML = `
    <span class="folder-row-twist empty"></span>
    <span class="folder-row-icon">${ICON_ALL_DOCS}</span>
    <span class="folder-row-name">All documents</span>
    <span class="folder-row-count">${rootCount}</span>`;
  all.addEventListener('click', () => { state.currentFolderId = null; renderFolderTree(); renderDocList(); });
  attachDropTarget(all, null);
  wrap.appendChild(all);

  const renderNodeInto = (node, depth, container) => {
    const id = node.id;
    const isExpanded = state.expandedFolders.has(id);
    const hasChildren = node.children.length > 0;
    const docCount = state.docs.filter(d => d.folder_id === id).length;

    const row = document.createElement('div');
    row.className = 'folder-row'
      + (state.currentFolderId === id ? ' active' : '')
      + (isExpanded ? ' expanded' : '');
    row.dataset.folderId = id;
    row.innerHTML = `
      <span class="folder-row-twist ${hasChildren ? '' : 'empty'}">${hasChildren ? '▶' : ''}</span>
      <span class="folder-row-icon">${isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER}</span>
      <span class="folder-row-name">${esc(node.name)}</span>
      ${docCount ? `<span class="folder-row-count">${docCount}</span>` : ''}
      ${state.canWrite ? `
      <span class="folder-row-actions">
        <button data-act="add"    title="New subfolder">+</button>
        <button data-act="rename" title="Rename">✎</button>
        <button data-act="delete" title="Delete">×</button>
      </span>` : ''}
    `;
    row.querySelector('.folder-row-twist').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasChildren) return;
      if (isExpanded) state.expandedFolders.delete(id); else state.expandedFolders.add(id);
      renderFolderTree();
    });
    row.addEventListener('click', () => {
      state.currentFolderId = id;
      renderFolderTree(); renderDocList();
    });
    row.querySelectorAll('.folder-row-actions button').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'add') promptNewFolder(id);
        else if (act === 'rename') promptRename(node);
        else if (act === 'delete') deleteFolder(id);
      });
    });
    attachDropTarget(row, id);
    container.appendChild(row);

    if (isExpanded && hasChildren) {
      const childWrap = document.createElement('div');
      childWrap.className = 'folder-children';
      container.appendChild(childWrap);
      node.children.forEach(c => renderNodeInto(c, depth + 1, childWrap));
    }
  };
  tree.forEach(root => renderNodeInto(root, 0, wrap));
}

function buildFolderTree(folders) {
  const byId = new Map(folders.map(f => [f.id, { ...f, children: [] }]));
  const roots = [];
  byId.forEach(node => {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
    else roots.push(node);
  });
  const sortRec = (arr) => { arr.sort((a, b) => a.name.localeCompare(b.name)); arr.forEach(n => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}

function getFolderPath(folderId) {
  if (!folderId) return [];
  const byId = new Map(state.folders.map(f => [f.id, f]));
  const out = []; let cur = byId.get(folderId);
  while (cur) { out.unshift(cur); cur = byId.get(cur.parent_id); }
  return out;
}

function attachDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    if (!state.canWrite) return;
    e.preventDefault();
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const docId = e.dataTransfer.getData('text/x-kb-docid');
    if (docId) await moveDocToFolder(docId, folderId);
  });
}

function promptNewFolder(parent_id = null) {
  const name = prompt(parent_id ? 'New subfolder name:' : 'New folder name:');
  if (!name?.trim()) return;
  createFolder({ name: name.trim(), parent_id });
}
function promptRename(node) {
  const name = prompt('Rename folder:', node.name);
  if (!name?.trim() || name === node.name) return;
  renameFolder(node.id, name.trim());
}

function openMoveDocModal() {
  const d = getDoc(state.currentDocId);
  if (!d || !state.canWrite) return;
  const tree = buildFolderTree(state.folders);
  const renderList = (nodes, depth = 0) => nodes.map(n => `
    <button type="button" data-folder="${n.id}" class="dropdown-item" style="display:flex;align-items:center;gap:8px;padding-left:${10 + depth * 16}px;">
      <span style="color:var(--warning);display:inline-flex;">${ICON_FOLDER}</span> ${esc(n.name)}
    </button>${renderList(n.children, depth + 1)}`).join('');
  openModal({
    title: 'Move to folder',
    body: `
      <p style="font-size:13px;color:var(--text-soft);margin:0 0 12px;">Pick a destination folder for <b>${esc(d.title)}</b>.</p>
      <div style="max-height:50vh;overflow-y:auto;">
        <button type="button" data-folder="" class="dropdown-item" style="display:flex;align-items:center;gap:8px;">
          <span style="color:var(--text-muted);display:inline-flex;">${ICON_ALL_DOCS}</span> All documents (root)
        </button>
        ${renderList(tree)}
      </div>`,
    footer: `<button class="btn btn-ghost btn-sm" id="mv-cancel">Cancel</button>`,
  });
  $('#mv-cancel').onclick = closeModal;
  $$('#modal-body [data-folder]').forEach(b => {
    b.onclick = async () => {
      const target = b.dataset.folder || null;
      await moveDocToFolder(d.id, target);
      closeModal();
    };
  });
}

async function createDoc(partial = {}) {
  const row = {
    owner_id:  state.user.id,
    title:     partial.title || 'Untitled',
    content:   partial.content || '',
    tags:      partial.tags || [],
    folder_id: partial.folder_id !== undefined ? partial.folder_id : state.currentFolderId,
  };
  const { data, error } = await sb.from('docs').insert(row).select().single();
  if (error) { toast('Create failed: ' + error.message, 'error'); return null; }
  state.docs.unshift(data);
  renderDocList(); renderTags();
  return data;
}

async function updateDoc(id, patch) {
  const { data, error } = await sb.from('docs').update(patch).eq('id', id).select().single();
  if (error) { toast('Save failed: ' + error.message, 'error'); return null; }
  const idx = state.docs.findIndex(d => d.id === id);
  if (idx >= 0) state.docs[idx] = data;
  return data;
}

async function deleteDoc(id) {
  const { error } = await sb.from('docs').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return false; }
  state.docs = state.docs.filter(d => d.id !== id);
  if (state.currentDocId === id) {
    state.currentDocId = state.docs[0]?.id || null;
    if (state.currentDocId) showView('doc'); else showView('welcome');
  }
  renderDocList(); renderTags();
  return true;
}

function getDoc(id) { return state.docs.find(d => d.id === id); }

/* ============================================================================
   REALTIME (so phone edits show up on laptop instantly)
   ============================================================================ */

function subscribeRealtime() {
  unsubscribeRealtime();
  setPill('connecting', 'Connecting');
  state.realtimeChannel = sb
    .channel('kb:' + state.user.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'docs' },
      (payload) => handleRealtime(payload))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'folders' },
      (payload) => handleFolderRealtime(payload))
    .subscribe(status => {
      if (status === 'SUBSCRIBED') setPill('live', 'Live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setPill('offline', 'Offline');
    });
}
function handleFolderRealtime({ eventType, new: nw, old }) {
  if (eventType === 'INSERT') {
    if (!state.folders.find(f => f.id === nw.id)) state.folders.push(nw);
  } else if (eventType === 'UPDATE') {
    const i = state.folders.findIndex(f => f.id === nw.id);
    if (i >= 0) state.folders[i] = nw;
  } else if (eventType === 'DELETE') {
    state.folders = state.folders.filter(f => f.id !== old.id);
    if (state.currentFolderId === old.id) state.currentFolderId = null;
  }
  renderFolderTree();
  renderDocList();
}
function unsubscribeRealtime() {
  if (state.realtimeChannel) {
    sb.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
}
function handleRealtime({ eventType, new: nw, old }) {
  if (eventType === 'INSERT') {
    if (!state.docs.find(d => d.id === nw.id)) state.docs.unshift(nw);
  } else if (eventType === 'UPDATE') {
    const i = state.docs.findIndex(d => d.id === nw.id);
    if (i >= 0) state.docs[i] = nw;
    else state.docs.unshift(nw);
  } else if (eventType === 'DELETE') {
    state.docs = state.docs.filter(d => d.id !== old.id);
  }
  renderDocList(); renderTags();
  if (state.activeView === 'doc' && state.currentDocId === (nw?.id || old?.id)) {
    if (eventType !== 'DELETE') renderDocView();
  }
}
function setPill(kind, label) {
  const p = $('#connection-pill');
  p.classList.remove('live', 'offline', 'connecting');
  p.classList.add(kind);
  $('#pill-label').textContent = label;
}

/* ============================================================================
   RENDERING (sidebar + tag chips)
   ============================================================================ */

function renderDocList() {
  const list = $('#doc-list');
  let docs = state.docs.slice();
  // "All documents" (state.currentFolderId === null) = root-level only (folder_id IS NULL).
  // Docs that have been moved into a folder do NOT appear under All documents anymore —
  // they live inside their folder.
  if (state.currentFolderId === null) docs = docs.filter(d => !d.folder_id);
  else docs = docs.filter(d => d.folder_id === state.currentFolderId);
  if (state.filterTag) docs = docs.filter(d => (d.tags || []).includes(state.filterTag));
  docs = sortDocs(docs, state.sort);
  docs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  $('#doc-count').textContent = docs.length;
  if (state.currentFolderId) {
    const path = getFolderPath(state.currentFolderId).map(f => f.name).join(' › ');
    $('#doc-count-label').textContent = path;
  } else if (state.filterTag) {
    $('#doc-count-label').textContent = `Tag: ${state.filterTag}`;
  } else {
    $('#doc-count-label').textContent = 'Documents';
  }

  if (docs.length === 0) {
    const msg = state.currentFolderId
      ? 'This folder is empty.<br/><span style="font-size:11.5px;">Drag a doc here, or press <kbd>Ctrl N</kbd>.</span>'
      : 'No documents yet.<br/><span style="font-size:11.5px;">Press <kbd>Ctrl N</kbd> to create one.</span>';
    list.innerHTML = `<div class="doc-item-empty">${msg}</div>`;
    return;
  }
  list.innerHTML = docs.map(d => `
    <div class="doc-item ${d.id === state.currentDocId ? 'active' : ''}" data-id="${d.id}" ${state.canWrite ? 'draggable="true"' : ''}>
      <div class="doc-item-title">
        ${d.pinned ? '<span class="doc-item-pin">★</span>' : `<span class="doc-item-icon">${ICON_DOC}</span>`}
        <span>${esc(d.title || 'Untitled')}</span>
      </div>
      <div class="doc-item-meta">
        <span>${fmtDate(d.updated_at)}</span>
        <span>·</span>
        <span>${wordCount(d.content)} words</span>
      </div>
    </div>
  `).join('');
  $$('#doc-list .doc-item').forEach(el => {
    el.addEventListener('click', () => {
      state.currentDocId = el.dataset.id;
      showView('doc');
      renderDocList();
    });
    if (state.canWrite) {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-kb-docid', el.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    }
  });
}

function sortDocs(docs, mode) {
  const a = docs.slice();
  switch (mode) {
    case 'created':    return a.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    case 'title':      return a.sort((x, y) => x.title.localeCompare(y.title));
    case 'title-desc': return a.sort((x, y) => y.title.localeCompare(x.title));
    case 'updated':
    default:           return a.sort((x, y) => new Date(y.updated_at) - new Date(x.updated_at));
  }
}

function renderTags() {
  const all = new Set();
  state.docs.forEach(d => (d.tags || []).forEach(t => all.add(t)));
  const tags = Array.from(all).sort();
  const wrap = $('#filter-tags');
  if (tags.length === 0) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = tags.map(t => `<span class="filter-tag ${state.filterTag === t ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</span>`).join('');
  $$('.filter-tag', wrap).forEach(el => el.addEventListener('click', () => {
    state.filterTag = state.filterTag === el.dataset.tag ? null : el.dataset.tag;
    renderTags(); renderDocList();
  }));
}

/* ============================================================================
   VIEW SWITCHING
   ============================================================================ */

function showView(view) {
  state.activeView = view;
  $('#welcome-view').hidden = view !== 'welcome';
  $('#doc-view').hidden     = view !== 'doc';
  $('#editor-view').hidden  = view !== 'editor';
  $('#search-view').hidden  = view !== 'search';
  if (view === 'doc' && state.currentDocId) renderDocView();
  if (view === 'editor') renderEditor();
  if (view === 'search') renderSearchResults();
  updatePageTitle();
}

function updatePageTitle() {
  let t = 'KnowledgeBox';
  if (state.activeView === 'doc') {
    const d = getDoc(state.currentDocId);
    if (d) t = `${d.title} · KnowledgeBox`;
  } else if (state.activeView === 'editor') t = 'Editing · KnowledgeBox';
  else if (state.activeView === 'search' && state.searchQuery) t = `Search: ${state.searchQuery} · KnowledgeBox`;
  if (document.title !== t) document.title = t;
}

/* ============================================================================
   DOC VIEW with highlights
   ============================================================================ */

function renderDocView() {
  const doc = getDoc(state.currentDocId);
  if (!doc) { showView('welcome'); return; }
  $('#doc-view-title').textContent = doc.title || 'Untitled';
  const path = getFolderPath(doc.folder_id);
  const pathHtml = path.length ? `<span style="color:var(--text-soft);font-weight:500;">${path.map(p => esc(p.name)).join(' › ')}</span><span class="dot">·</span>` : '';
  $('#doc-view-updated').innerHTML = pathHtml + 'Updated ' + fmtDate(doc.updated_at);
  $('#doc-view-words').textContent = wordCount(doc.content) + ' words';
  $('#doc-view-reading').textContent = readingMins(doc.content) + ' min read';
  $('#doc-view-tags').innerHTML = (doc.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join('');
  $('#pin-btn').classList.toggle('active', !!doc.pinned);

  const html = marked.parse(doc.content || '', { breaks: true, gfm: true });
  const safe = DOMPurify.sanitize(html);
  const target = $('#doc-rendered');
  target.innerHTML = safe;
  decorateCopy(target);

  if (state.searchTerms.length) {
    const count = highlightInNode(target, state.searchTerms);
    $('#match-nav').hidden = count === 0;
    state.matches = $$('mark', target);
    state.activeMatchIdx = 0;
    updateMatchCounter();
    if (state.matches.length) requestAnimationFrame(() => focusMatch(0));
  } else {
    $('#match-nav').hidden = true;
    state.matches = [];
  }
}

/* ---------- Copy buttons on rendered markdown ---------- */
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="0" ry="0"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function decorateCopy(root) {
  if (!root) return;
  // <pre> blocks
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.kb-copy-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kb-copy-btn';
    btn.title = 'Copy';
    btn.innerHTML = COPY_SVG;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code');
      const text = (code || pre).innerText;
      copyToClipboard(text, btn);
    });
    pre.appendChild(btn);
  });
  // Inline <code> (skip ones inside <pre>)
  root.querySelectorAll('code').forEach(code => {
    if (code.closest('pre')) return;
    if (code.parentElement?.classList.contains('kb-inline-code-wrap')) return;
    const wrap = document.createElement('span');
    wrap.className = 'kb-inline-code-wrap';
    code.parentNode.insertBefore(wrap, code);
    wrap.appendChild(code);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kb-copy-btn';
    btn.title = 'Copy';
    btn.innerHTML = COPY_SVG;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(code.innerText, btn);
    });
    wrap.appendChild(btn);
  });
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  if (!btn) return;
  const oldHTML = btn.innerHTML;
  btn.innerHTML = CHECK_SVG;
  btn.classList.add('copied');
  setTimeout(() => {
    btn.innerHTML = oldHTML;
    btn.classList.remove('copied');
  }, 1100);
}

function highlightInNode(root, terms) {
  if (!terms.length) return 0;
  const pattern = terms.map(escRe).join('|');
  const skip = new Set(['SCRIPT', 'STYLE', 'MARK']);
  let count = 0;
  const detect = new RegExp(pattern, 'i');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      let p = node.parentNode;
      while (p && p !== root) {
        if (skip.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return detect.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const targets = []; let n;
  while ((n = walker.nextNode())) targets.push(n);
  targets.forEach(node => {
    const text = node.nodeValue;
    const finder = new RegExp(pattern, 'gi');
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = finder.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      count++;
      last = m.index + m[0].length;
      if (m[0].length === 0) finder.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
  return count;
}

function focusMatch(idx) {
  if (!state.matches.length) return;
  state.matches.forEach(m => m.classList.remove('active-match'));
  const t = state.matches[idx];
  if (!t) return;
  t.classList.add('active-match');
  t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  updateMatchCounter();
}
function updateMatchCounter() {
  $('#match-counter').textContent = state.matches.length
    ? `${state.activeMatchIdx + 1} / ${state.matches.length}` : '0 / 0';
}

/* ============================================================================
   EDITOR (autosave on Ctrl+S; explicit save on button)
   ============================================================================ */

function renderEditor() {
  const doc = state.currentDocId ? getDoc(state.currentDocId) : null;
  $('#editor-title').value   = doc ? doc.title : '';
  $('#editor-tags').value    = doc ? (doc.tags || []).join(', ') : '';
  $('#editor-content').value = doc ? doc.content : '';
  state.isDirty = false;
  updateEditorStats();
  setSavedState('Idle');
  $('#editor-preview').hidden = true;
  $('#editor-content').focus();
}

function updateEditorStats() {
  const text = $('#editor-content').value;
  $('#editor-stats').textContent = `${wordCount(text)} words · ${text.length} chars · ${readingMins(text)} min read`;
}

function setSavedState(label, dirty = false) {
  $('#editor-saved-state').textContent = label;
  $('#editor-saved-state').style.color = dirty ? 'var(--danger)' : '';
}

async function saveEditor() {
  const title   = $('#editor-title').value.trim() || 'Untitled';
  const content = $('#editor-content').value;
  const tags    = $('#editor-tags').value.split(',').map(s => s.trim()).filter(Boolean);

  setSavedState('Saving…');
  let doc;
  if (state.currentDocId && getDoc(state.currentDocId)) {
    doc = await updateDoc(state.currentDocId, { title, content, tags });
  } else {
    doc = await createDoc({ title, content, tags });
    if (doc) state.currentDocId = doc.id;
  }
  if (!doc) { setSavedState('Save failed', true); return; }
  state.isDirty = false;
  setSavedState('Saved · ' + fmtDate(doc.updated_at));
  renderDocList(); renderTags();
  toast('Saved', 'success');
}

const scheduleAutosave = debounce(async () => {
  if (!state.isDirty || state.activeView !== 'editor') return;
  await saveEditor();
}, 1500);

function applyFormat(action) {
  const ta = $('#editor-content');
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const before = ta.value.slice(0, start), sel = ta.value.slice(start, end), after = ta.value.slice(end);
  let inserted = sel, cursorOffset = 0;
  switch (action) {
    case 'bold':      inserted = `**${sel || 'bold'}**`; cursorOffset = sel ? 0 : -2; break;
    case 'italic':    inserted = `*${sel || 'italic'}*`; cursorOffset = sel ? 0 : -1; break;
    case 'code':      inserted = `\`${sel || 'code'}\``; cursorOffset = sel ? 0 : -1; break;
    case 'codeblock': inserted = `\n\`\`\`\n${sel || 'code'}\n\`\`\`\n`; break;
    case 'heading':   inserted = (before.endsWith('\n') || !before ? '' : '\n') + `## ${sel || 'Heading'}\n`; break;
    case 'list':      inserted = (before.endsWith('\n') || !before ? '' : '\n') + `- ${sel || 'item'}\n`; break;
    case 'numlist':   inserted = (before.endsWith('\n') || !before ? '' : '\n') + `1. ${sel || 'item'}\n`; break;
    case 'quote':     inserted = (before.endsWith('\n') || !before ? '' : '\n') + `> ${sel || 'quote'}\n`; break;
    case 'link':      inserted = `[${sel || 'text'}](https://)`; cursorOffset = -1; break;
    case 'table':     inserted = `\n| Col 1 | Col 2 |\n| --- | --- |\n| a | b |\n`; break;
    case 'hr':        inserted = `\n\n---\n\n`; break;
  }
  ta.value = before + inserted + after;
  const newPos = before.length + inserted.length + cursorOffset;
  ta.setSelectionRange(newPos, newPos);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function togglePreview() {
  const p = $('#editor-preview');
  if (p.hidden) {
    p.innerHTML = DOMPurify.sanitize(marked.parse($('#editor-content').value || '', { breaks: true, gfm: true }));
    decorateCopy(p);
    p.hidden = false;
    $('#editor-preview-toggle').classList.add('btn-primary');
  } else {
    p.hidden = true;
    $('#editor-preview-toggle').classList.remove('btn-primary');
  }
}
function updatePreview() {
  const p = $('#editor-preview');
  if (p.hidden) return;
  p.innerHTML = DOMPurify.sanitize(marked.parse($('#editor-content').value || '', { breaks: true, gfm: true }));
  decorateCopy(p);
}

/* ============================================================================
   SEARCH — literal substring, case-insensitive, across title+content+tags
   ============================================================================ */

function performSearch(q) {
  state.searchQuery = q;
  if (!q.trim()) {
    state.searchTerms = [];
    if (state.activeView === 'search') {
      if (state.currentDocId) showView('doc'); else showView('welcome');
    }
    return;
  }
  state.searchTerms = [q];
  showView('search');
  renderSearchResults();
}

function renderSearchResults() {
  const q = state.searchQuery.trim();
  const wrap = $('#search-results');
  $('#search-view-title').textContent = `Results for "${q}"`;
  if (!q) { wrap.innerHTML = ''; return; }

  const needle = q.toLowerCase();
  const results = [];
  for (const doc of state.docs) {
    const title = doc.title || '', content = doc.content || '', tags = (doc.tags || []).join(' ');
    const hay = (title + '\n' + tags + '\n' + content).toLowerCase();
    let count = 0, from = 0;
    while (true) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      count++; from = i + needle.length;
    }
    if (count > 0) {
      const titleHit = title.toLowerCase().includes(needle) ? 1000 : 0;
      results.push({ doc, count, score: titleHit + count });
    }
  }
  results.sort((a, b) => b.score - a.score);

  if (results.length === 0) {
    wrap.innerHTML = `<div class="empty-search"><h3>No matches for "${esc(q)}"</h3><p>Search is literal — the exact text isn't in any doc.</p></div>`;
    return;
  }

  wrap.innerHTML = results.map(({ doc, count }) => `
    <div class="search-result" data-id="${doc.id}">
      <div class="search-result-head">
        <div class="search-result-title">${highlightString(doc.title || 'Untitled', state.searchTerms)}</div>
        <div class="search-result-count">${count} match${count === 1 ? '' : 'es'}</div>
      </div>
      <div class="search-result-snippet">${makeSnippet(doc.content, state.searchTerms)}</div>
      <div class="search-result-meta">
        <span>Updated ${fmtDate(doc.updated_at)}</span>
        <span>·</span>
        <span>${wordCount(doc.content)} words</span>
        ${(doc.tags || []).length ? '<span>·</span>' + doc.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join(' ') : ''}
      </div>
    </div>`).join('');

  $$('#search-results .search-result').forEach(el => el.addEventListener('click', () => {
    state.currentDocId = el.dataset.id;
    showView('doc'); renderDocList();
  }));
}

function highlightString(text, terms) {
  if (!terms.length) return esc(text);
  const re = new RegExp(`(${terms.map(escRe).join('|')})`, 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}
function makeSnippet(text, terms) {
  if (!text) return '';
  if (!terms.length) return esc(text.slice(0, 220)) + (text.length > 220 ? '…' : '');
  const re = new RegExp(terms.map(escRe).join('|'), 'i');
  const idx = text.search(re);
  if (idx < 0) return esc(text.slice(0, 220)) + '…';
  const start = Math.max(0, idx - 80), end = Math.min(text.length, idx + 160);
  const chunk = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  return highlightString(chunk, terms);
}

/* ============================================================================
   COMMAND PALETTE
   ============================================================================ */

const COMMANDS = [
  { id: 'new',         kind: 'cmd', label: 'Create new document',        run: () => { state.currentDocId = null; showView('editor'); } },
  { id: 'new-folder',  kind: 'cmd', label: 'Create new folder',          run: () => promptNewFolder(state.currentFolderId) },
  { id: 'move',        kind: 'cmd', label: 'Move current doc to folder', run: openMoveDocModal },
  { id: 'all-docs',    kind: 'cmd', label: 'Show all documents (root)',  run: () => { state.currentFolderId = null; renderFolderTree(); renderDocList(); } },
  { id: 'search',      kind: 'cmd', label: 'Focus search',                run: () => $('#global-search').focus() },
  { id: 'sidebar',     kind: 'cmd', label: 'Toggle sidebar',              run: toggleSidebar },
  { id: 'theme',       kind: 'cmd', label: 'Toggle dark / light theme',   run: toggleTheme },
  { id: 'preview',     kind: 'cmd', label: 'Toggle editor preview',       run: () => { if (state.activeView==='editor') togglePreview(); } },
  { id: 'history',     kind: 'cmd', label: 'Show version history',        run: () => openVersionHistory() },
  { id: 'share',       kind: 'cmd', label: 'Share current doc',           run: () => openShareModal() },
  { id: 'export',      kind: 'cmd', label: 'Export all docs (.json)',     run: exportAll },
  { id: 'import',      kind: 'cmd', label: 'Import docs (.json)',         run: triggerImport },
  { id: 'samples',     kind: 'cmd', label: 'Load sample runbooks',        run: seedSamples },
  { id: 'profile',     kind: 'cmd', label: 'Edit profile',                run: openProfile },
  { id: 'add-user',    kind: 'cmd', label: 'Add user (admin)',            run: () => state.isAdmin ? openAddUser() : toast('Admin only', 'error') },
  { id: 'users',       kind: 'cmd', label: 'Manage users (admin)',        run: () => state.isAdmin ? openManageUsers() : toast('Admin only', 'error') },
  { id: 'shortcuts',   kind: 'cmd', label: 'Show keyboard shortcuts',     run: openShortcuts },
  { id: 'print',       kind: 'cmd', label: 'Print / save as PDF',         run: () => window.print() },
  { id: 'logout',      kind: 'cmd', label: 'Sign out',                    run: signOut },
];

let cmdIdx = 0;
let cmdResults = [];
function openCmdPalette() {
  $('#cmd-palette').hidden = false;
  $('#cmd-palette-input').value = '';
  renderCmd('');
  $('#cmd-palette-input').focus();
}
function closeCmdPalette() { $('#cmd-palette').hidden = true; }
function renderCmd(q) {
  const ql = q.toLowerCase().trim();
  const cmds = COMMANDS.filter(c => !ql || c.label.toLowerCase().includes(ql));
  const docs = state.docs
    .filter(d => !ql || (d.title || '').toLowerCase().includes(ql))
    .slice(0, 10)
    .map(d => ({ id: 'doc:' + d.id, kind: 'doc', label: d.title || 'Untitled', run: () => { state.currentDocId = d.id; showView('doc'); renderDocList(); } }));
  cmdResults = ql ? [...docs, ...cmds] : [...cmds, ...docs];
  cmdIdx = 0;
  const out = $('#cmd-palette-results');
  if (cmdResults.length === 0) {
    out.innerHTML = '<div class="doc-item-empty">No matches.</div>';
    return;
  }
  out.innerHTML = cmdResults.map((c, i) =>
    `<div class="cmd-result ${i === cmdIdx ? 'active' : ''}" data-i="${i}">
       <span class="cmd-result-kind">${c.kind}</span>
       <span>${esc(c.label)}</span>
     </div>`).join('');
  $$('.cmd-result', out).forEach(el => {
    el.addEventListener('mouseenter', () => { cmdIdx = +el.dataset.i; refreshCmdActive(); });
    el.addEventListener('click', () => runCmd(+el.dataset.i));
  });
}
function refreshCmdActive() {
  $$('.cmd-result').forEach((el, i) => el.classList.toggle('active', i === cmdIdx));
  const a = $$('.cmd-result')[cmdIdx];
  if (a) a.scrollIntoView({ block: 'nearest' });
}
function runCmd(i) {
  const c = cmdResults[i];
  if (!c) return;
  closeCmdPalette();
  setTimeout(() => c.run(), 0);
}

/* ============================================================================
   MODALS
   ============================================================================ */

function openModal({ title, body, footer = '', size = '' }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-footer').innerHTML = footer;
  $('#modal').className = 'modal ' + size;
  $('#modal-overlay').hidden = false;
}
function closeModal() { $('#modal-overlay').hidden = true; }

async function openVersionHistory() {
  const d = getDoc(state.currentDocId);
  if (!d) return;
  openModal({ title: `History · ${d.title}`, body: '<div style="text-align:center;color:var(--text-muted);padding:24px;">Loading…</div>', footer: `<button class="btn btn-ghost btn-sm" id="vh-close">Close</button>`, size: 'modal-lg' });
  $('#vh-close').onclick = closeModal;
  const { data, error } = await sb.from('doc_versions').select('*').eq('doc_id', d.id).order('saved_at', { ascending: false }).limit(3);
  if (error) { $('#modal-body').textContent = error.message; return; }
  if (!data.length) { $('#modal-body').innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No previous versions yet. Edit and save to create history.</p>'; return; }
  $('#modal-body').innerHTML = `<div class="version-list">${data.map(v => `
    <div class="version-row" data-id="${v.id}">
      <div class="version-row-meta">
        <div class="version-row-title">${esc(v.title || 'Untitled')}</div>
        <div class="version-row-time">${fmtDate(v.saved_at)} · ${wordCount(v.content)} words</div>
      </div>
      <div class="version-actions">
        <button class="btn btn-ghost btn-sm" data-act="preview" data-id="${v.id}">Preview</button>
        <button class="btn btn-primary btn-sm" data-act="restore" data-id="${v.id}">Restore</button>
      </div>
    </div>`).join('')}</div>`;
  $('#modal-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const v = data.find(x => x.id === btn.dataset.id);
    if (btn.dataset.act === 'preview') {
      openModal({
        title: `Preview · ${v.title}`,
        body: `<div class="markdown-body" style="max-height:60vh;overflow-y:auto;">${DOMPurify.sanitize(marked.parse(v.content || '', { breaks: true, gfm: true }))}</div>`,
        footer: `<button class="btn btn-ghost btn-sm" id="vp-close">Close</button>`,
        size: 'modal-lg',
      });
      decorateCopy($('#modal-body'));
      $('#vp-close').onclick = closeModal;
    } else if (btn.dataset.act === 'restore') {
      if (!confirm('Restore this version? Current content becomes a new history entry.')) return;
      await updateDoc(d.id, { title: v.title, content: v.content, tags: v.tags });
      toast('Restored', 'success');
      closeModal();
      renderDocView();
    }
  });
}

async function openShareModal() {
  const d = getDoc(state.currentDocId);
  if (!d) return;
  let cur = d;
  const body = `
    <p style="margin:0 0 12px;color:var(--text-soft);font-size:13px;">Toggle public sharing. Anyone with the link can view the latest version (read-only).</p>
    <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
      <input type="checkbox" id="share-toggle" ${cur.is_public ? 'checked' : ''} />
      <span>Enable public link</span>
    </label>
    <div id="share-url-wrap" ${cur.is_public ? '' : 'hidden'} style="margin-top:14px;">
      <div class="share-row">
        <input id="share-url" readonly />
        <button class="btn btn-primary btn-sm" id="share-copy">Copy</button>
      </div>
      <p style="font-size:11.5px;color:var(--text-muted);margin:6px 0 0;">Disable any time — the link instantly stops working.</p>
    </div>`;
  openModal({ title: 'Share document', body, footer: `<button class="btn btn-ghost btn-sm" id="share-close">Close</button>` });
  $('#share-close').onclick = closeModal;

  const refresh = (doc) => {
    cur = doc;
    $('#share-toggle').checked = !!doc.is_public;
    $('#share-url-wrap').hidden = !doc.is_public;
    if (doc.share_token) {
      const u = new URL(location.href);
      u.hash = '#share=' + doc.share_token;
      $('#share-url').value = u.toString();
    }
  };
  refresh(cur);

  $('#share-toggle').onchange = async (e) => {
    const enabled = e.target.checked;
    const patch = { is_public: enabled };
    if (enabled && !cur.share_token) patch.share_token = randomToken();
    const updated = await updateDoc(d.id, patch);
    if (updated) refresh(updated);
  };
  $('#share-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#share-url').value); toast('Link copied', 'success'); }
    catch { $('#share-url').select(); document.execCommand('copy'); toast('Link copied', 'success'); }
  };
}

function randomToken() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

function openProfile() {
  const cur = state.profile || {};
  openModal({
    title: 'Profile & password',
    body: `
      <h4 style="margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Profile</h4>
      <div class="form-group"><label>Email</label><input type="email" value="${esc(state.user.email)}" disabled /></div>
      <div class="form-group"><label>Display name</label><input id="prof-name" type="text" value="${esc(cur.display_name || '')}" /></div>
      <button class="btn btn-primary btn-sm" id="pf-save">Save profile</button>
      <hr style="border:none;border-top:1px solid var(--border);margin:20px 0;"/>
      <h4 style="margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);">Change password</h4>
      <div class="form-group"><label>New password</label><input id="pf-newpw" type="password" minlength="8" autocomplete="new-password" /></div>
      <div class="form-group"><label>Confirm new password</label><input id="pf-confirm" type="password" minlength="8" autocomplete="new-password" /></div>
      <button class="btn btn-primary btn-sm" id="pf-pwsave">Change password</button>
      <div id="pf-msg" class="form-info" hidden style="margin-top:10px;"></div>
      <div id="pf-err" class="form-error" hidden style="margin-top:10px;"></div>
    `,
    footer: `<button class="btn btn-ghost btn-sm" id="pf-close">Close</button>`,
    size: 'modal-lg',
  });
  $('#pf-close').onclick = closeModal;
  $('#pf-save').onclick = async () => {
    const display_name = $('#prof-name').value.trim();
    const { error } = await sb.from('profiles').update({ display_name }).eq('id', state.user.id);
    if (error) return showInModal('pf-err', error.message);
    state.profile.display_name = display_name;
    renderUserChip();
    showInModal('pf-msg', 'Profile saved');
  };
  $('#pf-pwsave').onclick = async () => {
    const nw = $('#pf-newpw').value, cf = $('#pf-confirm').value;
    if (nw.length < 8) return showInModal('pf-err', 'Use at least 8 characters.');
    if (nw !== cf)     return showInModal('pf-err', 'Passwords do not match.');
    const { error } = await sb.auth.updateUser({ password: nw });
    if (error) return showInModal('pf-err', error.message);
    await sb.from('profiles').update({ must_change_password: false }).eq('id', state.user.id);
    showInModal('pf-msg', 'Password updated');
    $('#pf-newpw').value = ''; $('#pf-confirm').value = '';
  };
}

function showInModal(id, msg) {
  const ok = id === 'pf-msg';
  $('#pf-err').hidden = ok;
  $('#pf-msg').hidden = !ok;
  $('#' + id).textContent = msg;
  $('#' + id).hidden = false;
}

function openShortcuts() {
  const rows = [
    ['Search',          'Ctrl K'],
    ['Command palette', 'Ctrl Shift P'],
    ['New document',    'Ctrl N'],
    ['Save',            'Ctrl S'],
    ['Edit / View',     'Ctrl E'],
    ['Toggle preview',  'Ctrl P'],
    ['Bold / Italic',   'Ctrl B  /  Ctrl I'],
    ['Next / prev match','Enter / Shift+Enter'],
    ['Toggle sidebar',  'Ctrl B (outside editor)'],
    ['Toggle theme',    'Ctrl Shift L'],
    ['Close / cancel',  'Esc'],
  ];
  const body = `<div class="shortcuts-grid">${rows.map(([a, b]) => `<div class="shortcut-row"><span>${a}</span><kbd>${b}</kbd></div>`).join('')}</div>`;
  openModal({ title: 'Keyboard shortcuts', body, footer: `<button class="btn btn-ghost btn-sm" id="sc-close">Close</button>` });
  $('#sc-close').onclick = closeModal;
}

/* ============================================================================
   IMPORT / EXPORT (JSON backup)
   ============================================================================ */

function exportAll() {
  const payload = { exportedAt: new Date().toISOString(), docs: state.docs };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `knowledgebox-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported', 'success');
}
function triggerImport() { $('#import-file-input').click(); }

/* ============================================================================
   SAMPLES
   ============================================================================ */

const SAMPLES = [
  { title: 'CrashLoopBackOff troubleshooting', tags: ['k8s','oncall','runbook'], content:
`# CrashLoopBackOff Troubleshooting

A pod is stuck restarting.

\`\`\`bash
kubectl get pods -n production
kubectl describe pod <pod-name> -n production
kubectl logs <pod-name> -n production --previous
\`\`\`

## Common causes
- **OOMKilled** — bump memory limits
- **Bad image tag** — verify with describe
- **Failing liveness probe** — check /healthz
- **Missing config / secret** — check configmap and secret`,
  },
  { title: 'kubectl quick reference', tags: ['k8s','cheatsheet'], content:
`# kubectl quick reference

## Inspect
\`\`\`bash
kubectl get pods -A
kubectl describe pod <name>
kubectl logs <name> -f --tail=200
\`\`\`

## Roll out
\`\`\`bash
kubectl rollout status deployment/<name>
kubectl rollout undo deployment/<name>
kubectl scale deployment/<name> --replicas=3
\`\`\``,
  },
  { title: 'Incident response checklist', tags: ['oncall','runbook'], content:
`# Incident response

## First 5 minutes
1. Acknowledge the page
2. Open the incident channel
3. Snapshot dashboards before changing anything

## Triage
- Customer-facing? How many users?
- Spreading or contained?
- Recent deploy? \`kubectl rollout history\`

## Stop the bleeding
- Roll back last deploy first, ask questions later
- Scale up if load-related
- Drain bad nodes`,
  },
];

async function seedSamples() {
  if (state.docs.length > 0 && !confirm('Add sample runbooks to your library?')) return;
  for (const s of SAMPLES) await createDoc(s);
  toast(`Added ${SAMPLES.length} sample docs`, 'success');
}

/* ============================================================================
   MOBILE SIDEBAR DRAWER
   ============================================================================ */

function isMobile() { return window.matchMedia('(max-width: 640px)').matches; }

function toggleSidebar() {
  const sb = $('#sidebar');
  if (isMobile()) {
    const open = sb.classList.toggle('collapsed') === false;
    // After toggle: if NOT collapsed -> drawer is OPEN
    if (!sb.classList.contains('collapsed')) openSidebarMobile();
    else closeSidebarMobile();
  } else {
    sb.classList.toggle('collapsed');
  }
}
function openSidebarMobile() {
  $('#sidebar').classList.remove('collapsed');
  $('#sidebar-backdrop').hidden = false;
}
function closeSidebarMobile() {
  $('#sidebar').classList.add('collapsed');
  $('#sidebar-backdrop').hidden = true;
}

/* ============================================================================
   THEME
   ============================================================================ */

function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem('kb.theme', mode);
  const icon = $('#theme-icon');
  if (!icon) return;
  if (mode === 'dark') icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  else icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ============================================================================
   TOAST
   ============================================================================ */

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ============================================================================
   PUBLIC SHARE READ-ONLY MODE
   ============================================================================ */

async function maybeRenderSharedView() {
  const m = location.hash.match(/^#share=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  const token = m[1];
  $('#auth-screen').hidden = true;
  $('#app').hidden = true;
  document.body.innerHTML = `
    <div style="max-width:780px;margin:40px auto;padding:24px;font-family:var(--font);">
      <div id="share-loading" style="color:var(--text-muted);">Loading shared document…</div>
      <div id="share-doc"></div>
      <p style="margin-top:40px;font-size:12px;color:var(--text-muted);text-align:center;">
        Shared from <a href="${location.origin + location.pathname}">KnowledgeBox</a>
      </p>
    </div>`;
  const { data, error } = await sb.from('docs').select('title,content,tags,updated_at').eq('share_token', token).eq('is_public', true).maybeSingle();
  if (error || !data) {
    $('#share-loading').textContent = 'This share link is invalid or has been disabled.';
    return true;
  }
  const html = DOMPurify.sanitize(marked.parse(data.content || '', { breaks: true, gfm: true }));
  $('#share-loading').remove();
  $('#share-doc').innerHTML = `
    <h1 style="margin:0 0 6px;">${esc(data.title)}</h1>
    <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:24px;">Updated ${fmtDate(data.updated_at)} · ${wordCount(data.content)} words</div>
    <div class="markdown-body">${html}</div>`;
  decorateCopy($('#share-doc'));
  document.title = data.title + ' · KnowledgeBox (shared)';
  return true;
}

/* ============================================================================
   EVENT WIRING
   ============================================================================ */

function bindEvents() {
  // Auth
  $('#auth-form').addEventListener('submit', handleAuthSubmit);

  // Forced password change
  $('#pwchange-form').addEventListener('submit', handlePasswordChange);
  $('#pwchange-signout').addEventListener('click', signOut);

  // Top bar
  $('#toggle-sidebar').addEventListener('click', toggleSidebar);
  $('#sidebar-backdrop').addEventListener('click', () => { closeSidebarMobile(); });
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#new-doc-btn').addEventListener('click', () => { state.currentDocId = null; showView('editor'); });
  $('#cmd-palette-btn').addEventListener('click', openCmdPalette);

  // User dropdown
  $('#user-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#user-dropdown').hidden = !$('#user-dropdown').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) $('#user-dropdown').hidden = true;
  });
  $('#user-dropdown').addEventListener('click', (e) => {
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (!act) return;
    $('#user-dropdown').hidden = true;
    if (act === 'logout')      signOut();
    else if (act === 'export') exportAll();
    else if (act === 'import') triggerImport();
    else if (act === 'profile') openProfile();
    else if (act === 'shortcuts') openShortcuts();
    else if (act === 'users')   openManageUsers();
    else if (act === 'add-user') openAddUser();
    else if (act === 'backup')   openBackupModal();
  });

  // Sidebar sort
  $('#sort-select').addEventListener('change', (e) => { state.sort = e.target.value; renderDocList(); });

  // On mobile, tapping a doc closes the sidebar drawer
  $('#doc-list').addEventListener('click', () => { if (isMobile()) closeSidebarMobile(); });

  // Close sidebar drawer on viewport resize back to desktop
  window.addEventListener('resize', debounce(() => { if (!isMobile()) $('#sidebar-backdrop').hidden = true; }, 100));

  // Search
  const onSearch = debounce(() => performSearch($('#global-search').value), 120);
  $('#global-search').addEventListener('input', onSearch);
  $('#global-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#global-search').value = ''; performSearch(''); } });
  $('#clear-search-btn').addEventListener('click', () => { $('#global-search').value = ''; performSearch(''); });

  // Doc view toolbar
  $('#edit-btn').addEventListener('click', () => showView('editor'));
  $('#delete-btn').addEventListener('click', async () => {
    const d = getDoc(state.currentDocId); if (!d) return;
    if (!confirm(`Delete "${d.title}"? This cannot be undone.`)) return;
    await deleteDoc(d.id); toast('Deleted');
  });
  $('#pin-btn').addEventListener('click', async () => {
    const d = getDoc(state.currentDocId); if (!d) return;
    const updated = await updateDoc(d.id, { pinned: !d.pinned });
    if (updated) { renderDocList(); renderDocView(); }
  });
  $('#share-btn').addEventListener('click', openShareModal);
  $('#history-btn').addEventListener('click', openVersionHistory);
  $('#move-btn').addEventListener('click', openMoveDocModal);
  $('#new-folder-btn').addEventListener('click', () => promptNewFolder(state.currentFolderId));
  $('#print-btn').addEventListener('click', () => window.print());
  $('#next-match').addEventListener('click', () => {
    if (!state.matches.length) return;
    state.activeMatchIdx = (state.activeMatchIdx + 1) % state.matches.length;
    focusMatch(state.activeMatchIdx);
  });
  $('#prev-match').addEventListener('click', () => {
    if (!state.matches.length) return;
    state.activeMatchIdx = (state.activeMatchIdx - 1 + state.matches.length) % state.matches.length;
    focusMatch(state.activeMatchIdx);
  });

  // Editor
  $('#editor-content').addEventListener('input', () => {
    state.isDirty = true; setSavedState('Unsaved', true);
    updateEditorStats(); updatePreview(); scheduleAutosave();
  });
  $('#editor-title').addEventListener('input', () => { state.isDirty = true; setSavedState('Unsaved', true); scheduleAutosave(); });
  $('#editor-tags').addEventListener('input', () => { state.isDirty = true; setSavedState('Unsaved', true); scheduleAutosave(); });
  $('#editor-save').addEventListener('click', saveEditor);
  $('#editor-cancel').addEventListener('click', () => {
    if (state.currentDocId && getDoc(state.currentDocId)) showView('doc');
    else showView('welcome');
  });
  $('#editor-preview-toggle').addEventListener('click', togglePreview);
  $('#editor-format-bar').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.md;
    if (action) applyFormat(action);
  });

  // Welcome
  $('#welcome-new').addEventListener('click', () => { state.currentDocId = null; showView('editor'); });
  $('#welcome-sample').addEventListener('click', seedSamples);

  // Modal close
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', (e) => { if (e.target === $('#modal-overlay')) closeModal(); });

  // Command palette
  $('#cmd-palette-input').addEventListener('input', (e) => renderCmd(e.target.value));
  $('#cmd-palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdIdx = Math.min(cmdIdx + 1, cmdResults.length - 1); refreshCmdActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdIdx = Math.max(cmdIdx - 1, 0); refreshCmdActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdIdx); }
    else if (e.key === 'Escape') closeCmdPalette();
  });
  $('#cmd-palette').addEventListener('click', (e) => { if (e.target.id === 'cmd-palette') closeCmdPalette(); });

  // Import
  $('#import-file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      const docs = Array.isArray(data) ? data : data.docs;
      if (!Array.isArray(docs)) throw new Error('Invalid file format.');
      let n = 0;
      for (const d of docs) {
        if (!d.title && !d.content) continue;
        await createDoc({ title: d.title, content: d.content, tags: d.tags || [] });
        n++;
      }
      toast(`Imported ${n} doc${n === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    } finally { e.target.value = ''; }
  });

  // Global hotkeys
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (!$('#modal-overlay').hidden) { closeModal(); return; }
      if (!$('#cmd-palette').hidden) { closeCmdPalette(); return; }
      if (document.activeElement === $('#global-search')) {
        $('#global-search').value = ''; performSearch(''); $('#global-search').blur(); return;
      }
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openCmdPalette(); return; }
    if (ctrl && e.key.toLowerCase() === 'k') {
      if (document.activeElement?.tagName === 'TEXTAREA' && state.activeView === 'editor') {
        e.preventDefault(); applyFormat('link'); return;
      }
      e.preventDefault(); $('#global-search').focus(); $('#global-search').select(); return;
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); promptNewFolder(state.currentFolderId); return; }
    if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); state.currentDocId = null; showView('editor'); return; }
    if (ctrl && e.key.toLowerCase() === 's' && state.activeView === 'editor') { e.preventDefault(); saveEditor(); return; }
    if (ctrl && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      if (state.activeView === 'editor') showView('doc');
      else if (state.currentDocId) showView('editor');
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'p' && state.activeView === 'editor') { e.preventDefault(); togglePreview(); return; }
    if (ctrl && e.key.toLowerCase() === 'b') {
      if (document.activeElement?.tagName === 'TEXTAREA' && state.activeView === 'editor') {
        e.preventDefault(); applyFormat('bold'); return;
      }
      e.preventDefault(); toggleSidebar(); return;
    }
    if (ctrl && e.key.toLowerCase() === 'i' && state.activeView === 'editor' && document.activeElement?.tagName === 'TEXTAREA') {
      e.preventDefault(); applyFormat('italic'); return;
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggleTheme(); return; }

    if (state.activeView === 'doc' && state.matches.length && e.key === 'Enter') {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (e.shiftKey) state.activeMatchIdx = (state.activeMatchIdx - 1 + state.matches.length) % state.matches.length;
      else state.activeMatchIdx = (state.activeMatchIdx + 1) % state.matches.length;
      focusMatch(state.activeMatchIdx);
    }
  });

  // Warn before nav if editor is dirty
  window.addEventListener('beforeunload', (e) => {
    if (state.activeView === 'editor' && state.isDirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ============================================================================
   BOOT
   ============================================================================ */

applyTheme(localStorage.getItem('kb.theme') || 'light');
bindEvents();
if (isMobile()) $('#sidebar').classList.add('collapsed');

(async () => {
  // Public share-link view bypasses auth
  if (await maybeRenderSharedView()) return;
  await bootAuth();
})();
