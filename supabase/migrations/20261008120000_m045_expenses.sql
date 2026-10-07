-- M045 — finances internes, lot 2 : dépenses (B031, avec les décisions de
-- B034 et la contre-écriture de B035 demandées par la boucle 24b ;
-- PROPOSITION_D4_FINANCES_INTERNES.md ; décisions D183, D184 F1/F3/F4/F7/
-- F8/F10, D185, D186, D187 ; accord du fondateur 2026-10-07). Conception :
-- MIGRATION_ORDER.csv M013 (« expenses versions receipts », sans les reçus,
-- lot suivant), T024–T026 ; identifiant M013 jamais réutilisé.
--
-- - Brouillon (D187 H1) : contenu sur expenses, visible par son auteur seul
--   (entreprise ou chef de chantier actif, compte vérifié).
-- - Soumission (D184 F3/F4) : le chef de chantier soumet (SOUMISE) ;
--   l'entreprise approuve ou refuse avec motif, sur la version exacte ; une
--   dépense de l'entreprise est publiée APPROUVEE directement. Refus
--   définitif (H4). Contestation : entreprise seule, motif (F4).
-- - Correction et annulation (F7, H5) : entreprise seule, seulement une
--   dépense approuvée ou contestée ; correction = nouvelle version liée
--   (l'ancienne reste consultable et sort des totaux), annulation =
--   écriture d'annulation motivée.
-- - Totaux (BR046, H2) : calculés à la lecture ; engagé = approuvées +
--   contestées (version courante) ; en attente = soumises ; refusées,
--   annulées et versions remplacées exclues.
-- - Alerte de dépassement (F8, BR052, H2) : entreprise seule ; chef de
--   chantier jamais le budget ni l'alerte (D185, H3).
-- - Étape (F10, D182) : lien facultatif vers une étape active d'un plan
--   publié du même chantier ; jamais lu par une fonction propriétaire.
-- - Confidentialité (D183) : propriétaire principal, copropriétaire,
--   non-membre, ex-membre : « not_authorized » partout ; tables sans aucun
--   privilège ; audit lisible par l'entreprise seule (D186).
-- - Montants : FCFA, entiers, positifs (advance_parse_amount, M014).

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_by_role text not null check (created_by_role in ('CONTRACTOR', 'SITE_MANAGER')),
  status text not null default 'BROUILLON',
  -- Contenu du brouillon (D187 H1, même principe que D148).
  draft_amount_fcfa bigint null check (draft_amount_fcfa is null or draft_amount_fcfa > 0),
  draft_expense_date date null,
  draft_category text null,
  draft_supplier text null,
  draft_note text null,
  draft_phase_id uuid null,
  current_version_id uuid null,
  revision integer not null default 0 check (revision >= 0),
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  submitted_at_server timestamptz null,
  constraint expenses_id_project_unique unique (id, project_id),
  constraint expenses_status_known check (status in ('BROUILLON', 'SOUMISE', 'APPROUVEE', 'REFUSEE', 'CONTESTEE', 'ANNULEE')),
  constraint expenses_category_known check (draft_category is null or draft_category in ('MATERIAUX', 'MAIN_OEUVRE', 'TRANSPORT', 'LOCATION_MATERIEL', 'SOUS_TRAITANCE', 'FRAIS_DIVERS', 'AUTRE')),
  constraint expenses_text_bounds check (coalesce(char_length(draft_supplier), 0) <= 200 and coalesce(char_length(draft_note), 0) <= 1000),
  constraint expenses_draft_phase_same_project foreign key (draft_phase_id, project_id) references public.project_phases (id, project_id) on delete restrict
);

create index expenses_project_idx on public.expenses (project_id, created_at_server desc);

