-- M030 — complément B015/B016 : le parcours d'entrée par invitation doit
-- pouvoir détecter, AVANT de proposer "Accepter", qu'un appelant authentifié
-- est déjà membre actif du chantier — jamais seulement après un refus
-- serveur réactif. get_invitation_preview reste accessible à anon (BR024,
-- inchangé) ; le nouveau champ "already_member" n'est calculé que pour un
-- appelant authentifié et ne révèle jamais rien au-delà de SA PROPRE
-- adhésion — aucun assouplissement, aucune information supplémentaire pour
-- un appelant anonyme ou sur l'adhésion d'autrui.

begin;

alter type public.invitation_preview add attribute already_member boolean;

create or replace function public.get_invitation_preview(p_token text)
returns public.invitation_preview
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_hash bytea;
  v_row record;
  v_unavailable public.invitation_preview;
  v_already_member boolean := false;
begin
  v_unavailable := (null, null, null, null, false, null);

  if p_token is null or btrim(p_token) = '' then
    return v_unavailable;
  end if;

  v_hash := extensions.digest(p_token, 'sha256');

  -- Recherche indexée par hash (index unique sur token_hash) : aucune
  -- garantie de complexité annoncée au-delà de ça.
  --
  -- JOIN sur project_memberships avec la même matrice émetteur/bénéficiaire
  -- que create_invitation, PLUS authorization_revision inchangée : une
  -- invitation dont l'adhésion émettrice a été révoquée OU dont le rôle a
  -- changé (y compris un aller-retour A->B->A, détecté par la révision, pas
  -- par la valeur courante) ne remonte simplement plus de ligne ici — sans
  -- cette jointure, l'aperçu restait "disponible" avec le nom du chantier
  -- pour une invitation déjà invalidée par ailleurs (bug corrigé).
  select i.project_id, i.role, i.owner_profile, i.expires_at, i.status, p.name as project_name
  into v_row
  from public.invitations i
  join public.projects p on p.id = i.project_id
  join public.project_memberships pm on pm.id = i.created_by_membership_id
  where i.token_hash = v_hash
    and pm.revoked_at is null
    and pm.authorization_revision = i.created_by_membership_revision
    and (
      (i.role = 'CONTRACTOR' and pm.role = 'OWNER' and pm.owner_profile = 'PRIMARY')
      or (i.role = 'OWNER' and i.owner_profile = 'CO_OWNER' and pm.role = 'OWNER' and pm.owner_profile = 'PRIMARY')
      or (i.role = 'OWNER' and i.owner_profile = 'PRIMARY' and pm.role = 'CONTRACTOR')
      or (i.role = 'SITE_MANAGER' and pm.role = 'CONTRACTOR')
    )
  limit 1;

  -- Statuts indistincts (inexistant, expiré, refusé, révoqué, déjà accepté,
  -- OU émetteur invalidé ci-dessus) -> même résultat "non disponible", pour
  -- ne rien révéler avant authentification (BR024). Aucun nom d'émetteur :
  -- profiles ne porte aucune colonne de nom affichable (M002).
  if not found or v_row.status <> 'PENDING' or v_row.expires_at <= now() then
    return v_unavailable;
  end if;

  -- M030 : uniquement pour un appelant authentifié, sur SA PROPRE adhésion.
  -- auth.uid() est toujours null pour anon : cette branche ne s'exécute
  -- jamais pour un appelant non authentifié, v_already_member reste false
  -- (identique, en pratique, à "pas de compte donc pas déjà membre").
  if auth.uid() is not null then
    select exists (
      select 1 from public.project_memberships
      where project_id = v_row.project_id
        and profile_id = auth.uid()
        and revoked_at is null
    ) into v_already_member;
  end if;

  return (v_row.project_name, v_row.role, v_row.owner_profile, v_row.expires_at, true, v_already_member);
end;
$$;

commit;
