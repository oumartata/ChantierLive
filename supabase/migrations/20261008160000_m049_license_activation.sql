-- M049 — B049 : activation manuelle de licence et rôle administrateur de
-- plateforme (done_when : « payeur ne gagne aucun droit »). Décisions du
-- fondateur 2026-10-08 : D194 (A1 à A9), D193 L5, D004, D012, D019, D057.
-- Conception : API058 license.activate, SCR062, STATE_MACHINES license,
-- DATA_MODEL platform_admin (« rôle plateforme séparé, absent des adhésions
-- métier ordinaires »).
--
-- - Administrateur (A1, A2) : table platform_admins, écrite seulement par
--   une opération serveur (service_role) qui désigne un compte existant ;
--   aucune fonction de l'application ne l'écrit ; un administrateur n'a et
--   n'obtient aucune adhésion de chantier active.
-- - Il ne voit aucun contenu de chantier : aucune fonction de chantier ne lui
--   est ouverte (il n'est membre de rien) ; ses fonctions ne renvoient ni nom
--   ni adresse de chantier ni identité de membre (A9), seulement la
--   déclaration et sa preuve, dont chaque lecture est auditée (D193 L5).
-- - Activation (A3, A4, A7, A8) : l'administrateur active une déclaration en
--   attente ; licence ACTIVE du jour pour 12 mois ; jamais sur une licence
--   déjà active ; le statut du chantier n'est pas touché ; aucune adhésion,
--   aucun rôle, aucune permission n'est modifié (D004).
-- - Rejet (A5, A6) : motif obligatoire ; activer une déclaration n'en
--   active jamais une autre ; rien n'est supprimé.
-- - Audit : journal de plateforme séparé (platform_audit_events), lisible du
--   seul serveur ; l'identité de l'administrateur n'entre pas dans l'audit
--   des chantiers, lisible de l'entreprise (D186).

begin;

-- ---------------------------------------------------------------------------
-- 1. Administrateurs et journal de plateforme.
-- ---------------------------------------------------------------------------
create table public.platform_admins (
  profile_id uuid primary key references public.profiles (id) on delete restrict,
  designated_at_server timestamptz not null default now(),
  note text null check (note is null or char_length(note) <= 500)
);

create table public.platform_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid null references public.profiles (id) on delete restrict,
  actor_kind text not null check (actor_kind in ('ADMIN', 'SERVER_OPERATION')),
  action text not null,
  project_id uuid null references public.projects (id) on delete restrict,
  target_table text null,
  target_id uuid null,
  reason text null,
  context jsonb not null default '{}'::jsonb,
  created_at_server timestamptz not null default now(),
  constraint platform_audit_actor_consistency check ((actor_kind = 'ADMIN') = (actor_profile_id is not null))
);

alter table public.platform_admins enable row level security;
alter table public.platform_audit_events enable row level security;
revoke all privileges on table public.platform_admins from public, anon, authenticated;
revoke all privileges on table public.platform_audit_events from public, anon, authenticated;

create function public.reject_platform_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'platform_audit_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.platform_audit_events
for each row execute function public.reject_platform_audit_mutation();

-- A2 : la désignation est refusée si le compte a une adhésion active.
create function public.guard_platform_admin_designation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.profile_id <> old.profile_id then
    raise exception 'admin_designation_immutable';
  end if;
  if exists (select 1 from public.project_memberships m where m.profile_id = new.profile_id and m.revoked_at is null) then
    raise exception 'admin_has_project_membership';
  end if;
  return new;
end;
$$;

create trigger guard_designation before insert or update on public.platform_admins
for each row execute function public.guard_platform_admin_designation();

-- A2 : aucune adhésion de chantier active pour un administrateur.
create function public.guard_membership_not_admin()
returns trigger
language plpgsql
as $$
begin
  if new.revoked_at is null and exists (select 1 from public.platform_admins a where a.profile_id = new.profile_id) then
    raise exception 'admin_cannot_be_project_member';
  end if;
  return new;
end;
$$;

create trigger guard_not_admin before insert or update on public.project_memberships
for each row execute function public.guard_membership_not_admin();

revoke execute on function public.reject_platform_audit_mutation(), public.guard_platform_admin_designation(), public.guard_membership_not_admin()
  from public, anon, authenticated, service_role;

