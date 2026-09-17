-- M005 — audit_events, sync_operations
-- MIGRATION_ORDER.csv: M005, depends_on=M004, rollback_or_recovery="append-only;
-- jamais rollback destructif", validation_gate="UPDATE DELETE refusés"
--
-- Arbitrages fondateur B011 (2026-09-17) :
--   - audit_events : acteur HUMAN/SYSTEM (actor_kind + actor_profile_id
--     nullable, CHECK de cohérence) ; target_table NOT NULL, target_id
--     NULL ; refus UPDATE/DELETE/TRUNCATE par trigger (protection non
--     absolue face à un rôle disposant de droits DDL, ex: propriétaire) ;
--     heure serveur imposée par trigger BEFORE INSERT (DEFAULT seul
--     n'empêche pas une valeur fournie) ; lecture initiale limitée à
--     OWNER PRIMARY et CONTRACTOR (has_project_permission ne couvre pas
--     AUDIT_VIEW) — CO_OWNER ("limité", non précisé) et PLATFORM_ADMIN
--     (accès support, has_support_scope/M006) restent des exigences
--     différées, non annulées.
--   - sync_operations : écriture exclusivement serveur, aucun INSERT
--     client ; dépendance (depends_on_operation_uuid) contrainte au même
--     chantier ET au même acteur ; auto-dépendance interdite ;
--     created_at_server ET updated_at_server imposés par trigger à
--     l'insertion.
--   - Aucun rollback destructif pour ces deux tables (voir fichier
--     m005_rollback.DEV_ONLY.sql, documentaire, sans DROP).
--
-- Traitement idempotent réellement exécuté (comparaison acteur/chantier/
-- entité/action/contract_version/base_revision/payload_hash recalculé,
-- distinction en cours/réussi/échoué, INSERT-first pour la concurrence) :
-- HORS PÉRIMÈTRE de M005, relève de B038 "Implémenter sync push
-- idempotent". Résolution des conflits de révision : B041, distincte de
-- leur détection qui doit avoir lieu dans B038. M005 fournit uniquement
-- les fondations SQL (contraintes, colonnes de résultat).

begin;

-- --------------------------------------------------------------------------
-- audit_events (DATABASE_TABLES.csv T042, domaine integrity)
-- --------------------------------------------------------------------------

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  actor_kind text not null check (actor_kind in ('HUMAN', 'SYSTEM')),
  actor_profile_id uuid null references public.profiles (id) on delete restrict,
  action text not null,
  target_table text not null,
  target_id uuid null,
  result text not null,
  context jsonb null,
  reason text not null,
  created_at_server timestamptz not null default now(),
  constraint audit_events_actor_consistency check (
    (actor_kind = 'HUMAN' and actor_profile_id is not null)
    or (actor_kind = 'SYSTEM' and actor_profile_id is null)
  )
);

create index audit_events_project_id_idx on public.audit_events (project_id);
create index audit_events_target_idx on public.audit_events (target_table, target_id);
create index audit_events_actor_profile_id_idx on public.audit_events (actor_profile_id);

-- Heure serveur imposée : DEFAULT now() n'empêche pas une valeur fournie à
-- l'INSERT, un trigger l'écrase donc systématiquement.
create function public.set_audit_event_created_at_server()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  new.created_at_server := now();
  return new;
end;
$$;

revoke execute on function public.set_audit_event_created_at_server() from public, anon, authenticated, service_role;

create trigger set_created_at_server
before insert on public.audit_events
for each row execute function public.set_audit_event_created_at_server();

-- Refus UPDATE/DELETE inconditionnel (BR087, validation_gate M005).
-- Protection non absolue : un rôle avec droits DDL (ex: propriétaire de la
-- table) peut désactiver ce trigger via ALTER TABLE ... DISABLE TRIGGER.
create function public.reject_audit_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'audit_events est append-only : UPDATE et DELETE sont refusés';
end;
$$;

revoke execute on function public.reject_audit_event_mutation() from public, anon, authenticated, service_role;

create trigger reject_update_delete
before update or delete on public.audit_events
for each row execute function public.reject_audit_event_mutation();

