# Préparation — validation à l'écriture des variantes de demandes de plan

Diagnostic et proposition du 2026-10-06. Point de départ : HEAD `b863907`.
**Aucune migration appliquée, aucun code applicatif modifié.**

## 1. Défaut reproduit (Supabase local, données de démonstration)

Le compte de démonstration (rôle CONTRACTOR, chantier de démonstration) a
appelé directement `save_plan_request_variant` sur la demande ouverte
`44da7fdf-…`. Script et résultat :
`exports/preuves/validation-variantes-2026-10-06/` (hors Git). Aucun secret
n'est affiché.

| Contenu envoyé par appel direct | Écrit ? | Relecture par `validateProjectFile` |
|---|---|---|
| JSON qui n'est pas un fichier de projet (`{"bonjour": …}`) | **oui** (variante 2) | invalide : « numéro de version manquant » |
| Porte vers une pièce inexistante (`roomIndex` 999) | **oui** (variante 3) | invalide : « portes référencent une pièce inexistante » |
| Autorisations F2 invalides (borne > référence) | **oui** (variante 4), 4 autorisations stockées | valide v4, **autorisations écartées avec avis** |
| Témoin valide v4 | oui (variante 5) | valide v4 |
| Témoin valide v5 (F2, 4 autorisations) | oui (variante 6) | valide v5 |

Le contenu stocké est le JSON envoyé, à l'ordre des clés près (`jsonb`).
Les variantes 2 à 6 restent en base comme données de démonstration : rien
n'a été nettoyé ni réécrit.

## 2. Voies d'écriture (vérifiées dans la base locale, en lecture seule)

| Voie | Écrit le plan d'une variante ? | Accès |
|---|---|---|
| Action serveur `savePlanRequestVariantAction` (`chantiers/[id]/plans/actions.ts`) | oui, via la RPC ci-dessous, **sans aucune validation** (`JSON.parse` puis transmission) | utilisateur vérifié |
| RPC `save_plan_request_variant(uuid, uuid, jsonb)` (m031b, `security definer`) | **oui (seul `insert`)** : contrôles de rôle (CONTRACTOR, ou OWNER PRIMARY), de compte non provisoire, de demande ouverte et de parent ; `layout` seulement « non nul » | `authenticated` (EXECUTE) |
| RPC `finalize_plan_request_variant_deposit` | non : met à jour `project_plan_version_id` et `deposited_at_server`, sans relire le plan | `authenticated` |
| Accès direct à la table `project_plan_request_variants` | non pour `authenticated` et `anon` : aucun droit, sécurité par ligne active sans politique | `service_role` et `postgres` seulement |
| Déclencheur `reject_mutation` | interdit toute suppression, et toute modification du plan ou de l'identité après insertion | — |

**Seule voie à fermer** : l'**insertion** par `save_plan_request_variant`.
Le plan est ensuite immuable.

**Trois niveaux à distinguer** :
- **Format** : enveloppe `version`, `savedAt`, `orientation` et `layout`,
  version prise en charge.
- **Cohérence structurelle** : types, nombres finis, références de pièces
  dans les portes et fenêtres, autorisations F2 strictes. C'est ce que
  fait déjà `validateProjectFile`.
- **Admissibilité géométrique** (`independentVerify` : chevauchements,
  accès, fenêtres) : **non exigée par cette proposition**. Une variante
  peut légitimement être un brouillon incomplet ; l'exiger serait une
  règle nouvelle, à décider séparément. Le dépôt, lui, est déjà bloqué
  côté éditeur pour un brouillon en anomalie.

## 3. Contraintes qui orientent la solution

- **La validation est en TypeScript** (`validateProjectFile`) et ne peut
  pas tourner en SQL, sauf à la dupliquer, ce qui a déjà été écarté pour
  le catalogue (m032b).
- **Les contrôles de droits de la RPC reposent sur `auth.uid()`**, y
  compris `is_account_provisional()`. Une fonction réservée à
  `service_role` appelée sans session les ferait échouer ou obligerait à
  les réécrire, au risque de modifier les permissions.
- **Le mécanisme du catalogue (m032b) n'est pas applicable tel quel.**
  Son attestation s'appuie sur une ligne `private_object_uploads` préparée
  par l'utilisateur (`prepare_catalog_item_upload`), qui lie l'opération
  à son auteur. Les variantes n'ont pas de téléversement, donc pas de
  telle ligne. Il faut une table d'attestation dédiée, liée **au profil,
  à la demande et au contenu exact**, et à usage unique.

## 4. Proposition (option recommandée : attestation dédiée, contenu porté par l'attestation)

### 4.1 Base (migration m033, à créer, **non appliquée**)

