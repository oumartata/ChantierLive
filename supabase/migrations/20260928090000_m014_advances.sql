-- M014 — acomptes déclaratifs et avance exigée (B033). D011, D088, D094 ;
-- D126-D134 ; BR055-BR057, BR097, BR103, BR108-BR109 ; FR084-FR091, FR171.
--   Versements du client vers l'entreprise uniquement (D126). Deux acteurs
--   distincts : le titulaire COURANT du rôle opposé confirme, jamais l'auteur
--   de la déclaration (D133, BR108). ChantierLive ne détient ni ne transfère
--   aucun argent (BR055).
--   Avance exigée >= 1 FCFA (D127), fixée après devis accepté, plafonnée au
--   montant contractuel courant (D128), versionnée, figée après démarrage
--   (D131 : requirement_frozen_at, positionné UNIQUEMENT par B067).
--   Contesté exclu de la somme reconnue (D130) ; annulation réservée au
--   déclarant détenant encore un rôle autorisé (D132) ; justificatif privé
--   facultatif (D134).
--
-- Ordre des événements : compteur transactionnel advance_ledgers.last_event_seq
-- incrémenté sous le verrou du chantier ; chaque événement du journal
-- (advance_events, table UNIQUE pour tout le domaine) doit porter exactement
-- la valeur qui vient d'être allouée. Un rollback annule l'allocation ; un
-- rejeu idempotent n'alloue rien.
--
-- Idempotence : advance_operations (operation_uuid). Les droits COURANTS sont
-- revérifiés avant toute recherche d'opération et tout retour. Un rejeu
-- renvoie le résultat enregistré de l'opération ET l'état courant, séparés.
-- expected_revision n'entre pas dans l'empreinte et n'est pas contrôlé lors
-- d'un rejeu (la révision a normalement avancé depuis). Collision d'un même
-- operation_uuid entre chantiers : refus operation_conflict, sans mutation.
--
-- Ordre des verrous (écritures) : avisoire du chantier (même clé que
-- M021/M022) -> adhésion -> projects -> quotes -> advance_ledgers ->
-- advances. Compte vérifié relu après la dernière attente.
-- Hors périmètre : autorisation de démarrage (B067), reste dû (B068).

begin;

-- ----------------------------------------------------------------------------
-- Tables.
-- ----------------------------------------------------------------------------

create table public.advance_ledgers (
  project_id uuid primary key references public.projects (id) on delete restrict,
  revision integer not null default 0,
  last_event_seq bigint not null default 0,
  current_requirement_version_id uuid null,
  requirement_frozen_at timestamptz null,
  created_at_server timestamptz not null default now()
);

create table public.advance_requirement_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.advance_ledgers (project_id) on delete restrict,
  version_number integer not null check (version_number > 0),
  amount_fcfa bigint not null check (amount_fcfa between 1 and 1000000000000),
  contract_amount_fcfa_at_set bigint not null check (contract_amount_fcfa_at_set >= amount_fcfa),
  set_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint advance_requirement_versions_number_unique unique (project_id, version_number),
  constraint advance_requirement_versions_id_project_unique unique (id, project_id)
);

alter table public.advance_ledgers
  add constraint advance_ledgers_current_requirement_fk foreign key (current_requirement_version_id, project_id)
    references public.advance_requirement_versions (id, project_id);

create table public.advances (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.advance_ledgers (project_id) on delete restrict,
  declared_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  declared_role text not null check (declared_role in ('OWNER_PRIMARY', 'CONTRACTOR')),
  amount_fcfa bigint not null check (amount_fcfa between 1 and 1000000000000),
  external_payment_date date not null,
  mode text not null check (mode in ('ORANGE_MONEY', 'MOOV_MONEY', 'CASH', 'BANK', 'OTHER')),
  external_reference text null check (external_reference is null or char_length(external_reference) between 1 and 120),
  status text not null default 'DECLARED' check (status in ('DECLARED', 'RECEIVED', 'DISPUTED', 'CANCELLED')),
  created_at_server timestamptz not null default now(),
  constraint advances_id_project_unique unique (id, project_id)
);

create index advances_project_id_idx on public.advances (project_id);

-- Journal unique du domaine : l'ordre fait foi par event_seq, jamais par l'heure.
create table public.advance_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.advance_ledgers (project_id) on delete restrict,
  event_seq bigint not null check (event_seq > 0),
  kind text not null check (kind in ('REQUIREMENT_SET', 'DECLARED', 'CONFIRMED', 'DISPUTED', 'CANCELLED', 'RECEIPT_ATTACHED')),
  advance_id uuid null,
  requirement_version_id uuid null,
  actor_profile_id uuid not null references public.profiles (id) on delete restrict,
  actor_role text not null check (actor_role in ('OWNER_PRIMARY', 'CONTRACTOR')),
  reason text null check (reason is null or char_length(reason) between 1 and 1000),
  created_at_server timestamptz not null default now(),
  constraint advance_events_seq_unique unique (project_id, event_seq),
  constraint advance_events_target_consistency check (
    (kind = 'REQUIREMENT_SET' and requirement_version_id is not null and advance_id is null)
    or (kind <> 'REQUIREMENT_SET' and advance_id is not null and requirement_version_id is null)
  ),
  constraint advance_events_reason_consistency check ((kind in ('DISPUTED', 'CANCELLED')) = (reason is not null)),
  constraint advance_events_advance_fk foreign key (advance_id, project_id) references public.advances (id, project_id),
  constraint advance_events_requirement_fk foreign key (requirement_version_id, project_id)
    references public.advance_requirement_versions (id, project_id)
);

create unique index advance_events_one_per_kind on public.advance_events (advance_id, kind) where advance_id is not null;
create unique index advance_events_one_per_requirement on public.advance_events (requirement_version_id) where requirement_version_id is not null;

create table public.advance_operations (
  operation_uuid uuid primary key,
  project_id uuid not null references public.advance_ledgers (project_id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  command text not null check (command in ('SET_REQUIREMENT', 'DECLARE', 'CONFIRM', 'DISPUTE', 'CANCEL')),
  payload_hash text not null,
  advance_id uuid null,
  requirement_version_id uuid null,
  result_event_seq bigint null,
  outcome text not null,
  created_at_server timestamptz not null default now(),
  constraint advance_operations_advance_fk foreign key (advance_id, project_id) references public.advances (id, project_id),
  constraint advance_operations_requirement_fk foreign key (requirement_version_id, project_id)
    references public.advance_requirement_versions (id, project_id)
);

-- Justificatif (D134) : cible immuable fixée à la préparation, puis liaison
-- unique créée à la finalisation.
create table public.advance_receipt_upload_targets (
  private_object_upload_id uuid primary key,
  project_id uuid not null,
  advance_id uuid not null,
  created_at_server timestamptz not null default now(),
  constraint advance_receipt_upload_targets_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id),
  constraint advance_receipt_upload_targets_advance_fk foreign key (advance_id, project_id) references public.advances (id, project_id)
);

