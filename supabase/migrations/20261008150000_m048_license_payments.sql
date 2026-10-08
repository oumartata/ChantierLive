-- M048 — B048 : déclaration de paiement de licence (done_when : « preuve et
-- statut PENDING_REVIEW »). Décisions du fondateur 2026-10-08 : D193 (L1 à
-- L9), D004/D081 (le paiement ne donne aucun droit), D012 (12 mois), BR081 à
-- BR083. Conception : T034 project_licenses, T035 license_payments, API057,
-- FORM_SCHEMAS license_payment, MIGRATION_ORDER M017 (« droits indépendants
-- du paiement » ; identifiant M017 non réutilisé).
--
-- - ChantierLive ne détient ni ne transfère d'argent : la déclaration
--   enregistre une référence externe, un montant, une date et une preuve,
--   au statut PENDING_REVIEW. L'activation (B049) est hors de cette migration.
-- - Le payeur ne gagne aucun droit : aucune adhésion, aucun rôle, aucune
--   permission n'est lue pour être modifiée ici (D004, BR082, AC142).
-- - Déclarants (L3) : propriétaire principal et entreprise actifs, compte
--   vérifié. Copropriétaire, chef de chantier, non-membre : refusés.
-- - Preuve (L4) : compartiment privé dédié license-proofs, type réel attesté
--   sur les octets relus ; visible du seul déclarant (et de l'administrateur
--   en B049). Tous les membres actifs voient l'état de la licence, sans
--   montant ni preuve.
-- - Aucune donnée sensible (L6) : ni téléphone, ni carte, ni compte ; une
--   référence ou un nom qui ressemble à un tel numéro est refusé.
-- - Formule unique 12 mois (L2), prix lu dans un réglage de plateforme
--   modifiable sans code, marqué « prix de démonstration » en local.
-- - Avertissement avec accusé de lecture (L7) ; plusieurs déclarations
--   possibles (L8) ; annulation motivée par le déclarant tant qu'elle est en
--   attente, rien n'est supprimé (L9).
-- - Circuit d'envoi générique : type d'entité license_proof ; claim/recover/
--   get_upload_status/get_stale_key_bucket repris à l'identique de M046,
--   seule la branche license_proof est ajoutée.

begin;

-- ---------------------------------------------------------------------------
-- 1. Réglage de plateforme : formule et prix (L2).
-- ---------------------------------------------------------------------------
create table public.platform_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  value jsonb not null,
  note text null,
  updated_at_server timestamptz not null default now()
);

alter table public.platform_settings enable row level security;
revoke all privileges on table public.platform_settings from public, anon, authenticated;