create table public.expense_versions (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null,
  project_id uuid not null,
  version_number integer not null check (version_number >= 1),
  supersedes_version_id uuid null references public.expense_versions (id) on delete restrict,
  amount_fcfa bigint not null check (amount_fcfa > 0),
  expense_date date not null,
  category text not null check (category in ('MATERIAUX', 'MAIN_OEUVRE', 'TRANSPORT', 'LOCATION_MATERIEL', 'SOUS_TRAITANCE', 'FRAIS_DIVERS', 'AUTRE')),
  supplier text null check (supplier is null or char_length(supplier) <= 200),
  note text null check (note is null or char_length(note) <= 1000),
  phase_id uuid null,
  reason text null check (reason is null or char_length(btrim(reason)) between 3 and 1000),
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_by_role text not null check (created_by_role in ('CONTRACTOR', 'SITE_MANAGER')),
  created_at_server timestamptz not null default now(),
  constraint expense_versions_expense_fk foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict,
  constraint expense_versions_phase_same_project foreign key (phase_id, project_id) references public.project_phases (id, project_id) on delete restrict,
  constraint expense_versions_number_unique unique (expense_id, version_number),
  constraint expense_versions_chain check ((version_number = 1) = (supersedes_version_id is null)),
  constraint expense_versions_reason_rule check (version_number = 1 or reason is not null)
);

alter table public.expenses add constraint expenses_current_version_fk
  foreign key (current_version_id) references public.expense_versions (id) on delete restrict;

create table public.expense_decisions (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null,
  project_id uuid not null,
  version_id uuid not null references public.expense_versions (id) on delete restrict,
  decision text not null check (decision in ('SOUMISE', 'APPROUVEE', 'REFUSEE', 'CONTESTEE', 'CORRIGEE', 'ANNULEE')),
  reason text null check (reason is null or char_length(btrim(reason)) between 3 and 1000),
  decided_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  decided_by_role text not null check (decided_by_role in ('CONTRACTOR', 'SITE_MANAGER')),
  created_at_server timestamptz not null default now(),
  constraint expense_decisions_expense_fk foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict,
  constraint expense_decisions_reason_rule check (decision not in ('REFUSEE', 'CONTESTEE', 'CORRIGEE', 'ANNULEE') or reason is not null)
);

create index expense_decisions_expense_idx on public.expense_decisions (expense_id, created_at_server);

alter table public.expenses enable row level security;
alter table public.expense_versions enable row level security;
alter table public.expense_decisions enable row level security;
revoke all privileges on table public.expenses from public, anon, authenticated;
revoke all privileges on table public.expense_versions from public, anon, authenticated;
revoke all privileges on table public.expense_decisions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Gardes : versions et décisions immuables ; dépense jamais supprimée,
--    identité figée, brouillon figé dès la soumission, transitions de la
--    machine d'états seulement (même pour service_role).
-- ---------------------------------------------------------------------------
create function public.reject_expense_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'expense_record_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.expense_versions
for each row execute function public.reject_expense_record_mutation();
create trigger reject_mutation before update or delete on public.expense_decisions
for each row execute function public.reject_expense_record_mutation();

create function public.guard_expense_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'expense_immutable';
  end if;
  if new.id <> old.id or new.project_id <> old.project_id or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_by_role <> old.created_by_role or new.created_at_server <> old.created_at_server then
    raise exception 'expense_immutable';
  end if;
  if old.status in ('REFUSEE', 'ANNULEE') then
    raise exception 'expense_terminal';
  end if;
  if old.status <> 'BROUILLON' and (
       new.draft_amount_fcfa is distinct from old.draft_amount_fcfa or new.draft_expense_date is distinct from old.draft_expense_date
       or new.draft_category is distinct from old.draft_category or new.draft_supplier is distinct from old.draft_supplier
       or new.draft_note is distinct from old.draft_note or new.draft_phase_id is distinct from old.draft_phase_id) then
    raise exception 'expense_immutable';
  end if;
  if new.status <> old.status and (old.status, new.status) not in (
       ('BROUILLON', 'SOUMISE'), ('BROUILLON', 'APPROUVEE'), ('SOUMISE', 'APPROUVEE'), ('SOUMISE', 'REFUSEE'),
       ('APPROUVEE', 'CONTESTEE'), ('CONTESTEE', 'APPROUVEE'), ('APPROUVEE', 'ANNULEE'), ('CONTESTEE', 'ANNULEE')) then
    raise exception 'invalid_transition';
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