-- TRUNCATE ne déclenche pas les triggers ROW BEFORE/AFTER UPDATE|DELETE :
-- trigger STATEMENT dédié, même limite de protection que ci-dessus.
create function public.reject_audit_event_truncate()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'audit_events est append-only : TRUNCATE est refusé';
end;
$$;

revoke execute on function public.reject_audit_event_truncate() from public, anon, authenticated, service_role;

create trigger reject_truncate
before truncate on public.audit_events
for each statement execute function public.reject_audit_event_truncate();

alter table public.audit_events enable row level security;

revoke all privileges on table public.audit_events from public, anon, authenticated;

grant select on public.audit_events to authenticated;

-- Lecture initiale : OWNER PRIMARY et CONTRACTOR uniquement (droits natifs
-- non ambigus de AUDIT_VIEW, PERMISSIONS.csv). CO_OWNER ("limité", non
-- précisé) et PLATFORM_ADMIN (accès support, M006) délibérément exclus :
-- exigences différées, pas annulées — voir PROJECT_STATE.yaml.
create policy audit_events_select_owner_primary_or_contractor
on public.audit_events
for select
to authenticated
using (
  public.is_primary_owner(project_id)
  or public.has_project_role(project_id, array['CONTRACTOR']::public.membership_role[])
);

-- --------------------------------------------------------------------------
-- sync_operations (DATABASE_TABLES.csv T040)
-- --------------------------------------------------------------------------

create table public.sync_operations (
  operation_uuid uuid primary key,
  contract_version text not null,
  device_id text not null,
  project_id uuid not null references public.projects (id) on delete restrict,
  profile_id uuid not null references public.profiles (id) on delete restrict,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  base_revision integer not null,
  client_created_at timestamptz not null,
  payload jsonb not null,
  payload_hash text not null,
  depends_on_operation_uuid uuid null,
  local_media_refs jsonb null,
  status public.sync_item_status not null default 'QUEUED',
  server_revision integer null,
  event_cursor bigint null,
  canonical_entity jsonb null,
  error_code text null,
  retry_after_seconds integer null,
  created_at_server timestamptz not null default now(),
  updated_at_server timestamptz not null default now(),
  constraint sync_operations_uuid_project_profile_key unique (operation_uuid, project_id, profile_id),
  constraint sync_operations_no_self_dependency check (
    depends_on_operation_uuid is null or depends_on_operation_uuid <> operation_uuid
  ),
  -- Une opération ne peut dépendre que d'une opération du même chantier ET
  -- du même acteur (cadrage B011, cohérent avec SYNC_PROTOCOL.yaml
  -- "operation_uuid_uniqueness: globale par acteur et opération").
  constraint sync_operations_depends_on_fk
    foreign key (depends_on_operation_uuid, project_id, profile_id)
    references public.sync_operations (operation_uuid, project_id, profile_id)
    on delete restrict
);

create index sync_operations_project_id_idx on public.sync_operations (project_id);
create index sync_operations_profile_id_idx on public.sync_operations (profile_id);
create index sync_operations_depends_on_idx on public.sync_operations (depends_on_operation_uuid);
create index sync_operations_entity_idx on public.sync_operations (entity_type, entity_id);

-- created_at_server ET updated_at_server imposés à l'insertion, distincts
-- de client_created_at (fourni par le client, conservé tel quel par design).
create function public.set_sync_operation_server_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  new.created_at_server := now();
  new.updated_at_server := now();
  return new;
end;
$$;

revoke execute on function public.set_sync_operation_server_timestamps() from public, anon, authenticated, service_role;

create trigger set_server_timestamps
before insert on public.sync_operations
for each row execute function public.set_sync_operation_server_timestamps();

create trigger set_updated_at_server
before update on public.sync_operations
for each row execute function public.set_updated_at_server();

alter table public.sync_operations enable row level security;

revoke all privileges on table public.sync_operations from public, anon, authenticated;

grant select on public.sync_operations to authenticated;

-- Ses propres opérations ET adhésion chantier encore active.
create policy sync_operations_select_own_active_member
on public.sync_operations
for select
to authenticated
using (
  profile_id = auth.uid()
  and public.is_active_project_member(project_id)
);

commit;
