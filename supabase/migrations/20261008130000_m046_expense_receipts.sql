-- M046 — finances internes, lot 3 : reçus des dépenses (B032, done_when :
-- « absence et justification gérées » ; PROPOSITION_D4_FINANCES_INTERNES.md
-- §3 et §6 ; décisions D183, D184 F5 C et F6 A, D186, D187 ; accord du
-- fondateur 2026-10-07). Conception : MIGRATION_ORDER.csv M013 (reçus),
-- T027, BR048, FR073, AC073.
--
-- - Compartiment privé dédié expense-receipts (F6 A) : aucune politique
--   d'accès direct ; PDF/JPEG/PNG/WebP de 10 Mo au plus ; type réel attesté
--   par le serveur sur les octets relus (attest_storage_verified, M010),
--   comme M039 ; aucun antivirus (D176).
-- - Reçu facultatif (BR048), lié à la dépense et à la version en vigueur au
--   dépôt (aucune pour un brouillon) ; insertion seule ; retrait motivé,
--   visible dans la liste ; le fichier d'un reçu retiré n'est plus délivré.
-- - Joindre : brouillon -> son auteur seul (H1) ; soumise, approuvée ou
--   contestée -> l'entreprise, ou le chef de chantier pour ses propres
--   dépenses ; refusée ou annulée -> personne.
-- - Lire : ceux qui voient la dépense (entreprise, chef de chantier ; H1
--   pour les brouillons). Propriétaire, copropriétaire, ex-membre,
--   non-membre : « not_authorized » partout (D183).
-- - Justification d'un reçu absent (F5 C) : réglage par chantier, désactivé
--   par défaut, modifié par l'entreprise seule ; s'il est actif, l'envoi
--   (soumission ou publication) et la correction exigent un reçu actif ou
--   une justification écrite ; le retrait du dernier reçu d'une dépense
--   envoyée sans justification est alors refusé. Non rétroactif.
-- - Circuit d'envoi générique (M026) : nouveau type d'entité
--   expense_receipt ; claim/recover/get_upload_status/get_stale_key_bucket
--   repris à l'identique de M039, seule la branche expense_receipt est
--   ajoutée.

begin;

-- ---------------------------------------------------------------------------
-- 1. Stockage : type d'entité et compartiment privé.
-- ---------------------------------------------------------------------------
alter table public.private_object_uploads drop constraint private_object_uploads_entity_type_known;
alter table public.private_object_uploads add constraint private_object_uploads_entity_type_known
  check (entity_type in ('media_asset', 'plan_catalog_item_version', 'project_plan_version', 'advance_receipt', 'document_version', 'expense_receipt'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expense-receipts', 'expense-receipts', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

-- ---------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------
-- Réglage F5 C : une ligne par chantier, absente = désactivé.
create table public.project_expense_settings (
  project_id uuid primary key references public.projects (id) on delete restrict,
  require_no_receipt_justification boolean not null default false,
  revision integer not null default 0 check (revision >= 0),
  updated_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  updated_at_server timestamptz not null default now()
);

create table public.expense_receipts (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null,
  project_id uuid not null,
  attached_to_version_id uuid null references public.expense_versions (id) on delete restrict,
  private_object_upload_id uuid not null,
  mime_type text not null,
  file_size_bytes bigint not null check (file_size_bytes > 0),
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_by_role text not null check (created_by_role in ('CONTRACTOR', 'SITE_MANAGER')),
  created_at_server timestamptz not null default now(),
  withdrawn_at_server timestamptz null,
  withdrawn_by_profile_id uuid null references public.profiles (id) on delete restrict,
  withdrawn_by_role text null check (withdrawn_by_role is null or withdrawn_by_role in ('CONTRACTOR', 'SITE_MANAGER')),
  withdraw_reason text null check (withdraw_reason is null or char_length(btrim(withdraw_reason)) between 3 and 1000),
  constraint expense_receipts_expense_fk foreign key (expense_id, project_id) references public.expenses (id, project_id) on delete restrict,
  constraint expense_receipts_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id) on delete restrict,
  constraint expense_receipts_upload_unique unique (private_object_upload_id),
  constraint expense_receipts_withdraw_consistency check (
    (withdrawn_at_server is null) = (withdrawn_by_profile_id is null)
    and (withdrawn_at_server is null) = (withdrawn_by_role is null)
    and (withdrawn_at_server is null) = (withdraw_reason is null)
  )
);

create index expense_receipts_expense_idx on public.expense_receipts (expense_id, created_at_server);

-- Cible d'un envoi : la dépense, figée à la préparation.
create table public.expense_receipt_upload_targets (
  private_object_upload_id uuid primary key,
  project_id uuid not null,
  expense_id uuid not null,
  constraint expense_receipt_upload_targets_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id) on delete restrict,
  constraint expense_receipt_upload_targets_expense_fk foreign key (expense_id, project_id)
    references public.expenses (id, project_id) on delete restrict
);

