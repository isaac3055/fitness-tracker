-- Additive migration. No photos, filenames, prompts or API keys are stored here.
create table if not exists public.meal_photo_usage (
 user_id uuid not null references auth.users(id) on delete cascade,
 usage_day date not null,
 attempts integer not null check(attempts between 0 and 10),
 last_attempt_at timestamptz not null,
 primary key(user_id,usage_day)
);
alter table public.meal_photo_usage enable row level security;
revoke all on public.meal_photo_usage from public,anon,authenticated;
-- Definer has access to counters only; callers cannot select or alter usage.
create or replace function public.consume_meal_photo_quota()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
 caller uuid := auth.uid();
 today date := (clock_timestamp() at time zone 'Asia/Shanghai')::date;
 recent timestamptz;
 user_count integer;
 total_count integer;
begin
 if caller is null then raise exception 'Authentication required'; end if;
 -- Serialize the tiny global budget across serverless instances and users.
 perform pg_advisory_xact_lock(8261126002::bigint);
 select coalesce(sum(attempts),0) into total_count from public.meal_photo_usage where usage_day=today;
 select attempts,last_attempt_at into user_count,recent
  from public.meal_photo_usage where user_id=caller and usage_day=today;
 if total_count>=100 or coalesce(user_count,0)>=10 or recent>clock_timestamp()-interval '10 seconds' then
  return false;
 end if;
 -- Keep only recent counters. Failed provider requests also count; no automatic retry.
 delete from public.meal_photo_usage where usage_day<today-7;
 insert into public.meal_photo_usage(user_id,usage_day,attempts,last_attempt_at)
 values(caller,today,1,clock_timestamp())
 on conflict(user_id,usage_day) do update
 set attempts=public.meal_photo_usage.attempts+1,last_attempt_at=clock_timestamp();
 return true;
end $$;
revoke all on function public.consume_meal_photo_quota() from public,anon;
grant execute on function public.consume_meal_photo_quota() to authenticated;