-- Prix de démonstration (local) : à remplacer par le vrai prix avant le
-- pilote, sans code (mise à jour de cette ligne par l'administration).
insert into public.platform_settings (key, value, note) values
  ('license_offer', jsonb_build_object('label', 'Licence chantier 12 mois', 'duration_months', 12, 'price_fcfa', 100000, 'price_is_demo', true),
   'Prix de démonstration : le vrai prix est fixé par le fondateur avant le pilote (D193 L2).');

create function public.get_license_offer()
returns table (label text, duration_months integer, price_fcfa bigint, price_is_demo boolean)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select s.value into v from public.platform_settings s where s.key = 'license_offer';
  if v is null or (v->>'price_fcfa') is null or (v->>'price_fcfa')::bigint <= 0 then
    raise exception 'license_offer_unavailable';
  end if;
  return query select v->>'label', (v->>'duration_months')::integer, (v->>'price_fcfa')::bigint, coalesce((v->>'price_is_demo')::boolean, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Stockage : type d'entité et compartiment privé.
-- ---------------------------------------------------------------------------
alter table public.private_object_uploads drop constraint private_object_uploads_entity_type_known;
alter table public.private_object_uploads add constraint private_object_uploads_entity_type_known
  check (entity_type in ('media_asset', 'plan_catalog_item_version', 'project_plan_version', 'advance_receipt', 'document_version', 'expense_receipt', 'license_proof'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('license-proofs', 'license-proofs', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

-- ---------------------------------------------------------------------------
-- 3. Tables.
-- ---------------------------------------------------------------------------
create table public.project_licenses (
  project_id uuid primary key references public.projects (id) on delete restrict,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'EXPIRING', 'GRACE', 'READ_ONLY', 'CANCELLED')),
  starts_on date null,
  ends_on date null,
  revision integer not null default 0 check (revision >= 0),
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now()
);

create table public.license_payments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.project_licenses (project_id) on delete restrict,
  private_object_upload_id uuid not null,
  declared_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  declared_role text not null check (declared_role in ('CONTRACTOR', 'OWNER_PRIMARY')),
  offer_label text not null,
  offer_duration_months integer not null check (offer_duration_months > 0),
  offer_price_fcfa bigint not null check (offer_price_fcfa > 0),
  offer_price_is_demo boolean not null,
  amount_fcfa bigint not null check (amount_fcfa > 0),
  operator text not null check (operator in ('ORANGE_MONEY', 'MOOV_MONEY', 'OTHER')),
  payment_reference text not null check (char_length(payment_reference) between 4 and 120),
  paid_on date not null,
  payer_name text null check (payer_name is null or char_length(payer_name) between 1 and 120),
  proof_mime_type text not null,
  proof_size_bytes bigint not null check (proof_size_bytes > 0),
  status text not null default 'PENDING_REVIEW' check (status in ('PENDING_REVIEW', 'CANCELLED')),
  disclaimer_acknowledged_at timestamptz not null,
  created_at_server timestamptz not null default now(),
  cancelled_at_server timestamptz null,
  cancel_reason text null check (cancel_reason is null or char_length(btrim(cancel_reason)) between 3 and 1000),
  constraint license_payments_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id) on delete restrict,
  constraint license_payments_upload_unique unique (private_object_upload_id),
  constraint license_payments_cancel_consistency check ((status = 'CANCELLED') = (cancelled_at_server is not null and cancel_reason is not null))
);

create index license_payments_project_idx on public.license_payments (project_id, created_at_server desc);

-- Cible d'un envoi : la déclaration complète, figée à la préparation.
create table public.license_payment_upload_targets (
  private_object_upload_id uuid primary key,
  project_id uuid not null,
  declared_role text not null check (declared_role in ('CONTRACTOR', 'OWNER_PRIMARY')),
  amount_fcfa bigint not null check (amount_fcfa > 0),
  operator text not null check (operator in ('ORANGE_MONEY', 'MOOV_MONEY', 'OTHER')),
  payment_reference text not null,
  paid_on date not null,
  payer_name text null,
  disclaimer_acknowledged_at timestamptz not null,
  constraint license_payment_upload_targets_upload_fk foreign key (private_object_upload_id, project_id)
    references public.private_object_uploads (id, project_id) on delete restrict
);

alter table public.project_licenses enable row level security;
alter table public.license_payments enable row level security;
alter table public.license_payment_upload_targets enable row level security;
revoke all privileges on table public.project_licenses from public, anon, authenticated;
revoke all privileges on table public.license_payments from public, anon, authenticated;
revoke all privileges on table public.license_payment_upload_targets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Gardes (même service_role) : cible immuable ; déclaration jamais
--    supprimée ni réécrite, seule l'annulation (une fois) est permise.
-- ---------------------------------------------------------------------------
create function public.reject_license_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'license_record_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.license_payment_upload_targets
for each row execute function public.reject_license_record_mutation();

create function public.guard_license_payment_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'license_record_immutable';
  end if;
  if old.status <> 'PENDING_REVIEW' or new.status <> 'CANCELLED'
     or (to_jsonb(new) - array['status', 'cancelled_at_server', 'cancel_reason']) <> (to_jsonb(old) - array['status', 'cancelled_at_server', 'cancel_reason']) then
    raise exception 'license_record_immutable';
  end if;
  return new;
end;
$$;

create trigger guard_mutation before update or delete on public.license_payments
for each row execute function public.guard_license_payment_mutation();

create function public.guard_project_license_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'license_record_immutable';
  end if;
  if new.project_id <> old.project_id or new.created_at_server <> old.created_at_server then
    raise exception 'license_record_immutable';
  end if;
  new.updated_at_server := clock_timestamp();
  return new;
end;
$$;

create trigger guard_mutation before update or delete on public.project_licenses
for each row execute function public.guard_project_license_mutation();

revoke execute on function public.reject_license_record_mutation(), public.guard_license_payment_mutation(), public.guard_project_license_mutation()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Contrôles communs (toujours vrai/faux ou refus).
-- ---------------------------------------------------------------------------
-- Déclarant (L3) : propriétaire principal ou entreprise actif, compte vérifié.
create function public.license_require_declarant(p_project_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_party text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_project_id is null then
    raise exception 'not_authorized';
  end if;
  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);
  v_party := public.document_party(p_project_id, auth.uid());
  if v_party is null or v_party not in ('CONTRACTOR', 'OWNER_PRIMARY') then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  return v_party;
end;
$$;

-- Données sensibles (L6). Référence : refusée si elle n'est faite que de
-- chiffres (8 à 19, séparateurs espaces, points, tirets ou « + » ignorés),
-- forme d'un numéro de téléphone, de carte ou de compte ; une référence
-- Mobile Money habituelle (lettres et chiffres) reste acceptée. Nom du
-- payeur : refusé s'il contient 6 chiffres ou plus.
create function public.license_reference_looks_sensitive(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(regexp_replace(p_text, '[[:space:].+-]', '', 'g') ~ '^[0-9]{8,19}$', false);
$$;

create function public.license_name_looks_sensitive(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(regexp_replace(p_text, '[[:space:].+-]', '', 'g') ~ '[0-9]{6,}', false);
$$;

revoke execute on function public.license_require_declarant(uuid), public.license_reference_looks_sensitive(text), public.license_name_looks_sensitive(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Déclaration : préparation (avec la preuve) puis finalisation atomique.
-- ---------------------------------------------------------------------------
create function public.prepare_license_payment_upload(
  p_operation_uuid uuid,
  p_project_id uuid,
  p_amount_fcfa text,
  p_operator text,
  p_payment_reference text,
  p_paid_on date,
  p_payer_name text,
  p_disclaimer_ack boolean,
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
  v_party text;
  v_amount bigint;
  v_reference text := btrim(coalesce(p_payment_reference, ''));
  v_payer text := nullif(btrim(coalesce(p_payer_name, '')), '');
  v_existing public.private_object_uploads;
  v_target public.license_payment_upload_targets;
  v_row public.private_object_uploads;
  v_attempt_id uuid := gen_random_uuid();
begin
  if p_operation_uuid is null then
    raise exception 'not_authorized';
  end if;
  v_party := public.license_require_declarant(p_project_id);
  perform public.get_license_offer();
  if p_disclaimer_ack is not true then
    raise exception 'disclaimer_required';
  end if;
  v_amount := public.advance_parse_amount(p_amount_fcfa);
  if p_operator is null or p_operator not in ('ORANGE_MONEY', 'MOOV_MONEY', 'OTHER') then
    raise exception 'operator_invalid';
  end if;
  if char_length(v_reference) not between 4 and 120 then
    raise exception 'reference_invalid';
  end if;
  if public.license_reference_looks_sensitive(v_reference) or public.license_name_looks_sensitive(v_payer) then
    raise exception 'sensitive_data_refused';
  end if;
  if v_payer is not null and char_length(v_payer) > 120 then
    raise exception 'payer_invalid';
  end if;
  if p_paid_on is null or p_paid_on > (now() at time zone 'utc')::date then
    raise exception 'paid_on_invalid';
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
    select * into v_target from public.license_payment_upload_targets where private_object_upload_id = v_existing.id;
    if v_existing.entity_type <> 'license_proof' or v_existing.created_by_profile_id <> v_uid or v_existing.project_id is distinct from p_project_id
       or v_existing.expected_checksum <> p_expected_checksum or v_existing.expected_size_bytes <> p_expected_size_bytes
       or v_existing.expected_mime_type <> p_expected_mime_type or v_target.amount_fcfa <> v_amount or v_target.operator <> p_operator
       or v_target.payment_reference <> v_reference or v_target.paid_on <> p_paid_on or v_target.payer_name is distinct from v_payer then
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
    p_operation_uuid, p_project_id, 'license_proof', v_uid, v_attempt_id, clock_timestamp() + interval '15 minutes',
    '_private/' || p_project_id::text || '/license_proof/' || p_operation_uuid::text || '/candidates/' || v_attempt_id::text,
    p_expected_checksum, p_expected_size_bytes, p_expected_mime_type
  )
  on conflict (operation_uuid) do nothing
  returning * into v_row;
  if v_row.id is null then
    raise exception 'operation_uuid_conflict';
  end if;
  insert into public.license_payment_upload_targets (private_object_upload_id, project_id, declared_role, amount_fcfa, operator, payment_reference,
                                                     paid_on, payer_name, disclaimer_acknowledged_at)
  values (v_row.id, p_project_id, v_party, v_amount, p_operator, v_reference, p_paid_on, v_payer, clock_timestamp());
  return v_row;
end;
$$;

create function public.finalize_license_payment_upload(p_operation_uuid uuid)
returns public.license_payments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peek_project_id uuid;
  v_party text;
  v_row public.private_object_uploads;
  v_target public.license_payment_upload_targets;
  v_offer record;
  v_payment public.license_payments;
  v_now timestamptz;
  v_updated integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select project_id into v_peek_project_id from public.private_object_uploads
  where operation_uuid = p_operation_uuid and entity_type = 'license_proof';
  if v_peek_project_id is null then
    raise exception 'not_authorized';
  end if;
  -- Droits revérifiés à l'instant présent, rejeu compris.
  v_party := public.license_require_declarant(v_peek_project_id);
  select * into v_row from public.private_object_uploads where operation_uuid = p_operation_uuid for update;
  if v_row.id is null or v_row.created_by_profile_id is distinct from v_uid or v_row.entity_type is distinct from 'license_proof'
     or v_row.project_id is distinct from v_peek_project_id then
    raise exception 'not_authorized';
  end if;
  select * into v_target from public.license_payment_upload_targets where private_object_upload_id = v_row.id;
  if v_target.declared_role <> v_party then
    raise exception 'not_authorized';
  end if;

  if v_row.status = 'FINALIZED' then
    select * into v_payment from public.license_payments where private_object_upload_id = v_row.id;
    if found then
      return v_payment;
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

  select * into v_offer from public.get_license_offer();
  insert into public.project_licenses (project_id) values (v_row.project_id) on conflict (project_id) do nothing;
  insert into public.license_payments (project_id, private_object_upload_id, declared_by_profile_id, declared_role, offer_label, offer_duration_months,
                                       offer_price_fcfa, offer_price_is_demo, amount_fcfa, operator, payment_reference, paid_on, payer_name,
                                       proof_mime_type, proof_size_bytes, disclaimer_acknowledged_at, created_at_server)
  values (v_row.project_id, v_row.id, v_uid, v_party, v_offer.label, v_offer.duration_months, v_offer.price_fcfa, v_offer.price_is_demo,
          v_target.amount_fcfa, v_target.operator, v_target.payment_reference, v_target.paid_on, v_target.payer_name,
          v_row.expected_mime_type, v_row.expected_size_bytes, v_target.disclaimer_acknowledged_at, v_now)
  returning * into v_payment;
  update public.private_object_uploads set entity_id = v_payment.id where id = v_row.id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_uid, 'LICENSE_PAYMENT_DECLARED', 'license_payments', v_payment.id, 'SUCCESS',
          jsonb_build_object('operator', v_payment.operator, 'declared_role', v_party), 'Paiement de licence déclaré, en attente de vérification.');
  return v_payment;
end;
$$;

-- Annulation par le déclarant (L9) : motif, tant qu'elle est en attente.
create function public.cancel_license_payment(p_payment_id uuid, p_reason text)
returns public.license_payments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.license_payments;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select * into v_row from public.license_payments where id = p_payment_id;
  if not found then
    raise exception 'not_authorized';
  end if;
  perform public.license_require_declarant(v_row.project_id);
  select * into v_row from public.license_payments where id = p_payment_id for update;
  if v_row.declared_by_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;
  if v_row.status <> 'PENDING_REVIEW' then
    raise exception 'invalid_transition';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  update public.license_payments set status = 'CANCELLED', cancelled_at_server = clock_timestamp(), cancel_reason = v_reason
  where id = v_row.id returning * into v_row;
  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_row.project_id, 'HUMAN', v_uid, 'LICENSE_PAYMENT_CANCELLED', 'license_payments', v_row.id, 'SUCCESS', '{}'::jsonb, v_reason);
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lecture.
-- ---------------------------------------------------------------------------
-- État de la licence (L4) : tout membre actif ; aucun montant, aucune preuve.
create function public.get_project_license(p_project_id uuid)
returns table (status text, starts_on date, ends_on date, has_pending_declaration boolean, can_declare boolean)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_party text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_party := public.document_party(p_project_id, auth.uid());
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  return query
    select coalesce(l.status, 'NONE'), l.starts_on, l.ends_on,
           exists (select 1 from public.license_payments p where p.project_id = p_project_id and p.status = 'PENDING_REVIEW'),
           v_party in ('CONTRACTOR', 'OWNER_PRIMARY')
    from (select 1) as one
    left join public.project_licenses l on l.project_id = p_project_id;
end;
$$;

-- Déclarations : chaque déclarant voit les siennes seulement (L4).
create function public.list_my_license_payments(p_project_id uuid)
returns table (id uuid, status text, offer_label text, offer_price_fcfa bigint, offer_price_is_demo boolean, amount_fcfa bigint, operator text,
               payment_reference text, paid_on date, payer_name text, proof_mime_type text, proof_size_bytes bigint,
               created_at_server timestamptz, cancelled_at_server timestamptz, cancel_reason text, can_cancel boolean)
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
           p.status = 'PENDING_REVIEW' and v_party in ('CONTRACTOR', 'OWNER_PRIMARY')
    from public.license_payments p
    where p.project_id = p_project_id and p.declared_by_profile_id = v_uid
    order by p.created_at_server desc;
end;
$$;

-- Clé de la preuve : le déclarant seul, adhésion active (l'administrateur en B049).
create function public.get_license_proof_file_key(p_payment_id uuid)
returns table (bucket text, storage_key text, mime_type text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.license_payments;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select * into v_row from public.license_payments where id = p_payment_id;
  if not found or v_row.declared_by_profile_id <> v_uid or public.document_party(v_row.project_id, v_uid) is null then
    raise exception 'not_authorized';
  end if;
  return query
    select 'license-proofs'::text, u.storage_key, v_row.proof_mime_type
    from public.private_object_uploads u where u.id = v_row.private_object_upload_id and u.status = 'FINALIZED';
  if not found then
    raise exception 'file_not_finalized';
  end if;
end;
$$;

revoke execute on function public.get_license_offer(), public.prepare_license_payment_upload(uuid, uuid, text, text, text, date, text, boolean, text, bigint, text),
  public.finalize_license_payment_upload(uuid), public.cancel_license_payment(uuid, text), public.get_project_license(uuid),
  public.list_my_license_payments(uuid), public.get_license_proof_file_key(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_license_offer(), public.prepare_license_payment_upload(uuid, uuid, text, text, text, date, text, boolean, text, bigint, text),
  public.finalize_license_payment_upload(uuid), public.cancel_license_payment(uuid, text), public.get_project_license(uuid),
  public.list_my_license_payments(uuid), public.get_license_proof_file_key(uuid)
  to authenticated;

-- Nettoyage (service_role), même principe que M039 et M046.
create function public.list_expired_license_proof_uploads(p_older_than interval default interval '1 hour')
returns table (id uuid, project_id uuid, attempt_expires_at timestamptz)
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.project_id, u.attempt_expires_at
  from public.private_object_uploads u
  where u.entity_type = 'license_proof' and u.status in ('PENDING', 'FINALIZING') and u.attempt_expires_at < now() - p_older_than;
$$;

create function public.abandon_expired_license_proof_upload(p_id uuid, p_older_than interval default interval '1 hour')
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.private_object_uploads;
begin
  select * into v_row from public.private_object_uploads where id = p_id for update;
  if not found or v_row.entity_type <> 'license_proof' then
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

revoke execute on function public.list_expired_license_proof_uploads(interval), public.abandon_expired_license_proof_upload(uuid, interval)
  from public, anon, authenticated, service_role;
grant execute on function public.list_expired_license_proof_uploads(interval), public.abandon_expired_license_proof_upload(uuid, interval)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. get_stale_key_bucket, claim_upload_attempt, recover_media_upload_attempt,
--    get_upload_status : reprises à l'identique de M046 ; SEULE la branche
--    license_proof est ajoutée (verrou avisoire -> adhésion de déclarant
--    active -> ligne, compte vérifié relu, créateur = déclarant).
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
    when 'license_proof' then 'license-proofs'
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

  if v_peek_entity_type = 'license_proof' then
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
  elsif v_row.entity_type = 'license_proof' then
    v_authorized := true; -- déclarant (principal ou entreprise) revérifié ci-dessus sous verrou ; créateur = déclarant.
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

  if v_peek_entity_type = 'license_proof' then
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
  elsif v_row.entity_type = 'license_proof' then
    v_authorized := true; -- déclarant revérifié ci-dessus sous verrou ; créateur = déclarant.
    if public.is_account_provisional() is not false then
      raise exception 'account_provisional' using errcode = '42501';
    end if;
    v_path_prefix := '_private/' || v_row.project_id::text || '/license_proof/' || v_row.operation_uuid::text;
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
  elsif v_row.entity_type = 'license_proof' then
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