-- Justification d'un reçu absent : brouillon, puis figée dans la version.
alter table public.expenses add column draft_no_receipt_reason text null
  check (draft_no_receipt_reason is null or char_length(btrim(draft_no_receipt_reason)) between 3 and 1000);
alter table public.expense_versions add column no_receipt_reason text null
  check (no_receipt_reason is null or char_length(btrim(no_receipt_reason)) between 3 and 1000);

alter table public.project_expense_settings enable row level security;
alter table public.expense_receipts enable row level security;
alter table public.expense_receipt_upload_targets enable row level security;
revoke all privileges on table public.project_expense_settings from public, anon, authenticated;
revoke all privileges on table public.expense_receipts from public, anon, authenticated;
revoke all privileges on table public.expense_receipt_upload_targets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Gardes : cible immuable ; reçu jamais supprimé, seul son retrait
--    (une fois) est permis ; brouillon : justification figée dès l'envoi.
-- ---------------------------------------------------------------------------
create trigger reject_mutation before update or delete on public.expense_receipt_upload_targets
for each row execute function public.reject_expense_record_mutation();

create function public.guard_expense_receipt_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'expense_record_immutable';
  end if;
  if old.withdrawn_at_server is not null
     or new.id <> old.id or new.expense_id <> old.expense_id or new.project_id <> old.project_id
     or new.attached_to_version_id is distinct from old.attached_to_version_id
     or new.private_object_upload_id <> old.private_object_upload_id or new.mime_type <> old.mime_type
     or new.file_size_bytes <> old.file_size_bytes or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_by_role <> old.created_by_role or new.created_at_server <> old.created_at_server
     or new.withdrawn_at_server is null then
    raise exception 'expense_record_immutable';
  end if;
  return new;
end;
$$;

create trigger guard_mutation before update or delete on public.expense_receipts
for each row execute function public.guard_expense_receipt_mutation();

create or replace function public.guard_expense_mutation()
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
       or new.draft_note is distinct from old.draft_note or new.draft_phase_id is distinct from old.draft_phase_id
       or new.draft_no_receipt_reason is distinct from old.draft_no_receipt_reason) then
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

revoke execute on function public.guard_expense_receipt_mutation(), public.guard_expense_mutation()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Contrôles communs (toujours vrai/faux ou refus).
-- ---------------------------------------------------------------------------
create function public.expense_receipt_justification_required(p_project_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select s.require_no_receipt_justification from public.project_expense_settings s where s.project_id = p_project_id), false);
$$;

create function public.expense_active_receipt_count(p_expense_id uuid)
returns integer
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select count(*)::integer from public.expense_receipts r where r.expense_id = p_expense_id and r.withdrawn_at_server is null;
$$;

-- F5 C : refus si le réglage est actif, sans reçu actif ni justification.
create function public.expense_check_receipt_justification(p_project_id uuid, p_expense_id uuid, p_reason text)
returns void
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if public.expense_receipt_justification_required(p_project_id) is true
     and public.expense_active_receipt_count(p_expense_id) = 0
     and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'receipt_justification_required';
  end if;
end;
$$;

-- Joindre un reçu : brouillon -> son auteur ; envoyée et non terminale ->
-- l'entreprise ou l'auteur.
create function public.expense_can_attach_receipt(p_expense public.expenses, p_role text, p_uid uuid)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    case
      when p_role is null then false
      when p_expense.status = 'BROUILLON' then p_expense.created_by_profile_id = p_uid
      when p_expense.status in ('SOUMISE', 'APPROUVEE', 'CONTESTEE') then p_role = 'CONTRACTOR' or p_expense.created_by_profile_id = p_uid
      else false
    end, false);
$$;

