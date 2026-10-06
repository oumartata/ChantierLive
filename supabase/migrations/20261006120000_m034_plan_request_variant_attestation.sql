-- M034 — validation à l'écriture des variantes de demandes de plan
-- (PREPARATION_VALIDATION_VARIANTES.md, 2026-10-06). Défaut reproduit avant
-- ce lot : save_plan_request_variant(uuid, uuid, jsonb), exécutable par
-- `authenticated`, enregistrait N'IMPORTE QUEL json comme plan (JSON
-- quelconque, référence de pièce invalide, autorisations F2 invalides),
-- l'action serveur ne validant rien. La validation (validateProjectFile,
-- TypeScript) ne peut pas tourner en SQL : même principe de frontière de
-- confiance que M032b (catalogue), adapté — le plan validé est déposé par
-- l'action serveur (service_role SEUL) dans une ATTESTATION liée au profil
-- authentifié, à la demande et à une opération précise ; l'enregistrement,
-- appelé par l'utilisateur avec SES contrôles de session et de droits
-- inchangés (auth.uid(), rôle, compte non provisoire, demande ouverte,
-- parent), ne reçoit plus de plan en argument : il consomme l'attestation
-- et crée la variante dans la même transaction. Jamais une réécriture de
-- M031/M031b (fichiers laissés tels quels) ; aucune donnée existante
-- modifiée (les variantes déjà enregistrées gardent operation_uuid nul).

begin;

-- ---------------------------------------------------------------------------
-- Attestations : contenu VALIDÉ par l'action serveur, en attente
-- d'enregistrement. Jamais lisible ni modifiable par authenticated/anon.
-- ---------------------------------------------------------------------------
create table public.project_plan_request_variant_attestations (
  operation_uuid uuid primary key,
  request_id uuid not null references public.project_plan_requests(id),
  profile_id uuid not null references public.profiles(id),
  layout jsonb not null,
  attested_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz null,
  variant_id uuid null references public.project_plan_request_variants(id),
  constraint ppr_variant_attestations_layout_object check (jsonb_typeof(layout) = 'object'),
  constraint ppr_variant_attestations_layout_size check (octet_length(layout::text) <= 2097152),
  constraint ppr_variant_attestations_consumed_coherent check ((consumed_at is null) = (variant_id is null))
);

alter table public.project_plan_request_variant_attestations enable row level security;
revoke all on table public.project_plan_request_variant_attestations from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reprise sans doublon : une opération produit au plus une variante.
-- Colonne nulle pour toutes les variantes antérieures (aucune réécriture).
-- ---------------------------------------------------------------------------
alter table public.project_plan_request_variants
  add column operation_uuid uuid null;
alter table public.project_plan_request_variants
  add constraint project_plan_request_variants_operation_unique unique (operation_uuid);

