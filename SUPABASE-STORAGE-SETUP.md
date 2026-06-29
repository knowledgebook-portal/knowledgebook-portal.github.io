# Supabase Storage — one-time setup for file uploads

KnowledgeBox stores **text files** (`.yaml`, `.sh`, `.json`, `Dockerfile`, etc.) inside the database (cheap, searchable). **Images and PDFs** go in a Supabase Storage bucket (more efficient for binary). The bucket is free, 1 GB on free tier.

You do this once, takes ~3 minutes.

## Step 1 — Create the bucket

1. Supabase Dashboard → **Storage** (left sidebar)
2. **New bucket** → name it exactly: `kb-files`
3. **Public bucket:** ✅ ON (so the URLs work in `<img>` and `<iframe>` without auth tokens)
4. **File size limit:** `10485760` (= 10 MB — same as our app cap)
5. **Allowed MIME types:** leave blank (we restrict client-side)
6. Click **Create bucket**

## Step 2 — Add policies (so signed-in users can upload + read)

In Supabase Dashboard → **SQL Editor** → New query → paste and **Run**:

```sql
-- Allow any active user to read files (RLS on storage.objects)
drop policy if exists "kb_files_read" on storage.objects;
create policy "kb_files_read" on storage.objects
  for select using (
    bucket_id = 'kb-files'
    and (
      -- Public bucket means anyone can read; but we also check the requester
      -- is signed-in and active when going through the API
      auth.uid() is null
      or exists (
        select 1 from public.profiles
        where id = auth.uid() and status = 'active'
      )
    )
  );

-- Allow active editors/admins to upload
drop policy if exists "kb_files_insert" on storage.objects;
create policy "kb_files_insert" on storage.objects
  for insert with check (
    bucket_id = 'kb-files'
    and public.can_write()
  );

-- Allow active editors/admins to delete
drop policy if exists "kb_files_delete" on storage.objects;
create policy "kb_files_delete" on storage.objects
  for delete using (
    bucket_id = 'kb-files'
    and public.can_write()
  );
```

Should say **"Success. No rows returned."**

## Step 3 — Verify

1. Storage → `kb-files` bucket
2. Try uploading a small test image via the dashboard UI
3. Click the file → there should be a **Public URL** in the right panel
4. Open that URL in a new tab — image should load
5. Delete the test file

That's it. The app's upload button works now.

## What's in the bucket

After you start using uploads:

```
kb-files/
  ├─ images/
  │   └─ 2026/06/29/abc123-screenshot.png
  ├─ pdfs/
  │   └─ 2026/06/29/abc456-handbook.pdf
  └─ ...
```

Files are organized by year/month/day for sane navigation in the dashboard.

## What if I run out of 1 GB?

- Dashboard → Storage → file listing → sort by size → delete what you don't need
- Or upgrade to Supabase Pro ($25/mo, 100 GB storage)
- Or migrate to a self-hosted Supabase (LOCAL-SETUP.md, Path A)