revoke execute on function public.expense_receipt_justification_required(uuid), public.expense_active_receipt_count(uuid),
  public.expense_check_receipt_justification(uuid, uuid, text), public.expense_can_attach_receipt(public.expenses, text, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Réglage du chantier (F5 C) : entreprise seule pour l'écrire ;
--    entreprise et chef de chantier pour le lire.
-- ---------------------------------------------------------------------------
create function public.set_expense_receipt_policy(p_project_id uuid, p_required boolean, p_expected_revision integer)
returns public.project_expense_settings
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.expense_member_role(p_project_id, true);
  v_row public.project_expense_settings;
begin
  if v_role <> 'CONTRACTOR' then
    raise exception 'not_authorized';
  end if;
  if p_required is null then
    raise exception 'policy_invalid';
  end if;
  select * into v_row from public.project_expense_settings where project_id = p_project_id for update;
  if coalesce(v_row.revision, 0) <> coalesce(p_expected_revision, -1) then
    raise exception 'revision_conflict';
  end if;
  if coalesce(v_row.require_no_receipt_justification, false) = p_required then
    raise exception 'no_change';
  end if;
  insert into public.project_expense_settings (project_id, require_no_receipt_justification, revision, updated_by_profile_id, updated_at_server)
  values (p_project_id, p_required, 1, v_uid, clock_timestamp())
  on conflict (project_id) do update
    set require_no_receipt_justification = excluded.require_no_receipt_justification,
        revision = public.project_expense_settings.revision + 1,
        updated_by_profile_id = excluded.updated_by_profile_id,
        updated_at_server = excluded.updated_at_server
  returning * into v_row;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (p_project_id, 'HUMAN', v_uid, 'EXPENSE_RECEIPT_POLICY_SET', 'project_expense_settings', p_project_id, 'SUCCESS',
          jsonb_build_object('require_no_receipt_justification', p_required),
          case when p_required then 'Justification obligatoire en l''absence de reçu.' else 'Justification facultative en l''absence de reçu.' end);
  return v_row;
end;
$$;

create function public.get_expense_receipt_policy(p_project_id uuid)
returns table (require_no_receipt_justification boolean, revision integer, can_change boolean)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := public.expense_member_role(p_project_id, false);
begin
  return query
    select public.expense_receipt_justification_required(p_project_id),
           coalesce((select s.revision from public.project_expense_settings s where s.project_id = p_project_id), 0),
           v_role = 'CONTRACTOR';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Dépenses : justification d'un reçu absent (brouillon, envoi,
--    correction). Signatures modifiées : anciennes fonctions supprimées.
-- ---------------------------------------------------------------------------
drop function public.save_expense_draft(uuid, uuid, integer, text, date, text, text, text, uuid);

create function public.save_expense_draft(
  p_project_id uuid,
  p_expense_id uuid,
  p_expected_revision integer,
  p_amount_fcfa text,
  p_expense_date date,
  p_category text,
  p_supplier text,
  p_note text,
  p_phase_id uuid,
  p_no_receipt_reason text
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
  v_justification text := nullif(btrim(coalesce(p_no_receipt_reason, '')), '');
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
                                 draft_category, draft_supplier, draft_note, draft_phase_id, draft_no_receipt_reason)
    values (p_project_id, v_uid, v_role, v_amount, p_expense_date, p_category, nullif(btrim(coalesce(p_supplier, '')), ''),
            nullif(btrim(coalesce(p_note, '')), ''), p_phase_id, v_justification)
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
        draft_phase_id = p_phase_id, draft_no_receipt_reason = v_justification, revision = revision + 1
    where id = v_row.id
    returning * into v_row;
  end if;
  return v_row;
exception
  when check_violation then raise exception 'expense_invalid';
end;
$$;

