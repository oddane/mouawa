create or replace function public.private_owner(p text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(p, '/', 3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p, '/', 3)::uuid end
$$;
create or replace function public.is_private(p text) returns boolean language sql immutable set search_path = '' as $$ select p like 'data/users/%' $$;
create or replace function public.doc_parent(p text) returns text language sql immutable set search_path = '' as $$ select regexp_replace(p, '/[^/]+$', '') $$;
alter function public.jsonb_deep_merge(jsonb, jsonb) set search_path = '';
alter function public.doc_set(text, jsonb) set search_path = '';
alter function public.doc_merge(text, jsonb) set search_path = '';
