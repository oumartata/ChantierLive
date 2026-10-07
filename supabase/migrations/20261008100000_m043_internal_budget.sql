-- M043 — finances internes, lot 1 : budget prévisionnel interne (B030 ;
-- PROPOSITION_D4_FINANCES_INTERNES.md ; décisions D090, D183, D184 F2 A,
-- D185 ; accord du fondateur 2026-10-07). Conception : MIGRATION_ORDER.csv
-- M012 (« budgets budget_versions »), T022/T023 ; identifiant M012 jamais
-- réutilisé comme nom de fichier.
--
-- - Un budget global par chantier, en FCFA, montant entier positif, analysé
--   comme les versements (advance_parse_amount, M014) ; versions en
--   insertion seule (BR045) ; la nouvelle version devient courante
--   immédiatement, motif obligatoire pour une révision, ancienne visible
--   (D185 G2 A) ; aucune approbation.
-- - Lecture et écriture : entreprise active seule, compte vérifié pour
--   écrire (D185 G1 A : ni chef de chantier, ni délégation).
-- - Confidentialité (D183) : propriétaire principal, copropriétaire, chef de
--   chantier, non-membre et ex-membre reçoivent le même refus
--   « not_authorized » qu'un inconnu ; tables sans aucun privilège ; aucune
--   fonction lisible par le propriétaire (synthèse financière M028, fiche,
--   étapes, journal, incidents, documents) ne lit ces tables.
-- - Distinct du montant contractuel (D085), des paiements reconnus et du
--   reste dû, et de l'enveloppe indicative partagée projects.budget (D143).

begin;

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects (id) on delete restrict,
  current_version_id uuid null,
  revision integer not null default 0 check (revision >= 0),
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  constraint budgets_id_project_unique unique (id, project_id)
);

create table public.budget_versions (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null,
  project_id uuid not null,
  version_number integer not null check (version_number >= 1),
  supersedes_version_id uuid null references public.budget_versions (id) on delete restrict,
  amount_fcfa bigint not null check (amount_fcfa > 0),
  reason text null,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  constraint budget_versions_budget_fk foreign key (budget_id, project_id) references public.budgets (id, project_id) on delete restrict,
  constraint budget_versions_number_unique unique (budget_id, version_number),
  constraint budget_versions_chain check ((version_number = 1) = (supersedes_version_id is null)),
  constraint budget_versions_reason_rule check (
    (version_number = 1 and (reason is null or char_length(btrim(reason)) between 3 and 1000))
    or (version_number > 1 and reason is not null and char_length(btrim(reason)) between 3 and 1000)
  )
);

alter table public.budgets add constraint budgets_current_version_fk
  foreign key (current_version_id) references public.budget_versions (id) on delete restrict;

alter table public.budgets enable row level security;
alter table public.budget_versions enable row level security;
revoke all privileges on table public.budgets from public, anon, authenticated;
revoke all privileges on table public.budget_versions from public, anon, authenticated;

create function public.reject_budget_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'budget_version_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.budget_versions
for each row execute function public.reject_budget_version_mutation();

create function public.guard_budget_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'budget_immutable';
  end if;
  if new.id <> old.id or new.project_id <> old.project_id or new.created_at_server <> old.created_at_server then
    raise exception 'budget_immutable';
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

create trigger guard_mutation before update or delete on public.budgets
for each row execute function public.guard_budget_mutation();

revoke execute on function public.reject_budget_version_mutation(), public.guard_budget_mutation()
  from public, anon, authenticated, service_role;

-- Entreprise active seule (D185 G1 A) ; tout autre appelant : not_authorized.
create function public.budget_require_contractor(p_project_id uuid, p_for_write boolean)
returns uuid
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  ) then
    raise exception 'not_authorized';
  end if;
  if p_for_write and public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke execute on function public.budget_require_contractor(uuid, boolean) from public, anon, authenticated, service_role;

-- Déclaration (version 1) ou révision directe (motif obligatoire).
create function public.set_internal_budget(p_project_id uuid, p_amount_fcfa text, p_reason text, p_expected_revision integer)
returns public.budget_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := public.budget_require_contractor(p_project_id, true);
  v_amount bigint := public.advance_parse_amount(p_amount_fcfa);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_budget public.budgets;
  v_current public.budget_versions;
  v_row public.budget_versions;
begin
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);
  select * into v_budget from public.budgets where project_id = p_project_id for update;
  if not found then
    if p_expected_revision is distinct from 0 then
      raise exception 'revision_conflict';
    end if;
    if v_reason is not null and char_length(v_reason) < 3 then
      raise exception 'reason_required';
    end if;
    insert into public.budgets (project_id) values (p_project_id) returning * into v_budget;
  else
    if p_expected_revision is null or p_expected_revision <> v_budget.revision then
      raise exception 'revision_conflict';
    end if;
    if v_reason is null or char_length(v_reason) < 3 then
      raise exception 'reason_required';
    end if;
    select * into v_current from public.budget_versions where id = v_budget.current_version_id;
    if v_current.amount_fcfa = v_amount then
      raise exception 'no_change';
    end if;
  end if;

  insert into public.budget_versions (budget_id, project_id, version_number, supersedes_version_id, amount_fcfa, reason, created_by_profile_id, created_at_server)
  values (v_budget.id, p_project_id, coalesce(v_current.version_number, 0) + 1, v_current.id, v_amount, v_reason, v_uid, clock_timestamp())
  returning * into v_row;
  update public.budgets set current_version_id = v_row.id, revision = revision + 1 where id = v_budget.id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', v_uid, case when v_current.id is null then 'INTERNAL_BUDGET_SET' else 'INTERNAL_BUDGET_REVISED' end,
          'budget_versions', v_row.id, 'SUCCESS', jsonb_build_object('version_number', v_row.version_number),
          coalesce(v_reason, 'Budget interne déclaré.'));
  return v_row;
end;
$$;

create type public.internal_budget_view as (
  budget_id uuid,
  revision integer,
  current_version_number integer,
  amount_fcfa bigint,
  reason text,
  updated_at_server timestamptz
);

create function public.get_internal_budget(p_project_id uuid)
returns public.internal_budget_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_result public.internal_budget_view;
begin
  perform public.budget_require_contractor(p_project_id, false);
  select b.id, b.revision, v.version_number, v.amount_fcfa, v.reason, v.created_at_server
    into v_result
  from public.budgets b
  join public.budget_versions v on v.id = b.current_version_id
  where b.project_id = p_project_id;
  return v_result;
end;
$$;

create type public.internal_budget_version_view as (
  version_number integer,
  amount_fcfa bigint,
  reason text,
  author_is_me boolean,
  created_at_server timestamptz,
  is_current boolean
);

create function public.list_internal_budget_versions(p_project_id uuid)
returns setof public.internal_budget_version_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := public.budget_require_contractor(p_project_id, false);
begin
  return query
    select v.version_number, v.amount_fcfa, v.reason, v.created_by_profile_id = v_uid, v.created_at_server, v.id = b.current_version_id
    from public.budget_versions v
    join public.budgets b on b.id = v.budget_id
    where v.project_id = p_project_id
    order by v.version_number desc;
end;
$$;

revoke execute on function public.set_internal_budget(uuid, text, text, integer), public.get_internal_budget(uuid),
  public.list_internal_budget_versions(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_internal_budget(uuid, text, text, integer), public.get_internal_budget(uuid),
  public.list_internal_budget_versions(uuid)
  to authenticated;

commit;