create trigger guard_mutation before update or delete on public.expenses
for each row execute function public.guard_expense_mutation();

revoke execute on function public.reject_expense_record_mutation(), public.guard_expense_mutation()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Contrôles communs (toujours vrai/faux ou refus).
-- ---------------------------------------------------------------------------
-- Rôle interne de l'appelant : CONTRACTOR ou SITE_MANAGER actif ; sinon
-- not_authorized (propriétaire, copropriétaire, non-membre, ex-membre).
create function public.expense_member_role(p_project_id uuid, p_for_write boolean)
returns text
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select m.role::text into v_role
  from public.project_memberships m
  where m.project_id = p_project_id and m.profile_id = v_uid and m.revoked_at is null
    and m.role in ('CONTRACTOR', 'SITE_MANAGER')
  limit 1;
  if v_role is null then
    raise exception 'not_authorized';
  end if;
  if p_for_write and public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

-- Lecture d'une dépense : brouillon par son auteur seul (H1), sinon tout
-- rôle interne (H3).
create function public.expense_visible(p_expense public.expenses, p_uid uuid)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(p_expense.status <> 'BROUILLON' or p_expense.created_by_profile_id = p_uid, false);
$$;

-- Verrou, révision attendue, visibilité.
create function public.expense_lock(p_expense_id uuid, p_expected_revision integer)
returns public.expenses
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_project uuid;
  v_exp public.expenses;
begin
  select project_id into v_project from public.expenses where id = p_expense_id;
  if v_project is null then
    raise exception 'not_authorized';
  end if;
  perform public.expense_member_role(v_project, true);
  select * into v_exp from public.expenses where id = p_expense_id for update;
  if public.expense_visible(v_exp, auth.uid()) is not true then
    raise exception 'not_authorized';
  end if;
  if p_expected_revision is null or p_expected_revision <> v_exp.revision then
    raise exception 'revision_conflict';
  end if;
  return v_exp;
end;
$$;