create or replace function public.submit_expense(p_expense_id uuid, p_expected_revision integer)
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
  perform public.expense_check_receipt_justification(v_exp.project_id, v_exp.id, v_exp.draft_no_receipt_reason);
  insert into public.expense_versions (expense_id, project_id, version_number, amount_fcfa, expense_date, category, supplier, note, phase_id,
                                       no_receipt_reason, created_by_profile_id, created_by_role)
  values (v_exp.id, v_exp.project_id, 1, v_exp.draft_amount_fcfa, v_exp.draft_expense_date, v_exp.draft_category, v_exp.draft_supplier,
          v_exp.draft_note, v_exp.draft_phase_id, v_exp.draft_no_receipt_reason, v_uid, v_role)
  returning * into v_version;
  -- Entreprise : approuvée directement ; chef de chantier : soumise (F4).
  v_status := case when v_role = 'CONTRACTOR' then 'APPROUVEE' else 'SOUMISE' end;
  update public.expenses
  set status = v_status, current_version_id = v_version.id, submitted_at_server = clock_timestamp(), revision = revision + 1
  where id = v_exp.id
  returning * into v_exp;
  -- Les reçus joints au brouillon restent liés à la dépense (aucune version au dépôt).
  insert into public.expense_decisions (expense_id, project_id, version_id, decision, decided_by_profile_id, decided_by_role)
  values (v_exp.id, v_exp.project_id, v_version.id, v_status, v_uid, v_role);
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_exp.project_id, 'HUMAN', v_uid, case when v_status = 'APPROUVEE' then 'EXPENSE_PUBLISHED_APPROVED' else 'EXPENSE_SUBMITTED' end,
          'expense_versions', v_version.id, 'SUCCESS',
          jsonb_build_object('expense_id', v_exp.id, 'receipt_count', public.expense_active_receipt_count(v_exp.id)), 'Dépense interne enregistrée.');
  return v_exp;
end;
$$;

drop function public.correct_expense(uuid, integer, text, text, date, text, text, text, uuid);

