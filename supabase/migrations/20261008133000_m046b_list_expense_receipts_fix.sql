-- M046b — correction de M046 (boucle 25) : list_expense_receipts échouait
-- pour tout appelant (« column reference "id" is ambiguous ») — la colonne
-- de sortie id masquait expenses.id dans la lecture de la dépense. Seule
-- cette lecture est qualifiée ; corps, droits et privilèges inchangés.

begin;

create or replace function public.list_expense_receipts(p_expense_id uuid)
returns table (id uuid, mime_type text, file_size_bytes bigint, attached_to_version_number integer, created_by_role text, author_is_me boolean,
               created_at_server timestamptz, withdrawn boolean, withdrawn_at_server timestamptz, withdrawn_by_role text, withdraw_reason text,
               can_withdraw boolean)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_role text;
  v_can_attach boolean;
begin
  select e.* into v_exp from public.expenses e where e.id = p_expense_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  v_role := public.expense_member_role(v_exp.project_id, false);
  if public.expense_visible(v_exp, v_uid) is not true then
    raise exception 'not_authorized';
  end if;
  v_can_attach := public.expense_can_attach_receipt(v_exp, v_role, v_uid);
  return query
    select r.id, r.mime_type, r.file_size_bytes, ver.version_number, r.created_by_role, r.created_by_profile_id = v_uid,
           r.created_at_server, r.withdrawn_at_server is not null, r.withdrawn_at_server, r.withdrawn_by_role, r.withdraw_reason,
           r.withdrawn_at_server is null and v_can_attach and (v_role = 'CONTRACTOR' or r.created_by_profile_id = v_uid)
    from public.expense_receipts r
    left join public.expense_versions ver on ver.id = r.attached_to_version_id
    where r.expense_id = p_expense_id
    order by r.created_at_server, r.id;
end;
$$;

commit;
