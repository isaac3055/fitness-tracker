\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
 ('10000000-0000-0000-0000-000000000001','a@example.invalid'),
 ('20000000-0000-0000-0000-000000000002','b@example.invalid');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
insert into public.body_measurements(user_id,logged_on,weight_kg) values
 ('10000000-0000-0000-0000-000000000001','2026-01-01',80);
do $$ begin
 begin
 insert into public.body_measurements(user_id,logged_on,weight_kg) values
 ('20000000-0000-0000-0000-000000000002','2026-01-01',90);
 raise exception 'Cross-user insert unexpectedly succeeded';
 exception when insufficient_privilege then null;
 end;
end $$;
select public.sync_health_batch(
 '[{"logged_on":"2026-01-01","timezone":"Asia/Shanghai","active_kcal":400,"resting_kcal":1600}]',
 '[{"sample_id":"30000000-0000-0000-0000-000000000003","measured_at":"2026-01-01T00:00:00Z","logged_on":"2026-01-01","weight_kg":80}]',
 '[]','{}');
select public.sync_health_batch(
 '[{"logged_on":"2026-01-01","timezone":"Asia/Shanghai","active_kcal":450,"resting_kcal":1600}]',
 '[{"sample_id":"30000000-0000-0000-0000-000000000003","measured_at":"2026-01-01T00:00:00Z","logged_on":"2026-01-01","weight_kg":80}]',
 '[]','{}');
do $$ begin
 if (select count(*) from public.health_daily)<>1 then raise exception 'Daily dedup failed'; end if;
 if (select count(*) from public.health_measurements)<>1 then raise exception 'Sample dedup failed'; end if;
 if (select active_kcal from public.health_daily)<>450 then raise exception 'Update failed'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
do $$ begin
 if exists(select 1 from public.body_measurements) or exists(select 1 from public.health_daily) then raise exception 'Cross-user read'; end if;
end $$;
update public.body_measurements set weight_kg=20;
delete from public.body_measurements;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
do $$ begin
 if (select weight_kg from public.body_measurements)<>80 then raise exception 'Cross-user mutation'; end if;
end $$;
select public.sync_health_batch('[]','[]','[]','{30000000-0000-0000-0000-000000000003}');
do $$ begin
 if exists(select 1 from public.health_measurements) then raise exception 'Tombstone failed'; end if;
end $$;
select public.delete_my_account();
reset role;
do $$ begin
 if exists(select 1 from public.body_measurements where user_id='10000000-0000-0000-0000-000000000001') then raise exception 'Account cascade failed'; end if;
end $$;
set local role anon;
do $$ begin
 begin perform public.delete_my_account(); raise exception 'Anonymous delete allowed';
 exception when insufficient_privilege then null; end;
 begin perform * from public.body_measurements; raise exception 'Anonymous read allowed';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