create function public.correct_expense(
  p_expense_id uuid,
  p_expected_revision integer,
  p_reason text,
  p_amount_fcfa text,
  p_expense_date date,
  p_category text,
  p_supplier text,
  p_note text,
  p_phase_id uuid,
  p_no_receipt_reason text
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
  v_justification text := nullif(btrim(coalesce(p_no_receipt_reason, '')), '');
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
  perform public.expense_check_receipt_justification(v_exp.project_id, v_exp.id, v_justification);
  if v_amount = v_prev.amount_fcfa and p_expense_date = v_prev.expense_date and p_category = v_prev.category
     and nullif(btrim(coalesce(p_supplier, '')), '') is not distinct from v_prev.supplier
     and nullif(btrim(coalesce(p_note, '')), '') is not distinct from v_prev.note
     and p_phase_id is not distinct from v_prev.phase_id
     and v_justification is not distinct from v_prev.no_receipt_reason then
    raise exception 'no_change';
  end if;
  begin
    insert into public.expense_versions (expense_id, project_id, version_number, supersedes_version_id, amount_fcfa, expense_date, category,
                                         supplier, note, phase_id, no_receipt_reason, reason, created_by_profile_id, created_by_role)
    values (v_exp.id, v_exp.project_id, v_prev.version_number + 1, v_prev.id, v_amount, p_expense_date, p_category,
            nullif(btrim(coalesce(p_supplier, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), p_phase_id, v_justification,
            v_reason, v_uid, v_role)
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

-- Liste : justification, nombre de reçus actifs, droit de joindre.
drop function public.list_project_expenses(uuid);
alter type public.expense_view add attribute no_receipt_reason text;
alter type public.expense_view add attribute receipt_count integer;
alter type public.expense_view add attribute can_attach_receipt boolean;

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
           v_role = 'CONTRACTOR' and e.status in ('APPROUVEE', 'CONTESTEE'),
           case when v.id is null then e.draft_no_receipt_reason else v.no_receipt_reason end,
           public.expense_active_receipt_count(e.id),
           public.expense_can_attach_receipt(e, v_role, v_uid)
    from public.expenses e
    left join public.expense_versions v on v.id = e.current_version_id
    left join public.project_phases ph on ph.id = case when v.id is null then e.draft_phase_id else v.phase_id end
    where e.project_id = p_project_id and public.expense_visible(e, v_uid)
    order by (e.status = 'BROUILLON') desc, coalesce(v.expense_date, e.draft_expense_date) desc, e.created_at_server desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reçus : préparation, finalisation, liste, clé de fichier, retrait.
-- ---------------------------------------------------------------------------
create function public.prepare_expense_receipt_upload(
  p_operation_uuid uuid,
  p_expense_id uuid,
  p_expected_checksum text,
  p_expected_size_bytes bigint,
  p_expected_mime_type text
)
returns public.private_object_uploads
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project uuid;
  v_role text;
  v_exp public.expenses;
  v_existing public.private_object_uploads;
  v_target public.expense_receipt_upload_targets;
  v_row public.private_object_uploads;
  v_attempt_id uuid := gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_operation_uuid is null or p_expense_id is null then
    raise exception 'not_authorized';
  end if;
  select project_id into v_project from public.expenses where id = p_expense_id;
  if v_project is null then
    raise exception 'not_authorized';
  end if;
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_project::text)::bigint);
  v_role := public.expense_member_role(v_project, true);
  select * into v_exp from public.expenses where id = p_expense_id for update;
  if public.expense_visible(v_exp, v_uid) is not true or public.expense_can_attach_receipt(v_exp, v_role, v_uid) is not true then
    raise exception 'not_authorized';
  end if;
  if p_expected_checksum is null or p_expected_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'checksum_required';
  end if;
  if p_expected_size_bytes is null or p_expected_size_bytes <= 0 or p_expected_size_bytes > 10485760 then
    raise exception 'size_required';
  end if;
  if p_expected_mime_type is null or p_expected_mime_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    raise exception 'mime_type_required';
  end if;

  select * into v_existing from public.private_object_uploads where operation_uuid = p_operation_uuid;
  if found then
    select * into v_target from public.expense_receipt_upload_targets where private_object_upload_id = v_existing.id;
    if v_existing.entity_type <> 'expense_receipt' or v_existing.created_by_profile_id <> v_uid
       or v_existing.project_id is distinct from v_project or v_target.expense_id is distinct from p_expense_id
       or v_existing.expected_checksum <> p_expected_checksum or v_existing.expected_size_bytes <> p_expected_size_bytes
       or v_existing.expected_mime_type <> p_expected_mime_type then
      raise exception 'operation_uuid_conflict';
    end if;
    if v_existing.status = 'ABANDONED' then
      raise exception 'operation_abandoned';
    end if;
    return v_existing;
  end if;

  insert into public.private_object_uploads (
    operation_uuid, project_id, entity_type, created_by_profile_id, attempt_id, attempt_expires_at, candidate_key,
    expected_checksum, expected_size_bytes, expected_mime_type
  ) values (
    p_operation_uuid, v_project, 'expense_receipt', v_uid, v_attempt_id, clock_timestamp() + interval '15 minutes',
    '_private/' || v_project::text || '/expense_receipt/' || p_operation_uuid::text || '/candidates/' || v_attempt_id::text,
    p_expected_checksum, p_expected_size_bytes, p_expected_mime_type
  )
  on conflict (operation_uuid) do nothing
  returning * into v_row;
  if v_row.id is null then
    raise exception 'operation_uuid_conflict';
  end if;
  insert into public.expense_receipt_upload_targets (private_object_upload_id, project_id, expense_id)
  values (v_row.id, v_project, p_expense_id);
  return v_row;
end;
$$;

create function public.finalize_expense_receipt_upload(p_operation_uuid uuid)
returns public.expense_receipts
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_project_id uuid;
  v_role text;
  v_row public.private_object_uploads;
  v_target public.expense_receipt_upload_targets;
  v_exp public.expenses;
  v_receipt public.expense_receipts;
  v_now timestamptz;
  v_updated integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select project_id into v_peek_project_id from public.private_object_uploads
  where operation_uuid = p_operation_uuid and entity_type = 'expense_receipt';
  if v_peek_project_id is null then
    raise exception 'not_authorized';
  end if;
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);
  v_role := public.expense_member_role(v_peek_project_id, true);

  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid for update;
  if v_row.id is null or v_row.created_by_profile_id is distinct from v_uid or v_row.entity_type is distinct from 'expense_receipt'
     or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;
  select * into v_target from public.expense_receipt_upload_targets where private_object_upload_id = v_row.id;
  -- Droits revérifiés à l'instant présent, rejeu compris.
  select * into v_exp from public.expenses where id = v_target.expense_id for update;
  if public.expense_visible(v_exp, v_uid) is not true or public.expense_can_attach_receipt(v_exp, v_role, v_uid) is not true then
    raise exception 'not_authorized';
  end if;

  if v_row.status = 'FINALIZED' then
    select * into v_receipt from public.expense_receipts where private_object_upload_id = v_row.id;
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

  update public.private_object_uploads
  set status = 'FINALIZED', storage_key = v_row.candidate_key, finalized_at = v_now, finalized_by_profile_id = v_uid
  where id = v_row.id and attempt_id = v_row.attempt_id and status = 'FINALIZING';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'storage_not_verified';
  end if;

  insert into public.expense_receipts (expense_id, project_id, attached_to_version_id, private_object_upload_id, mime_type, file_size_bytes,
                                       created_by_profile_id, created_by_role, created_at_server)
  values (v_exp.id, v_exp.project_id, v_exp.current_version_id, v_row.id, v_row.expected_mime_type, v_row.expected_size_bytes,
          v_uid, v_role, v_now)
  returning * into v_receipt;
  update public.private_object_uploads set entity_id = v_receipt.id where id = v_row.id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_exp.project_id, 'HUMAN', v_uid, 'EXPENSE_RECEIPT_ATTACHED', 'expense_receipts', v_receipt.id, 'SUCCESS',
          jsonb_build_object('expense_id', v_exp.id, 'version_id', v_exp.current_version_id), 'Reçu joint à une dépense interne.');
  return v_receipt;
