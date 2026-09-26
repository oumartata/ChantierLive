-- M022 — avenants au devis accepté (B066). BR094/BR095/BR096 ; D087 ; D117-D125.
--   D117 : seul OWNER/PRIMARY décide (CO_OWNER différé).
--   D118 : estimations privées au CONTRACTOR ; OWNER/PRIMARY et CO_OWNER voient
--          les versions proposées et leur historique ; aucun accès SITE_MANAGER.
--   D119 : augmentation uniquement : chaque ligne et le total strictement > 0.
--   D120 : plusieurs avenants en parallèle ; révision propre à chaque avenant ;
--          une seule version PROPOSED par avenant.
--   D121 : créé seulement après acceptation du devis, rattaché exactement à la
--          version acceptée ; aucun lien au plan ni à une phase.
--   D122 : avenant accepté figé, aucune nouvelle version.
--   D123 : titre 1-200, motif 1-1000, 1 à 200 lignes au format D115 (analyse
--          partagée public.parse_quote_lines), dates serveur.
--   D124 : ESTIMATE -> PROPOSED -> ACCEPTED | REFUSED | SUPERSEDED ; audit
--          PROPOSED/ACCEPTED/REFUSED/EXECUTION_AUTHORIZED, jamais pour un brouillon.
--   D125 : autorisation d'exécution explicite du CONTRACTOR, une seule fois,
--          après acceptation, en insertion seule.
-- Montant contractuel dérivé (get_contract_amount) : devis accepté + total de la
-- version ACCEPTED de chaque avenant (au plus une par avenant, index unique).
-- Hors périmètre : reste dû et vue client (B068), démarrage (B067).
--
-- Ordre des verrous (écritures) : avisoire du chantier (même clé que M021) ->
-- adhésion de l'appelant -> projects -> quotes -> change_orders -> versions
-- (id croissant). Compte vérifié relu après la dernière attente.

begin;

-- ----------------------------------------------------------------------------
-- Tables.
-- ----------------------------------------------------------------------------

create table public.change_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  quote_id uuid not null,
  accepted_quote_version_id uuid not null,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  revision integer not null default 0,
  pending_version_id uuid null,
  accepted_version_id uuid null,
  constraint change_orders_id_project_unique unique (id, project_id),
  constraint change_orders_quote_project_fk foreign key (quote_id, project_id) references public.quotes (id, project_id),
  constraint change_orders_quote_version_project_fk foreign key (accepted_quote_version_id, project_id) references public.quote_versions (id, project_id)
);

create index change_orders_project_id_idx on public.change_orders (project_id);

