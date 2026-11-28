
create schema derang;
revoke all on schema derang from public, anon, authenticated;
create table derang.admins (id uuid primary key references auth.users(id) on delete cascade);
create table derang.groups (id uuid primary key default gen_random_uuid(), name text not null, deadline bigint not null, categories text[] not null, closed boolean not null default false);
create table derang.members (id uuid primary key default gen_random_uuid(), group_id uuid not null references derang.groups, name text not null, code_hash text unique not null, consent text[] not null default '{}');
create index on derang.members(group_id);
create table derang.sessions (hash text primary key, member_id uuid not null references derang.members on delete cascade, expires timestamptz not null default now() + interval '8 hours');
create index on derang.sessions(expires);
create table derang.receipts (reviewer uuid references derang.members, recipient uuid references derang.members, primary key(reviewer, recipient), check(reviewer <> recipient));
create index on derang.receipts(recipient);
create table derang.totals (recipient uuid references derang.members, question text, sum integer not null, count integer not null, primary key(recipient,question));
create table derang.comments (id uuid primary key default gen_random_uuid(), recipient uuid not null references derang.members, kind text not null, body text not null);
create index on derang.comments(recipient,kind);
alter table derang.admins enable row level security;
alter table derang.groups enable row level security;
alter table derang.members enable row level security;
alter table derang.sessions enable row level security;
alter table derang.receipts enable row level security;
alter table derang.totals enable row level security;
alter table derang.comments enable row level security;

create function public.derang_request(action text, credential text, payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g derang.groups;
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
  if action = 'member_login' then
    select * into m from derang.members where code_hash = payload->>'codeHash';
    if not found then return '{"status":401,"message":"کد دعوت معتبر نیست."}'; end if;
    delete from derang.sessions where expires <= now();
    insert into derang.sessions(hash,member_id) values (credential,m.id);
    return '{}';
  end if;

  if action in ('admin','new_group','new_member','close_group') then
    if not exists(select 1 from derang.admins where id::text = credential) then
      return '{"status":401,"message":"ورود مدیر مجاز نیست."}';
    end if;
    if action = 'admin' then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',grp.id,'name',grp.name,'deadline',grp.deadline,
        'open',not grp.closed and grp.deadline > extract(epoch from clock_timestamp())*1000,
        'members',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.name),'[]') from derang.members p where p.group_id=grp.id)
      ) order by grp.deadline desc),'[]') into result from derang.groups grp;
      return jsonb_build_object('groups',result);
    elsif action = 'new_group' then
      insert into derang.groups(name,deadline,categories)
      values(payload->>'name',(payload->>'deadline')::bigint,array(select jsonb_array_elements_text(payload->'categories')));
      return '{}';
    end if;
    select * into g from derang.groups where id::text=payload->>'id' for update;
    if not found or g.closed or g.deadline <= extract(epoch from clock_timestamp())*1000 then
      return '{"status":409,"message":"این دوره باز نیست."}';
    end if;
    if action = 'close_group' then update derang.groups set closed=true where id=g.id;
    else insert into derang.members(group_id,name,code_hash) values(g.id,payload->>'name',payload->>'codeHash');
    end if;
    return '{}';
  end if;

  select p.* into m from derang.members p join derang.sessions s on s.member_id=p.id
  where s.hash=credential and s.expires>now();
  if not found then return '{"status":401,"message":"دوباره وارد شو."}'; end if;
  if action = 'logout' then delete from derang.sessions where hash=credential; return '{}'; end if;

  -- Serialize writes for each round, including closure and consent changes.
  select * into g from derang.groups where id=m.group_id for update;
  select * into m from derang.members where id=m.id;
  finished := g.closed or g.deadline <= extract(epoch from clock_timestamp())*1000;
  if action = 'group' then
    return jsonb_build_object('id',g.id,'name',g.name,'deadline',g.deadline,'open',not finished,'me',m.name,
      'consent',m.consent,'canChangeConsent',not finished and not exists(select 1 from derang.receipts where recipient=m.id),
      'friends',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'done',
        (exists(select 1 from derang.receipts where reviewer=m.id and recipient=p.id))::int) order by p.name),'[]')
       from derang.members p where p.group_id=g.id and p.id<>m.id));
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

  select * into target from derang.members where id::text=payload->>'id' and group_id=g.id and id<>m.id;
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
revoke all on function public.derang_request(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.derang_request(text,text,jsonb) to service_role;
