alter table public.mesa_admins rename to mouawa_admins;
create or replace function public.is_admin() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.mouawa_admins where uid = (select auth.uid()))
$$;
create or replace function public.first_user_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.mouawa_admins) then insert into public.mouawa_admins (uid) values (new.id); end if;
  return new;
end $$;
revoke execute on function public.first_user_admin() from public, anon, authenticated;
comment on table public.docs is 'Mouawa documents: every collection/doc path the app stores.';
comment on table public.mouawa_admins is 'Mouawa moderators. The first person to sign up is added automatically.';