revoke execute on function public.expense_member_role(uuid, boolean), public.expense_visible(public.expenses, uuid),
  public.expense_lock(uuid, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Brouillon (H1).
-- ---------------------------------------------------------------------------
create function public.save_expense_draft(
  p_project_id uuid,
  p_expense_id uuid,
  p_expected_revision integer,
  p_amount_fcfa text,
  p_expense_date date,
  p_category text,
  p_supplier text,
  p_note text,
  p_phase_id uuid
)
returns public.expenses
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.expense_member_role(p_project_id, true);
  v_amount bigint := public.advance_parse_amount(p_amount_fcfa);
  v_row public.expenses;
begin
  if p_expense_date is null then
    raise exception 'expense_date_required';
  end if;
  if p_category is null or p_category not in ('MATERIAUX', 'MAIN_OEUVRE', 'TRANSPORT', 'LOCATION_MATERIEL', 'SOUS_TRAITANCE', 'FRAIS_DIVERS', 'AUTRE') then
    raise exception 'category_invalid';
  end if;
  perform public.phase_link_check(p_project_id, p_phase_id);
  if p_expense_id is null then
    insert into public.expenses (project_id, created_by_profile_id, created_by_role, draft_amount_fcfa, draft_expense_date,
                                 draft_category, draft_supplier, draft_note, draft_phase_id)
    values (p_project_id, v_uid, v_role, v_amount, p_expense_date, p_category, nullif(btrim(coalesce(p_supplier, '')), ''),
            nullif(btrim(coalesce(p_note, '')), ''), p_phase_id)
    returning * into v_row;
  else
    select * into v_row from public.expenses where id = p_expense_id and project_id = p_project_id for update;
    if not found or v_row.created_by_profile_id <> v_uid or v_row.status <> 'BROUILLON' then
      raise exception 'not_authorized';
    end if;
    if p_expected_revision is null or p_expected_revision <> v_row.revision then
      raise exception 'revision_conflict';
    end if;
    update public.expenses
    set draft_amount_fcfa = v_amount, draft_expense_date = p_expense_date, draft_category = p_category,
        draft_supplier = nullif(btrim(coalesce(p_supplier, '')), ''), draft_note = nullif(btrim(coalesce(p_note, '')), ''),
        draft_phase_id = p_phase_id, revision = revision + 1
    where id = v_row.id
    returning * into v_row;
  end if;
  return v_row;
exception
  when check_violation then raise exception 'expense_invalid';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Soumission / publication (F3, F4) : version 1 créée.
-- ---------------------------------------------------------------------------
create function public.submit_expense(p_expense_id uuid, p_expected_revision integer)
returns public.expenses
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_exp public.expenses;
  v_version public.expense_versions;
  v_status text;
begin
  v_exp := public.expense_lock(p_expense_id, p_expected_revision);
  v_role := public.expense_member_role(v_exp.project_id, true);
  if v_exp.status <> 'BROUILLON' or v_exp.created_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;
  perform public.phase_link_check(v_exp.project_id, v_exp.draft_phase_id);
  insert into public.expense_versions (expense_id, project_id, version_number, amount_fcfa, expense_date, category, supplier, note, phase_id,
                                       created_by_profile_id, created_by_role)
  values (v_exp.id, v_exp.project_id, 1, v_exp.draft_amount_fcfa, v_exp.draft_expense_date, v_exp.draft_category, v_exp.draft_supplier,
          v_exp.draft_note, v_exp.draft_phase_id, v_uid, v_role)
  returning * into v_version;
  -- Entreprise : approuvée directement ; chef de chantier : soumise (F4).
  v_status := case when v_role = 'CONTRACTOR' then 'APPROUVEE' else 'SOUMISE' end;
  update public.expenses
  set status = v_status, current_version_id = v_version.id, submitted_at_server = clock_timestamp(), revision = revision + 1
  where id = v_exp.id
  returning * into v_exp;
  insert into public.expense_decisions (expense_id, project_id, version_id, decision, decided_by_profile_id, decided_by_role)
  values (v_exp.id, v_exp.project_id, v_version.id, v_status, v_uid, v_role);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_exp.project_id, 'HUMAN', v_uid, case when v_status = 'APPROUVEE' then 'EXPENSE_PUBLISHED_APPROVED' else 'EXPENSE_SUBMITTED' end,
          'expense_versions', v_version.id, 'SUCCESS', jsonb_build_object('expense_id', v_exp.id), 'Dépense interne enregistrée.');
  return v_exp;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Décision, contestation, correction, annulation (entreprise seule).
-- ---------------------------------------------------------------------------
create function public.decide_expense(p_expense_id uuid, p_expected_revision integer, p_decision text, p_reason text)
returns public.expenses
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_exp public.expenses;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_exp := public.expense_lock(p_expense_id, p_expected_revision);
  v_role := public.expense_member_role(v_exp.project_id, true);
  if v_role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if p_decision is null or p_decision not in ('APPROUVEE', 'REFUSEE', 'CONTESTEE') then
    raise exception 'decision_invalid';
  end if;
  if (p_decision in ('APPROUVEE', 'REFUSEE') and v_exp.status <> 'SOUMISE') or (p_decision = 'CONTESTEE' and v_exp.status <> 'APPROUVEE') then
    raise exception 'invalid_transition';
  end if;
  if p_decision in ('REFUSEE', 'CONTESTEE') and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'reason_required';
  end if;
  update public.expenses set status = p_decision, revision = revision + 1 where id = v_exp.id returning * into v_exp;
  insert into public.expense_decisions (expense_id, project_id, version_id, decision, reason, decided_by_profile_id, decided_by_role)
  values (v_exp.id, v_exp.project_id, v_exp.current_version_id, p_decision, v_reason, v_uid, v_role);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_exp.project_id, 'HUMAN', v_uid, 'EXPENSE_' || p_decision, 'expense_versions', v_exp.current_version_id, 'SUCCESS',
          jsonb_build_object('expense_id', v_exp.id), coalesce(v_reason, 'Dépense approuvée par l''entreprise.'));
  return v_exp;
