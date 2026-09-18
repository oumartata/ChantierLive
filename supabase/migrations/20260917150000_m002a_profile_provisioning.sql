-- M002a — provisioning du profil à l'inscription et synchronisation des
-- identifiants Auth (documentaire, dépend de M002, ne le modifie pas)
-- MVP_BACKLOG.csv B012 "Implémenter inscription e-mail/téléphone et connexion"
--
-- Arbitrages fondateur B012 (2026-09-17) :
--   - trigger transactionnel sur auth.users (AFTER INSERT + AFTER UPDATE),
--     SECURITY DEFINER, création de public.profiles et synchronisation de
--     public.profile_identifiers ; profiles.archived_at jamais touché ici.
--   - la confirmation (email_confirmed_at/phone_confirmed_at) n'est reprise
--     que si elle porte sur la MÊME transition de ligne que la valeur
--     concernée : aucune confirmation héritée d'un ancien identifiant.
--   - un identifiant remis à NULL/vide archive sa ligne active sans en créer
--     de nouvelle ; une perte de confirmation à valeur inchangée efface
--     verified_at_server sur la ligne active (le compte peut redevenir
--     provisional, calcul dérivé, aucune colonne ajoutée).
--   - is_account_provisional() : sans argument, identité via auth.uid()
--     uniquement, retourne TRUE (provisional) si identité ou profil absent
--     — échec fermé, aucun accès sensible accordé par défaut.

begin;

-- --------------------------------------------------------------------------
-- Fonction interne partagée : synchronise un identifiant (EMAIL ou PHONE)
-- pour un profil donné, à partir des valeurs avant/après d'auth.users.
-- --------------------------------------------------------------------------

create function public.sync_auth_identifier(
  p_profile_id uuid,
  p_kind public.identifier_kind,
  p_old_value text,
  p_new_value text,
  p_old_confirmed_at timestamptz,
  p_new_confirmed_at timestamptz
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_normalized text;
  v_old_blank boolean;
  v_new_blank boolean;
begin
  v_old_blank := p_old_value is null or btrim(p_old_value) = '';
  v_new_blank := p_new_value is null or btrim(p_new_value) = '';

  -- Identifiant retiré (NULL ou vide) : archiver la ligne active, rien de
  -- plus. Le compte redevient provisional si c'était le seul vérifié
  -- (calcul dérivé par is_account_provisional, aucune colonne à mettre à jour).
  if v_new_blank then
    if not v_old_blank then
      update public.profile_identifiers
        set archived_at = now()
        where profile_id = p_profile_id
          and kind = p_kind
          and archived_at is null;
    end if;
    return;
  end if;

  if p_kind = 'EMAIL' then
    v_normalized := lower(btrim(p_new_value));
  else
    -- auth.users.phone est stocké par GoTrue sans le préfixe "+" (constaté
    -- empiriquement) ; profile_identifiers exige le format E.164 avec "+"
    -- (M002, profile_identifiers_phone_canonical). Reformatage explicite,
    -- jamais une confiance aveugle dans le format Auth.
    v_normalized := btrim(p_new_value);
    if left(v_normalized, 1) <> '+' then
      v_normalized := '+' || v_normalized;
    end if;
  end if;

  -- Première apparition (inscription ou ajout) : nouvelle ligne. La
  -- confirmation vient de la MÊME ligne NEW, jamais d'un état antérieur.
  if v_old_blank then
    insert into public.profile_identifiers (profile_id, kind, value_normalized, verified_at_server)
      values (p_profile_id, p_kind, v_normalized, p_new_confirmed_at);
    return;
  end if;

  if p_old_value = p_new_value then
    -- Valeur inchangée : seule la confirmation peut évoluer (gagnée ou
    -- perdue). Ne rien faire si rien n'a changé.
    if p_old_confirmed_at is distinct from p_new_confirmed_at then
      update public.profile_identifiers
        set verified_at_server = p_new_confirmed_at
        where profile_id = p_profile_id
          and kind = p_kind
          and archived_at is null;
    end if;
    return;
  end if;

  -- Remplacement : archiver l'ancienne ligne active, insérer une nouvelle
  -- avec la confirmation de la MÊME ligne NEW (jamais celle de l'ancienne
  -- valeur, même si p_old_confirmed_at était renseigné).
  update public.profile_identifiers
    set archived_at = now()
    where profile_id = p_profile_id
      and kind = p_kind
      and archived_at is null;

  insert into public.profile_identifiers (profile_id, kind, value_normalized, verified_at_server)
    values (p_profile_id, p_kind, v_normalized, p_new_confirmed_at);
end;
$$;

revoke execute on function public.sync_auth_identifier(uuid, public.identifier_kind, text, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

-- --------------------------------------------------------------------------
-- Trigger AFTER INSERT ON auth.users : crée profiles + profile_identifiers.
-- --------------------------------------------------------------------------

create function public.provision_profile_on_signup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into public.profiles (id) values (new.id);
  perform public.sync_auth_identifier(new.id, 'EMAIL', null, new.email, null, new.email_confirmed_at);
  perform public.sync_auth_identifier(new.id, 'PHONE', null, new.phone, null, new.phone_confirmed_at);
  return new;
end;
$$;

revoke execute on function public.provision_profile_on_signup() from public, anon, authenticated, service_role;

create trigger provision_profile_on_signup
after insert on auth.users
for each row execute function public.provision_profile_on_signup();

-- --------------------------------------------------------------------------
-- Trigger AFTER UPDATE ON auth.users : synchronise les changements de
-- valeur et/ou de confirmation. Ne touche jamais public.profiles.
-- --------------------------------------------------------------------------

create function public.sync_profile_on_auth_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.sync_auth_identifier(new.id, 'EMAIL', old.email, new.email, old.email_confirmed_at, new.email_confirmed_at);
  perform public.sync_auth_identifier(new.id, 'PHONE', old.phone, new.phone, old.phone_confirmed_at, new.phone_confirmed_at);
  return new;
end;
$$;

revoke execute on function public.sync_profile_on_auth_update() from public, anon, authenticated, service_role;

create trigger sync_profile_on_auth_update
after update on auth.users
for each row execute function public.sync_profile_on_auth_update();

-- --------------------------------------------------------------------------
-- is_account_provisional() — état dérivé, aucune colonne ajoutée.
-- --------------------------------------------------------------------------

create function public.is_account_provisional()
returns boolean
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    return true;
  end if;

  if not exists (select 1 from public.profiles p where p.id = auth.uid()) then
    return true;
  end if;

  return not exists (
    select 1
    from public.profile_identifiers pi
    where pi.profile_id = auth.uid()
      and pi.verified_at_server is not null
      and pi.archived_at is null
  );
end;
$$;

revoke execute on function public.is_account_provisional() from public, anon, authenticated, service_role;
grant execute on function public.is_account_provisional() to authenticated;

commit;
