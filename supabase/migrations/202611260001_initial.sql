begin;

create table public.profiles (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null unique references auth.users(id) on delete cascade default auth.uid(),
 height_cm numeric not null check(height_cm between 50 and 250),
 goal_weight_kg numeric not null check(goal_weight_kg between 20 and 400),
 calorie_target numeric not null check(calorie_target between 500 and 10000),
 protein_target numeric not null check(protein_target between 0 and 500),
 timezone text not null default 'Asia/Shanghai' check(length(timezone) between 1 and 100),
 created_at timestamptz not null default now()
);
create table public.body_measurements (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 logged_on date not null,
 weight_kg numeric not null check(weight_kg between 20 and 400),
 body_fat_percent numeric check(body_fat_percent between 1 and 75),
 waist_cm numeric check(waist_cm between 20 and 250),
 unique(user_id,logged_on)
);
create table public.training_plans (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 day_of_week integer not null check(day_of_week between 0 and 6),
 name text not null check(length(trim(name)) between 1 and 100),
 exercises text not null check(length(trim(exercises)) between 1 and 4000)
);
create table public.workout_logs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 logged_on date not null,
 name text not null check(length(trim(name)) between 1 and 100),
 duration_minutes numeric not null check(duration_minutes between 1 and 1440),
 calories numeric not null check(calories between 0 and 15000)
);
create table public.food_entries (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 logged_on date not null,
 meal text not null check(meal in ('早餐','午餐','晚餐','加餐')),
 name text not null check(length(trim(name)) between 1 and 100),
 calories numeric not null check(calories between 0 and 15000),
 protein numeric not null check(protein between 0 and 1000),
 carbs numeric not null check(carbs between 0 and 2000),
 fat numeric not null check(fat between 0 and 1000)
);
create table public.daily_energy (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 logged_on date not null,
 active_kcal numeric not null check(active_kcal between 0 and 15000),
 resting_kcal numeric not null check(resting_kcal between 0 and 10000),
 unique(user_id,logged_on)
);
create table public.health_daily (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 logged_on date not null,
 timezone text not null,
 active_kcal numeric check(active_kcal between 0 and 100000),
 resting_kcal numeric check(resting_kcal between 0 and 100000),
 steps numeric check(steps between 0 and 1000000),
 exercise_minutes numeric check(exercise_minutes between 0 and 1440),
 heart_rate numeric check(heart_rate between 1 and 400),
 synced_at timestamptz not null default now(),
 unique(user_id,logged_on)
);
create table public.health_measurements (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 sample_id uuid not null,
 measured_at timestamptz not null,
 logged_on date not null,
 weight_kg numeric check(weight_kg between 0.1 and 1000),
 body_fat_percent numeric check(body_fat_percent between 0 and 100),
 check((weight_kg is null) <> (body_fat_percent is null)),
 unique(user_id,sample_id)
);
create table public.health_workouts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
 sample_id uuid not null,
 logged_on date not null,
 started_at timestamptz not null,
 activity_type integer not null check(activity_type >= 0),
 duration_minutes numeric not null check(duration_minutes between 0 and 100000),
 calories numeric check(calories between 0 and 100000),
 unique(user_id,sample_id)
);

do $$
declare t text;
begin
 foreach t in array array['profiles','body_measurements','training_plans','workout_logs','food_entries','daily_energy','health_daily','health_measurements','health_workouts'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('create policy own_rows on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',t);
   execute format('create index %I on public.%I(user_id)',t||'_user_idx',t);
   execute format('revoke all on public.%I from anon, authenticated',t);
   execute format('grant select, insert, update, delete on public.%I to authenticated',t);
 end loop;
end $$;

-- SECURITY INVOKER: caller's JWT and every table's RLS remain in force.
-- Idempotent UUID upserts and tombstones are atomic. No service-role key is used.
create function public.sync_health_batch(daily jsonb, measurements jsonb, workouts jsonb, deleted_ids uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if jsonb_typeof(daily) <> 'array' or jsonb_typeof(measurements) <> 'array' or jsonb_typeof(workouts) <> 'array' then
   raise exception 'Expected arrays';
 end if;
 if jsonb_array_length(daily)>100 or jsonb_array_length(measurements)>10000 or jsonb_array_length(workouts)>10000 or cardinality(deleted_ids)>20000 then
   raise exception 'Batch too large';
 end if;
 delete from public.health_measurements where user_id=auth.uid() and sample_id=any(deleted_ids);
 delete from public.health_workouts where user_id=auth.uid() and sample_id=any(deleted_ids);
 insert into public.health_daily(user_id,logged_on,timezone,active_kcal,resting_kcal,steps,exercise_minutes,heart_rate)
 select auth.uid(),x.logged_on,x.timezone,x.active_kcal,x.resting_kcal,x.steps,x.exercise_minutes,x.heart_rate
 from jsonb_to_recordset(daily) as x(logged_on date,timezone text,active_kcal numeric,resting_kcal numeric,steps numeric,exercise_minutes numeric,heart_rate numeric)
 on conflict(user_id,logged_on) do update set timezone=excluded.timezone,active_kcal=excluded.active_kcal,
 resting_kcal=excluded.resting_kcal,steps=excluded.steps,exercise_minutes=excluded.exercise_minutes,
 heart_rate=excluded.heart_rate,synced_at=now();
 insert into public.health_measurements(user_id,sample_id,measured_at,logged_on,weight_kg,body_fat_percent)
 select auth.uid(),x.sample_id,x.measured_at,x.logged_on,x.weight_kg,x.body_fat_percent
 from jsonb_to_recordset(measurements) as x(sample_id uuid,measured_at timestamptz,logged_on date,weight_kg numeric,body_fat_percent numeric)
 on conflict(user_id,sample_id) do update set measured_at=excluded.measured_at,logged_on=excluded.logged_on,
 weight_kg=excluded.weight_kg,body_fat_percent=excluded.body_fat_percent;
 insert into public.health_workouts(user_id,sample_id,logged_on,started_at,activity_type,duration_minutes,calories)
 select auth.uid(),x.sample_id,x.logged_on,x.started_at,x.activity_type,x.duration_minutes,x.calories
 from jsonb_to_recordset(workouts) as x(sample_id uuid,logged_on date,started_at timestamptz,activity_type integer,duration_minutes numeric,calories numeric)
 on conflict(user_id,sample_id) do update set logged_on=excluded.logged_on,started_at=excluded.started_at,
 activity_type=excluded.activity_type,duration_minutes=excluded.duration_minutes,calories=excluded.calories;
end;
$$;
revoke all on function public.sync_health_batch(jsonb,jsonb,jsonb,uuid[]) from public, anon;
grant execute on function public.sync_health_batch(jsonb,jsonb,jsonb,uuid[]) to authenticated;

-- Only the authenticated caller can delete their own auth row; cascade removes all records.
create function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 delete from auth.users where id = auth.uid();
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
commit;