end;
$$;

create function public.correct_expense(
  p_expense_id uuid,
  p_expected_revision integer,
  p_reason text,
  p_amount_fcfa text,
  p_expense_date date,
  p_category text,
  p_supplier text,
  p_note text,
  p_phase_id uuid
)
returns public.expense_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_exp public.expenses;
  v_prev public.expense_versions;
  v_row public.expense_versions;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_amount bigint;
begin
  v_exp := public.expense_lock(p_expense_id, p_expected_revision);
  v_role := public.expense_member_role(v_exp.project_id, true);
  if v_role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if v_exp.status not in ('APPROUVEE', 'CONTESTEE') then
    raise exception 'invalid_transition';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  v_amount := public.advance_parse_amount(p_amount_fcfa);
  if p_expense_date is null then
    raise exception 'expense_date_required';
  end if;
  if p_category is null or p_category not in ('MATERIAUX', 'MAIN_OEUVRE', 'TRANSPORT', 'LOCATION_MATERIEL', 'SOUS_TRAITANCE', 'FRAIS_DIVERS', 'AUTRE') then
    raise exception 'category_invalid';
  end if;
  select * into v_prev from public.expense_versions where id = v_exp.current_version_id;
  if p_phase_id is distinct from v_prev.phase_id then
    perform public.phase_link_check(v_exp.project_id, p_phase_id);
  end if;
  if v_amount = v_prev.amount_fcfa and p_expense_date = v_prev.expense_date and p_category = v_prev.category
     and nullif(btrim(coalesce(p_supplier, '')), '') is not distinct from v_prev.supplier
     and nullif(btrim(coalesce(p_note, '')), '') is not distinct from v_prev.note
     and p_phase_id is not distinct from v_prev.phase_id then
    raise exception 'no_change';
  end if;
  begin
    insert into public.expense_versions (expense_id, project_id, version_number, supersedes_version_id, amount_fcfa, expense_date, category,
                                         supplier, note, phase_id, reason, created_by_profile_id, created_by_role)
    values (v_exp.id, v_exp.project_id, v_prev.version_number + 1, v_prev.id, v_amount, p_expense_date, p_category,
            nullif(btrim(coalesce(p_supplier, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), p_phase_id, v_reason, v_uid, v_role)
    returning * into v_row;
  exception
    when check_violation then raise exception 'expense_invalid';
  end;
  update public.expenses set status = 'APPROUVEE', current_version_id = v_row.id, revision = revision + 1 where id = v_exp.id;
  insert into public.expense_decisions (expense_id, project_id, version_id, decision, reason, decided_by_profile_id, decided_by_role)
  values (v_exp.id, v_exp.project_id, v_row.id, 'CORRIGEE', v_reason, v_uid, v_role);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_exp.project_id, 'HUMAN', v_uid, 'EXPENSE_CORRECTED', 'expense_versions', v_row.id, 'SUCCESS',
          jsonb_build_object('expense_id', v_exp.id, 'supersedes_version_id', v_prev.id), v_reason);
  return v_row;
end;
$$;

create function public.cancel_expense(p_expense_id uuid, p_expected_revision integer, p_reason text)
returns public.expenses
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_exp public.expenses;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_exp := public.expense_lock(p_expense_id, p_expected_revision);
  v_role := public.expense_member_role(v_exp.project_id, true);
  if v_role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if v_exp.status not in ('APPROUVEE', 'CONTESTEE') then
    raise exception 'invalid_transition';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  update public.expenses set status = 'ANNULEE', revision = revision + 1 where id = v_exp.id returning * into v_exp;
  insert into public.expense_decisions (expense_id, project_id, version_id, decision, reason, decided_by_profile_id, decided_by_role)
  values (v_exp.id, v_exp.project_id, v_exp.current_version_id, 'ANNULEE', v_reason, v_uid, v_role);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_exp.project_id, 'HUMAN', v_uid, 'EXPENSE_CANCELLED', 'expenses', v_exp.id, 'SUCCESS', '{}'::jsonb, v_reason);
  return v_exp;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lecture (H1, H3) ; totaux (H2) ; alerte (F8, entreprise seule).