create table public.advance_receipts (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null unique,
  project_id uuid not null,
  private_object_upload_id uuid not null unique,
  attached_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint advance_receipts_advance_fk foreign key (advance_id, project_id) references public.advances (id, project_id),
  constraint advance_receipts_target_fk foreign key (private_object_upload_id) references public.advance_receipt_upload_targets (private_object_upload_id),
  constraint advance_receipts_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id)
);

-- ----------------------------------------------------------------------------
-- Invariants (déclencheurs).
-- ----------------------------------------------------------------------------

create function public.guard_advance_ledger()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'advance_ledger_immutable';
  end if;
  if tg_op = 'INSERT' then
    if new.last_event_seq <> 0 or new.current_requirement_version_id is not null or new.requirement_frozen_at is not null then
      raise exception 'advance_ledger_immutable';
    end if;
    new.revision := 0;
    return new;
  end if;
  if new.project_id <> old.project_id or new.created_at_server <> old.created_at_server then
    raise exception 'advance_ledger_immutable';
  end if;
  -- Chaque mise à jour alloue exactement un numéro d'événement.
  if new.last_event_seq <> old.last_event_seq + 1 then
    raise exception 'advance_sequence_violation';
  end if;
  if old.requirement_frozen_at is not null
     and (new.requirement_frozen_at is distinct from old.requirement_frozen_at
          or new.current_requirement_version_id is distinct from old.current_requirement_version_id) then
    raise exception 'requirement_frozen';
  end if;
  new.revision := old.revision + 1;
  return new;
end;
$$;

create trigger guard_advance_ledger
before insert or update or delete on public.advance_ledgers
for each row execute function public.guard_advance_ledger();

-- Événement : porte exactement le numéro qui vient d'être alloué.
create function public.guard_advance_event_insert()
returns trigger
language plpgsql
as $$
begin
  if new.event_seq is distinct from (select last_event_seq from public.advance_ledgers where project_id = new.project_id) then
    raise exception 'advance_sequence_violation';
  end if;
  return new;
end;
$$;

create trigger guard_advance_event_insert
before insert on public.advance_events
for each row execute function public.guard_advance_event_insert();

create function public.guard_advance_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'advance_immutable';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'DECLARED' then
      raise exception 'advance_must_start_declared';
    end if;
    return new;
  end if;
  if new.project_id <> old.project_id or new.declared_by_profile_id <> old.declared_by_profile_id
     or new.declared_role <> old.declared_role or new.amount_fcfa <> old.amount_fcfa
     or new.external_payment_date <> old.external_payment_date or new.mode <> old.mode
     or new.external_reference is distinct from old.external_reference
     or new.created_at_server <> old.created_at_server then
    raise exception 'advance_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'DECLARED' and new.status in ('RECEIVED', 'DISPUTED', 'CANCELLED'))
     or (old.status = 'RECEIVED' and new.status in ('DISPUTED', 'CANCELLED'))
     or (old.status = 'DISPUTED' and new.status = 'CANCELLED') then
    return new;
  end if;
  raise exception 'invalid_transition';
end;
$$;

create trigger guard_advance_mutation
before insert or update or delete on public.advances
for each row execute function public.guard_advance_mutation();

create function public.reject_advance_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'advance_record_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.advance_requirement_versions
for each row execute function public.reject_advance_record_mutation();
create trigger reject_mutation before update or delete on public.advance_events
for each row execute function public.reject_advance_record_mutation();
create trigger reject_mutation before update or delete on public.advance_operations
for each row execute function public.reject_advance_record_mutation();
create trigger reject_mutation before update or delete on public.advance_receipt_upload_targets
for each row execute function public.reject_advance_record_mutation();
create trigger reject_mutation before update or delete on public.advance_receipts
for each row execute function public.reject_advance_record_mutation();

alter table public.advance_ledgers enable row level security;
alter table public.advance_requirement_versions enable row level security;
alter table public.advances enable row level security;
alter table public.advance_events enable row level security;
alter table public.advance_operations enable row level security;
alter table public.advance_receipt_upload_targets enable row level security;
alter table public.advance_receipts enable row level security;
revoke all privileges on table public.advance_ledgers, public.advance_requirement_versions, public.advances,
  public.advance_events, public.advance_operations, public.advance_receipt_upload_targets, public.advance_receipts
  from public, anon, authenticated;

revoke execute on function public.guard_advance_ledger(), public.guard_advance_event_insert(),
  public.guard_advance_mutation(), public.reject_advance_record_mutation()
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Justificatifs : extension de private_object_uploads (M026), bucket privé.
-- ----------------------------------------------------------------------------

alter table public.private_object_uploads
  drop constraint private_object_uploads_entity_type_known;
