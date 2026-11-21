-- All management writes remain website-authorized at the database boundary.
create function public.save_website_form(p_website_id uuid,p_form_id uuid,p_form_key text,p_name text,p_fields jsonb,p_active boolean,p_host_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare field jsonb; k text; seen text[] := '{}'; result public.website_forms%rowtype; host uuid;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then
    raise exception 'Website not found' using errcode='42501';
  end if;
  if p_form_key is null or p_form_key !~ '^[a-z][a-z0-9_]{0,63}$' or p_name is null or length(btrim(p_name)) not between 1 and 100 or jsonb_typeof(p_fields) is distinct from 'array' or jsonb_array_length(p_fields) not between 1 and 32 or p_active is null or p_host_ids is null or cardinality(p_host_ids)>16 then
    raise exception 'Invalid form' using errcode='22023';
  end if;
  for field in select * from jsonb_array_elements(p_fields) loop
    k:=field->>'key';
    if jsonb_typeof(field) is distinct from 'object' or k is null or k !~ '^[a-z][a-z0-9_]{0,63}$' or k=any(seen) or k in ('website','submission_id') or field->>'kind' not in ('text','email','telephone','multiline') or field->>'kind' is null or jsonb_typeof(field->'required') is distinct from 'boolean' or coalesce(field->>'max_length','') !~ '^[1-9][0-9]{0,3}$' or (field->>'max_length')::int>5000 or coalesce(length(btrim(field->>'label')),0) not between 1 and 100 or exists(select 1 from jsonb_object_keys(field) key where key not in ('key','kind','required','max_length','label')) then
      raise exception 'Invalid field definition' using errcode='22023';
    end if;
    seen:=array_append(seen,k);
  end loop;
  if p_active and cardinality(p_host_ids)=0 then raise exception 'Active form needs a verified host' using errcode='22023'; end if;
  if cardinality(p_host_ids)<>(select count(distinct x) from unnest(p_host_ids) x) then raise exception 'Invalid hosts' using errcode='22023'; end if;
  foreach host in array p_host_ids loop
    if not exists(select 1 from public.website_form_hosts where id=host and website_id=p_website_id and verified_at is not null) then raise exception 'Host not found or not verified' using errcode='22023'; end if;
  end loop;
  if p_form_id is null then
    insert into public.website_forms(website_id,form_key,name,fields,active) values(p_website_id,p_form_key,btrim(p_name),p_fields,p_active) returning * into result;
  else
    update public.website_forms set form_key=p_form_key,name=btrim(p_name),fields=p_fields,active=p_active where id=p_form_id and website_id=p_website_id returning * into result;
    if not found then raise exception 'Form not found' using errcode='42501'; end if;
    delete from public.website_form_origins where form_id=p_form_id;
  end if;
  insert into public.website_form_origins(website_id,form_id,host_id) select p_website_id,result.id,x from unnest(p_host_ids) x;
  return to_jsonb(result);
end $$;
revoke all on function public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]) from public, anon;
grant execute on function public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]) to authenticated;

create function public.set_website_form_response_status(p_website_id uuid,p_form_id uuid,p_response_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result public.website_form_responses%rowtype;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Response not found' using errcode='42501'; end if;
  if p_status is null or p_status not in ('new','reviewed','spam') then raise exception 'Invalid status' using errcode='22023'; end if;
  update public.website_form_responses set status=p_status where id=p_response_id and form_id=p_form_id and website_id=p_website_id returning * into result;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  return to_jsonb(result);
end $$;
revoke all on function public.set_website_form_response_status(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.set_website_form_response_status(uuid,uuid,uuid,text) to authenticated;
