-- Documents: Mesa's data model is document-shaped (collection/doc paths). One table holds every doc.
create table public.docs (
  path text primary key,
  coll text not null,
  data jsonb not null default '{}'::jsonb,
  owner uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index docs_coll_idx on public.docs (coll);
create index docs_owner_idx on public.docs (owner);
alter table public.docs replica identity full;

create or replace function public.private_owner(p text) returns uuid
language sql immutable as $$
  select case when p like 'data/users/%' then nullif(split_part(p, '/', 3), '')::uuid end
$$;
create or replace function public.is_private(p text) returns boolean
language sql immutable as $$ select p like 'data/users/%' $$;

alter table public.docs enable row level security;

create policy "public docs readable by signed-in people" on public.docs for select to authenticated
  using (not public.is_private(path) or public.private_owner(path) = (select auth.uid()));
create policy "profiles and email index readable before sign-in" on public.docs for select to anon
  using (coll in ('profiles', 'emails'));
create policy "signed-in people write shared docs, own private docs" on public.docs for insert to authenticated
  with check (not public.is_private(path) or public.private_owner(path) = (select auth.uid()));
create policy "update shared docs, own private docs" on public.docs for update to authenticated
  using (not public.is_private(path) or public.private_owner(path) = (select auth.uid()))
  with check (not public.is_private(path) or public.private_owner(path) = (select auth.uid()));
create policy "delete shared docs, own private docs" on public.docs for delete to authenticated
  using (not public.is_private(path) or public.private_owner(path) = (select auth.uid()));

create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language sql immutable as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      coalesce((select jsonb_object_agg(k,
        case when a ? k and b ? k then public.jsonb_deep_merge(a -> k, b -> k)
             when b ? k then b -> k else a -> k end)
        from (select jsonb_object_keys(a) k union select jsonb_object_keys(b)) keys), '{}'::jsonb)
    else b end
$$;

create or replace function public.doc_parent(p text) returns text
language sql immutable as $$ select regexp_replace(p, '/[^/]+$', '') $$;

create or replace function public.doc_set(p_path text, p_data jsonb) returns void
language sql security invoker as $$
  insert into public.docs (path, coll, data) values (p_path, public.doc_parent(p_path), coalesce(p_data, '{}'::jsonb))
  on conflict (path) do update set data = excluded.data, updated_at = now()
$$;
create or replace function public.doc_merge(p_path text, p_patch jsonb) returns boolean
language plpgsql security invoker as $$
begin
  update public.docs set data = public.jsonb_deep_merge(data, coalesce(p_patch, '{}'::jsonb)), updated_at = now() where path = p_path;
  if not found then raise exception 'not_found: %', p_path using errcode = 'P0002'; end if;
  return true;
end $$;

create table public.mesa_admins (uid uuid primary key references auth.users(id) on delete cascade, added_at timestamptz default now());
alter table public.mesa_admins enable row level security;
create policy "admins can see the admin list" on public.mesa_admins for select to authenticated using (uid = (select auth.uid()));
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.mesa_admins where uid = auth.uid())
$$;
create or replace function public.first_user_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.mesa_admins) then insert into public.mesa_admins (uid) values (new.id); end if;
  return new;
end $$;
create trigger on_auth_user_first_admin after insert on auth.users for each row execute function public.first_user_admin();

create table public.auth_handles (handle text primary key, user_id uuid not null references auth.users(id) on delete cascade, updated_at timestamptz default now());
alter table public.auth_handles enable row level security;
create or replace function public.claim_handle(h text) returns boolean
language plpgsql security definer set search_path = public as $$
declare lh text := lower(trim(both '@' from h));
begin
  if auth.uid() is null or lh !~ '^[a-z0-9_]{2,15}$' then return false; end if;
  if not exists (select 1 from public.docs where coll = 'profiles' and owner = auth.uid() and lower(data->>'handle') = lh) then return false; end if;
  insert into public.auth_handles (handle, user_id) values (lh, auth.uid())
  on conflict (handle) do update set user_id = excluded.user_id, updated_at = now();
  return true;
end $$;
revoke all on function public.claim_handle(text) from anon;

alter publication supabase_realtime add table public.docs;

insert into storage.buckets (id, name, public, file_size_limit) values ('blobs', 'blobs', true, 104857600) on conflict (id) do nothing;
create policy "signed-in people upload media" on storage.objects for insert to authenticated with check (bucket_id = 'blobs');