end;
$$;

create function public.list_expense_receipts(p_expense_id uuid)
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
  select * into v_exp from public.expenses where id = p_expense_id;
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

-- Clé du fichier : délivrée seulement à qui voit la dépense, pour un reçu
-- non retiré ; le serveur émet ensuite l'URL signée (service_role).
create function public.get_expense_receipt_file_key(p_receipt_id uuid)
returns table (bucket text, storage_key text, mime_type text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_receipt public.expense_receipts;
  v_exp public.expenses;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select * into v_receipt from public.expense_receipts where id = p_receipt_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  select * into v_exp from public.expenses where id = v_receipt.expense_id;
  perform public.expense_member_role(v_exp.project_id, false);
  if public.expense_visible(v_exp, v_uid) is not true then
    raise exception 'not_authorized';
  end if;
  if v_receipt.withdrawn_at_server is not null then
    raise exception 'receipt_withdrawn';
  end if;
  return query
    select 'expense-receipts'::text, u.storage_key, v_receipt.mime_type
    from public.private_object_uploads u where u.id = v_receipt.private_object_upload_id and u.status = 'FINALIZED';
  if not found then
    raise exception 'file_not_finalized';
  end if;
end;
$$;

-- Retrait motivé : l'entreprise, ou l'auteur du reçu, tant que la dépense
-- accepte des reçus ; F5 C : jamais le dernier reçu d'une dépense envoyée
-- sans justification quand le réglage est actif.
create function public.withdraw_expense_receipt(p_receipt_id uuid, p_reason text)
returns public.expense_receipts
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_receipt public.expense_receipts;
  v_exp public.expenses;
  v_role text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_justification text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select * into v_receipt from public.expense_receipts where id = p_receipt_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  v_role := public.expense_member_role(v_receipt.project_id, true);
  select * into v_exp from public.expenses where id = v_receipt.expense_id for update;
  select * into v_receipt from public.expense_receipts where id = p_receipt_id for update;
  if public.expense_visible(v_exp, v_uid) is not true or public.expense_can_attach_receipt(v_exp, v_role, v_uid) is not true
     or not (v_role = 'CONTRACTOR' or v_receipt.created_by_profile_id = v_uid) then
    raise exception 'not_authorized';
  end if;
  if v_receipt.withdrawn_at_server is not null then
    raise exception 'receipt_withdrawn';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  if v_exp.status <> 'BROUILLON' and public.expense_receipt_justification_required(v_exp.project_id) is true
     and public.expense_active_receipt_count(v_exp.id) = 1 then
    select no_receipt_reason into v_justification from public.expense_versions where id = v_exp.current_version_id;
    if v_justification is null then
      raise exception 'receipt_justification_required';
    end if;
  end if;
  update public.expense_receipts
  set withdrawn_at_server = clock_timestamp(), withdrawn_by_profile_id = v_uid, withdrawn_by_role = v_role, withdraw_reason = v_reason
  where id = v_receipt.id
  returning * into v_receipt;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_exp.project_id, 'HUMAN', v_uid, 'EXPENSE_RECEIPT_WITHDRAWN', 'expense_receipts', v_receipt.id, 'SUCCESS',
          jsonb_build_object('expense_id', v_exp.id), v_reason);
  return v_receipt;
end;
$$;

