-- M001 — extensions, enums et fonctions communes
-- MIGRATION_ORDER.csv: M001, depends_on=none, validation_gate="base vide migre sans erreur"
-- Ne crée aucune table métier ni politique RLS (réservé à M002+ / M004+).
--
-- Objets créés, tous dérivés explicitement des spécifications :
--   - extension pgcrypto            (DATA_MODEL.yaml conventions.primary_keys, conventions.identifiers)
--   - 10 enums de statut/rôle       (DATA_MODEL.yaml membership.*, STATE_MACHINES.yaml)
--   - fonction commune set_updated_at_server() (DATA_MODEL.yaml conventions.timestamps)
--
-- QUESTION OUVERTE (non résolue, à valider par le fondateur avant toute
-- migration qui en dépend) : pas d'enum "approval_status" ici. STATE_MACHINES.yaml
-- définit "approval" avec seulement initial+terminal (pas de "states:" complet
-- comme les autres machines) et DATABASE_TABLES.csv qualifie son état d'"état
-- dérivé" des décisions append-only (pas une colonne de statut classique).
-- Forme non confirmée -> NE PAS considérer un report à M015 comme acquis ni
-- inventer sa forme ; à trancher explicitement avant que M015 ne soit écrite.

begin;

-- --------------------------------------------------------------------------
-- Extensions
-- --------------------------------------------------------------------------

-- gen_random_uuid() pour les clés primaires générées côté serveur, et
-- digest()/crypt() pour les identifiants sensibles stockés hachés.
-- AUDIT : déjà provisionnée par le bootstrap propre à Supabase
-- (/docker-entrypoint-initdb.d/init-scripts/00000000000000-initial-schema.sql,
-- exécuté avant toute migration projet) — pas introduite par M001. L'énoncé
-- IF NOT EXISTS ne la rend PAS portable sur un PostgreSQL vierge hors
-- Supabase : le schéma "extensions" ci-dessous est un prérequis fourni par
-- ce bootstrap et n'est pas créé par cette migration. Voir le rollback DEV
-- ONLY, qui ne supprime pas cette extension (préexistante et partagée).
create extension if not exists pgcrypto with schema extensions;

-- --------------------------------------------------------------------------
-- Enums — rôles (DATA_MODEL.yaml: membership.roles, membership.owner_profiles)
-- --------------------------------------------------------------------------

-- Rôles techniques d'adhésion à un chantier. PLATFORM_ADMIN est
-- explicitement un rôle plateforme séparé, absent des adhésions métier
-- ordinaires (DATA_MODEL.yaml ligne "platform_admin") : il n'appartient pas
-- à cet enum.
create type public.membership_role as enum (
  'OWNER',
  'CONTRACTOR',
  'SITE_MANAGER'
);

create type public.owner_profile as enum (
  'PRIMARY',
  'CO_OWNER'
);

-- --------------------------------------------------------------------------
-- Enums — machines à états (STATE_MACHINES.yaml)
-- --------------------------------------------------------------------------

create type public.invitation_status as enum (
  'PENDING',
  'ACCEPTED',
  'REFUSED',
  'REVOKED',
  'EXPIRED'
);

create type public.project_status as enum (
  'DRAFT',
  'ACTIVE',
  'SUSPENDED',
  'COMPLETED',
  'ARCHIVED',
  'READ_ONLY'
);

-- Applicable au journal, aux médias et aux documents (STATE_MACHINES.yaml
-- "record", applies_to: [journal, media, document]).
create type public.record_status as enum (
  'DRAFT',
  'PUBLISHED',
  'SUPERSEDED',
  'ARCHIVED'
);

-- Applicable aux dépenses et versions de budget (STATE_MACHINES.yaml
-- "financial_record", applies_to: [expense, budget_version]).
create type public.financial_record_status as enum (
  'DRAFT',
  'PUBLISHED',
  'APPROVED',
  'REJECTED',
  'DISPUTED',
  'SUPERSEDED',
  'CANCELLED'
);

create type public.advance_status as enum (
  'DRAFT',
  'DECLARED',
  'RECEIVED',
  'DISPUTED',
  'CANCELLED'
);

create type public.incident_status as enum (
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED'
);

create type public.sync_item_status as enum (
  'QUEUED',
  'UPLOADING',
  'SYNCED',
  'FAILED',
  'CONFLICT',
  'CANCELLED'
);

create type public.license_status as enum (
  'PENDING',
  'ACTIVE',
  'EXPIRING',
  'GRACE',
  'READ_ONLY',
  'CANCELLED'
);

-- --------------------------------------------------------------------------
-- Fonction commune (DATA_MODEL.yaml conventions.timestamps:
-- [created_at_server, updated_at_server])
-- --------------------------------------------------------------------------

-- Renseigne updated_at_server à l'heure serveur (timestamptz, UTC) à chaque
-- UPDATE. SECURITY INVOKER (pas d'élévation de privilège nécessaire) et
-- search_path figé au strict minimum : ne référence aucune table, donc ne
-- dépend d'aucun schéma applicatif.
create function public.set_updated_at_server()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at_server := now();
  return new;
end;
$$;

-- Fonction utilitaire déclenchée uniquement par des triggers de table
-- (créés avec les tables correspondantes, à partir de M002) : aucun appel
-- direct par un rôle API n'est nécessaire. Un trigger s'exécute indépendamment
-- des privilèges EXECUTE du rôle à l'origine du DML, donc révoquer EXECUTE
-- ici ne casse aucun déclenchement futur.
--
-- AUDIT : par défaut PostgreSQL accorde EXECUTE à PUBLIC à la création d'une
-- fonction (revoqué ci-dessous), mais Supabase pose en plus des privilèges
-- par défaut sur le schéma public qui accordent EXECUTE à anon, authenticated
-- et service_role pour toute nouvelle fonction — constaté via pg_default_acl.
-- Ces trois rôles sont donc explicitement révoqués eux aussi, uniquement pour
-- cette fonction (aucun ALTER DEFAULT PRIVILEGES global, aucune autre
-- fonction touchée).
revoke execute on function public.set_updated_at_server() from public, anon, authenticated, service_role;

commit;
