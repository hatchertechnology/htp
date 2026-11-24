-- Fail-closed comparison pilot disable. Stop comparison API ingress and coordinate
-- all service callers first. This leaves the pilot approvals, the gate helper, the
-- seven comparison RPCs, the bounded cleanup function, evidence and ledger history
-- intact. It is NOT an authorization to re-enable.
begin;
revoke execute on function public.import_independent_audit(uuid,text,text,jsonb),public.independent_audit_history(uuid,uuid,timestamptz,uuid),public.save_independent_comparison(uuid,uuid,uuid,boolean),public.independent_comparison_history(uuid,timestamptz,uuid),public.independent_comparison_detail(uuid,uuid),public.independent_evidence_fingerprint(uuid),public.delete_independent_audit_evidence(uuid,text,text) from public,anon,authenticated;
revoke all on function public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text) from public,anon,authenticated,service_role;
do $holds$
declare r text; member_name text; signature text;
begin
  foreach r in array array['anon','authenticated'] loop
    for member_name in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      foreach signature in array array['public.import_independent_audit(uuid,text,text,jsonb)','public.independent_audit_history(uuid,uuid,timestamptz,uuid)','public.save_independent_comparison(uuid,uuid,uuid,boolean)','public.independent_comparison_history(uuid,timestamptz,uuid)','public.independent_comparison_detail(uuid,uuid)','public.independent_evidence_fingerprint(uuid)','public.delete_independent_audit_evidence(uuid,text,text)','public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)'] loop
        if has_function_privilege(member_name,signature,'EXECUTE') then raise exception 'comparison_pilot_owner_hold_drift: % %', member_name, signature; end if;
      end loop;
    end loop;
  end loop;
  for member_name in select rolname from pg_roles where pg_has_role('service_role',oid,'MEMBER') loop
    if has_function_privilege(member_name,'public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)','EXECUTE') then raise exception 'comparison_pilot_cleanup_hold_drift'; end if;
  end loop;
end $holds$;
commit;
