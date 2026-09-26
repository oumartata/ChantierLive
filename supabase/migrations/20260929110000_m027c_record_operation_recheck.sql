-- M027c — revalidation du compte dans advance_record_operation après
-- l'attente du verrou d'operation_uuid (M027b). M014, M027 et M027b ne sont
-- pas réécrites ; seul ce helper partagé est remplacé. Les contrôles métier
-- propres à chaque commande restent dans les commandes (inchangées).

create or replace function public.advance_record_operation(
  p_operation_uuid uuid, p_project_id uuid, p_uid uuid, p_command text, p_hash text,
  p_advance_id uuid, p_requirement_version_id uuid, p_event_seq bigint, p_outcome text)
returns public.advance_command_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_inserted uuid;
  v_result public.advance_command_result;
begin
  -- M027b : verrou de l'operation_uuid tenu jusqu'à la fin de la
  -- transaction, partagé avec authorize_work_start (aucun autre changement).
  perform pg_advisory_xact_lock(hashtext('advance_operation_uuid:' || p_operation_uuid::text)::bigint);
  -- M027c : ce verrou peut attendre une transaction rivale portant le même
  -- UUID ; le compte a pu redevenir provisoire pendant cette attente. Aucun
  -- succès sans compte vérifié courant : l'exception annule toute la
  -- commande appelante (versement, événement, audit, compteur, révision).
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  insert into public.advance_operations (operation_uuid, project_id, profile_id, command, payload_hash, advance_id,
                                         requirement_version_id, result_event_seq, outcome)
  values (p_operation_uuid, p_project_id, p_uid, p_command, p_hash, p_advance_id, p_requirement_version_id, p_event_seq, p_outcome)
  on conflict (operation_uuid) do nothing
  returning operation_uuid into v_inserted;
  if v_inserted is null then
    raise exception 'operation_conflict';
  end if;
  v_result.operation_uuid := p_operation_uuid;
  v_result.replayed := false;
  v_result.command := p_command;
  v_result.advance_id := p_advance_id;
  v_result.requirement_version_id := p_requirement_version_id;
  v_result.result_event_seq := p_event_seq;
  v_result.outcome := p_outcome;
  v_result.current_status := (select status from public.advances where id = p_advance_id);
  v_result.ledger_revision := (select revision from public.advance_ledgers where project_id = p_project_id);
  return v_result;
end;
$$;

revoke execute on function public.advance_record_operation(uuid, uuid, uuid, text, text, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role;
