\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
 ('10000000-0000-0000-0000-000000000001','quota-a@example.invalid'),
 ('20000000-0000-0000-0000-000000000002','quota-b@example.invalid');
set local role anon;
do $$ begin
 begin perform public.consume_meal_photo_quota();raise exception 'Anonymous quota access allowed';
 exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
do $$ begin
 if not public.consume_meal_photo_quota() then raise exception 'First request rejected';end if;
 if public.consume_meal_photo_quota() then raise exception 'Cooldown bypass';end if;
 begin perform * from public.meal_photo_usage;raise exception 'Counter read allowed';
 exception when insufficient_privilege then null;end;
 begin delete from public.meal_photo_usage;raise exception 'Counter reset allowed';
 exception when insufficient_privilege then null;end;
end $$;
reset role;
update public.meal_photo_usage set attempts=10,last_attempt_at=clock_timestamp()-interval '1 minute';
set local role authenticated;
do $$ begin
 if public.consume_meal_photo_quota() then raise exception 'Daily cap bypass';end if;
end $$;
select set_config('request.jwt.claims','{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
do $$ begin
 if not public.consume_meal_photo_quota() then raise exception 'User budgets not isolated';end if;
end $$;
reset role;
-- Seed 9 more users at 10 attempts each to reach the global budget.
insert into auth.users(id,email)
 select ('30000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'quota-'||i||'@example.invalid' from generate_series(1,9) i;
insert into public.meal_photo_usage(user_id,usage_day,attempts,last_attempt_at)
 select id,(clock_timestamp() at time zone 'Asia/Shanghai')::date,10,clock_timestamp()-interval '1 minute'
 from auth.users where id::text like '30000000-%';
update public.meal_photo_usage set last_attempt_at=clock_timestamp()-interval '1 minute';
set local role authenticated;
do $$ begin
 if public.consume_meal_photo_quota() then raise exception 'Global cap bypass';end if;
end $$;
select public.delete_my_account();
reset role;
do $$ begin
 if exists(select 1 from public.meal_photo_usage where user_id='20000000-0000-0000-0000-000000000002')
 then raise exception 'Account counter deletion failed';end if;
end $$;
rollback;