revoke execute on function public.set_expense_receipt_policy(uuid, boolean, integer), public.get_expense_receipt_policy(uuid),
  public.save_expense_draft(uuid, uuid, integer, text, date, text, text, text, uuid, text), public.submit_expense(uuid, integer),
  public.correct_expense(uuid, integer, text, text, date, text, text, text, uuid, text), public.list_project_expenses(uuid),
  public.prepare_expense_receipt_upload(uuid, uuid, text, bigint, text), public.finalize_expense_receipt_upload(uuid),
  public.list_expense_receipts(uuid), public.get_expense_receipt_file_key(uuid), public.withdraw_expense_receipt(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_expense_receipt_policy(uuid, boolean, integer), public.get_expense_receipt_policy(uuid),
  public.save_expense_draft(uuid, uuid, integer, text, date, text, text, text, uuid, text), public.submit_expense(uuid, integer),
  public.correct_expense(uuid, integer, text, text, date, text, text, text, uuid, text), public.list_project_expenses(uuid),
  public.prepare_expense_receipt_upload(uuid, uuid, text, bigint, text), public.finalize_expense_receipt_upload(uuid),
  public.list_expense_receipts(uuid), public.get_expense_receipt_file_key(uuid), public.withdraw_expense_receipt(uuid, text)
  to authenticated;

-- Nettoyage (service_role), même principe que M039.
create function public.list_expired_expense_receipt_uploads(p_older_than interval default interval '1 hour')
returns table (id uuid, project_id uuid, attempt_expires_at timestamptz)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.project_id, u.attempt_expires_at
  from public.private_object_uploads u
  where u.entity_type = 'expense_receipt' and u.status in ('PENDING', 'FINALIZING') and u.attempt_expires_at < now() - p_older_than;
$$;

create function public.abandon_expired_expense_receipt_upload(p_id uuid, p_older_than interval default interval '1 hour')
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
begin
  select * into v_row from public.private_object_uploads where id = p_id for update;
  if not found or v_row.entity_type <> 'expense_receipt' then
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

revoke execute on function public.list_expired_expense_receipt_uploads(interval), public.abandon_expired_expense_receipt_upload(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_expense_receipt_uploads(interval), public.abandon_expired_expense_receipt_upload(uuid, interval)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. get_stale_key_bucket, claim_upload_attempt, recover_media_upload_attempt,
--    get_upload_status : reprises à l'identique de M039 ; SEULE la branche
--    expense_receipt est ajoutée (verrou avisoire -> adhésion interne active
--    -> ligne, compte vérifié relu, créateur = déposant).
-- ---------------------------------------------------------------------------
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
    when 'document_version' then 'project-documents'
    when 'expense_receipt' then 'expense-receipts'
    else null
  end
  from public.private_object_stale_keys k
  join public.private_object_uploads u on u.id = k.private_object_upload_id
  where k.id = p_id;
$$;

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

  if v_peek_entity_type in ('project_plan_version', 'advance_receipt', 'document_version') then
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

  if v_peek_entity_type = 'expense_receipt' then
    perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);

    select id into v_membership_id
    from public.project_memberships
    where project_id = v_peek_project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
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
  elsif v_row.entity_type = 'document_version' then
    v_authorized := true; -- adhésion de dépôt revérifiée ci-dessus sous verrou ; créateur = déposant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
  elsif v_row.entity_type = 'expense_receipt' then
    v_authorized := true; -- adhésion interne revérifiée ci-dessus sous verrou ; créateur = déposant.
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

  if v_peek_entity_type in ('project_plan_version', 'advance_receipt', 'document_version') then
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

  if v_peek_entity_type = 'expense_receipt' then
    perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_peek_project_id::text)::bigint);

    select id into v_membership_id
    from public.project_memberships
    where project_id = v_peek_project_id
      and profile_id = v_uid
      and revoked_at is null
      and role in ('CONTRACTOR', 'SITE_MANAGER')
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
  elsif v_row.entity_type = 'document_version' then
    v_authorized := true; -- adhésion de dépôt revérifiée ci-dessus sous verrou ; créateur = déposant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/document_version/' || v_row.operation_uuid::text;
  elsif v_row.entity_type = 'expense_receipt' then
    v_authorized := true; -- adhésion interne revérifiée ci-dessus sous verrou ; créateur = déposant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/expense_receipt/' || v_row.operation_uuid::text;
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
  elsif v_row.entity_type = 'document_version' then
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
  elsif v_row.entity_type = 'expense_receipt' then
    v_authorized := exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = v_uid
        and revoked_at is null
        and role in ('CONTRACTOR', 'SITE_MANAGER')
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
