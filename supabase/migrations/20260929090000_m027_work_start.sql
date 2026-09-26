-- M027 — B067 : autorisation de démarrage des travaux (D094, D135-D139,
-- BR101, BR110, BR111).
--
-- Additive : M014 n'est pas réécrite. On étend ses contraintes (événement
-- REQUIREMENT_FROZEN, commande WORK_START) et on réutilise ses helpers
-- (advance_lock_project, advance_caller_role, advance_status_internal,
-- advance_payload_hash, advance_find_operation, contract_amount_internal,
-- advance_require_reader) ainsi que ses déclencheurs (compteur +1,
-- numéro d'événement = numéro alloué, figement irréversible).

-- ----------------------------------------------------------------------------
-- Extensions de M014.
-- ----------------------------------------------------------------------------

alter table public.advance_events drop constraint advance_events_kind_check;
alter table public.advance_events add constraint advance_events_kind_check
  check (kind in ('REQUIREMENT_SET', 'REQUIREMENT_FROZEN', 'DECLARED', 'CONFIRMED', 'DISPUTED', 'CANCELLED', 'RECEIPT_ATTACHED'));

alter table public.advance_events drop constraint advance_events_target_consistency;
alter table public.advance_events add constraint advance_events_target_consistency check (
  (kind in ('REQUIREMENT_SET', 'REQUIREMENT_FROZEN') and requirement_version_id is not null and advance_id is null)
  or (kind not in ('REQUIREMENT_SET', 'REQUIREMENT_FROZEN') and advance_id is not null and requirement_version_id is null)
);

-- L'événement de figement porte la version exigée courante, déjà portée par
-- son REQUIREMENT_SET : l'unicité par version ne vaut que pour REQUIREMENT_SET.
drop index public.advance_events_one_per_requirement;
create unique index advance_events_one_per_requirement
  on public.advance_events (requirement_version_id) where kind = 'REQUIREMENT_SET';
create unique index advance_events_one_frozen_per_project
  on public.advance_events (project_id) where kind = 'REQUIREMENT_FROZEN';

alter table public.advance_operations drop constraint advance_operations_command_check;
alter table public.advance_operations add constraint advance_operations_command_check
  check (command in ('SET_REQUIREMENT', 'DECLARE', 'CONFIRM', 'DISPUTE', 'CANCEL', 'WORK_START'));

-- ----------------------------------------------------------------------------
-- work_start_authorizations : une par chantier, instantané immuable.
-- ----------------------------------------------------------------------------

create table public.work_start_authorizations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects (id) on delete restrict,
  operation_uuid uuid not null unique,
  authorized_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  authorized_at_server timestamptz not null,
  project_status_at_start text not null check (project_status_at_start in ('DRAFT', 'ACTIVE')),
  quote_id uuid not null,
  quote_version_id uuid not null,
  quote_total_fcfa bigint not null check (quote_total_fcfa >= 0),
  contract_amount_fcfa bigint not null check (contract_amount_fcfa >= 0),
  plan_version_id uuid not null,
  plan_validation_id uuid not null,
  advance_requirement_version_id uuid not null,
  advance_required_fcfa bigint not null check (advance_required_fcfa >= 1),
  advance_recognized_fcfa bigint not null,
  advance_event_seq bigint not null check (advance_event_seq > 0),
  constraint work_start_recognized_covers_required check (advance_recognized_fcfa >= advance_required_fcfa),
  constraint work_start_quote_fk foreign key (quote_id, project_id) references public.quotes (id, project_id),
  constraint work_start_quote_version_fk foreign key (quote_version_id, project_id) references public.quote_versions (id, project_id),
  constraint work_start_plan_version_fk foreign key (plan_version_id, project_id) references public.project_plan_versions (id, project_id),
  constraint work_start_plan_validation_fk foreign key (plan_validation_id, plan_version_id)
    references public.plan_validations (id, project_plan_version_id),
  constraint work_start_requirement_fk foreign key (advance_requirement_version_id, project_id)
    references public.advance_requirement_versions (id, project_id),
  constraint work_start_event_fk foreign key (project_id, advance_event_seq) references public.advance_events (project_id, event_seq)
);

create function public.reject_work_start_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'work_start_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.work_start_authorizations
for each row execute function public.reject_work_start_mutation();

alter table public.work_start_authorizations enable row level security;
revoke all privileges on table public.work_start_authorizations from public, anon, authenticated;
revoke execute on function public.reject_work_start_mutation() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- authorize_work_start — CONTRACTOR seul (D094), transaction unique :
-- figement + événement numéroté + autorisation + audit + opération.
-- ----------------------------------------------------------------------------

create function public.authorize_work_start(p_operation_uuid uuid, p_project_id uuid, p_expected_revision integer)
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
  v_result public.advance_command_result;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_project_id is null then
    raise exception 'not_authorized';
  end if;
  v_hash := public.advance_payload_hash(jsonb_build_object('command', 'WORK_START', 'project_id', p_project_id));

  -- Verrous (ordre M014), puis droits courants et compte vérifié APRÈS la
  -- dernière attente, AVANT toute recherche d'opération.
  v_role := public.advance_lock_project(p_project_id, v_uid);
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
  -- Un seul horodatage serveur, pris après toutes les attentes.
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
    project_id, operation_uuid, authorized_by_profile_id, authorized_at_server, project_status_at_start,
    quote_id, quote_version_id, quote_total_fcfa, contract_amount_fcfa, plan_version_id, plan_validation_id,
    advance_requirement_version_id, advance_required_fcfa, advance_recognized_fcfa, advance_event_seq)
  values (
    p_project_id, p_operation_uuid, v_uid, v_now, v_project.status,
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
-- Lectures. Droits courants revérifiés à chaque appel (D137).
-- ----------------------------------------------------------------------------

create type public.work_start_view as (
  authorized boolean,
  authorized_at_server timestamptz,
  authorized_by_me boolean,
  project_status_at_start text,
  quote_version_number integer,
  quote_total_fcfa text,
  contract_amount_fcfa text,
  plan_version_number integer,
  advance_required_fcfa text,
  advance_recognized_at_start_fcfa text,
  advance_event_seq bigint,
  current_recognized_fcfa text,
  deficit_fcfa text
);

-- OWNER/PRIMARY, CO_OWNER, CONTRACTOR (advance_require_reader de M014).
create function public.get_work_start(p_project_id uuid)
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

-- Quatre rôles actifs : uniquement le fait et la date (aucune donnée
-- financière dans la réponse).
create function public.get_work_start_summary(p_project_id uuid)
returns table (authorized boolean, authorized_at_server timestamptz)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_role := public.advance_caller_role(p_project_id, auth.uid());
  if v_role is null then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return query
  select w.id is not null, w.authorized_at_server
  from (select 1) x left join public.work_start_authorizations w on w.project_id = p_project_id;
end;
$$;

revoke execute on function public.authorize_work_start(uuid, uuid, integer), public.get_work_start(uuid),
  public.get_work_start_summary(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_work_start(uuid, uuid, integer), public.get_work_start(uuid),
  public.get_work_start_summary(uuid)
  to authenticated;
