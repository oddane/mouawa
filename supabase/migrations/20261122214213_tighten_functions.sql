revoke execute on function public.first_user_admin() from public, anon, authenticated;
revoke execute on function public.claim_handle(text) from public, anon;
grant execute on function public.claim_handle(text) to authenticated;
create or replace function public.is_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.mesa_admins where uid = (select auth.uid()))
$$;
comment on table public.auth_handles is 'Private on purpose: no RLS policies. Only the login edge function (service role) reads it.';
