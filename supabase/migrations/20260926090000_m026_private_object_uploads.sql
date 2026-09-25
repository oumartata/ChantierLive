-- M026 — fondation générique d'upload privé (B026, T054, DATABASE_TABLES.csv)
-- Dépend de M001 uniquement (MIGRATION_ORDER.csv). Table strictement générique
-- et entity-agnostique : aucune fonction PREPARE/FINALIZE/READ ici — chaque
-- entity_type enregistre son propre contrôle fin dans sa PROPRE migration
-- (registre par domaine, DATA_MODEL.yaml private_object_access), première
-- consommatrice : media_asset (M010, B027).
--
-- Architecture retenue (DATA_MODEL.yaml upload_immutability/
-- candidate_non_rewritability/privileged_boundary/private_object_access,
-- corrigée après vérification empirique locale du 2026-09-24 et revues
-- successives du 2026-09-25) :
--   - Source temporaire (chemin distinct, écrit par le CLIENT via une URL
--     signée) et candidate (chemin distinct construit et écrit
--     EXCLUSIVEMENT par le serveur privilégié) ne sont JAMAIS le même objet.
--   - Une candidate reçoit AU PLUS une tentative d'écriture. Aucune
--     réémission automatique du PUT après timeout : la porte CAS
--     (write_claimed_at, colonne ci-dessous, prise par une transaction
--     Postgres AVANT tout appel Storage) empêche structurellement deux
--     écritures concurrentes vers la même candidate — nécessaire car
--     vérifié empiriquement (storage-api v1.72.1, local) que le seul
--     contrôle "sans upsert" du fournisseur n'est PAS atomique sous
--     concurrence réelle (deux PUT concurrents vers la même clé peuvent
--     TOUS DEUX aboutir côté fournisseur, écrasement silencieux).
--   - Sur résultat incertain (timeout), ou tentative expirée : jamais de
--     réouverture d'écriture sur l'ancienne candidate. Un nouvel attempt_id
--     et une nouvelle clé candidate sont ouverts sur la MÊME ligne
--     d'opération (même operation_uuid = même opération logique, jamais une
--     seconde opération ni un second objet métier).
--   - Attestation de contrôle Storage (storage_verified_attempt_id) : écrite
--     UNIQUEMENT par une fonction dont l'EXECUTE est accordé au seul rôle
--     service_role (jamais authenticated/anon) — un client authentifié ne
--     peut jamais fabriquer cette attestation, quels que soient ses droits
--     métier par ailleurs (frontière de confiance, privileged_boundary).
--   - FINALIZED (transition atomique : attempt_id courant + expiration
--     encore valide + attestation présente pour cet attempt_id + droits
--     revérifiés) enregistre la clé exacte de la candidate gagnante comme
--     référence permanente ; la création/liaison de l'objet métier
--     consommateur s'exécute DANS LA MÊME transaction PostgreSQL (voir
--     finalize_media_upload, M010) — un échec de cette liaison annule tout,
--     l'opération reste non-FINALIZED et récupérable.
--   - Nettoyage (corrigé, revue 2026-09-26) : toute clé référencée par une
--     ligne FINALIZED n'est jamais éligible, quel que soit son âge. La ligne
--     private_object_uploads elle-même n'est JAMAIS supprimée physiquement —
--     supprimer operation_uuid romprait l'identité d'idempotence de
--     l'opération (une contrainte unique libérée permettrait à un rejeu
--     tardif de recréer une ligne pour le "même" operation_uuid, perçu par
--     l'appelant comme la même opération mais physiquement distincte). Statut
--     terminal ABANDONED ajouté à la place. Chaque clé Storage qui a pu être
--     réellement écrite (candidate d'une tentative abandonnée par une
--     reprise, ou source temporaire devenue inutile après FINALIZED) est
--     enregistrée dans private_object_stale_keys AVANT d'être perdue de vue,
--     puis supprimée un objet à la fois avec une confirmation post-suppression
--     (voir M010 : abandon_expired_media_upload, claim_stale_key_for_cleanup,
--     mark_stale_key_cleaned) — jamais une suppression dont l'échec ferait
--     perdre la référence.
--
-- Aucune policy RLS permissive : accès exclusivement par fonctions SECURITY
-- DEFINER propres à chaque entity_type (registre par domaine, refus par
-- défaut si non enregistré).

begin;

