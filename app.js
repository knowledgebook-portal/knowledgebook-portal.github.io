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

/* ---------- App state ---------- */
const state = {
  user: null,
  profile: null,
  docs: [],
  currentDocId: null,
  activeView: 'welcome',      // welcome | doc | editor | search
  sort: 'updated',
  filterTag: null,
  searchQuery: '',
  searchTerms: [],            // single phrase, for highlighting
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

/* ----- Admin: invoke Edge Function for create/reset/delete ----- */
async function adminFn(action, body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const url = SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/admin-users';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

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

  // Disable write actions for viewers
  $('#new-doc-btn').style.display = canWrite ? '' : 'none';
  $('#welcome-new').style.display = canWrite ? '' : 'none';
  $('#welcome-sample').style.display = canWrite ? '' : 'none';
  $('#import-btn').style.display = canWrite ? '' : 'none';
  $('#edit-btn').style.display = canWrite ? '' : 'none';
  $('#delete-btn').style.display = canWrite ? '' : 'none';
  $('#pin-btn').style.display = canWrite ? '' : 'none';
  $('#share-btn').style.display = canWrite ? '' : 'none';

  state.canWrite = canWrite;
  state.isAdmin = isAdmin;
}

/* ============================================================================
   DATA LAYER (Supabase docs CRUD)
   ============================================================================ */

async function loadDocs() {
  const { data, error } = await sb.from('docs').select('*').order('updated_at', { ascending: false });
  if (error) { toast('Load failed: ' + error.message, 'error'); return; }
  state.docs = data || [];
  renderDocList();
  renderTags();
}

async function createDoc(partial = {}) {
  const row = {
    owner_id: state.user.id,
    title:    partial.title || 'Untitled',
    content:  partial.content || '',
    tags:     partial.tags || [],
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
    .channel('docs:' + state.user.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'docs', filter: `owner_id=eq.${state.user.id}` },
      (payload) => handleRealtime(payload))
    .subscribe(status => {
      if (status === 'SUBSCRIBED') setPill('live', 'Live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setPill('offline', 'Offline');
    });
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
  if (state.filterTag) docs = docs.filter(d => (d.tags || []).includes(state.filterTag));
  docs = sortDocs(docs, state.sort);
  docs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  $('#doc-count').textContent = docs.length;
  $('#doc-count-label').textContent = state.filterTag ? `Tag: ${state.filterTag}` : 'All documents';

  if (docs.length === 0) {
    list.innerHTML = '<div class="doc-item-empty">No documents yet.<br/>Press <kbd>Ctrl N</kbd> to create one.</div>';
    return;
  }
  list.innerHTML = docs.map(d => `
    <div class="doc-item ${d.id === state.currentDocId ? 'active' : ''}" data-id="${d.id}">
      <div class="doc-item-title">
        ${d.pinned ? '<span class="doc-item-pin">★</span>' : ''}
        <span>${esc(d.title || 'Untitled')}</span>
      </div>
      <div class="doc-item-meta">
        <span>${fmtDate(d.updated_at)}</span>
        <span>·</span>
        <span>${wordCount(d.content)} words</span>
      </div>
    </div>
  `).join('');
  $$('#doc-list .doc-item').forEach(el => el.addEventListener('click', () => {
    state.currentDocId = el.dataset.id;
    showView('doc');
    renderDocList();
  }));
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
  $('#doc-view-updated').textContent = 'Updated ' + fmtDate(doc.updated_at);
  $('#doc-view-words').textContent = wordCount(doc.content) + ' words';
  $('#doc-view-reading').textContent = readingMins(doc.content) + ' min read';
  $('#doc-view-tags').innerHTML = (doc.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join('');
  $('#pin-btn').classList.toggle('active', !!doc.pinned);

  const html = marked.parse(doc.content || '', { breaks: true, gfm: true });
  const safe = DOMPurify.sanitize(html);
  const target = $('#doc-rendered');
  target.innerHTML = safe;

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
  const { data, error } = await sb.from('doc_versions').select('*').eq('doc_id', d.id).order('saved_at', { ascending: false }).limit(40);
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