-- Le déclencheur d'immuabilité fige aussi operation_uuid (corps M031
-- repris à l'identique, une condition ajoutée).
create or replace function public.reject_project_plan_request_variant_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'project_plan_request_variant_immutable';
  end if;
  if old.project_plan_version_id is not null then
    raise exception 'project_plan_request_variant_immutable';
  end if;
  if new.request_id <> old.request_id
     or new.project_id <> old.project_id
     or coalesce(new.parent_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
        <> coalesce(old.parent_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
     or new.variant_number <> old.variant_number
     or new.layout <> old.layout
     or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_at_server <> old.created_at_server
     or new.operation_uuid is distinct from old.operation_uuid then
    raise exception 'project_plan_request_variant_immutable';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- attest_plan_request_variant_layout — SEULE porte d'entrée d'un plan de
-- variante. Réservée au service_role (aucun grant à authenticated/anon),
-- appelée uniquement par l'action serveur APRÈS validateProjectFile, avec
-- le profil lu dans la session serveur (jamais déclaré par le client).
-- Idempotente pour le MÊME contenu, la même demande et le même profil ;
-- refuse toute autre combinaison sous la même opération.
-- ---------------------------------------------------------------------------
create function public.attest_plan_request_variant_layout(
  p_operation_uuid uuid,
  p_request_id uuid,
  p_profile_id uuid,
  p_layout jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.project_plan_request_variant_attestations;
begin
  if p_operation_uuid is null or p_request_id is null or p_profile_id is null then
    raise exception 'attestation_invalid';
  end if;
  if p_layout is null or jsonb_typeof(p_layout) <> 'object' then
    raise exception 'layout_invalid_format';
  end if;
  if octet_length(p_layout::text) > 2097152 then
    raise exception 'layout_too_large';
  end if;

  select * into v_row
  from public.project_plan_request_variant_attestations
  where operation_uuid = p_operation_uuid
  for update;

  if found then
    if v_row.request_id <> p_request_id or v_row.profile_id <> p_profile_id or v_row.layout <> p_layout then
      raise exception 'attestation_conflict';
    end if;
    return;
  end if;

  insert into public.project_plan_request_variant_attestations (operation_uuid, request_id, profile_id, layout)
  values (p_operation_uuid, p_request_id, p_profile_id, p_layout);
end;
$$;

revoke execute on function public.attest_plan_request_variant_layout(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.attest_plan_request_variant_layout(uuid, uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- save_plan_request_variant : l'ancienne signature (plan libre en argument)
-- est SUPPRIMÉE ; la nouvelle reçoit l'opération attestée. Contrôles de
-- session et de droits repris À L'IDENTIQUE de M031b, toujours exécutés,
-- y compris lors d'une reprise. Reprise d'une opération déjà consommée
-- (réponse réseau perdue) : renvoie la MÊME variante, sans rien écrire —
-- même si la demande n'est plus ouverte depuis — à condition que profil,
-- demande et parent soient identiques. Sinon : demande ouverte exigée.
-- ---------------------------------------------------------------------------
drop function public.save_plan_request_variant(uuid, uuid, jsonb);

create function public.save_plan_request_variant(p_request_id uuid, p_parent_variant_id uuid, p_operation_uuid uuid)
returns public.project_plan_request_variants
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_request public.project_plan_requests;
  v_membership record;
  v_attestation public.project_plan_request_variant_attestations;
  v_next_number integer;
  v_row public.project_plan_request_variants;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select * into v_request from public.project_plan_requests where id = p_request_id for update;
  if not found then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('plan_request:' || v_request.project_id::text)::bigint);

  select role, owner_profile into v_membership
  from public.project_memberships
  where project_id = v_request.project_id
    and profile_id = v_uid
    and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile = 'PRIMARY'))
  for update;

  if not found then
    raise exception 'not_authorized';
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if p_operation_uuid is null then
    raise exception 'layout_not_attested';
  end if;

  select * into v_attestation
  from public.project_plan_request_variant_attestations
  where operation_uuid = p_operation_uuid
  for update;

  if not found then
    raise exception 'layout_not_attested';
  end if;

  -- Substitution de profil ou de demande : jamais acceptée.
  if v_attestation.profile_id <> v_uid or v_attestation.request_id <> p_request_id then
    raise exception 'not_authorized';
  end if;

  -- Reprise identique : la variante existe déjà pour cette opération.
  if v_attestation.consumed_at is not null then
    select * into v_row from public.project_plan_request_variants where id = v_attestation.variant_id;
    if v_row.parent_variant_id is distinct from p_parent_variant_id then
      raise exception 'attestation_conflict';
    end if;
    return v_row;
  end if;

  if v_request.status <> 'OPEN' then
    raise exception 'request_not_open';
  end if;

  if p_parent_variant_id is not null and not exists (
    select 1 from public.project_plan_request_variants where id = p_parent_variant_id and request_id = p_request_id
  ) then
    raise exception 'parent_variant_not_found';
  end if;

  select coalesce(max(variant_number), 0) + 1 into v_next_number
  from public.project_plan_request_variants
  where request_id = p_request_id;

  insert into public.project_plan_request_variants (
    request_id, project_id, parent_variant_id, variant_number, layout, created_by_profile_id, operation_uuid
  ) values (
    p_request_id, v_request.project_id, p_parent_variant_id, v_next_number, v_attestation.layout, v_uid, p_operation_uuid
  )
  returning * into v_row;

  update public.project_plan_request_variant_attestations
  set consumed_at = clock_timestamp(), variant_id = v_row.id
  where operation_uuid = p_operation_uuid;

  return v_row;
end;
$$;

revoke execute on function public.save_plan_request_variant(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_plan_request_variant(uuid, uuid, uuid) to authenticated;

commit;
