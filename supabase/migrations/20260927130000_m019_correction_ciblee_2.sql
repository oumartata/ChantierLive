-- Correction ciblée B061 (revue, complément point 3) — decide_catalog_item_
-- validation et get_catalog_item_validation_file_key vérifiaient encore
-- is_account_provisional() AVANT tout verrou potentiellement bloquant
-- (désignation, puis ligne de validation) — même défaut que finalize_
-- catalog_item_upload AVANT sa correction (20260927120000), non reporté ici
-- par erreur lors de cette première correction. Revérifié maintenant APRÈS
-- les deux verrous, immédiatement avant l'action sensible (transition pour
-- decide, restitution de la clé pour get_file_key) — jamais avant une
-- attente susceptible de rendre ce contrôle obsolète.
-- N'modifie pas 20260927090000/100000/110000/120000 déjà appliquées :
-- CREATE OR REPLACE additif, grants préservés (revérifiés après application).

begin;

create or replace function public.decide_catalog_item_validation(
  p_validation_id uuid,
  p_decision text,
  p_note text
)
returns public.plan_catalog_item_validations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_designation_id uuid;
  v_designation public.plan_engineer_designations;
  v_row public.plan_catalog_item_validations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_decision not in ('VALIDATED', 'REJECTED') then
    raise exception 'invalid_decision';
  end if;

  select designation_id into v_designation_id
  from public.plan_catalog_item_validations where id = p_validation_id;

  if v_designation_id is null then
    raise exception 'not_authorized';
  end if;

  -- Verrou POTENTIELLEMENT BLOQUANT : une désignation active peut être
  -- concurremment manipulée (révocation) par son propriétaire.
  select * into v_designation from public.plan_engineer_designations where id = v_designation_id for update;
  if not found or v_designation.revoked_at is not null or v_designation.engineer_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  -- Verrou POTENTIELLEMENT BLOQUANT : une soumission concurrente sur la même
  -- version peut clôturer cette ligne (voir submit_catalog_item_version_for_validation).
  select * into v_row from public.plan_catalog_item_validations where id = p_validation_id for update;
  if not found or v_row.designation_id <> v_designation.id then
    raise exception 'not_authorized';
  end if;

  if v_row.status <> 'PENDING' then
    raise exception 'already_decided';
  end if;

  -- Revérifié ICI, APRÈS les deux verrous ci-dessus (jamais avant une
  -- attente susceptible de le rendre obsolète) — immédiatement avant la
  -- transition. Un refus ici ne modifie RIEN : aucun UPDATE n'a encore été
  -- exécuté.
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  update public.plan_catalog_item_validations
  set status = p_decision, decided_at_server = clock_timestamp(), decided_by_profile_id = v_uid,
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.get_catalog_item_validation_file_key(p_validation_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_designation_id uuid;
  v_designation public.plan_engineer_designations;
  v_row public.plan_catalog_item_validations;
  v_version public.plan_catalog_item_versions;
  v_upload public.private_object_uploads;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select designation_id into v_designation_id
  from public.plan_catalog_item_validations where id = p_validation_id;

  if v_designation_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_designation from public.plan_engineer_designations where id = v_designation_id for update;
  if not found or v_designation.revoked_at is not null or v_designation.engineer_profile_id <> v_uid then
    raise exception 'not_authorized';
  end if;

  select * into v_row from public.plan_catalog_item_validations where id = p_validation_id for update;
  if not found or v_row.designation_id <> v_designation.id or v_row.status <> 'PENDING' then
    raise exception 'not_authorized';
  end if;

  select * into v_version from public.plan_catalog_item_versions where id = v_row.version_id;
  if not found then
    raise exception 'not_authorized';
  end if;

  select * into v_upload from public.private_object_uploads where id = v_version.private_object_upload_id;
  if not found or v_upload.status <> 'FINALIZED' then
    raise exception 'file_not_finalized';
  end if;

  -- Revérifié ICI, APRÈS les deux verrous ci-dessus, immédiatement avant de
  -- restituer la clé — un refus ne délivre RIEN et ne modifie aucune ligne
  -- (fonction strictement lectrice au-delà de ses deux verrous).
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return v_upload.storage_key;
end;
$$;

commit;