```sql
-- m033 — validation à l'écriture des variantes de demandes (PROPOSITION)
begin;

-- Attestations : contenu VALIDÉ par l'action serveur, en attente
-- d'enregistrement. Jamais lisible ni modifiable par authenticated/anon.
create table public.project_plan_request_variant_attestations (
  operation_uuid uuid primary key,
  request_id uuid not null references public.project_plan_requests(id),
  profile_id uuid not null,
  layout jsonb not null,
  layout_sha256 text not null,
  attested_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz null,
  constraint ppr_variant_attestation_layout_size check (octet_length(layout::text) <= 2097152)
);
alter table public.project_plan_request_variant_attestations enable row level security;
revoke all on public.project_plan_request_variant_attestations from public, anon, authenticated;

-- Reprise sans doublon : une opération = au plus une variante.
alter table public.project_plan_request_variants add column operation_uuid uuid null unique;
-- Le déclencheur reject_mutation doit aussi figer operation_uuid
-- (ajouter : or new.operation_uuid is distinct from old.operation_uuid).

-- Attestation : service_role SEULEMENT. Idempotente pour le MÊME contenu ;
-- refuse un AUTRE contenu, une autre demande ou un autre profil sous la
-- même opération (jamais réutilisable pour un autre contenu).
create function public.attest_plan_request_variant_layout(
  p_operation_uuid uuid, p_request_id uuid, p_profile_id uuid, p_layout jsonb, p_layout_sha256 text
) returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_row public.project_plan_request_variant_attestations;
begin
  if p_layout is null or jsonb_typeof(p_layout) <> 'object' then raise exception 'layout_invalid_format'; end if;
  if octet_length(p_layout::text) > 2097152 then raise exception 'layout_too_large'; end if;
  select * into v_row from public.project_plan_request_variant_attestations where operation_uuid = p_operation_uuid for update;
  if found then
    if v_row.request_id <> p_request_id or v_row.profile_id <> p_profile_id or v_row.layout_sha256 <> p_layout_sha256 then
      raise exception 'attestation_conflict';
    end if;
    return; -- même contenu : reprise idempotente
  end if;
  insert into public.project_plan_request_variant_attestations (operation_uuid, request_id, profile_id, layout, layout_sha256)
  values (p_operation_uuid, p_request_id, p_profile_id, p_layout, p_layout_sha256);
end; $$;
revoke execute on function public.attest_plan_request_variant_layout(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.attest_plan_request_variant_layout(uuid, uuid, uuid, jsonb, text) to service_role;

-- Enregistrement : MÊMES contrôles qu'aujourd'hui (auth.uid(), rôle,
-- compte non provisoire, demande OPEN, parent), mais le layout vient
-- EXCLUSIVEMENT de l'attestation : plus aucun layout fourni par l'appelant.
drop function public.save_plan_request_variant(uuid, uuid, jsonb);
create function public.save_plan_request_variant(p_request_id uuid, p_parent_variant_id uuid, p_operation_uuid uuid)
returns public.project_plan_request_variants language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
-- … contrôles existants inchangés (copiés de m031b) …
-- 1) attestation : select … for update where operation_uuid = p_operation_uuid ;
--    absente → 'layout_not_attested' ; profile_id <> auth.uid() ou
--    request_id <> p_request_id → 'not_authorized'.
-- 2) déjà consommée → renvoyer la variante existante (operation_uuid) :
--    reprise après échec SANS doublon.
-- 3) insert (…, layout = attestation.layout, operation_uuid = p_operation_uuid) ;
--    consumed_at = clock_timestamp().
$$;
revoke execute on function public.save_plan_request_variant(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_plan_request_variant(uuid, uuid, uuid) to authenticated;
commit;
```

**Propriétés** :
- **Appel direct par `authenticated`** :
  - plus aucune fonction n'accepte un plan en argument (l'ancienne
    signature est supprimée, comme `finalize_catalog_item_upload` en
    m032b) ;
  - l'attestation n'est pas exécutable (`42501`) ;
  - la table d'attestation est inaccessible ;
  - une opération non attestée est refusée.
- **Liaison au contenu exact** : le plan enregistré est **celui stocké
  dans l'attestation**, et non un plan resoumis. Son empreinte SHA-256
  sert seulement à refuser qu'une même opération soit réattestée avec un
  autre contenu. L'attestation est liée au profil et à la demande, et
  devient à usage unique une fois consommée.
- **Permissions** : inchangées. Les contrôles de rôle et de compte
  restent dans la fonction appelée par l'utilisateur, sous
  `auth.uid()`.
- **Données existantes** : aucune réécriture. Les anciennes variantes
  gardent `operation_uuid` nul, restent lisibles, et la lecture continue
  de les filtrer.

### 4.2 Action serveur (`chantiers/[id]/plans/actions.ts`, `savePlanRequestVariantAction`)

