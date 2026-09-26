-- M027b — B067, correctifs de revue (M027 n'est pas réécrite).
--
-- 1. Attentes après le contrôle du compte : authorize_work_start prend le
--    verrou transactionnel de l'operation_uuid APRÈS les verrous du
--    chantier ; advance_record_operation (M014) le prend aussi avant son
--    insertion. Une transaction rivale portant le même UUID (autorisation
--    ou commande d'acompte) fait donc attendre B067 sur ce verrou, AVANT
--    la revérification des droits et du compte, la recherche d'opération et
--    l'horodatage unique ; les insertions uniques qui suivent ne peuvent
--    plus attendre sur l'UUID. Revérification finale avant succès.
-- 2. Auteur historique : authorized_by_membership_id (repère d'adhésion,
--    convention de l'écran Équipe), figé à l'autorisation et exposé par
--    get_work_start aux trois rôles lecteurs ; inchangé après transfert.
--    get_work_start_summary (SITE_MANAGER) reste strictement fait + date.

-- ----------------------------------------------------------------------------
-- Auteur historique.
-- ----------------------------------------------------------------------------

alter table public.work_start_authorizations add column authorized_by_membership_id uuid null;

-- Rattrapage des lignes existantes (base locale uniquement ; M027 n'a
-- jamais été appliquée à distance) : adhésion du profil auteur active à
-- l'heure d'autorisation. Le déclencheur d'immuabilité n'est suspendu que
-- le temps de cette instruction, dans la transaction de migration.
alter table public.work_start_authorizations disable trigger reject_mutation;
update public.work_start_authorizations w
set authorized_by_membership_id = (
  select m.id from public.project_memberships m
  where m.project_id = w.project_id and m.profile_id = w.authorized_by_profile_id
    and m.created_at_server <= w.authorized_at_server
    and (m.revoked_at is null or m.revoked_at > w.authorized_at_server)
  order by m.created_at_server desc limit 1);
alter table public.work_start_authorizations enable trigger reject_mutation;

alter table public.work_start_authorizations alter column authorized_by_membership_id set not null;
alter table public.work_start_authorizations add constraint work_start_author_membership_fk
  foreign key (authorized_by_membership_id, project_id) references public.project_memberships (id, project_id);

alter type public.work_start_view add attribute authorized_by_membership_id uuid, add attribute authorized_by_role text;

-- ----------------------------------------------------------------------------
-- Verrou d'operation_uuid partagé (M014, corps inchangé par ailleurs).
-- ----------------------------------------------------------------------------

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

-- ----------------------------------------------------------------------------
-- authorize_work_start : verrou d'UUID, revérifications, auteur.
-- ----------------------------------------------------------------------------

create or replace function public.authorize_work_start(p_operation_uuid uuid, p_project_id uuid, p_expected_revision integer)
returns public.advance_command_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  v_role text;
  v_found public.advance_command_result;
  v_project record;
  v_quote record;
  v_ledger public.advance_ledgers;
  v_status record;
  v_validation_id uuid;
  v_contract numeric;
  v_now timestamptz;
  v_seq bigint;
  v_auth_id uuid;
  v_op uuid;
  v_membership_id uuid;
  v_result public.advance_command_result;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_project_id is null then
    raise exception 'not_authorized';
  end if;
  v_hash := public.advance_payload_hash(jsonb_build_object('command', 'WORK_START', 'project_id', p_project_id));

  -- Verrous (ordre M014), puis verrou de l'operation_uuid : toute transaction
  -- qui insère ce même UUID (autorisation ou opération d'acompte, M027b)
  -- le détient jusqu'à sa fin. C'est la DERNIÈRE attente possible : les
  -- insertions uniques qui suivent ne peuvent plus attendre sur cet UUID
  -- (chantier, compteur et figement sont déjà sérialisés par les verrous).
  v_role := public.advance_lock_project(p_project_id, v_uid);
  perform pg_advisory_xact_lock(hashtext('advance_operation_uuid:' || p_operation_uuid::text)::bigint);
  -- Droits courants et compte vérifié APRÈS la dernière attente, AVANT toute
  -- recherche d'opération.
  v_role := public.advance_caller_role(p_project_id, v_uid);
  if v_role is distinct from 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  -- Rejeu légitime : même profil, chantier, commande et empreinte.
  v_found := public.advance_find_operation(p_operation_uuid, p_project_id, v_uid, 'WORK_START', v_hash);
  if v_found.operation_uuid is not null then
    return v_found;
  end if;

  if exists (select 1 from public.work_start_authorizations where project_id = p_project_id) then
    raise exception 'work_start_already_authorized';
  end if;

  select id, status::text as status, retained_plan_version_id, published_plan_version_id
    into v_project from public.projects where id = p_project_id;
  if v_project.status not in ('DRAFT', 'ACTIVE') then
    raise exception 'project_status_incompatible';
  end if;

  select q.id as quote_id, v.id as version_id, v.plan_version_id, v.total_amount_fcfa
    into v_quote
  from public.quotes q join public.quote_versions v on v.id = q.accepted_version_id and v.status = 'ACCEPTED'
  where q.project_id = p_project_id;
  if v_quote.version_id is null then
    raise exception 'quote_not_accepted';
  end if;

  -- D135 : plan du devis accepté, encore retenu ET publié, validé.
  if v_project.retained_plan_version_id is distinct from v_quote.plan_version_id
     or v_project.published_plan_version_id is distinct from v_quote.plan_version_id then
    raise exception 'plan_divergence';
  end if;
  select id into v_validation_id from public.plan_validations
  where project_plan_version_id = v_quote.plan_version_id and project_id = p_project_id and status = 'VALIDATED'
  order by decided_at_server desc, id limit 1;
  if v_validation_id is null then
    raise exception 'plan_not_validated';
  end if;

  select * into v_status from public.advance_status_internal(p_project_id);
  if v_status.fully_recognized is not true then
    raise exception 'advance_not_fully_recognized';
  end if;

  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;
  select * into v_ledger from public.advance_ledgers where project_id = p_project_id;
  if v_ledger.revision is distinct from p_expected_revision then
    raise exception 'advance_conflict';
  end if;
  if v_ledger.requirement_frozen_at is not null then
    raise exception 'requirement_frozen';
  end if;

  v_contract := public.contract_amount_internal(p_project_id);
  -- Auteur historique : adhésion (repère) du CONTRACTOR, verrouillée depuis
  -- advance_lock_project ; elle reste l'auteur après un transfert de rôle.
  select id into v_membership_id from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null;
  -- Un seul horodatage serveur, pris après toutes les attentes (verrous du
  -- chantier ET de l'operation_uuid).
  v_now := clock_timestamp();

  -- 1. Figement + numéro (une seule mise à jour ; déclencheur : +1 exact).
  update public.advance_ledgers
  set last_event_seq = last_event_seq + 1, requirement_frozen_at = v_now
  where project_id = p_project_id
  returning last_event_seq into v_seq;

  -- 2. Événement portant exactement ce numéro.
  insert into public.advance_events (project_id, event_seq, kind, requirement_version_id, actor_profile_id, actor_role, created_at_server)
  values (p_project_id, v_seq, 'REQUIREMENT_FROZEN', v_ledger.current_requirement_version_id, v_uid, 'CONTRACTOR', v_now);

  -- 3. Autorisation. Collision d'operation_uuid (autre chantier, même
  -- concurrent) : l'insertion attend la transaction rivale puis n'insère rien
  -- -> refus maîtrisé, toute la transaction est annulée.
  insert into public.work_start_authorizations (
    project_id, operation_uuid, authorized_by_profile_id, authorized_by_membership_id, authorized_at_server, project_status_at_start,
    quote_id, quote_version_id, quote_total_fcfa, contract_amount_fcfa, plan_version_id, plan_validation_id,
    advance_requirement_version_id, advance_required_fcfa, advance_recognized_fcfa, advance_event_seq)
  values (
    p_project_id, p_operation_uuid, v_uid, v_membership_id, v_now, v_project.status,
    v_quote.quote_id, v_quote.version_id, v_quote.total_amount_fcfa, v_contract::bigint, v_quote.plan_version_id, v_validation_id,
    v_ledger.current_requirement_version_id, v_status.requirement_amount_fcfa::bigint, v_status.recognized_sum_fcfa::bigint, v_seq)
  on conflict (operation_uuid) do nothing
  returning id into v_auth_id;
  if v_auth_id is null then
    raise exception 'operation_conflict';
  end if;

  -- 4. Audit (created_at_server imposé par le déclencheur M005 ; l'heure
  -- d'autorisation figure dans le contexte).
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', v_uid, 'WORK_START_AUTHORIZE', 'work_start_authorizations', v_auth_id, 'SUCCESS',
          jsonb_build_object('event_seq', v_seq, 'authorized_at_server', v_now, 'quote_version_id', v_quote.version_id,
                             'plan_version_id', v_quote.plan_version_id, 'plan_validation_id', v_validation_id,
                             'advance_required_fcfa', v_status.requirement_amount_fcfa, 'advance_recognized_fcfa', v_status.recognized_sum_fcfa),
          'Démarrage des travaux autorisé dans l''application par l''entreprise ; avance exigée figée.');

  -- 5. Opération, en dernier (même garde contre une collision concurrente,
  -- y compris avec une commande d'acompte portant le même operation_uuid).
  insert into public.advance_operations (operation_uuid, project_id, profile_id, command, payload_hash, advance_id,
                                         requirement_version_id, result_event_seq, outcome, created_at_server)
  values (p_operation_uuid, p_project_id, v_uid, 'WORK_START', v_hash, null,
          v_ledger.current_requirement_version_id, v_seq, 'WORK_START_AUTHORIZED', v_now)
  on conflict (operation_uuid) do nothing
  returning operation_uuid into v_op;
  if v_op is null then
    raise exception 'operation_conflict';
  end if;

  -- Revérification finale avant succès (défense en profondeur : aucune
  -- attente n'est plus possible depuis le verrou d'UUID, mais le succès
  -- n'est jamais rendu sans droits ni compte vérifié courants).
  if public.advance_caller_role(p_project_id, v_uid) is distinct from 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_result.operation_uuid := p_operation_uuid;
  v_result.replayed := false;
  v_result.command := 'WORK_START';
  v_result.requirement_version_id := v_ledger.current_requirement_version_id;
  v_result.result_event_seq := v_seq;
  v_result.outcome := 'WORK_START_AUTHORIZED';
  v_result.ledger_revision := (select revision from public.advance_ledgers where project_id = p_project_id);
  return v_result;
end;
$$;

-- ----------------------------------------------------------------------------
-- get_work_start : auteur historique (repère d'adhésion).
-- ----------------------------------------------------------------------------

create or replace function public.get_work_start(p_project_id uuid)
returns public.work_start_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := public.advance_require_reader(p_project_id);
  v_row public.work_start_authorizations;
  v_sum numeric;
  v_view public.work_start_view;
begin
  select * into v_row from public.work_start_authorizations where project_id = p_project_id;
  v_view.authorized := v_row.id is not null;
  if v_row.id is null then
    return v_view;
  end if;
  v_sum := public.recognized_payments_total_internal(p_project_id);
  v_view.authorized_at_server := v_row.authorized_at_server;
  v_view.authorized_by_me := v_row.authorized_by_profile_id = auth.uid();
  v_view.authorized_by_membership_id := v_row.authorized_by_membership_id;
  v_view.authorized_by_role := 'CONTRACTOR';
  v_view.project_status_at_start := v_row.project_status_at_start;
  v_view.quote_version_number := (select version_number from public.quote_versions where id = v_row.quote_version_id);
  v_view.quote_total_fcfa := v_row.quote_total_fcfa::text;
  v_view.contract_amount_fcfa := v_row.contract_amount_fcfa::text;
  v_view.plan_version_number := (select version_number from public.project_plan_versions where id = v_row.plan_version_id);
  v_view.advance_required_fcfa := v_row.advance_required_fcfa::text;
  v_view.advance_recognized_at_start_fcfa := v_row.advance_recognized_fcfa::text;
  v_view.advance_event_seq := v_row.advance_event_seq;
  v_view.current_recognized_fcfa := v_sum::text;
  -- D138 : alerte seulement si la somme actuelle est sous le montant figé.
  v_view.deficit_fcfa := case when v_sum < v_row.advance_required_fcfa then (v_row.advance_required_fcfa - v_sum)::text end;
  return v_view;
end;
$$;

revoke execute on function public.advance_record_operation(uuid, uuid, uuid, text, text, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.authorize_work_start(uuid, uuid, integer), public.get_work_start(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_work_start(uuid, uuid, integer), public.get_work_start(uuid)
  to authenticated;