alter table public.private_object_uploads
  add constraint private_object_uploads_entity_type_known
  check (entity_type in ('media_asset', 'plan_catalog_item_version', 'project_plan_version', 'advance_receipt'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('advance-receipts', 'advance-receipts', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Fonctions internes (aucun EXECUTE client).
-- ----------------------------------------------------------------------------

-- Rôle courant de l'appelant sur le chantier : CONTRACTOR, OWNER_PRIMARY,
-- CO_OWNER, SITE_MANAGER ou NULL.
create function public.advance_caller_role(p_project_id uuid, p_uid uuid)
returns text
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when m.role = 'CONTRACTOR' then 'CONTRACTOR'
    when m.role = 'OWNER' and m.owner_profile = 'PRIMARY' then 'OWNER_PRIMARY'
    when m.role = 'OWNER' and m.owner_profile = 'CO_OWNER' then 'CO_OWNER'
    when m.role = 'SITE_MANAGER' then 'SITE_MANAGER'
    else null end
  from public.project_memberships m
  where m.project_id = p_project_id and m.profile_id = p_uid and m.revoked_at is null;
$$;

-- Prélude commun des écritures : avisoire -> adhésion -> projects -> quotes
-- -> advance_ledgers. Renvoie le rôle courant (relu sous verrou).
create function public.advance_lock_project(p_project_id uuid, p_uid uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text;
begin
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);
  perform 1 from public.project_memberships
  where project_id = p_project_id and profile_id = p_uid and revoked_at is null
  for update;
  v_role := public.advance_caller_role(p_project_id, p_uid);
  perform 1 from public.projects where id = p_project_id for update;
  perform 1 from public.quotes where project_id = p_project_id for update;
  perform 1 from public.advance_ledgers where project_id = p_project_id for update;
  return v_role;
end;
$$;

-- Montant contractuel courant (BR094), même définition que get_contract_amount
-- (M022), sans contrôle d'accès : appelé sous le verrou du chantier.
create function public.contract_amount_internal(p_project_id uuid)
returns numeric
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select v.total_amount_fcfa::numeric + coalesce((
    select sum(cv.total_amount_fcfa)
    from public.change_orders o join public.change_order_versions cv on cv.id = o.accepted_version_id
    where o.project_id = p_project_id and cv.status = 'ACCEPTED'), 0)
  from public.quotes q join public.quote_versions v on v.id = q.accepted_version_id
  where q.project_id = p_project_id;
$$;

-- Alloue le prochain numéro d'événement (une seule mise à jour du ledger).
create function public.advance_allocate_seq(p_project_id uuid, p_requirement_version_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_seq bigint;
begin
  update public.advance_ledgers
  set last_event_seq = last_event_seq + 1,
      current_requirement_version_id = coalesce(p_requirement_version_id, current_requirement_version_id)
  where project_id = p_project_id
  returning last_event_seq into v_seq;
  if v_seq is null then
    raise exception 'advance_requirement_missing';
  end if;
  return v_seq;
end;
$$;

create function public.advance_payload_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
$$;

-- État agrégé (D127-D130) : jamais « intégralement reconnue » sans montant exigé.
create function public.advance_status_internal(p_project_id uuid)
returns table (requirement_amount_fcfa numeric, recognized_sum_fcfa numeric, fully_recognized boolean)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select r.amount_fcfa::numeric,
         coalesce((select sum(a.amount_fcfa) from public.advances a where a.project_id = p_project_id and a.status = 'RECEIVED'), 0),
         r.amount_fcfa is not null
           and coalesce((select sum(a.amount_fcfa) from public.advances a where a.project_id = p_project_id and a.status = 'RECEIVED'), 0) >= r.amount_fcfa
  from (select 1) x
  left join public.advance_ledgers l on l.project_id = p_project_id
  left join public.advance_requirement_versions r on r.id = l.current_requirement_version_id;
$$;

-- Pour B068 : total des versements reconnus (avance et solde).
create function public.recognized_payments_total_internal(p_project_id uuid)
returns numeric
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(sum(a.amount_fcfa), 0)::numeric from public.advances a where a.project_id = p_project_id and a.status = 'RECEIVED';
$$;

revoke execute on function public.advance_caller_role(uuid, uuid), public.advance_lock_project(uuid, uuid),
  public.contract_amount_internal(uuid), public.advance_allocate_seq(uuid, uuid), public.advance_payload_hash(jsonb),
  public.advance_status_internal(uuid), public.recognized_payments_total_internal(uuid)
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Résultat des commandes : opération enregistrée ET état courant, séparés.
-- ----------------------------------------------------------------------------

create type public.advance_command_result as (
  operation_uuid uuid,
  replayed boolean,
  command text,
  advance_id uuid,
  requirement_version_id uuid,
  result_event_seq bigint,
  outcome text,
  current_status text,
  ledger_revision integer
);

-- Recherche d'une opération APRÈS la revérification des droits courants.
-- Renvoie NULL si inconnue ; refuse toute divergence (profil, chantier,
-- commande, empreinte) sans détail.
create function public.advance_find_operation(p_operation_uuid uuid, p_project_id uuid, p_uid uuid, p_command text, p_hash text)
returns public.advance_command_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_op public.advance_operations;
  v_result public.advance_command_result;
begin
  select * into v_op from public.advance_operations where operation_uuid = p_operation_uuid;
  if not found then
    return null;
  end if;
  if v_op.profile_id <> p_uid or v_op.project_id <> p_project_id or v_op.command <> p_command or v_op.payload_hash <> p_hash then
    raise exception 'operation_conflict';
  end if;
  v_result.operation_uuid := v_op.operation_uuid;
  v_result.replayed := true;
  v_result.command := v_op.command;
  v_result.advance_id := v_op.advance_id;
  v_result.requirement_version_id := v_op.requirement_version_id;
  v_result.result_event_seq := v_op.result_event_seq;
  v_result.outcome := v_op.outcome;
  v_result.current_status := (select status from public.advances where id = v_op.advance_id);
  v_result.ledger_revision := (select revision from public.advance_ledgers where project_id = p_project_id);
  return v_result;
end;
$$;

-- Enregistre l'opération en fin de commande. Un même operation_uuid inséré
-- par une transaction concurrente (autre chantier) : l'insertion attend sa
-- fin puis ne fait rien -> refus maîtrisé, toute la transaction est annulée.
create function public.advance_record_operation(
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

revoke execute on function public.advance_find_operation(uuid, uuid, uuid, text, text),
  public.advance_record_operation(uuid, uuid, uuid, text, text, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role;

-- Montant saisi en texte (^\d{1,13}$), borné 1 .. 1e12, jamais arrondi.
create function public.advance_parse_amount(p_amount text)
returns bigint
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v numeric;
begin
  if p_amount is null or p_amount !~ '^\d{1,13}$' then
    raise exception 'invalid_amount';
  end if;
  v := p_amount::numeric;
  if v < 1 or v > 1000000000000 then
    raise exception 'amount_out_of_bounds';
  end if;
  return v::bigint;
end;
$$;

revoke execute on function public.advance_parse_amount(text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- set_advance_requirement — CONTRACTOR, devis accepté, <= montant contractuel.
-- ----------------------------------------------------------------------------

create function public.set_advance_requirement(p_operation_uuid uuid, p_project_id uuid, p_amount_fcfa text, p_expected_revision integer)
returns public.advance_command_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_amount bigint;
  v_hash text;
  v_role text;
  v_found public.advance_command_result;
  v_ledger public.advance_ledgers;
  v_contract numeric;
  v_version public.advance_requirement_versions;
  v_seq bigint;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_project_id is null then
    raise exception 'not_authorized';
  end if;
  v_amount := public.advance_parse_amount(p_amount_fcfa);
  v_hash := public.advance_payload_hash(jsonb_build_object('command', 'SET_REQUIREMENT', 'project_id', p_project_id, 'amount_fcfa', v_amount::text));

  v_role := public.advance_lock_project(p_project_id, v_uid);
  if v_role is distinct from 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_found := public.advance_find_operation(p_operation_uuid, p_project_id, v_uid, 'SET_REQUIREMENT', v_hash);
  if v_found.operation_uuid is not null then
    return v_found;
  end if;

  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;
  select * into v_ledger from public.advance_ledgers where project_id = p_project_id;
  if coalesce(v_ledger.revision, 0) is distinct from p_expected_revision then
    raise exception 'advance_conflict';
  end if;
  if v_ledger.requirement_frozen_at is not null then
    raise exception 'requirement_frozen';
  end if;
  v_contract := public.contract_amount_internal(p_project_id);
  if v_contract is null then
    raise exception 'quote_not_accepted';
  end if;
  if v_amount > v_contract then
    raise exception 'amount_above_contract';
  end if;

  if v_ledger.project_id is null then
    insert into public.advance_ledgers (project_id) values (p_project_id);
  end if;

  insert into public.advance_requirement_versions (project_id, version_number, amount_fcfa, contract_amount_fcfa_at_set, set_by_profile_id)
  values (p_project_id,
          coalesce((select max(version_number) from public.advance_requirement_versions where project_id = p_project_id), 0) + 1,
          v_amount, v_contract::bigint, v_uid)
  returning * into v_version;

  v_seq := public.advance_allocate_seq(p_project_id, v_version.id);
  insert into public.advance_events (project_id, event_seq, kind, requirement_version_id, actor_profile_id, actor_role)
  values (p_project_id, v_seq, 'REQUIREMENT_SET', v_version.id, v_uid, 'CONTRACTOR');

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', v_uid, 'ADVANCE_REQUIREMENT_SET', 'advance_requirement_versions', v_version.id, 'SUCCESS',
          jsonb_build_object('event_seq', v_seq, 'amount_fcfa', v_amount, 'version_number', v_version.version_number),
          'Montant d''avance exigé fixé par l''entreprise (déclaratif, aucun paiement).');

  return public.advance_record_operation(p_operation_uuid, p_project_id, v_uid, 'SET_REQUIREMENT', v_hash, null, v_version.id, v_seq, 'REQUIREMENT_SET');
end;
$$;

-- ----------------------------------------------------------------------------
-- declare_advance_payment — OWNER/PRIMARY ou CONTRACTOR, avance exigée fixée.
-- ----------------------------------------------------------------------------

create function public.declare_advance_payment(
  p_operation_uuid uuid, p_project_id uuid, p_amount_fcfa text, p_payment_date date, p_mode text,
  p_reference text, p_disclaimer_ack boolean, p_expected_revision integer)
returns public.advance_command_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_amount bigint;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_hash text;
  v_role text;
  v_found public.advance_command_result;
  v_ledger public.advance_ledgers;
  v_advance public.advances;
  v_seq bigint;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_project_id is null then
    raise exception 'not_authorized';
  end if;
  v_amount := public.advance_parse_amount(p_amount_fcfa);
  if p_payment_date is null or p_payment_date > (now() at time zone 'UTC')::date or p_payment_date < date '2000-01-01' then
    raise exception 'invalid_payment_date';
  end if;
  if p_mode is null or p_mode not in ('ORANGE_MONEY', 'MOOV_MONEY', 'CASH', 'BANK', 'OTHER') then
    raise exception 'invalid_mode';
  end if;
  if v_reference is not null and char_length(v_reference) > 120 then
    raise exception 'invalid_reference';
  end if;
  if p_disclaimer_ack is not true then
    raise exception 'disclaimer_required';
  end if;
  v_hash := public.advance_payload_hash(jsonb_build_object('command', 'DECLARE', 'project_id', p_project_id,
    'amount_fcfa', v_amount::text, 'payment_date', p_payment_date::text, 'mode', p_mode, 'reference', v_reference));

  v_role := public.advance_lock_project(p_project_id, v_uid);
  if v_role is null or v_role not in ('OWNER_PRIMARY', 'CONTRACTOR') then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  v_found := public.advance_find_operation(p_operation_uuid, p_project_id, v_uid, 'DECLARE', v_hash);
  if v_found.operation_uuid is not null then
    return v_found;
  end if;

  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;
  select * into v_ledger from public.advance_ledgers where project_id = p_project_id;
  if v_ledger.current_requirement_version_id is null then
    raise exception 'advance_requirement_missing';
  end if;
  if v_ledger.revision is distinct from p_expected_revision then
    raise exception 'advance_conflict';
  end if;

  insert into public.advances (project_id, declared_by_profile_id, declared_role, amount_fcfa, external_payment_date, mode, external_reference)
  values (p_project_id, v_uid, v_role, v_amount, p_payment_date, p_mode, v_reference)
  returning * into v_advance;

  v_seq := public.advance_allocate_seq(p_project_id);
  insert into public.advance_events (project_id, event_seq, kind, advance_id, actor_profile_id, actor_role)
  values (p_project_id, v_seq, 'DECLARED', v_advance.id, v_uid, v_role);

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', v_uid, 'ADVANCE_DECLARED', 'advances', v_advance.id, 'SUCCESS',
          jsonb_build_object('event_seq', v_seq, 'amount_fcfa', v_amount, 'declared_role', v_role),
          'Versement déclaré, sans exécution de paiement.');

  return public.advance_record_operation(p_operation_uuid, p_project_id, v_uid, 'DECLARE', v_hash, v_advance.id, null, v_seq, 'DECLARED');
end;
$$;

-- ----------------------------------------------------------------------------
-- Actions sur un versement : CONFIRM (rôle opposé, jamais le déclarant),
-- DISPUTE (OWNER/PRIMARY ou CONTRACTOR, motif), CANCEL (déclarant, motif).
-- ----------------------------------------------------------------------------

create function public.advance_act(p_operation_uuid uuid, p_advance_id uuid, p_command text, p_reason text, p_expected_revision integer)
returns public.advance_command_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_project_id uuid;
  v_hash text;
  v_role text;
  v_found public.advance_command_result;
  v_ledger public.advance_ledgers;
  v_advance public.advances;
  v_seq bigint;
  v_new_status text;
  v_kind text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_advance_id is null then
    raise exception 'not_authorized';
  end if;
  if p_command in ('DISPUTE', 'CANCEL') and (v_reason is null or char_length(v_reason) > 1000) then
    raise exception 'reason_required';
  end if;
  v_hash := public.advance_payload_hash(jsonb_build_object('command', p_command, 'advance_id', p_advance_id,
    'reason', case when p_command = 'CONFIRM' then null else v_reason end));

  select project_id into v_project_id from public.advances where id = p_advance_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;

  v_role := public.advance_lock_project(v_project_id, v_uid);
  select * into v_advance from public.advances where id = p_advance_id for update;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  -- Droits COURANTS, indépendants de l'état : revérifiés avant tout rejeu.
  if p_command = 'CONFIRM' then
    if v_role is null or v_role not in ('OWNER_PRIMARY', 'CONTRACTOR') then
      raise exception 'not_authorized';
    end if;
    if v_uid = v_advance.declared_by_profile_id then
      raise exception 'self_confirmation_refused';
    end if;
    if v_role = v_advance.declared_role then
      raise exception 'not_confirming_role';
    end if;
  elsif p_command = 'DISPUTE' then
    if v_role is null or v_role not in ('OWNER_PRIMARY', 'CONTRACTOR') then
      raise exception 'not_authorized';
    end if;
  elsif p_command = 'CANCEL' then
    if v_role is null or v_role not in ('OWNER_PRIMARY', 'CONTRACTOR') then
      raise exception 'not_authorized';
    end if;
    if v_uid <> v_advance.declared_by_profile_id then
      raise exception 'not_declarant';
    end if;
  else
    raise exception 'invalid_command';
  end if;

  v_found := public.advance_find_operation(p_operation_uuid, v_project_id, v_uid, p_command, v_hash);
  if v_found.operation_uuid is not null then
    return v_found;
  end if;

  -- Confirmation déjà acquise : réussite idempotente, aucun événement (EC039).
  if p_command = 'CONFIRM' and v_advance.status = 'RECEIVED' then
    return public.advance_record_operation(p_operation_uuid, v_project_id, v_uid, p_command, v_hash, p_advance_id, null, null, 'ALREADY_CONFIRMED');
  end if;

  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;
  select * into v_ledger from public.advance_ledgers where project_id = v_project_id;
  if v_ledger.revision is distinct from p_expected_revision then
    raise exception 'advance_conflict';
  end if;

  v_new_status := case p_command when 'CONFIRM' then 'RECEIVED' when 'DISPUTE' then 'DISPUTED' else 'CANCELLED' end;
  v_kind := case p_command when 'CONFIRM' then 'CONFIRMED' when 'DISPUTE' then 'DISPUTED' else 'CANCELLED' end;
  if not ((p_command = 'CONFIRM' and v_advance.status = 'DECLARED')
          or (p_command = 'DISPUTE' and v_advance.status in ('DECLARED', 'RECEIVED'))
          or (p_command = 'CANCEL' and v_advance.status in ('DECLARED', 'RECEIVED', 'DISPUTED'))) then
    raise exception 'invalid_transition';
  end if;

  update public.advances set status = v_new_status where id = p_advance_id;
  v_seq := public.advance_allocate_seq(v_project_id);
  insert into public.advance_events (project_id, event_seq, kind, advance_id, actor_profile_id, actor_role, reason)
  values (v_project_id, v_seq, v_kind, p_advance_id, v_uid, v_role, case when p_command = 'CONFIRM' then null else v_reason end);

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_project_id, 'HUMAN', v_uid, 'ADVANCE_' || v_kind, 'advances', p_advance_id, 'SUCCESS',
          jsonb_build_object('event_seq', v_seq, 'actor_role', v_role, 'previous_status', v_advance.status),
          coalesce(v_reason, 'Versement confirmé par la partie opposée (déclaratif).'));

  return public.advance_record_operation(p_operation_uuid, v_project_id, v_uid, p_command, v_hash, p_advance_id, null, v_seq, v_kind);
end;
$$;

revoke execute on function public.advance_act(uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;

create function public.confirm_advance_payment(p_operation_uuid uuid, p_advance_id uuid, p_expected_revision integer)
returns public.advance_command_result
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$ select public.advance_act(p_operation_uuid, p_advance_id, 'CONFIRM', null, p_expected_revision); $$;

create function public.dispute_advance_payment(p_operation_uuid uuid, p_advance_id uuid, p_reason text, p_expected_revision integer)
returns public.advance_command_result
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$ select public.advance_act(p_operation_uuid, p_advance_id, 'DISPUTE', p_reason, p_expected_revision); $$;

create function public.cancel_advance_payment(p_operation_uuid uuid, p_advance_id uuid, p_reason text, p_expected_revision integer)
returns public.advance_command_result
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$ select public.advance_act(p_operation_uuid, p_advance_id, 'CANCEL', p_reason, p_expected_revision); $$;

revoke execute on function public.set_advance_requirement(uuid, uuid, text, integer),
  public.declare_advance_payment(uuid, uuid, text, date, text, text, boolean, integer),
  public.confirm_advance_payment(uuid, uuid, integer), public.dispute_advance_payment(uuid, uuid, text, integer),
  public.cancel_advance_payment(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.set_advance_requirement(uuid, uuid, text, integer),
  public.declare_advance_payment(uuid, uuid, text, date, text, text, boolean, integer),
  public.confirm_advance_payment(uuid, uuid, integer), public.dispute_advance_payment(uuid, uuid, text, integer),
  public.cancel_advance_payment(uuid, uuid, text, integer)
  to authenticated;

-- ----------------------------------------------------------------------------
-- Lectures : CONTRACTOR, OWNER/PRIMARY, CO_OWNER ; SITE_MANAGER et tiers refusés.
-- ----------------------------------------------------------------------------

create function public.advance_require_reader(p_project_id uuid)
returns text
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
  if v_role is null or v_role not in ('CONTRACTOR', 'OWNER_PRIMARY', 'CO_OWNER') then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

revoke execute on function public.advance_require_reader(uuid) from public, anon, authenticated, service_role;

create type public.advance_status_view as (
  has_requirement boolean,
  requirement_amount_fcfa text,
  requirement_version_number integer,
  requirement_frozen boolean,
  recognized_sum_fcfa text,
  fully_recognized boolean,
  recognized_above_advance_fcfa text,
  contract_amount_fcfa text,
  recognized_above_contract_fcfa text,
  requirement_above_contract boolean,
  revision integer
);

create function public.get_advance_status(p_project_id uuid)
returns public.advance_status_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := public.advance_require_reader(p_project_id);
  v_ledger public.advance_ledgers;
  v_req public.advance_requirement_versions;
  v_sum numeric;
  v_contract numeric;
  v_view public.advance_status_view;
begin
  select * into v_ledger from public.advance_ledgers where project_id = p_project_id;
  select * into v_req from public.advance_requirement_versions where id = v_ledger.current_requirement_version_id;
  v_sum := public.recognized_payments_total_internal(p_project_id);
  v_contract := public.contract_amount_internal(p_project_id);

  v_view.has_requirement := v_req.id is not null;
  v_view.requirement_amount_fcfa := v_req.amount_fcfa::text;
  v_view.requirement_version_number := v_req.version_number;
  v_view.requirement_frozen := v_ledger.requirement_frozen_at is not null;
  v_view.recognized_sum_fcfa := v_sum::text;
  -- Jamais vrai sans montant exigé fixé (aucune assimilation à zéro).
  v_view.fully_recognized := v_req.id is not null and v_sum >= v_req.amount_fcfa;
  v_view.recognized_above_advance_fcfa := case when v_req.id is not null and v_sum > v_req.amount_fcfa then (v_sum - v_req.amount_fcfa)::text end;
  v_view.contract_amount_fcfa := v_contract::text;
  v_view.recognized_above_contract_fcfa := case when v_contract is not null and v_sum > v_contract then (v_sum - v_contract)::text end;
  v_view.requirement_above_contract := v_req.id is not null and v_contract is not null and v_req.amount_fcfa > v_contract;
  v_view.revision := case when v_role in ('CONTRACTOR', 'OWNER_PRIMARY') then coalesce(v_ledger.revision, 0) end;
  return v_view;
end;
$$;

create type public.advance_payment_view as (
  advance_id uuid,
  declared_role text,
  declared_by_me boolean,
  amount_fcfa text,
  external_payment_date date,
  mode text,
  external_reference text,
  status text,
  declared_event_seq bigint,
  declared_at_server timestamptz,
  has_receipt boolean,
  can_confirm boolean,
  can_dispute boolean,
  can_cancel boolean,
  can_attach_receipt boolean
);

create function public.list_advance_payments(p_project_id uuid)
returns setof public.advance_payment_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := public.advance_require_reader(p_project_id);
  v_uid uuid := auth.uid();
begin
  return query
  select a.id, a.declared_role, a.declared_by_profile_id = v_uid, a.amount_fcfa::text, a.external_payment_date, a.mode,
         a.external_reference, a.status, e.event_seq, a.created_at_server,
         exists (select 1 from public.advance_receipts r where r.advance_id = a.id),
         a.status = 'DECLARED' and v_role in ('OWNER_PRIMARY', 'CONTRACTOR') and v_role <> a.declared_role and a.declared_by_profile_id <> v_uid,
         a.status in ('DECLARED', 'RECEIVED') and v_role in ('OWNER_PRIMARY', 'CONTRACTOR'),
         a.status <> 'CANCELLED' and v_role in ('OWNER_PRIMARY', 'CONTRACTOR') and a.declared_by_profile_id = v_uid,
         a.status <> 'CANCELLED' and v_role in ('OWNER_PRIMARY', 'CONTRACTOR') and a.declared_by_profile_id = v_uid
           and not exists (select 1 from public.advance_receipts r where r.advance_id = a.id)
  from public.advances a
  join public.advance_events e on e.advance_id = a.id and e.kind = 'DECLARED'
  where a.project_id = p_project_id
  order by e.event_seq desc;
end;
$$;

create type public.advance_event_view as (
  event_seq bigint,
  kind text,
  advance_id uuid,
  requirement_amount_fcfa text,
  requirement_version_number integer,
  actor_role text,
  reason text,
  created_at_server timestamptz
);

create function public.list_advance_events(p_project_id uuid)
returns setof public.advance_event_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := public.advance_require_reader(p_project_id);
begin
  return query
  select e.event_seq, e.kind, e.advance_id, r.amount_fcfa::text, r.version_number, e.actor_role, e.reason, e.created_at_server
  from public.advance_events e
  left join public.advance_requirement_versions r on r.id = e.requirement_version_id
  where e.project_id = p_project_id
  order by e.event_seq;
end;
$$;

revoke execute on function public.get_advance_status(uuid), public.list_advance_payments(uuid), public.list_advance_events(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_advance_status(uuid), public.list_advance_payments(uuid), public.list_advance_events(uuid)
  to authenticated;

-- ----------------------------------------------------------------------------
-- Justificatifs : préparation, finalisation, lecture, abandon (D134).
-- ----------------------------------------------------------------------------

-- Préparation : déclarant détenant un rôle autorisé, versement non annulé et
-- sans justificatif. Cible advance_id et paramètres liés à l'opération,
-- immuables ; rejeu identique renvoie la ligne, sinon operation_uuid_conflict.
create function public.prepare_advance_receipt_upload(
  p_operation_uuid uuid, p_advance_id uuid, p_expected_checksum text, p_expected_size_bytes bigint, p_expected_mime_type text)
returns public.private_object_uploads
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_role text;
  v_advance public.advances;
  v_existing public.private_object_uploads;
  v_target public.advance_receipt_upload_targets;
  v_row public.private_object_uploads;
  v_attempt_id uuid := gen_random_uuid();
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_advance_id is null then
    raise exception 'not_authorized';
  end if;
  if p_expected_checksum is null or p_expected_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'checksum_required';
  end if;
  if p_expected_size_bytes is null or p_expected_size_bytes <= 0 or p_expected_size_bytes > 10485760 then
    raise exception 'size_required';
  end if;
  if p_expected_mime_type is null or p_expected_mime_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'mime_type_required';
  end if;

  select project_id into v_project_id from public.advances where id = p_advance_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;
  v_role := public.advance_lock_project(v_project_id, v_uid);
  select * into v_advance from public.advances where id = p_advance_id for update;
  if v_role is null or v_role not in ('OWNER_PRIMARY', 'CONTRACTOR') or v_advance.declared_by_profile_id is distinct from v_uid then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select * into v_existing from public.private_object_uploads where operation_uuid = p_operation_uuid;
  if found then
    select * into v_target from public.advance_receipt_upload_targets where private_object_upload_id = v_existing.id;
    if v_existing.entity_type <> 'advance_receipt' or v_existing.created_by_profile_id <> v_uid
       or v_existing.project_id is distinct from v_project_id or v_target.advance_id is distinct from p_advance_id
       or v_existing.expected_checksum <> p_expected_checksum or v_existing.expected_size_bytes <> p_expected_size_bytes
       or v_existing.expected_mime_type <> p_expected_mime_type then
      raise exception 'operation_uuid_conflict';
    end if;
    if v_existing.status = 'ABANDONED' then
      raise exception 'operation_abandoned';
    end if;
    return v_existing;
  end if;

  if v_advance.status = 'CANCELLED' then
    raise exception 'advance_cancelled';
  end if;
  if exists (select 1 from public.advance_receipts where advance_id = p_advance_id) then
    raise exception 'receipt_already_attached';
  end if;

  v_now := clock_timestamp();
  insert into public.private_object_uploads (
    operation_uuid, project_id, entity_type, created_by_profile_id, attempt_id, attempt_expires_at, candidate_key,
    expected_checksum, expected_size_bytes, expected_mime_type
  ) values (
    p_operation_uuid, v_project_id, 'advance_receipt', v_uid, v_attempt_id, v_now + interval '15 minutes',
    '_private/' || v_project_id::text || '/advance_receipt/' || p_operation_uuid::text || '/candidates/' || v_attempt_id::text,
    p_expected_checksum, p_expected_size_bytes, p_expected_mime_type
  )
  on conflict (operation_uuid) do nothing
  returning * into v_row;
  if v_row.id is null then
    -- Même operation_uuid préparé concurremment ailleurs : refus maîtrisé.
    raise exception 'operation_uuid_conflict';
  end if;

  insert into public.advance_receipt_upload_targets (private_object_upload_id, project_id, advance_id)
  values (v_row.id, v_project_id, p_advance_id);

  return v_row;
end;
$$;

-- Finalisation atomique : FINALIZED + liaison + événement + audit. Rejeu d'une
-- opération déjà finalisée : droits courants revérifiés, liaison renvoyée.
create function public.finalize_advance_receipt_upload(p_operation_uuid uuid)
returns public.advance_receipts
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_project_id uuid;
  v_role text;
  v_row public.private_object_uploads;
  v_target public.advance_receipt_upload_targets;
  v_advance public.advances;
  v_receipt public.advance_receipts;
  v_now timestamptz;
  v_updated integer;
  v_seq bigint;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select project_id into v_peek_project_id from public.private_object_uploads
  where operation_uuid = p_operation_uuid and entity_type = 'advance_receipt';
  if v_peek_project_id is null then
    raise exception 'not_authorized';
  end if;

  v_role := public.advance_lock_project(v_peek_project_id, v_uid);
  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid for update;
  select * into v_target from public.advance_receipt_upload_targets where private_object_upload_id = v_row.id;
  select * into v_advance from public.advances where id = v_target.advance_id for update;
  if v_row.id is null or v_advance.id is null or v_row.created_by_profile_id is distinct from v_uid
     or v_row.entity_type is distinct from 'advance_receipt' or v_row.project_id is distinct from v_peek_project_id
     or v_role is null or v_role not in ('OWNER_PRIMARY', 'CONTRACTOR') or v_advance.declared_by_profile_id is distinct from v_uid then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_row.status = 'FINALIZED' then
    select * into v_receipt from public.advance_receipts where private_object_upload_id = v_row.id;
    if found then
      return v_receipt;
    end if;
    raise exception 'finalize_inconsistent_state';
  end if;

  v_now := clock_timestamp();
  if v_row.status <> 'FINALIZING' or v_row.storage_verified_attempt_id is distinct from v_row.attempt_id then
    raise exception 'storage_not_verified';
  end if;
  if v_row.attempt_expires_at <= v_now then
    raise exception 'attempt_expired';
  end if;
  if v_advance.status = 'CANCELLED' then
    raise exception 'advance_cancelled';
  end if;
  if exists (select 1 from public.advance_receipts where advance_id = v_advance.id) then
    raise exception 'receipt_already_attached';
  end if;

  update public.private_object_uploads
  set status = 'FINALIZED', storage_key = v_row.candidate_key, finalized_at = v_now, finalized_by_profile_id = v_uid
  where id = v_row.id and attempt_id = v_row.attempt_id and status = 'FINALIZING';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'storage_not_verified';
  end if;

  insert into public.advance_receipts (advance_id, project_id, private_object_upload_id, attached_by_profile_id)
  values (v_advance.id, v_row.project_id, v_row.id, v_uid)
  returning * into v_receipt;
  update public.private_object_uploads set entity_id = v_receipt.id where id = v_row.id;

  v_seq := public.advance_allocate_seq(v_row.project_id);
  insert into public.advance_events (project_id, event_seq, kind, advance_id, actor_profile_id, actor_role)
  values (v_row.project_id, v_seq, 'RECEIPT_ATTACHED', v_advance.id, v_uid, v_role);

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_uid, 'ADVANCE_RECEIPT_ATTACHED', 'advance_receipts', v_receipt.id, 'SUCCESS',
          jsonb_build_object('event_seq', v_seq, 'advance_id', v_advance.id),
          'Justificatif facultatif rattaché au versement déclaré.');

  return v_receipt;
end;
$$;

-- Lecture : clé exacte renvoyée aux seuls lecteurs autorisés (droits courants
-- à CHAQUE émission de lien) ; la signature Storage est faite côté serveur.
-- Lecture historique permise même si le versement a été annulé ensuite.
create function public.get_advance_receipt_file_key(p_advance_id uuid)
returns table (bucket text, storage_key text, mime_type text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_project_id uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select project_id into v_project_id from public.advances where id = p_advance_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;
  perform public.advance_require_reader(v_project_id);
  return query
  select 'advance-receipts'::text, u.storage_key, u.expected_mime_type
  from public.advance_receipts r join public.private_object_uploads u on u.id = r.private_object_upload_id
  where r.advance_id = p_advance_id and u.status = 'FINALIZED';
  if not found then
    raise exception 'file_not_finalized';
  end if;
end;
$$;

revoke execute on function public.prepare_advance_receipt_upload(uuid, uuid, text, bigint, text),
  public.finalize_advance_receipt_upload(uuid), public.get_advance_receipt_file_key(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_advance_receipt_upload(uuid, uuid, text, bigint, text),
  public.finalize_advance_receipt_upload(uuid), public.get_advance_receipt_file_key(uuid)
  to authenticated;

-- Nettoyage (service_role) : abandon des tentatives expirées ; seule la
-- candidate revendiquée d'une tentative NON finalisée est tracée ; aucune
-- source n'existe dans ce flux (écriture serveur directe de la candidate).
create function public.list_expired_advance_receipt_uploads(p_older_than interval default interval '1 hour')
returns table (id uuid, project_id uuid, attempt_expires_at timestamptz)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.project_id, u.attempt_expires_at
  from public.private_object_uploads u
  where u.entity_type = 'advance_receipt'
    and u.status in ('PENDING', 'FINALIZING')
    and u.attempt_expires_at < now() - p_older_than;
$$;

create function public.abandon_expired_advance_receipt_upload(p_id uuid, p_older_than interval default interval '1 hour')
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
begin
  select * into v_row from public.private_object_uploads where id = p_id for update;
  if not found or v_row.entity_type <> 'advance_receipt' then
    return false;
  end if;
  if v_row.status not in ('PENDING', 'FINALIZING') or v_row.attempt_expires_at >= now() - p_older_than then
    return false;
  end if;
  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;
  update public.private_object_uploads set status = 'ABANDONED' where id = v_row.id;
  return true;
end;
$$;

revoke execute on function public.list_expired_advance_receipt_uploads(interval), public.abandon_expired_advance_receipt_upload(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_advance_receipt_uploads(interval), public.abandon_expired_advance_receipt_upload(uuid, interval)
  to service_role;

-- get_stale_key_bucket : branche advance_receipt AJOUTÉE, autres inchangées.
create or replace function public.get_stale_key_bucket(p_id uuid)
returns text
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select case u.entity_type
    when 'media_asset' then 'project-media'
    when 'plan_catalog_item_version' then 'organization-catalog'
    when 'project_plan_version' then 'project-plans'
    when 'advance_receipt' then 'advance-receipts'
    else null
  end
  from public.private_object_stale_keys k
  join public.private_object_uploads u on u.id = k.private_object_upload_id
  where k.id = p_id;
$$;

-- ----------------------------------------------------------------------------
-- claim_upload_attempt / recover_media_upload_attempt / get_upload_status :
-- reprises à l'identique de M020 (correction de revue) ; SEULE la branche
-- advance_receipt est ajoutée (verrou avisoire -> adhésion -> ligne, compte
-- vérifié relu, créateur = déclarant détenant un rôle autorisé).
-- ----------------------------------------------------------------------------

create or replace function public.claim_upload_attempt(p_operation_uuid uuid, p_expected_attempt_id uuid default null)
returns public.upload_claim_result
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_entity_type text;
  v_peek_project_id uuid;
  v_row public.private_object_uploads;
  v_now timestamptz;
  v_authorized boolean;
  v_membership_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select entity_type, project_id into v_peek_entity_type, v_peek_project_id
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid;

  if v_peek_entity_type is null then
    raise exception 'not_authorized';
  end if;

  if v_peek_entity_type in ('project_plan_version', 'advance_receipt') then
    perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);

    select id into v_membership_id
    from public.project_memberships
    where project_id = v_peek_project_id
      and profile_id = v_uid
      and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    for update;

    if v_membership_id is null then
      raise exception 'not_authorized';
    end if;
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type <> v_peek_entity_type or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type = 'media_asset' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and role in ('CONTRACTOR', 'SITE_MANAGER')
    );
  elsif v_row.entity_type = 'plan_catalog_item_version' then
    v_authorized := exists (
      select 1 from public.organizations
      where id = v_row.organization_id
        and owner_profile_id = v_uid
        and archived_at is null
    );
  elsif v_row.entity_type = 'project_plan_version' then
    v_authorized := true; -- déjà revérifié ci-dessus, sous verrou adhésion.
    -- Compte vérifié relu APRÈS la dernière attente (verrou de la ligne),
    -- avant tout retour (y compris les rejeux) et toute mutation.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  elsif v_row.entity_type = 'advance_receipt' then
    v_authorized := true; -- adhésion revérifiée ci-dessus sous verrou ; créateur = déclarant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'not_authorized';
  end if;

  if p_expected_attempt_id is not null and v_row.attempt_id <> p_expected_attempt_id then
    raise exception 'attempt_changed';
  end if;

  if v_row.status <> 'PENDING' then
    return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
            v_row.expected_mime_type, v_row.attempt_id, v_row.status, false, v_row.organization_id)::public.upload_claim_result;
  end if;

  v_now := clock_timestamp();

  if v_row.attempt_expires_at <= v_now then
    raise exception 'attempt_expired';
  end if;

  if v_row.write_claimed_at is not null then
    return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
            v_row.expected_mime_type, v_row.attempt_id, v_row.status, false, v_row.organization_id)::public.upload_claim_result;
  end if;

  update public.private_object_uploads
  set write_claimed_at = v_now
  where id = v_row.id
    and write_claimed_at is null
  returning * into v_row;

  return (v_row.project_id, v_row.candidate_key, v_row.expected_checksum, v_row.expected_size_bytes,
          v_row.expected_mime_type, v_row.attempt_id, v_row.status, true, v_row.organization_id)::public.upload_claim_result;
end;
$$;

create or replace function public.recover_media_upload_attempt(p_operation_uuid uuid)
returns public.private_object_uploads
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_entity_type text;
  v_peek_project_id uuid;
  v_row public.private_object_uploads;
  v_now timestamptz;
  v_new_attempt uuid;
  v_new_candidate text;
  v_authorized boolean;
  v_path_prefix text;
  v_membership_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select entity_type, project_id into v_peek_entity_type, v_peek_project_id
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid;

  if v_peek_entity_type is null then
    raise exception 'not_authorized';
  end if;

  if v_peek_entity_type in ('project_plan_version', 'advance_receipt') then
    perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);

    select id into v_membership_id
    from public.project_memberships
    where project_id = v_peek_project_id
      and profile_id = v_uid
      and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    for update;

    if v_membership_id is null then
      raise exception 'operation_access_revoked';
    end if;
  end if;

  select * into v_row
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid
  for update;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type <> v_peek_entity_type or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type = 'media_asset' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and role in ('CONTRACTOR', 'SITE_MANAGER')
    );
    v_path_prefix := '_private/' || v_row.project_id::text || '/media_asset/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'plan_catalog_item_version' then
    v_authorized := exists (
      select 1 from public.organizations
      where id = v_row.organization_id
        and owner_profile_id = v_uid
        and archived_at is null
    );
    v_path_prefix := '_private/' || v_row.organization_id::text || '/plan_catalog_item_version/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'project_plan_version' then
    v_authorized := true; -- déjà revérifié ci-dessus, sous verrou adhésion.
    -- Même placement que claim_upload_attempt : après la dernière attente,
    -- avant le retour FINALIZED et avant toute nouvelle tentative.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/project_plan_version/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'advance_receipt' then
    v_authorized := true; -- adhésion revérifiée ci-dessus sous verrou ; créateur = déclarant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/advance_receipt/' || v_row.operation_uuid::text;
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'operation_access_revoked';
  end if;

  if v_row.status = 'FINALIZED' then
    return v_row;
  end if;

  if v_row.status = 'ABANDONED' then
    raise exception 'operation_abandoned';
  end if;

  v_now := clock_timestamp();

  if v_row.attempt_expires_at > v_now then
    return v_row;
  end if;

  if v_row.write_claimed_at is not null then
    insert into public.private_object_stale_keys (private_object_upload_id, storage_key, kind)
    values (v_row.id, v_row.candidate_key, 'candidate');
  end if;

  v_new_attempt := gen_random_uuid();
  v_new_candidate := v_path_prefix || '/candidates/' || v_new_attempt::text;

  update public.private_object_uploads
  set attempt_id = v_new_attempt,
      candidate_key = v_new_candidate,
      attempt_expires_at = v_now + interval '15 minutes',
      write_claimed_at = null,
      status = 'PENDING',
      storage_verified_attempt_id = null
  where id = v_row.id
  returning * into v_row;

  if v_row.entity_type = 'media_asset' then
    insert into public.audit_events (
      project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, reason
    ) values (
      v_row.project_id, 'HUMAN', v_uid, 'MEDIA_UPLOAD_ATTEMPT_ABANDONED', 'private_object_uploads', v_row.id, 'SUCCESS',
      'Tentative expirée abandonnée, nouvel attempt_id/candidate ouverts.'
    );
  end if;

  return v_row;
end;
$$;

create or replace function public.get_upload_status(p_operation_uuid uuid)
returns public.private_object_uploads
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_entity_type text;
  v_peek_project_id uuid;
  v_row public.private_object_uploads;
  v_authorized boolean;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select entity_type, project_id into v_peek_entity_type, v_peek_project_id
  from public.private_object_uploads
  where operation_uuid = p_operation_uuid;

  if v_peek_entity_type is null then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid;

  if not found or v_row.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  if v_row.entity_type = 'media_asset' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and role in ('CONTRACTOR', 'SITE_MANAGER')
    );
  elsif v_row.entity_type = 'plan_catalog_item_version' then
    v_authorized := exists (
      select 1 from public.organizations
      where id = v_row.organization_id
        and owner_profile_id = v_uid
        and archived_at is null
    );
  elsif v_row.entity_type = 'project_plan_version' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    );
    -- Aucune attente ici (lecture) : contrôlé avant le retour de la ligne.
    if v_authorized and public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  elsif v_row.entity_type = 'advance_receipt' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
    );
    if v_authorized and public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  else
    v_authorized := false;
  end if;

  if not v_authorized then
    raise exception 'operation_access_revoked';
  end if;

  return v_row;
end;
$$;

commit;