1. Lire `operation_uuid` (UUID fourni par le client et conservé entre les
   tentatives, comme pour le dépôt) en plus de `request_id`,
   `parent_variant_id` et `layout`.
2. `validateProjectFile(JSON.parse(layout))` : en cas d'échec, refus
   « Fichier de projet invalide : … ».
3. **Avis non vide** (autorisations F2 invalides, ou présentes dans un
   fichier < v5) : **refus explicite**, jamais un enregistrement corrigé
   en silence. Message : « Les autorisations d'adaptation de ce plan sont
   invalides (…). Corrigez-les ou révoquez-les, puis enregistrez à
   nouveau. »
4. Contenu attesté = `validated.value` (fichier validé, version
   normalisée par `projectFileVersionFor`). SHA-256 du JSON canonique.
5. `service.rpc("attest_plan_request_variant_layout", { …, p_profile_id: user.id })`,
   où `user.id` vient de la session serveur (`requireVerifiedAccount`),
   jamais du formulaire.
6. `supabase.rpc("save_plan_request_variant", { p_request_id, p_parent_variant_id, p_operation_uuid })`.
7. Nouveaux motifs dans `mapPlanError` : `layout_not_attested`,
   `attestation_conflict`, `layout_invalid_format`, `layout_too_large`.

### 4.3 Éditeur (`PlanEditor.tsx`, `handleSaveVariant`)

- Un `operation_uuid` est conservé dans une référence, comme
  `depositOperationUuidRef`, réutilisé à chaque nouvel essai et
  renouvelé après un succès.
- En cas de refus : message affiché, **brouillon intact** (aucun
  `commit`, aucune entrée d'historique), comme aujourd'hui.

### 4.4 Option écartée : fonction d'écriture réservée à `service_role`

Plus courte (une seule fonction, sans table d'attestation), mais elle
appellerait `is_account_provisional()` et les contrôles de rôle sans
session (`auth.uid()` nul). Il faudrait **réécrire ces contrôles** sur un
`p_profile_id` fourni : risque direct de modifier les permissions. Non
recommandée.

## 5. Tests proposés (à exécuter après application, Supabase local)

**Appels directs** avec un compte de démonstration autorisé (CONTRACTOR) :
- ancienne signature `save_plan_request_variant(…, p_layout)` :
  `PGRST202` ;
- `attest_plan_request_variant_layout` : `42501` ;
- `select` ou `insert` sur la table d'attestation : refusé ;
- `save_plan_request_variant` avec une opération non attestée :
  `layout_not_attested` ;
- avec l'opération attestée pour un **autre** profil ou une **autre**
  demande : `not_authorized` ;
- réattester la même opération avec un **autre** contenu :
  `attestation_conflict` ;
- rappeler `save` après succès : **même variante** renvoyée, aucun
  doublon.

**Par l'action serveur**, avec les 5 cas de la reproduction :
- les 3 contenus invalides sont **refusés**, avec un motif explicite pour
  les autorisations ;
- les témoins v4 et v5 sont enregistrés, relus à l'identique et
  rechargés dans l'éditeur.

**Non-régression** :
- permissions : le propriétaire principal et l'entrepreneur gardent leur
  accès ; un autre profil ou un compte provisoire est toujours refusé ;
- reprise après coupure entre l'attestation et l'enregistrement : même
  opération, aucun doublon ;
- anciennes variantes, dont les invalides de la reproduction, toujours
  listées et relues comme aujourd'hui ;
- dépôt candidat d'une variante valide inchangé ;
- `npm run verify`.

**Procédure de vérification** :
1. appliquer la migration sur une base **locale** sauvegardée au
   préalable ;
2. rejouer le script de reproduction, qui devrait voir les 5 appels
   directs refusés par `PGRST202` ;
3. exécuter la suite d'appels directs ci-dessus ;
4. faire le parcours navigateur : enregistrer, recharger, rouvrir,
   déposer une variante v5 F2 ;
5. tenter d'enregistrer un plan aux autorisations invalides : refus et
   brouillon intact.

## 6. Impact sur les parcours existants

- **Enregistrer une variante** : une étape serveur de plus, sans effet
  visible si le plan est valide ; un refus explicite sinon.
- **Ouvrir, charger ou déposer une variante** : inchangés.
- **Variantes déjà enregistrées** : inchangées. Elles restent filtrées à
  la lecture : « illisible » si le format est invalide, autorisations
  écartées avec avis.
- **Appelants de l'ancienne RPC** (recherche dans le dépôt) :
  - l'action serveur  ;
  - le test d'intégration  (4 appels
    directs, dont un avec ), **à adapter** pour passer par
    l'attestation ou par l'action.

  Tout autre appel direct serait refusé après migration, ce qui est
  voulu.
