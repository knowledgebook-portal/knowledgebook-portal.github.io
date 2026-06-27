// ============================================================================
//  admin-users — Supabase Edge Function
//  ============================================================================
//  Deploy this in Supabase Dashboard:
//    1. Left sidebar: Edge Functions
//    2. "Create a new function"
//    3. Name it EXACTLY: admin-users
//    4. Paste ALL of this file's contents as the function code
//    5. Click "Deploy function"
//    6. Open the function -> Secrets tab -> already has SUPABASE_URL,
//       SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY by default. Done.
//
//  This function performs admin-only user operations that the browser cannot
//  do with the anon key. It verifies the CALLER is an active admin (by
//  checking their JWT against the profiles table) before doing anything.
//
//  Endpoints (all POST /functions/v1/admin-users):
//    { action: "create",  email, password, role, display_name }
//    { action: "reset",   user_id, new_password }
//    { action: "delete",  user_id }
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405);

  // 1. Verify caller's JWT (sent by the browser as `Authorization: Bearer <jwt>`)
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Missing auth" }, 401);

  // Use a per-request client bound to the user's JWT so we can read their identity
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: caller, error: callerErr } = await userClient.auth.getUser();
  if (callerErr || !caller?.user) return json({ error: "Invalid auth" }, 401);

  // 2. Check the caller is an active admin
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: callerProfile, error: profileErr } = await admin
    .from("profiles")
    .select("role, status")
    .eq("id", caller.user.id)
    .maybeSingle();
  if (profileErr) return json({ error: profileErr.message }, 500);
  if (!callerProfile || callerProfile.role !== "admin" || callerProfile.status !== "active") {
    return json({ error: "Admin only" }, 403);
  }

  // 3. Dispatch action
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = body?.action;

  try {
    if (action === "create") {
      const { email, password, role, display_name } = body;
      if (!email || !password) return json({ error: "Email and password required" }, 400);
      if (!["admin", "editor", "viewer"].includes(role)) return json({ error: "Invalid role" }, 400);

      // Create auth user (email auto-confirmed so they can sign in immediately)
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: display_name || email.split("@")[0] },
      });
      if (createErr) return json({ error: createErr.message }, 400);

      // Upsert profile with the requested role, mark must_change_password=true
      const { error: profErr } = await admin.from("profiles").upsert({
        id: created.user.id,
        email: created.user.email,
        display_name: display_name || email.split("@")[0],
        role,
        status: "active",
        must_change_password: true,
      });
      if (profErr) {
        // rollback the auth user if profile insert fails
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: profErr.message }, 500);
      }

      return json({ ok: true, user: { id: created.user.id, email: created.user.email, role } });
    }

    if (action === "reset") {
      const { user_id, new_password } = body;
      if (!user_id || !new_password) return json({ error: "user_id and new_password required" }, 400);
      if (new_password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);

      const { error: pwErr } = await admin.auth.admin.updateUserById(user_id, { password: new_password });
      if (pwErr) return json({ error: pwErr.message }, 400);

      // Force them to change it on next login
      await admin.from("profiles").update({ must_change_password: true }).eq("id", user_id);
      return json({ ok: true });
    }

    if (action === "delete") {
      const { user_id } = body;
      if (!user_id) return json({ error: "user_id required" }, 400);
      if (user_id === caller.user.id) return json({ error: "You cannot delete yourself" }, 400);

      const { error: delErr } = await admin.auth.admin.deleteUser(user_id);
      if (delErr) return json({ error: delErr.message }, 400);
      // profiles row cascades via FK
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