create table public.change_order_versions (
  id uuid primary key default gen_random_uuid(),
  change_order_id uuid not null references public.change_orders (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status text not null default 'ESTIMATE',
  title text not null check (char_length(title) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 1000),
  total_amount_fcfa bigint not null check (total_amount_fcfa between 1 and 1000000000000),
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  created_xact xid8 not null default pg_current_xact_id(),
  constraint change_order_versions_status_known check (status in ('ESTIMATE', 'PROPOSED', 'ACCEPTED', 'REFUSED', 'SUPERSEDED')),
  constraint change_order_versions_number_unique unique (change_order_id, version_number),
  constraint change_order_versions_id_project_unique unique (id, project_id),
  constraint change_order_versions_id_order_project_unique unique (id, change_order_id, project_id),
  constraint change_order_versions_order_project_fk foreign key (change_order_id, project_id) references public.change_orders (id, project_id)
);

create unique index change_order_versions_one_proposed on public.change_order_versions (change_order_id) where status = 'PROPOSED';
create unique index change_order_versions_one_accepted on public.change_order_versions (change_order_id) where status = 'ACCEPTED';
create index change_order_versions_project_id_idx on public.change_order_versions (project_id);

-- Pointeurs : version du MÊME avenant et du MÊME chantier.
alter table public.change_orders
  add constraint change_orders_pending_version_fk foreign key (pending_version_id, id, project_id)
    references public.change_order_versions (id, change_order_id, project_id),
  add constraint change_orders_accepted_version_fk foreign key (accepted_version_id, id, project_id)
    references public.change_order_versions (id, change_order_id, project_id);

-- Lignes : format D115 ; D119 impose un prix et un montant de ligne > 0.
create table public.change_order_version_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.change_order_versions (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  position integer not null check (position between 1 and 200),
  label text not null check (char_length(label) between 1 and 200),
  unit text not null check (char_length(unit) between 1 and 20),
  quantity numeric(10, 3) not null check (quantity > 0 and quantity <= 1000000),
  unit_price_fcfa bigint not null check (unit_price_fcfa between 1 and 10000000000),
  line_amount_fcfa bigint not null check (line_amount_fcfa between 1 and 1000000000000),
  constraint change_order_version_lines_amount_exact check (line_amount_fcfa = round(quantity * unit_price_fcfa)),
  constraint change_order_version_lines_position_unique unique (version_id, position),
  constraint change_order_version_lines_version_project_fk foreign key (version_id, project_id) references public.change_order_versions (id, project_id)
);

create table public.change_order_proposals (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique references public.change_order_versions (id) on delete restrict,
  change_order_id uuid not null references public.change_orders (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  proposed_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  proposed_at_server timestamptz not null,
  supersedes_version_id uuid null references public.change_order_versions (id) on delete restrict,
  constraint change_order_proposals_version_fk foreign key (version_id, change_order_id, project_id)
    references public.change_order_versions (id, change_order_id, project_id),
  constraint change_order_proposals_supersedes_fk foreign key (supersedes_version_id, change_order_id, project_id)
    references public.change_order_versions (id, change_order_id, project_id)
);

create table public.change_order_decisions (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique references public.change_order_versions (id) on delete restrict,
  change_order_id uuid not null references public.change_orders (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  decision text not null check (decision in ('ACCEPTED', 'REFUSED')),
  decided_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  decided_at_server timestamptz not null,
  reason text null check (reason is null or char_length(reason) between 1 and 1000),
  constraint change_order_decisions_version_fk foreign key (version_id, change_order_id, project_id)
    references public.change_order_versions (id, change_order_id, project_id)
);

create table public.change_order_execution_authorizations (
  id uuid primary key default gen_random_uuid(),
  change_order_id uuid not null unique references public.change_orders (id) on delete restrict,
  version_id uuid not null unique references public.change_order_versions (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  authorized_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  authorized_at_server timestamptz not null,
  constraint change_order_execution_version_fk foreign key (version_id, change_order_id, project_id)
    references public.change_order_versions (id, change_order_id, project_id)
);

-- ----------------------------------------------------------------------------
-- Invariants (déclencheurs).
-- ----------------------------------------------------------------------------

-- Nouvel avenant : révision 0, sans pointeur, rattaché à la version ACCEPTÉE
-- du devis du même chantier (D121).
create function public.guard_change_order_insert()
returns trigger
language plpgsql
as $$
begin
  if new.pending_version_id is not null or new.accepted_version_id is not null then
    raise exception 'change_order_immutable';
  end if;
  if not exists (
    select 1 from public.quotes q
    where q.id = new.quote_id and q.project_id = new.project_id
      and q.accepted_version_id = new.accepted_quote_version_id
  ) then
    raise exception 'quote_not_accepted';
  end if;
  new.revision := 0;
  return new;
end;
$$;

create trigger guard_change_order_insert
before insert on public.change_orders
for each row execute function public.guard_change_order_insert();

-- Identité et rattachement immuables ; acceptation posée une seule fois ;
-- aucune proposition en attente après acceptation (D122).
create function public.guard_change_order_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'change_order_immutable';
  end if;
  if new.project_id <> old.project_id or new.quote_id <> old.quote_id
     or new.accepted_quote_version_id <> old.accepted_quote_version_id
     or new.created_by_profile_id <> old.created_by_profile_id or new.created_at_server <> old.created_at_server then
    raise exception 'change_order_immutable';
  end if;
  if old.accepted_version_id is not null and new.accepted_version_id is distinct from old.accepted_version_id then
    raise exception 'change_order_immutable';
  end if;
  if new.accepted_version_id is not null and new.pending_version_id is not null then
    raise exception 'change_order_accepted';
  end if;
  if new.pending_version_id is not null
     and (select status from public.change_order_versions where id = new.pending_version_id) is distinct from 'PROPOSED' then
    raise exception 'pending_version_not_proposed';
  end if;
  if new.accepted_version_id is not null
     and (select status from public.change_order_versions where id = new.accepted_version_id) is distinct from 'ACCEPTED' then
    raise exception 'accepted_version_not_accepted';
  end if;
  new.revision := old.revision + 1;
  return new;
end;
$$;

create trigger guard_change_order_update
before update or delete on public.change_orders
for each row execute function public.guard_change_order_update();

create function public.guard_change_order_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'change_order_version_immutable';
  end if;
  if new.change_order_id <> old.change_order_id or new.project_id <> old.project_id
     or new.version_number <> old.version_number or new.title <> old.title or new.reason <> old.reason
     or new.total_amount_fcfa <> old.total_amount_fcfa or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_at_server <> old.created_at_server or new.created_xact <> old.created_xact then
    raise exception 'change_order_version_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'ESTIMATE' and new.status = 'PROPOSED')
     or (old.status = 'PROPOSED' and new.status in ('ACCEPTED', 'REFUSED', 'SUPERSEDED')) then
    return new;
  end if;
  raise exception 'change_order_version_transition_refused';
end;
$$;

create trigger guard_change_order_version_mutation
before update or delete on public.change_order_versions
for each row execute function public.guard_change_order_version_mutation();

-- Nouvelle version : ESTIMATE, jamais sur un avenant accepté (D122).
create function public.guard_change_order_version_insert()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'ESTIMATE' then
    raise exception 'change_order_version_must_start_as_estimate';
  end if;
  if (select accepted_version_id from public.change_orders where id = new.change_order_id) is not null then
    raise exception 'change_order_accepted';
  end if;
  new.created_xact := pg_current_xact_id();
  return new;
end;
$$;

create trigger guard_change_order_version_insert
before insert on public.change_order_versions
for each row execute function public.guard_change_order_version_insert();

create function public.guard_change_order_version_line()
returns trigger
language plpgsql
as $$
declare
  v_created_xact xid8;
  v_status text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'change_order_version_line_immutable';
  end if;
  select created_xact, status into v_created_xact, v_status from public.change_order_versions where id = new.version_id;
  if v_created_xact is distinct from pg_current_xact_id() or v_status is distinct from 'ESTIMATE' then
    raise exception 'change_order_version_lines_closed';
  end if;
  return new;
end;
$$;

create trigger guard_change_order_version_line
before insert or update or delete on public.change_order_version_lines
for each row execute function public.guard_change_order_version_line();

-- Contrôle différé (SECURITY DEFINER, cf. M021) : 1 à 200 lignes, total exact.
create function public.check_change_order_version_total()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_count integer;
  v_sum numeric;
  v_total bigint;
begin
  select total_amount_fcfa into v_total from public.change_order_versions where id = new.id;
  select count(*), coalesce(sum(line_amount_fcfa), 0) into v_count, v_sum
  from public.change_order_version_lines where version_id = new.id;
  if v_count < 1 or v_count > 200 or v_sum <> v_total then
    raise exception 'change_order_version_total_inconsistent';
  end if;
  return null;
end;
$$;

revoke execute on function public.check_change_order_version_total() from public, anon, authenticated, service_role;

create constraint trigger check_change_order_version_total
after insert on public.change_order_versions
deferrable initially deferred
for each row execute function public.check_change_order_version_total();

-- Décision cohérente avec le statut déjà posé ; autorisation seulement sur la
-- version acceptée de l'avenant (D125).
create function public.guard_change_order_event_insert()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'change_order_decisions' then
    if (select status from public.change_order_versions where id = new.version_id) is distinct from new.decision then
      raise exception 'decision_status_mismatch';
    end if;
  elsif tg_table_name = 'change_order_execution_authorizations' then
    if (select accepted_version_id from public.change_orders where id = new.change_order_id) is distinct from new.version_id then
      raise exception 'change_order_not_accepted';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_change_order_event_insert before insert on public.change_order_decisions
for each row execute function public.guard_change_order_event_insert();
create trigger guard_change_order_event_insert before insert on public.change_order_execution_authorizations
for each row execute function public.guard_change_order_event_insert();

create function public.reject_change_order_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'change_order_event_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.change_order_proposals
for each row execute function public.reject_change_order_event_mutation();
create trigger reject_mutation before update or delete on public.change_order_decisions
for each row execute function public.reject_change_order_event_mutation();
create trigger reject_mutation before update or delete on public.change_order_execution_authorizations
for each row execute function public.reject_change_order_event_mutation();

alter table public.change_orders enable row level security;
alter table public.change_order_versions enable row level security;
alter table public.change_order_version_lines enable row level security;
alter table public.change_order_proposals enable row level security;
alter table public.change_order_decisions enable row level security;
alter table public.change_order_execution_authorizations enable row level security;
revoke all privileges on table public.change_orders, public.change_order_versions, public.change_order_version_lines,
  public.change_order_proposals, public.change_order_decisions, public.change_order_execution_authorizations
  from public, anon, authenticated;

revoke execute on function public.guard_change_order_insert(), public.guard_change_order_update(),
  public.guard_change_order_version_mutation(), public.guard_change_order_version_insert(),
  public.guard_change_order_version_line(), public.guard_change_order_event_insert(),
  public.reject_change_order_event_mutation()
  from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Lecture (D118) : prédicat unique.
-- ----------------------------------------------------------------------------

create function public.change_order_version_readable(p_version_id uuid, p_uid uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.change_order_versions v
    join public.project_memberships m on m.project_id = v.project_id and m.profile_id = p_uid and m.revoked_at is null
    where v.id = p_version_id
      and (
        m.role = 'CONTRACTOR'
        or (m.role = 'OWNER' and m.owner_profile in ('PRIMARY', 'CO_OWNER')
            and exists (select 1 from public.change_order_proposals p where p.version_id = v.id))
      )
  );
$$;

revoke execute on function public.change_order_version_readable(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- create_change_order_estimate — CONTRACTOR actif, devis accepté.
-- p_change_order_id NULL : nouvel avenant (révision attendue 0) ; sinon
-- nouvelle version d'un avenant non accepté. Aucun audit (D124).
-- ----------------------------------------------------------------------------

create function public.create_change_order_estimate(
  p_project_id uuid, p_change_order_id uuid, p_title text, p_reason text, p_lines jsonb, p_expected_revision integer)
returns public.change_order_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership_id uuid;
  v_quote public.quotes;
  v_order public.change_orders;
  v_version public.change_order_versions;
  v_title text := btrim(coalesce(p_title, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_total bigint;
  v_min bigint;
  v_next integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;
  if char_length(v_title) not between 1 and 200 then
    raise exception 'invalid_title';
  end if;
  if char_length(v_reason) not between 1 and 1000 then
    raise exception 'invalid_reason';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.projects where id = p_project_id for update;
  select * into v_quote from public.quotes where project_id = p_project_id for update;
  if p_change_order_id is not null then
    select * into v_order from public.change_orders where id = p_change_order_id and project_id = p_project_id for update;
    if v_order.id is null then
      raise exception 'not_authorized';
    end if;
  end if;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_quote.accepted_version_id is null then
    raise exception 'quote_not_accepted';
  end if;
  if coalesce(v_order.revision, 0) is distinct from p_expected_revision then
    raise exception 'change_order_conflict';
  end if;
  if v_order.accepted_version_id is not null then
    raise exception 'change_order_accepted';
  end if;

  -- Analyse complète (D115) avant toute écriture ; D119 : chaque ligne > 0.
  select sum(l.line_amount_fcfa), min(l.line_amount_fcfa) into v_total, v_min from public.parse_quote_lines(p_lines) l;
  if v_min < 1 then
    raise exception 'line_amount_not_positive';
  end if;

  if v_order.id is null then
    insert into public.change_orders (project_id, quote_id, accepted_quote_version_id, created_by_profile_id)
    values (p_project_id, v_quote.id, v_quote.accepted_version_id, v_uid)
    returning * into v_order;
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next from public.change_order_versions where change_order_id = v_order.id;

  insert into public.change_order_versions (change_order_id, project_id, version_number, title, reason, total_amount_fcfa, created_by_profile_id)
  values (v_order.id, p_project_id, v_next, v_title, v_reason, v_total, v_uid)
  returning * into v_version;

  insert into public.change_order_version_lines (version_id, project_id, position, label, unit, quantity, unit_price_fcfa, line_amount_fcfa)
  select v_version.id, p_project_id, l.line_position, l.label, l.unit, l.quantity, l.unit_price_fcfa, l.line_amount_fcfa
  from public.parse_quote_lines(p_lines) l order by l.line_position;

  -- Toute nouvelle version incrémente la révision de l'avenant (déclencheur).
  update public.change_orders set pending_version_id = pending_version_id where id = v_order.id;

  return v_version;
end;
$$;

revoke execute on function public.create_change_order_estimate(uuid, uuid, text, text, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.create_change_order_estimate(uuid, uuid, text, text, jsonb, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- propose_change_order_version — CONTRACTOR actif ; remplace uniquement la
-- proposition en attente du MÊME avenant (SUPERSEDED).
-- ----------------------------------------------------------------------------

create function public.propose_change_order_version(p_version_id uuid, p_expected_revision integer)
returns public.change_order_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_order_id uuid;
  v_membership_id uuid;
  v_order public.change_orders;
  v_target public.change_order_versions;
  v_previous_pending uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;

  select project_id, change_order_id into v_project_id, v_order_id from public.change_order_versions where id = p_version_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = v_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.projects where id = v_project_id for update;
  perform 1 from public.quotes where project_id = v_project_id for update;
  select * into v_order from public.change_orders where id = v_order_id for update;
  perform 1 from public.change_order_versions
  where id in (p_version_id, v_order.pending_version_id) order by id for update;
  select * into v_target from public.change_order_versions where id = p_version_id;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_order.revision is distinct from p_expected_revision then
    raise exception 'change_order_conflict';
  end if;
  if v_order.accepted_version_id is not null then
    raise exception 'change_order_accepted';
  end if;
  if v_target.status <> 'ESTIMATE' then
    raise exception 'version_not_estimate';
  end if;

  v_previous_pending := v_order.pending_version_id;
  if v_previous_pending is not null then
    update public.change_orders set pending_version_id = null where id = v_order_id;
    update public.change_order_versions set status = 'SUPERSEDED' where id = v_previous_pending;
  end if;

  update public.change_order_versions set status = 'PROPOSED' where id = p_version_id returning * into v_target;

  insert into public.change_order_proposals (version_id, change_order_id, project_id, proposed_by_profile_id, proposed_at_server, supersedes_version_id)
  values (p_version_id, v_order_id, v_project_id, v_uid, clock_timestamp(), v_previous_pending);

  update public.change_orders set pending_version_id = p_version_id where id = v_order_id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_project_id, 'HUMAN', v_uid, 'CHANGE_ORDER_PROPOSED', 'change_order_versions', p_version_id, 'SUCCESS',
          jsonb_build_object('change_order_id', v_order_id, 'total_amount_fcfa', v_target.total_amount_fcfa, 'supersedes_version_id', v_previous_pending),
          'Proposition chiffrée d''un avenant au client.');

  return v_target;
end;
$$;

revoke execute on function public.propose_change_order_version(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.propose_change_order_version(uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- decide_change_order_version — OWNER/PRIMARY seul (D117).
-- ----------------------------------------------------------------------------

create function public.decide_change_order_version(p_version_id uuid, p_decision text, p_reason text, p_expected_revision integer)
returns public.change_order_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_order_id uuid;
  v_membership_id uuid;
  v_order public.change_orders;
  v_target public.change_order_versions;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_decision is null or p_decision not in ('ACCEPTED', 'REFUSED') then
    raise exception 'invalid_decision';
  end if;
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;
  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception 'invalid_reason';
  end if;

  select project_id, change_order_id into v_project_id, v_order_id from public.change_order_versions where id = p_version_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = v_project_id and profile_id = v_uid and revoked_at is null
    and role = 'OWNER' and owner_profile = 'PRIMARY'
  for update;
  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.projects where id = v_project_id for update;
  perform 1 from public.quotes where project_id = v_project_id for update;
  select * into v_order from public.change_orders where id = v_order_id for update;
  select * into v_target from public.change_order_versions where id = p_version_id for update;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_order.revision is distinct from p_expected_revision then
    raise exception 'change_order_conflict';
  end if;
  -- Un brouillon n'est jamais décidable ni révélé : même refus qu'une version absente.
  if v_target.status = 'ESTIMATE' then
    raise exception 'not_authorized';
  end if;
  if v_target.status <> 'PROPOSED' or v_order.pending_version_id is distinct from p_version_id then
    raise exception 'version_not_pending';
  end if;

  update public.change_orders set pending_version_id = null where id = v_order_id;
  update public.change_order_versions set status = p_decision where id = p_version_id returning * into v_target;

  insert into public.change_order_decisions (version_id, change_order_id, project_id, decision, decided_by_profile_id, decided_at_server, reason)
  values (p_version_id, v_order_id, v_project_id, p_decision, v_uid, clock_timestamp(), v_reason);

  if p_decision = 'ACCEPTED' then
    update public.change_orders set accepted_version_id = p_version_id where id = v_order_id;
  end if;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_project_id, 'HUMAN', v_uid,
          case when p_decision = 'ACCEPTED' then 'CHANGE_ORDER_ACCEPTED' else 'CHANGE_ORDER_REFUSED' end,
          'change_order_versions', p_version_id, 'SUCCESS',
          jsonb_build_object('change_order_id', v_order_id, 'total_amount_fcfa', v_target.total_amount_fcfa),
          coalesce(v_reason, 'Décision du client sur l''avenant proposé.'));

  return v_target;
end;
$$;

revoke execute on function public.decide_change_order_version(uuid, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.decide_change_order_version(uuid, text, text, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- authorize_change_order_execution — CONTRACTOR actif, avenant accepté, une
-- seule fois (refus explicite execution_already_authorized, sans doublon).
-- ----------------------------------------------------------------------------

create function public.authorize_change_order_execution(p_change_order_id uuid, p_expected_revision integer)
returns public.change_order_execution_authorizations
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_membership_id uuid;
  v_order public.change_orders;
  v_auth public.change_order_execution_authorizations;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;

  select project_id into v_project_id from public.change_orders where id = p_change_order_id;
  if v_project_id is null then
    raise exception 'not_authorized';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || v_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = v_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.projects where id = v_project_id for update;
  perform 1 from public.quotes where project_id = v_project_id for update;
  select * into v_order from public.change_orders where id = p_change_order_id for update;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_order.revision is distinct from p_expected_revision then
    raise exception 'change_order_conflict';
  end if;
  if v_order.accepted_version_id is null then
    raise exception 'change_order_not_accepted';
  end if;
  if exists (select 1 from public.change_order_execution_authorizations where change_order_id = p_change_order_id) then
    raise exception 'execution_already_authorized';
  end if;

  insert into public.change_order_execution_authorizations (change_order_id, version_id, project_id, authorized_by_profile_id, authorized_at_server)
  values (p_change_order_id, v_order.accepted_version_id, v_project_id, v_uid, clock_timestamp())
  returning * into v_auth;

  -- L'autorisation incrémente la révision de l'avenant (déclencheur).
  update public.change_orders set pending_version_id = pending_version_id where id = p_change_order_id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_project_id, 'HUMAN', v_uid, 'CHANGE_ORDER_EXECUTION_AUTHORIZED', 'change_order_versions', v_order.accepted_version_id, 'SUCCESS',
          jsonb_build_object('change_order_id', p_change_order_id),
          'Autorisation d''exécution du périmètre de l''avenant accepté dans l''application.');

  return v_auth;
end;
$$;

revoke execute on function public.authorize_change_order_execution(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.authorize_change_order_execution(uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- Lectures.
-- ----------------------------------------------------------------------------

-- Une ligne par version lisible (D118). La révision n'est fournie qu'aux
-- acteurs qui agissent (CONTRACTOR, OWNER/PRIMARY).
create type public.change_order_version_view as (
  change_order_id uuid,
  revision integer,
  version_id uuid,
  version_number integer,
  status text,
  title text,
  reason text,
  total_amount_fcfa text,
  is_pending boolean,
  is_accepted boolean,
  created_at_server timestamptz,
  proposed_at_server timestamptz,
  decided_at_server timestamptz,
  decision_reason text,
  execution_authorized_at_server timestamptz
);

create function public.list_change_orders(p_project_id uuid)
returns setof public.change_order_version_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership public.project_memberships;
  v_acts boolean;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  select * into v_membership from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null
    and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile in ('PRIMARY', 'CO_OWNER')));
  if not found then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;
  v_acts := v_membership.role = 'CONTRACTOR' or v_membership.owner_profile = 'PRIMARY';

  return query
  select o.id, case when v_acts then o.revision else null end, v.id, v.version_number, v.status, v.title, v.reason,
         v.total_amount_fcfa::text, o.pending_version_id is not distinct from v.id, o.accepted_version_id is not distinct from v.id,
         v.created_at_server, p.proposed_at_server, d.decided_at_server, d.reason,
         case when a.version_id = v.id then a.authorized_at_server else null end
  from public.change_order_versions v
  join public.change_orders o on o.id = v.change_order_id
  left join public.change_order_proposals p on p.version_id = v.id
  left join public.change_order_decisions d on d.version_id = v.id
  left join public.change_order_execution_authorizations a on a.change_order_id = o.id
  where v.project_id = p_project_id
    and public.change_order_version_readable(v.id, v_uid)
  order by o.created_at_server, o.id, v.version_number desc;
end;
$$;

revoke execute on function public.list_change_orders(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_change_orders(uuid) to authenticated;

create function public.get_change_order_version_lines(p_version_id uuid)
returns setof public.quote_version_line_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not public.change_order_version_readable(p_version_id, auth.uid()) then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select l.position, l.label, l.unit, l.quantity::text, l.unit_price_fcfa::text, l.line_amount_fcfa::text
  from public.change_order_version_lines l
  where l.version_id = p_version_id
  order by l.position;
end;
$$;

revoke execute on function public.get_change_order_version_lines(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_change_order_version_lines(uuid) to authenticated;

-- Montant contractuel dérivé (BR094) : devis accepté + version ACCEPTED de
-- chaque avenant (une seule par avenant : accepted_version_id). Texte exact.
create type public.contract_amount as (
  quote_amount_fcfa text,
  change_orders_amount_fcfa text,
  accepted_change_order_count integer,
  contract_amount_fcfa text
);

create function public.get_contract_amount(p_project_id uuid)
returns public.contract_amount
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_quote_amount numeric;
  v_orders_amount numeric;
  v_count integer;
  v_result public.contract_amount;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = v_uid and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile in ('PRIMARY', 'CO_OWNER')))
  ) then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  select v.total_amount_fcfa into v_quote_amount
  from public.quotes q join public.quote_versions v on v.id = q.accepted_version_id
  where q.project_id = p_project_id;
  if v_quote_amount is null then
    return v_result;
  end if;

  select coalesce(sum(v.total_amount_fcfa), 0), count(*) into v_orders_amount, v_count
  from public.change_orders o join public.change_order_versions v on v.id = o.accepted_version_id
  where o.project_id = p_project_id and v.status = 'ACCEPTED';

  v_result.quote_amount_fcfa := v_quote_amount::text;
  v_result.change_orders_amount_fcfa := v_orders_amount::text;
  v_result.accepted_change_order_count := v_count;
  v_result.contract_amount_fcfa := (v_quote_amount + v_orders_amount)::text;
  return v_result;
end;
$$;

revoke execute on function public.get_contract_amount(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_contract_amount(uuid) to authenticated;

commit;
