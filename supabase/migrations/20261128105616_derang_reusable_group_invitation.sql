alter table derang.members add column declined boolean not null default false;
create or replace function public.derang_group_request(action text, credential text, payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g derang.groups;
  created_count integer;
  m derang.members;
  target derang.members;
  finished boolean;
  options text[];
  question text;
  score jsonb;
  comment_kind text;
  comment_body text;
  has_answer boolean := false;
  result jsonb;
begin
  if action = 'health' then return '{"ok":true}'; end if;
  if action = 'new_group' then
    insert into derang.creation_limits as rate (bucket, count)
    values (date_trunc('minute', now()), 1)
    on conflict (bucket) do update set count = rate.count+1 where rate.count < 15
    returning count into created_count;
    if created_count is null then return '{"status":429,"message":"کمی صبر کن و دوباره تلاش کن."}'; end if;
    delete from derang.creation_limits where bucket < now() - interval '1 day';
    insert into derang.groups(name,deadline,categories,group_key_hash,owner_key_hash)
    values(payload->>'name',(payload->>'deadline')::bigint,array(select jsonb_array_elements_text(payload->'categories')),
      payload->>'groupHash',payload->>'ownerHash') returning * into g;
    insert into derang.owner_sessions(hash,group_id) values(credential,g.id);
    return '{}';
  end if;
  if action = 'register' then
    select * into g from derang.groups where group_key_hash=payload->>'groupHash' for update;
    if not found then return '{"status":404,"message":"کلید گروه معتبر نیست."}'; end if;
    if exists(select 1 from derang.members where group_id=g.id and code_hash=payload->>'codeHash') then return '{}'; end if;
    if (select count(*) from derang.members where group_id=g.id and not approved and not declined) >= 100 then
      return '{"status":429,"message":"صف درخواست‌های این گروه پر است."}';
    end if;
    if g.closed or g.deadline <= extract(epoch from clock_timestamp())*1000 then
      return '{"status":409,"message":"مهلت عضویت در این گروه پایان یافته است."}';
    end if;
    insert into derang.members(group_id,name,code_hash,approved)
    values(g.id,payload->>'name',payload->>'codeHash',false);
    return '{}';
  end if;
  if action in ('member_login','owner_login') then
    select * into g from derang.groups where group_key_hash=payload->>'groupHash';
    if not found then return '{"status":401,"message":"کلیدهای واردشده معتبر نیستند."}'; end if;
    if action = 'owner_login' then
      if g.owner_key_hash is distinct from payload->>'keyHash' then
        return '{"status":401,"message":"کلیدهای واردشده معتبر نیستند."}';
      end if;
      delete from derang.owner_sessions where expires <= now();
      insert into derang.owner_sessions(hash,group_id) values(credential,g.id);
    else
      select * into m from derang.members where group_id=g.id and code_hash=payload->>'keyHash';
      if not found then return '{"status":401,"message":"کلیدهای واردشده معتبر نیستند."}'; end if;
      if m.declined then return '{"status":403,"message":"درخواست عضویت رد شده است."}'; end if;
      if not m.approved then return '{"status":403,"message":"درخواست عضویت در انتظار تأیید سازندهٔ گروه است."}'; end if;
      delete from derang.sessions where expires <= now();
      insert into derang.sessions(hash,member_id) values(credential,m.id);
    end if;
    return '{}';
  end if;

  if action = 'logout' then
    delete from derang.sessions where hash=credential;
    delete from derang.owner_sessions where hash=credential;
    return '{}';
  end if;

  if action in ('manage','decline_member','approve_member','close_group') then
    select grp.* into g from derang.groups grp join derang.owner_sessions s on s.group_id=grp.id
    where s.hash=credential and s.expires>now() for update of grp;
    if not found then return '{"status":401,"message":"دوباره وارد شو."}'; end if;
    finished := g.closed or g.deadline <= extract(epoch from clock_timestamp())*1000;
    if action = 'manage' then
      select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'approved',p.approved,'declined',p.declined) order by p.name),'[]')
      into result from derang.members p where p.group_id=g.id;
      return jsonb_build_object('id',g.id,'name',g.name,'deadline',g.deadline,'open',not finished,'members',result);
    end if;
    if finished then return '{"status":409,"message":"این دوره باز نیست."}'; end if;
    if action = 'close_group' then update derang.groups set closed=true where id=g.id;
    else
      update derang.members set approved=(action='approve_member'),declined=(action='decline_member')
      where id::text=payload->>'id' and group_id=g.id and not approved and not declined;
      if not found then return '{"status":409,"message":"این درخواست در انتظار بررسی نیست."}'; end if;
    end if;
    return '{}';
  end if;

  select p.* into m from derang.members p join derang.sessions s on s.member_id=p.id
  where s.hash=credential and s.expires>now() and p.approved;
  if not found then return '{"status":401,"message":"دوباره وارد شو."}'; end if;

  -- Serialize writes for each round, including closure and consent changes.
  select * into g from derang.groups where id=m.group_id for update;
  select * into m from derang.members where id=m.id;
  finished := g.closed or g.deadline <= extract(epoch from clock_timestamp())*1000;
  if action = 'group' then
    return jsonb_build_object('id',g.id,'name',g.name,'deadline',g.deadline,'open',not finished,'me',m.name,
      'consent',m.consent,'canChangeConsent',not finished and not exists(select 1 from derang.receipts where recipient=m.id),
      'friends',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'done',
        (exists(select 1 from derang.receipts where reviewer=m.id and recipient=p.id))::int) order by p.name),'[]')
       from derang.members p where p.group_id=g.id and p.id<>m.id and p.approved));
  elsif action = 'report' then
    if not finished then return '{"status":409,"message":"گزارش بعد از پایان دوره منتشر می‌شود."}'; end if;
    return jsonb_build_object('name',m.name,'categories',g.categories,'consent',m.consent,
      'totals',(select coalesce(jsonb_object_agg(t.question,jsonb_build_object('score',round(t.sum::numeric/t.count,1),'count',t.count)),'{}') from derang.totals t where t.recipient=m.id and t.count>=3),
      'comments',(select coalesce(jsonb_object_agg(kind,bodies),'{}') from (select kind,jsonb_agg(body order by id) bodies from derang.comments where recipient=m.id group by kind having count(*)>=3) c));
  elsif action = 'consent' then
    if finished or exists(select 1 from derang.receipts where recipient=m.id) then
      return '{"status":409,"message":"تنظیمات این دوره دیگر قابل تغییر نیست."}';
    end if;
    update derang.members set consent=array(select jsonb_array_elements_text(payload->'options')) where id=m.id;
    return '{}';
  end if;

  select * into target from derang.members where id::text=payload->>'id' and group_id=g.id and id<>m.id and approved;
  if not found then return '{"status":404,"message":"عضو پیدا نشد."}'; end if;
  if finished then return '{"status":409,"message":"مهلت بازخورد تمام شده است."}'; end if;
  if exists(select 1 from derang.receipts where reviewer=m.id and recipient=target.id) then
    return '{"status":409,"message":"بازخوردت قبلاً ثبت شده است."}';
  end if;
  if action = 'review_form' then return jsonb_build_object('name',target.name,'categories',g.categories,'consent',target.consent); end if;
  if action <> 'review_submit' then return '{"status":404,"message":"صفحه پیدا نشد."}'; end if;

  options := g.categories || array(select x from unnest(target.consent) x where x in ('style','politics'));
  for question,score in select key,value from jsonb_each(payload->'answers') loop
    if not exists(select 1 from unnest(options) cat where (payload->'questionIds'->cat) ? question)
       or score::text not in ('1','2','3','4','5') then
      return '{"status":400,"message":"پاسخ نامعتبر است. فرم را دوباره باز کن."}';
    end if;
    has_answer := true;
  end loop;
  if not has_answer and not ('text'=any(target.consent) and (coalesce(payload->>'appreciation','')<>'' or coalesce(payload->>'change','')<>'')) then
    return '{"status":400,"message":"حداقل یک پاسخ ثبت کن."}';
  end if;
  insert into derang.receipts values(m.id,target.id);
  for question,score in select key,value from jsonb_each(payload->'answers') loop
    insert into derang.totals as t values(target.id,question,score::text::integer,1)
    on conflict on constraint totals_pkey do update set sum=t.sum+excluded.sum,count=t.count+1;
  end loop;
  if 'text'=any(target.consent) then
    foreach comment_kind in array array['appreciation','change'] loop
      comment_body := coalesce(payload->>comment_kind,'');
      if comment_body<>'' then insert into derang.comments(recipient,kind,body) values(target.id,comment_kind,comment_body); end if;
    end loop;
  end if;
  return '{}';
end $$;
revoke all on function public.derang_group_request(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.derang_group_request(text,text,jsonb) to service_role;