create table public.private_object_uploads (
  id uuid primary key default gen_random_uuid(),
  operation_uuid uuid not null,
  project_id uuid null references public.projects (id) on delete restrict,
  organization_id uuid null references public.organizations (id) on delete restrict,
  entity_type text not null,
  entity_id uuid null,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  status text not null default 'PENDING',
  attempt_id uuid not null default gen_random_uuid(),
  attempt_expires_at timestamptz not null,
  candidate_key text not null,
  storage_key text null,
  expected_checksum text not null,
  expected_size_bytes bigint not null,
  expected_mime_type text not null,
  -- Écrite exclusivement par attest_storage_verified (service_role, M010+).
  storage_verified_attempt_id uuid null,
  -- Porte CAS : NULL = aucune écriture Storage encore revendiquée pour
  -- l'attempt_id courant. Un UPDATE conditionnel (WHERE write_claimed_at IS
  -- NULL) sous verrou de ligne garantit qu'un seul appelant "gagne" le droit
  -- d'écrire la candidate courante.
  write_claimed_at timestamptz null,
  created_at_server timestamptz not null default now(),
  finalized_at timestamptz null,
  finalized_by_profile_id uuid null references public.profiles (id) on delete restrict,
  constraint private_object_uploads_operation_unique unique (operation_uuid),
  constraint private_object_uploads_tenant_exclusive check (num_nonnulls(project_id, organization_id) = 1),
  -- Registre par domaine : étendre cette liste dans une migration dédiée à
  -- chaque nouvel entity_type, jamais un texte libre non contrôlé.
  constraint private_object_uploads_entity_type_known check (entity_type in ('media_asset')),
  constraint private_object_uploads_status_known check (status in ('PENDING', 'FINALIZING', 'FINALIZED', 'ABANDONED')),
  constraint private_object_uploads_expected_size_positive check (expected_size_bytes > 0),
  constraint private_object_uploads_finalized_consistency check (
    (status = 'FINALIZED') = (storage_key is not null and finalized_at is not null and finalized_by_profile_id is not null)
  )
);

create index private_object_uploads_project_idx on public.private_object_uploads (project_id) where project_id is not null;
create index private_object_uploads_org_idx on public.private_object_uploads (organization_id) where organization_id is not null;
create index private_object_uploads_status_expiry_idx on public.private_object_uploads (status, attempt_expires_at);
create index private_object_uploads_entity_idx on public.private_object_uploads (entity_type, entity_id) where entity_id is not null;

alter table public.private_object_uploads enable row level security;

-- Aucun accès direct : tout passe par des fonctions SECURITY DEFINER propres
-- à chaque entity_type (M010 pour media_asset).
revoke all privileges on table public.private_object_uploads from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- private_object_stale_keys — trace RÉCUPÉRABLE de toute clé Storage ayant pu
-- être réellement écrite puis devenue inutile : candidate d'une tentative
-- abandonnée (recover_media_upload_attempt/abandon_expired_media_upload,
-- M010), ou source temporaire redevenue inutile après FINALIZED. Une clé
-- n'est jamais supprimée de Storage sans passer par une ligne ici, et
-- cette ligne n'est marquée cleaned_at qu'APRÈS confirmation réelle de la
-- suppression côté Storage — un échec laisse la trace intacte et réclamable
-- à nouveau, jamais perdue (corrige la revue 2026-09-26 : l'ancienne
-- claim_candidate_for_cleanup supprimait la ligne AVANT storage.remove()).
-- Générique par entity_type, comme private_object_uploads lui-même.
-- ----------------------------------------------------------------------------

create table public.private_object_stale_keys (
  id uuid primary key default gen_random_uuid(),
  private_object_upload_id uuid not null references public.private_object_uploads (id) on delete restrict,
  storage_key text not null,
  kind text not null check (kind in ('candidate', 'source')),
  recorded_at timestamptz not null default now(),
  -- Porte CAS de nettoyage (même principe que write_claimed_at) : NULL = non
  -- revendiquée. Une réclamation ancienne et jamais confirmée (cleaned_at
  -- toujours NULL) redevient réclamable après un délai de grâce, plutôt que
  -- de bloquer indéfiniment sur un échec silencieux.
  cleanup_claimed_at timestamptz null,
  cleaned_at timestamptz null
);

create index private_object_stale_keys_pending_idx
  on public.private_object_stale_keys (cleaned_at, cleanup_claimed_at)
  where cleaned_at is null;

alter table public.private_object_stale_keys enable row level security;
revoke all privileges on table public.private_object_stale_keys from public, anon, authenticated;

commit;