-- ---------------------------------------------------------------------------
create type public.expense_view as (
  id uuid,
  status text,
  created_by_role text,
  author_is_me boolean,
  revision integer,
  amount_fcfa bigint,
  expense_date date,
  category text,
  supplier text,
  note text,
  phase_id uuid,
  phase_label text,
  version_number integer,
  created_at_server timestamptz,
  submitted_at_server timestamptz,
  last_reason text,
  can_edit_draft boolean,
  can_submit boolean,
  can_decide boolean,
  can_dispute boolean,
  can_correct boolean,
  can_cancel boolean
);

create function public.list_project_expenses(p_project_id uuid)
returns setof public.expense_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.expense_member_role(p_project_id, false);
begin
  return query
    select e.id, e.status, e.created_by_role, e.created_by_profile_id = v_uid, e.revision,
           coalesce(v.amount_fcfa, e.draft_amount_fcfa), coalesce(v.expense_date, e.draft_expense_date), coalesce(v.category, e.draft_category),
           case when v.id is null then e.draft_supplier else v.supplier end,
           case when v.id is null then e.draft_note else v.note end,
           case when v.id is null then e.draft_phase_id else v.phase_id end,
           ph.label, v.version_number, e.created_at_server, e.submitted_at_server,
           (select d.reason from public.expense_decisions d where d.expense_id = e.id order by d.created_at_server desc, d.id desc limit 1),
           e.status = 'BROUILLON' and e.created_by_profile_id = v_uid,
           e.status = 'BROUILLON' and e.created_by_profile_id = v_uid,
           v_role = 'CONTRACTOR' and e.status = 'SOUMISE',
           v_role = 'CONTRACTOR' and e.status = 'APPROUVEE',
           v_role = 'CONTRACTOR' and e.status in ('APPROUVEE', 'CONTESTEE'),
           v_role = 'CONTRACTOR' and e.status in ('APPROUVEE', 'CONTESTEE')
    from public.expenses e
    left join public.expense_versions v on v.id = e.current_version_id
    left join public.project_phases ph on ph.id = case when v.id is null then e.draft_phase_id else v.phase_id end
    where e.project_id = p_project_id and public.expense_visible(e, v_uid)
    order by (e.status = 'BROUILLON') desc, coalesce(v.expense_date, e.draft_expense_date) desc, e.created_at_server desc;
end;
$$;

create function public.get_expense_history(p_expense_id uuid)
returns table (kind text, version_number integer, amount_fcfa bigint, expense_date date, category text, supplier text, note text,
               phase_id uuid, reason text, actor_role text, author_is_me boolean, created_at_server timestamptz)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_exp public.expenses;
begin
  select * into v_exp from public.expenses where id = p_expense_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  perform public.expense_member_role(v_exp.project_id, false);
  if public.expense_visible(v_exp, v_uid) is not true then
    raise exception 'not_authorized';
  end if;
  return query
    select 'VERSION'::text, v.version_number, v.amount_fcfa, v.expense_date, v.category, v.supplier, v.note, v.phase_id, v.reason,
           v.created_by_role, v.created_by_profile_id = v_uid, v.created_at_server
    from public.expense_versions v where v.expense_id = p_expense_id
    union all
    select 'DECISION:' || d.decision, ver.version_number, null::bigint, null::date, null::text, null::text, null::text, null::uuid, d.reason,
           d.decided_by_role, d.decided_by_profile_id = v_uid, d.created_at_server
    from public.expense_decisions d join public.expense_versions ver on ver.id = d.version_id
    where d.expense_id = p_expense_id
    order by 12, 1;
end;
$$;