-- Désignation : opération serveur seulement (service_role), jamais l'application.
create function public.designate_platform_admin(p_profile_id uuid, p_note text)
returns public.platform_admins
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.platform_admins;
begin
  if p_profile_id is null or not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'profile_not_found';
  end if;
  insert into public.platform_admins (profile_id, note) values (p_profile_id, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (profile_id) do nothing
  returning * into v_row;
  if v_row.profile_id is null then
    raise exception 'already_admin';
  end if;
  insert into public.platform_audit_events (actor_kind, action, target_table, target_id, reason)
  values ('SERVER_OPERATION', 'PLATFORM_ADMIN_DESIGNATED', 'platform_admins', p_profile_id, v_row.note);
  return v_row;
end;
$$;

revoke execute on function public.designate_platform_admin(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.designate_platform_admin(uuid, text) to service_role;

-- L'appelant est-il administrateur ? (ne renseigne que sur soi-même)
create function public.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(auth.uid() is not null and exists (select 1 from public.platform_admins a where a.profile_id = auth.uid()), false);
$$;

create function public.require_platform_admin()
returns uuid
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if public.is_platform_admin() is not true then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

revoke execute on function public.is_platform_admin(), public.require_platform_admin() from public, anon, authenticated, service_role;
grant execute on function public.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Décisions sur les déclarations : ACTIVATED ou REJECTED (motif).
-- ---------------------------------------------------------------------------
alter table public.license_payments drop constraint license_payments_status_check;
alter table public.license_payments add constraint license_payments_status_check
  check (status in ('PENDING_REVIEW', 'CANCELLED', 'ACTIVATED', 'REJECTED'));
alter table public.license_payments add column decided_at_server timestamptz null;
alter table public.license_payments add column decided_by_profile_id uuid null references public.profiles (id) on delete restrict;
alter table public.license_payments add column decision_note text null
  check (decision_note is null or char_length(btrim(decision_note)) between 3 and 1000);
alter table public.license_payments add constraint license_payments_decision_consistency check (
  (status in ('ACTIVATED', 'REJECTED')) = (decided_at_server is not null and decided_by_profile_id is not null)
  and (status <> 'REJECTED' or decision_note is not null)
);

-- Garde : PENDING_REVIEW vers CANCELLED (déclarant), ACTIVATED ou REJECTED
-- (administrateur), une seule fois ; aucun autre champ ne change.
create or replace function public.guard_license_payment_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'license_record_immutable';
  end if;
  if old.status <> 'PENDING_REVIEW' or new.status not in ('CANCELLED', 'ACTIVATED', 'REJECTED')
     or (to_jsonb(new) - array['status', 'cancelled_at_server', 'cancel_reason', 'decided_at_server', 'decided_by_profile_id', 'decision_note'])
        <> (to_jsonb(old) - array['status', 'cancelled_at_server', 'cancel_reason', 'decided_at_server', 'decided_by_profile_id', 'decision_note'])
     or (new.status = 'CANCELLED' and (new.decided_at_server is not null or new.decision_note is not null))
     or (new.status in ('ACTIVATED', 'REJECTED') and (new.cancelled_at_server is not null or new.cancel_reason is not null)) then
    raise exception 'license_record_immutable';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_license_payment_mutation() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Fonctions administrateur (A9 : ni nom ni adresse de chantier, ni
--    identité de membre).
-- ---------------------------------------------------------------------------
create function public.list_license_payments_for_review(p_include_decided boolean)
returns table (payment_id uuid, project_ref text, license_status text, declared_role text, amount_fcfa bigint, operator text,
               payment_reference text, paid_on date, payer_name text, offer_label text, offer_price_fcfa bigint, offer_price_is_demo boolean,
               proof_mime_type text, proof_size_bytes bigint, status text, declared_at_server timestamptz, decided_at_server timestamptz,
               decision_note text, other_pending_on_project integer)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.require_platform_admin();
  return query
    select p.id, upper(left(p.project_id::text, 8)), coalesce(l.status, 'NONE'), p.declared_role, p.amount_fcfa, p.operator,
           p.payment_reference, p.paid_on, p.payer_name, p.offer_label, p.offer_price_fcfa, p.offer_price_is_demo,
           p.proof_mime_type, p.proof_size_bytes, p.status, p.created_at_server, p.decided_at_server, p.decision_note,
           (select count(*)::integer from public.license_payments o where o.project_id = p.project_id and o.status = 'PENDING_REVIEW' and o.id <> p.id)
    from public.license_payments p
    left join public.project_licenses l on l.project_id = p.project_id
    where p.status = 'PENDING_REVIEW' or coalesce(p_include_decided, false)
    order by (p.status = 'PENDING_REVIEW') desc, p.created_at_server;
end;
$$;

-- Lecture de la preuve par l'administrateur : chaque délivrance est auditée.
create function public.get_license_proof_file_key_for_admin(p_payment_id uuid)
returns table (bucket text, storage_key text, mime_type text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_row public.license_payments;
begin
  select * into v_row from public.license_payments where id = p_payment_id;
  if not found then
    raise exception 'not_found';
  end if;
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, project_id, target_table, target_id)
  values (v_admin, 'ADMIN', 'LICENSE_PROOF_VIEWED', v_row.project_id, 'license_payments', v_row.id);
  return query
    select 'license-proofs'::text, u.storage_key, v_row.proof_mime_type
    from public.private_object_uploads u where u.id = v_row.private_object_upload_id and u.status = 'FINALIZED';
  if not found then
    raise exception 'file_not_finalized';
  end if;
end;
$$;

create function public.activate_license_payment(p_payment_id uuid, p_verification_note text)
returns public.license_payments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_row public.license_payments;
  v_license public.project_licenses;
  v_note text := nullif(btrim(coalesce(p_verification_note, '')), '');
  v_today date := (now() at time zone 'utc')::date;
begin
  select * into v_row from public.license_payments where id = p_payment_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'PENDING_REVIEW' then
    raise exception 'invalid_transition';
  end if;
  if v_note is not null and char_length(v_note) < 3 then
    raise exception 'note_invalid';
  end if;
  select * into v_license from public.project_licenses where project_id = v_row.project_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- A7 : jamais sur une licence déjà active ; renouvellement hors B049.
  if v_license.status in ('ACTIVE', 'EXPIRING') then
    raise exception 'license_already_active';
  end if;
  if v_license.status <> 'PENDING' then
    raise exception 'renewal_not_supported';
  end if;
  update public.license_payments
  set status = 'ACTIVATED', decided_at_server = clock_timestamp(), decided_by_profile_id = v_admin, decision_note = v_note
  where id = v_row.id
  returning * into v_row;
  -- A4 : du jour pour 12 mois ; A8 : le chantier n'est pas touché.
  update public.project_licenses
  set status = 'ACTIVE', starts_on = v_today, ends_on = (v_today + make_interval(months => v_row.offer_duration_months))::date, revision = revision + 1
  where project_id = v_row.project_id;
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, project_id, target_table, target_id, reason, context)
  values (v_admin, 'ADMIN', 'LICENSE_ACTIVATED', v_row.project_id, 'license_payments', v_row.id, v_note,
          jsonb_build_object('starts_on', v_today, 'duration_months', v_row.offer_duration_months, 'amount_fcfa', v_row.amount_fcfa,
                             'operator', v_row.operator, 'payment_reference', v_row.payment_reference));
  return v_row;
end;
$$;

create function public.reject_license_payment(p_payment_id uuid, p_reason text)
returns public.license_payments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_row public.license_payments;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_row from public.license_payments where id = p_payment_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'PENDING_REVIEW' then
    raise exception 'invalid_transition';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  update public.license_payments
  set status = 'REJECTED', decided_at_server = clock_timestamp(), decided_by_profile_id = v_admin, decision_note = v_reason
  where id = v_row.id
  returning * into v_row;
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, project_id, target_table, target_id, reason)
  values (v_admin, 'ADMIN', 'LICENSE_PAYMENT_REJECTED', v_row.project_id, 'license_payments', v_row.id, v_reason);
  return v_row;
