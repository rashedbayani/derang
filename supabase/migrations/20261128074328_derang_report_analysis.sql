create table derang.report_analysis (
  member_id uuid primary key references derang.members on delete cascade,
  version text not null,
  lease uuid not null,
  requested_at timestamptz not null,
  summary text check (char_length(summary) between 1 and 1600)
);
alter table derang.report_analysis enable row level security;

create function public.derang_report_analysis(operation text, credential text, analysis_version text, request_lease uuid, analysis_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member_uuid uuid;
  cached derang.report_analysis;
begin
  select p.id into member_uuid
  from derang.sessions s join derang.members p on p.id=s.member_id
  join derang.groups g on g.id=p.group_id
  where s.hash=credential and s.expires>now()
    and (g.closed or g.deadline <= extract(epoch from clock_timestamp())*1000);
  if not found then return '{"status":401}'; end if;

  if operation = 'claim' then
    insert into derang.report_analysis as a values (member_uuid,analysis_version,request_lease,now(),null)
    on conflict (member_id) do update
      set version=excluded.version, lease=excluded.lease, requested_at=excluded.requested_at, summary=null
      where (a.summary is null and a.requested_at < now()-interval '45 seconds')
         or (a.summary is not null and a.version<>excluded.version)
    returning * into cached;
    if found then return '{"claimed":true}'; end if;
    select * into cached from derang.report_analysis where member_id=member_uuid;
    if cached.summary is not null and cached.version=analysis_version then
      return jsonb_build_object('summary',cached.summary);
    end if;
    return '{"status":409}';
  elsif operation = 'get' then
    select * into cached from derang.report_analysis where member_id=member_uuid and version=analysis_version;
    return jsonb_build_object('summary',cached.summary);
  elsif operation = 'complete' then
    update derang.report_analysis set summary=analysis_text
    where member_id=member_uuid and version=analysis_version and lease=request_lease and summary is null;
    if found then return '{"saved":true}'; end if;
    return '{"status":409}';
  end if;
  return '{"status":400}';
end $$;

revoke all on function public.derang_report_analysis(text,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.derang_report_analysis(text,text,text,uuid,text) to service_role;