create type public.expense_totals_view as (
  engaged_fcfa bigint,
  pending_fcfa bigint,
  engaged_count integer,
  pending_count integer,
  refused_count integer,
  cancelled_count integer,
  by_category jsonb
);

-- Totaux (H2) : version courante des dépenses approuvées et contestées ;
-- soumises à part ; rien d'autre.
create function public.get_expense_totals(p_project_id uuid)
returns public.expense_totals_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_result public.expense_totals_view;
begin
  perform public.expense_member_role(p_project_id, false);
  select coalesce(sum(v.amount_fcfa) filter (where e.status in ('APPROUVEE', 'CONTESTEE')), 0)::bigint,
         coalesce(sum(v.amount_fcfa) filter (where e.status = 'SOUMISE'), 0)::bigint,
         (count(*) filter (where e.status in ('APPROUVEE', 'CONTESTEE')))::integer,
         (count(*) filter (where e.status = 'SOUMISE'))::integer,
         (count(*) filter (where e.status = 'REFUSEE'))::integer,
         (count(*) filter (where e.status = 'ANNULEE'))::integer
    into v_result.engaged_fcfa, v_result.pending_fcfa, v_result.engaged_count, v_result.pending_count, v_result.refused_count, v_result.cancelled_count
  from public.expenses e
  join public.expense_versions v on v.id = e.current_version_id
  where e.project_id = p_project_id;
  select coalesce(jsonb_object_agg(category, total), '{}'::jsonb) into v_result.by_category
  from (
    select v.category, sum(v.amount_fcfa)::bigint as total
    from public.expenses e join public.expense_versions v on v.id = e.current_version_id
    where e.project_id = p_project_id and e.status in ('APPROUVEE', 'CONTESTEE')
    group by v.category
  ) t;
  return v_result;
end;
$$;

create type public.expense_budget_alert_view as (
  has_budget boolean,
  budget_fcfa bigint,
  engaged_fcfa bigint,
  over_budget boolean,
  overrun_fcfa bigint
);

-- Alerte de dépassement : entreprise seule (D185 : jamais le chef de
-- chantier) ; informe sans bloquer (BR052).
create function public.get_expense_budget_alert(p_project_id uuid)
returns public.expense_budget_alert_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_result public.expense_budget_alert_view;
begin
  perform public.budget_require_contractor(p_project_id, false);
  select v.amount_fcfa into v_result.budget_fcfa
  from public.budgets b join public.budget_versions v on v.id = b.current_version_id where b.project_id = p_project_id;
  v_result.has_budget := v_result.budget_fcfa is not null;
  select coalesce(sum(v.amount_fcfa), 0)::bigint into v_result.engaged_fcfa
  from public.expenses e join public.expense_versions v on v.id = e.current_version_id
  where e.project_id = p_project_id and e.status in ('APPROUVEE', 'CONTESTEE');
  v_result.over_budget := coalesce(v_result.has_budget and v_result.engaged_fcfa > v_result.budget_fcfa, false);
  v_result.overrun_fcfa := case when v_result.over_budget then v_result.engaged_fcfa - v_result.budget_fcfa else 0 end;
  return v_result;
end;
$$;

revoke execute on function public.save_expense_draft(uuid, uuid, integer, text, date, text, text, text, uuid),
  public.submit_expense(uuid, integer), public.decide_expense(uuid, integer, text, text),
  public.correct_expense(uuid, integer, text, text, date, text, text, text, uuid), public.cancel_expense(uuid, integer, text),
  public.list_project_expenses(uuid), public.get_expense_history(uuid), public.get_expense_totals(uuid), public.get_expense_budget_alert(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_expense_draft(uuid, uuid, integer, text, date, text, text, text, uuid),
  public.submit_expense(uuid, integer), public.decide_expense(uuid, integer, text, text),
  public.correct_expense(uuid, integer, text, text, date, text, text, text, uuid), public.cancel_expense(uuid, integer, text),
  public.list_project_expenses(uuid), public.get_expense_history(uuid), public.get_expense_totals(uuid), public.get_expense_budget_alert(uuid)
  to authenticated;

commit;
