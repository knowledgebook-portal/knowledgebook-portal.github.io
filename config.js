/*
  KnowledgeBox config
  ===================
  Paste your Supabase project URL and anon (public) key below.

  Where to find them:
    1. https://app.supabase.com  -> your project
    2. Settings (left sidebar) -> API
    3. Copy "Project URL" and "anon public" key

  These two values are SAFE to commit publicly:
    - The anon key only allows operations permitted by Row Level Security,
      which we've configured so each user can only access their own docs.
    - Anyone running this app must still log in with a real account.

  Never paste your SERVICE ROLE key here. That one is admin-only and dangerous.
*/

export const SUPABASE_URL  = 'https://tuvuraeayugptonqzuon.supabase.co';
export const SUPABASE_ANON = 'sb_publishable_DtW2NdJtuvEOctrKoaAWnw_Ap7rtFdv';
