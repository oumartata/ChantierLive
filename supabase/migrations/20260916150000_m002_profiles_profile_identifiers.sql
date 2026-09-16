-- M002 — profiles, profile_identifiers
-- MIGRATION_ORDER.csv: M002, depends_on=M001, validation_gate="unicité e-mail/téléphone"
-- Arbitrages fondateur B007 (2026-09-16) : profiles.id = auth.users.id (FK, pas
-- d'UUID indépendant) ; ON DELETE RESTRICT des deux côtés (l'archivage ne
-- libère pas ces FK, la suppression/anonymisation est un processus séparé,
-- non conçu ici) ; aucune vérification automatique, aucune fonction Auth,
-- aucun trigger de signup, aucune policy RLS (RLS activée, refus par défaut).
--
-- QUESTIONS EXPLICITEMENT DIFFÉRÉES (non traitées par cette migration, voir
-- PROJECT_STATE.yaml/PROJECT_HANDOFF.yaml open_questions) :
--   - conditions d'activation du compte (aucun statut de compte créé ici)
--   - mécanisme fiable de vérification d'identifiant (verified_at_server est
--     un simple champ nullable ; rien ne l'alimente automatiquement)
--   - processus de suppression/anonymisation de compte

begin;

-- --------------------------------------------------------------------------
-- Enum propre à cette table (TECH_ARCHITECTURE.yaml auth.methods: exactement
-- email_password et phone_password)
-- --------------------------------------------------------------------------

create type public.identifier_kind as enum ('EMAIL', 'PHONE');

-- --------------------------------------------------------------------------
-- profiles (DATABASE_TABLES.csv T001 — write_pattern "update contrôlé")
-- --------------------------------------------------------------------------

-- id = auth.users.id, pas un uuid généré indépendamment (correction fondateur).
-- ON DELETE RESTRICT : bloque toute suppression physique de auth.users tant
-- qu'un profil existe ; pas de contournement par archivage (archived_at ne
-- lève pas cette contrainte). Aucun processus de suppression n'est fourni par
-- cette migration.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  archived_at timestamptz null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now()
);

-- Pas de created_by/updated_by (arbitrage #12) : id identifie déjà le
-- titulaire du profil, ces colonnes n'apporteraient aucune information
-- distincte. Cette migration ne fournit aucun mécanisme de création
-- automatique du profil (ni trigger, ni fonction) : l'insertion de la ligne
-- profiles reste hors périmètre de M002.

create trigger set_updated_at_server
before update on public.profiles
for each row execute function public.set_updated_at_server();

alter table public.profiles enable row level security;

-- Refus par défaut (D049/D054) : aucune policy créée dans M002. PUBLIC n'a
-- aucun privilège par défaut sur les tables (à la différence des fonctions),
-- le revoke ci-dessous est gardé pour rester explicite/auditable.
revoke all privileges on table public.profiles from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- profile_identifiers (DATABASE_TABLES.csv T002 — write_pattern
-- "serveur uniquement")
-- --------------------------------------------------------------------------

-- ON DELETE RESTRICT (comme profiles) : même logique, pas de perte silencieuse
-- d'un identifiant tant que le profil parent existe.
create table public.profile_identifiers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete restrict,
  kind public.identifier_kind not null,
  -- Valeur normalisée uniquement (arbitrage #6) : pas de colonne "brute"
  -- séparée. E-mail : espaces extérieurs retirés, minuscules, points et
  -- suffixes "+" non modifiés. Téléphone : E.164 canonique, aucun pays déduit
  -- automatiquement (arbitrages #7/#8).
  value_normalized text not null,
  -- Vérifié <=> non NULL (arbitrage #4) ; aucune écriture automatique dans
  -- cette migration, aucun rôle API ne peut l'atteindre (voir revoke ci-dessous).
  verified_at_server timestamptz null,
  archived_at timestamptz null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  -- Vérifie uniquement la forme canonique (arbitrage #9), pas la validité
  -- réelle de l'adresse : pas d'espace, minuscules, forme local@domaine.tld
  -- minimale. La validation complète reste au futur chemin serveur.
  constraint profile_identifiers_email_canonical check (
    kind <> 'EMAIL' or (
      value_normalized <> ''
      and value_normalized = btrim(value_normalized)
      and value_normalized = lower(value_normalized)
      and value_normalized ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    )
  ),
  -- Forme E.164 uniquement : "+" puis 1 à 15 chiffres, premier chiffre non
  -- nul. Ne vérifie pas qu'un tel numéro existe réellement (arbitrage #9).
  constraint profile_identifiers_phone_canonical check (
    kind <> 'PHONE' or (
      value_normalized ~ '^\+[1-9][0-9]{0,14}$'
    )
  )
);

create trigger set_updated_at_server
before update on public.profile_identifiers
for each row execute function public.set_updated_at_server();

-- Note pour le futur mécanisme d'écriture (hors périmètre de M002, BR009) :
-- un remplacement d'identifiant exige une nouvelle vérification. Ne jamais
-- modifier value_normalized d'une ligne existante en conservant
-- verified_at_server : archiver la ligne (archived_at) et en insérer une
-- nouvelle avec verified_at_server NULL. Aucun mécanisme supplémentaire n'est
-- implémenté par cette migration.

-- Unicité BR002 ("normalisé et unique lorsqu'il est vérifié") : partielle,
-- parmi les identifiants vérifiés et non archivés uniquement. Des doublons
-- non vérifiés (ou archivés) restent possibles.
create unique index profile_identifiers_verified_unique
  on public.profile_identifiers (kind, value_normalized)
  where verified_at_server is not null and archived_at is null;

alter table public.profile_identifiers enable row level security;

-- "Serveur uniquement" (T002) : aucun privilège pour anon/authenticated, y
-- compris SELECT. Aucune fonction SECURITY DEFINER créée : le futur écriture
-- serveur passera par service_role (contourne RLS nativement, Supabase), pas
-- encore implémenté ici.
revoke all privileges on table public.profile_identifiers from public, anon, authenticated;

commit;