end;
$$;

revoke execute on function public.list_license_payments_for_review(boolean), public.get_license_proof_file_key_for_admin(uuid),
  public.activate_license_payment(uuid, text), public.reject_license_payment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_license_payments_for_review(boolean), public.get_license_proof_file_key_for_admin(uuid),
  public.activate_license_payment(uuid, text), public.reject_license_payment(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Côté déclarant : la décision (et son motif) apparaît dans ses déclarations.
-- ---------------------------------------------------------------------------
drop function public.list_my_license_payments(uuid);

create function public.list_my_license_payments(p_project_id uuid)
returns table (id uuid, status text, offer_label text, offer_price_fcfa bigint, offer_price_is_demo boolean, amount_fcfa bigint, operator text,
               payment_reference text, paid_on date, payer_name text, proof_mime_type text, proof_size_bytes bigint,
               created_at_server timestamptz, cancelled_at_server timestamptz, cancel_reason text, can_cancel boolean,
               decided_at_server timestamptz, decision_note text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_party text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_party := public.document_party(p_project_id, v_uid);
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  return query
    select p.id, p.status, p.offer_label, p.offer_price_fcfa, p.offer_price_is_demo, p.amount_fcfa, p.operator, p.payment_reference, p.paid_on,
           p.payer_name, p.proof_mime_type, p.proof_size_bytes, p.created_at_server, p.cancelled_at_server, p.cancel_reason,
           p.status = 'PENDING_REVIEW' and v_party in ('CONTRACTOR', 'OWNER_PRIMARY'),
           p.decided_at_server, p.decision_note
    from public.license_payments p
    where p.project_id = p_project_id and p.declared_by_profile_id = v_uid
    order by p.created_at_server desc;
end;
$$;

revoke execute on function public.list_my_license_payments(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_my_license_payments(uuid) to authenticated;

commit;
