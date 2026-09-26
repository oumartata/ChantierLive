-- M021 — devis de chantier (B065). D085/BR093/BR094 ; arbitrages D112-D116.
--   D112 : seul OWNER/PRIMARY décide (CO_OWNER différé, APPROVAL_DECIDE non détourné).
--   D113 : estimation liée au plan RETENU ; proposition si cette version est
--          retenue ET publiée ; revérifié à l'acceptation, sinon plan_changed.
--   D114 : un devis par chantier, une seule proposition en attente ; aucune
--          nouvelle version après acceptation (modifications = avenants B066).
--   D115 : lignes (libellé, unité, quantité NUMERIC bornée, prix unitaire FCFA),
--          montant de ligne arrondi au FCFA (demi vers le haut), total = somme.
--   D116 : estimations privées au CONTRACTOR ; OWNER/PRIMARY et CO_OWNER voient
--          les versions proposées et leur historique ; aucun accès SITE_MANAGER.
-- Hors périmètre : avenants (B066), avance/paiements, vue client (B068), démarrage (B067).
--
-- Précision numérique (D115) :
--   quantité  : texte ^\d{1,7}(\.\d{1,3})?$ vérifié AVANT conversion, 0 < q <= 1 000 000 ;
--   prix      : texte ^\d{1,11}$ vérifié AVANT conversion, 0 <= p <= 10 000 000 000 FCFA ;
--   ligne     : round(q * p) en numeric exact (demi vers le haut pour des valeurs
--               positives), <= 1 000 000 000 000 FCFA ;
--   total     : somme des montants de ligne, <= 1 000 000 000 000 FCFA ;
--   1 à 200 lignes, libellé 1-200 caractères, unité 1-20 caractères.
--   Toute valeur hors format ou hors borne est refusée, jamais arrondie.
--
-- Ordre des verrous (écritures) : avisoire du chantier (même clé que B063/B064,
-- qui fige plan retenu et publié) -> adhésion de l'appelant -> projects ->
-- quotes -> versions (id croissant). Compte vérifié relu après la dernière
-- attente, avant toute écriture.

begin;

-- ----------------------------------------------------------------------------
-- Tables.
-- ----------------------------------------------------------------------------

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects (id) on delete restrict,
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  revision integer not null default 0,
  pending_version_id uuid null,
  accepted_version_id uuid null,
  constraint quotes_id_project_unique unique (id, project_id)
);

create table public.quote_versions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status text not null default 'ESTIMATE',
  plan_version_id uuid not null,
  total_amount_fcfa bigint not null check (total_amount_fcfa between 0 and 1000000000000),
  created_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  created_at_server timestamptz not null default now(),
  -- Transaction de création : seules des lignes insérées dans CETTE transaction
  -- peuvent rattacher des prestations à la version (aucun ajout tardif).
  created_xact xid8 not null default pg_current_xact_id(),
  constraint quote_versions_status_known check (status in ('ESTIMATE', 'PROPOSED', 'ACCEPTED', 'REFUSED', 'SUPERSEDED')),
  constraint quote_versions_number_unique unique (quote_id, version_number),
  constraint quote_versions_id_project_unique unique (id, project_id),
  constraint quote_versions_quote_project_fk foreign key (quote_id, project_id) references public.quotes (id, project_id),
  constraint quote_versions_plan_project_fk foreign key (plan_version_id, project_id) references public.project_plan_versions (id, project_id)
);

create unique index quote_versions_one_proposed_per_quote on public.quote_versions (quote_id) where status = 'PROPOSED';
create index quote_versions_project_id_idx on public.quote_versions (project_id);

alter table public.quotes
  add constraint quotes_pending_version_fk foreign key (pending_version_id, project_id) references public.quote_versions (id, project_id),
  add constraint quotes_accepted_version_fk foreign key (accepted_version_id, project_id) references public.quote_versions (id, project_id);

create table public.quote_version_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.quote_versions (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  position integer not null check (position between 1 and 200),
  label text not null check (char_length(label) between 1 and 200),
  unit text not null check (char_length(unit) between 1 and 20),
  quantity numeric(10, 3) not null check (quantity > 0 and quantity <= 1000000),
  unit_price_fcfa bigint not null check (unit_price_fcfa between 0 and 10000000000),
  line_amount_fcfa bigint not null check (line_amount_fcfa between 0 and 1000000000000),
  constraint quote_version_lines_amount_exact check (line_amount_fcfa = round(quantity * unit_price_fcfa)),
  constraint quote_version_lines_position_unique unique (version_id, position),
  constraint quote_version_lines_version_project_fk foreign key (version_id, project_id) references public.quote_versions (id, project_id)
);

-- Événements séparés, conservés, en insertion seule.
create table public.quote_proposals (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique references public.quote_versions (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  proposed_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  proposed_at_server timestamptz not null,
  published_plan_version_id uuid not null,
  supersedes_version_id uuid null references public.quote_versions (id) on delete restrict,
  constraint quote_proposals_version_project_fk foreign key (version_id, project_id) references public.quote_versions (id, project_id),
  constraint quote_proposals_plan_project_fk foreign key (published_plan_version_id, project_id) references public.project_plan_versions (id, project_id)
);

create table public.quote_decisions (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique references public.quote_versions (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  decision text not null check (decision in ('ACCEPTED', 'REFUSED')),
  decided_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  decided_at_server timestamptz not null,
  reason text null check (reason is null or char_length(reason) between 1 and 1000),
  constraint quote_decisions_version_project_fk foreign key (version_id, project_id) references public.quote_versions (id, project_id)
);

-- ----------------------------------------------------------------------------
-- Déclencheurs d'intégrité.
-- ----------------------------------------------------------------------------

-- quotes : révision incrémentée par le serveur à chaque mise à jour ;
-- pending_version_id ne pointe que vers une version PROPOSED ;
-- accepted_version_id est posé une seule fois, vers une version ACCEPTED.
create function public.guard_quote_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quote_immutable';
  end if;
  if new.project_id <> old.project_id or new.created_by_profile_id <> old.created_by_profile_id
     or new.created_at_server <> old.created_at_server then
    raise exception 'quote_immutable';
  end if;
  if old.accepted_version_id is not null and new.accepted_version_id is distinct from old.accepted_version_id then
    raise exception 'quote_immutable';
  end if;
  if new.pending_version_id is not null
     and (select status from public.quote_versions where id = new.pending_version_id) is distinct from 'PROPOSED' then
    raise exception 'pending_version_not_proposed';
  end if;
  if new.accepted_version_id is not null
     and (select status from public.quote_versions where id = new.accepted_version_id) is distinct from 'ACCEPTED' then
    raise exception 'accepted_version_not_accepted';
  end if;
  new.revision := old.revision + 1;
  return new;
end;
$$;

create trigger guard_quote_update
before update or delete on public.quotes
for each row execute function public.guard_quote_update();

-- Nouveau devis : révision 0, sans pointeur (posés ensuite par mise à jour).
create function public.guard_quote_insert()
returns trigger
language plpgsql
as $$
begin
  if new.pending_version_id is not null or new.accepted_version_id is not null then
    raise exception 'quote_immutable';
  end if;
  new.revision := 0;
  return new;
end;
$$;

create trigger guard_quote_insert
before insert on public.quotes
for each row execute function public.guard_quote_insert();

-- quote_versions : contenu immuable ; seules transitions permises
-- ESTIMATE -> PROPOSED et PROPOSED -> ACCEPTED | REFUSED | SUPERSEDED.
create function public.guard_quote_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quote_version_immutable';
  end if;
  if new.quote_id <> old.quote_id or new.project_id <> old.project_id or new.version_number <> old.version_number
     or new.plan_version_id <> old.plan_version_id or new.total_amount_fcfa <> old.total_amount_fcfa
     or new.created_by_profile_id <> old.created_by_profile_id or new.created_at_server <> old.created_at_server
     or new.created_xact <> old.created_xact then
    raise exception 'quote_version_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'ESTIMATE' and new.status = 'PROPOSED')
     or (old.status = 'PROPOSED' and new.status in ('ACCEPTED', 'REFUSED', 'SUPERSEDED')) then
    return new;
  end if;
  raise exception 'quote_version_transition_refused';
end;
$$;

create trigger guard_quote_version_mutation
before update or delete on public.quote_versions
for each row execute function public.guard_quote_version_mutation();

create function public.guard_quote_version_insert()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'ESTIMATE' then
    raise exception 'quote_version_must_start_as_estimate';
  end if;
  new.created_xact := pg_current_xact_id();
  return new;
end;
$$;

create trigger guard_quote_version_insert
before insert on public.quote_versions
for each row execute function public.guard_quote_version_insert();

-- Lignes : insertion uniquement dans la transaction qui crée la version
-- (aucun ajout tardif), jamais de modification ni de suppression.
create function public.guard_quote_version_line()
returns trigger
language plpgsql
as $$
declare
  v_created_xact xid8;
  v_status text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'quote_version_line_immutable';
  end if;
  select created_xact, status into v_created_xact, v_status from public.quote_versions where id = new.version_id;
  if v_created_xact is distinct from pg_current_xact_id() or v_status is distinct from 'ESTIMATE' then
    raise exception 'quote_version_lines_closed';
  end if;
  return new;
end;
$$;

create trigger guard_quote_version_line
before insert or update or delete on public.quote_version_lines
for each row execute function public.guard_quote_version_line();

-- Cohérence vérifiée à la validation de la transaction de création :
-- 1 à 200 lignes, total = somme exacte des montants de ligne.
-- SECURITY DEFINER : le contrôle différé s'exécute à la validation de la
-- transaction, hors de la fonction RPC appelante, avec les droits de
-- l'appelant (authenticated, sans aucun droit direct sur ces tables).
create function public.check_quote_version_total()
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
  select total_amount_fcfa into v_total from public.quote_versions where id = new.id;
  select count(*), coalesce(sum(line_amount_fcfa), 0) into v_count, v_sum
  from public.quote_version_lines where version_id = new.id;
  if v_count < 1 or v_count > 200 or v_sum <> v_total then
    raise exception 'quote_version_total_inconsistent';
  end if;
  return null;
end;
$$;

create constraint trigger check_quote_version_total
after insert on public.quote_versions
deferrable initially deferred
for each row execute function public.check_quote_version_total();

create function public.reject_quote_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'quote_event_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.quote_proposals
for each row execute function public.reject_quote_event_mutation();
create trigger reject_mutation before update or delete on public.quote_decisions
for each row execute function public.reject_quote_event_mutation();

alter table public.quotes enable row level security;
alter table public.quote_versions enable row level security;
alter table public.quote_version_lines enable row level security;
alter table public.quote_proposals enable row level security;
alter table public.quote_decisions enable row level security;
revoke all privileges on table public.quotes, public.quote_versions, public.quote_version_lines,
  public.quote_proposals, public.quote_decisions from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Lecture (D116) : prédicat unique.
-- ----------------------------------------------------------------------------

create function public.quote_version_readable(p_version_id uuid, p_uid uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from public.quote_versions v
    join public.project_memberships m on m.project_id = v.project_id and m.profile_id = p_uid and m.revoked_at is null
    where v.id = p_version_id
      and (
        m.role = 'CONTRACTOR'
        or (m.role = 'OWNER' and m.owner_profile in ('PRIMARY', 'CO_OWNER')
            and exists (select 1 from public.quote_proposals p where p.version_id = v.id))
      )
  );
$$;

revoke execute on function public.quote_version_readable(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Analyse des lignes (D115) : formats vérifiés AVANT toute conversion.
-- ----------------------------------------------------------------------------

create function public.parse_quote_lines(p_lines jsonb)
returns table (line_position integer, label text, unit text, quantity numeric, unit_price_fcfa bigint, line_amount_fcfa bigint)
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_line jsonb;
  v_i integer := 0;
  v_label text;
  v_unit text;
  v_qty_text text;
  v_price_text text;
  v_qty numeric;
  v_price numeric;
  v_amount numeric;
  v_total numeric := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines';
  end if;
  if jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 200 then
    raise exception 'invalid_lines_count';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_i := v_i + 1;
    if jsonb_typeof(v_line) <> 'object'
       or jsonb_typeof(v_line -> 'label') is distinct from 'string'
       or jsonb_typeof(v_line -> 'unit') is distinct from 'string'
       or jsonb_typeof(v_line -> 'quantity') is distinct from 'string'
       or jsonb_typeof(v_line -> 'unit_price_fcfa') is distinct from 'string' then
      raise exception 'invalid_line';
    end if;
    v_label := btrim(v_line ->> 'label');
    v_unit := btrim(v_line ->> 'unit');
    v_qty_text := v_line ->> 'quantity';
    v_price_text := v_line ->> 'unit_price_fcfa';
    if char_length(v_label) not between 1 and 200 or char_length(v_unit) not between 1 and 20 then
      raise exception 'invalid_line';
    end if;
    -- Format vérifié sur le TEXTE : une décimale excédentaire est refusée, jamais arrondie.
    if v_qty_text !~ '^\d{1,7}(\.\d{1,3})?$' or v_price_text !~ '^\d{1,11}$' then
      raise exception 'invalid_line';
    end if;
    v_qty := v_qty_text::numeric;
    v_price := v_price_text::numeric;
    if v_qty <= 0 or v_qty > 1000000 or v_price > 10000000000 then
      raise exception 'amount_out_of_bounds';
    end if;
    v_amount := round(v_qty * v_price);
    if v_amount > 1000000000000 then
      raise exception 'amount_out_of_bounds';
    end if;
    v_total := v_total + v_amount;
    if v_total > 1000000000000 then
      raise exception 'amount_out_of_bounds';
    end if;
    line_position := v_i;
    label := v_label;
    unit := v_unit;
    quantity := v_qty;
    unit_price_fcfa := v_price::bigint;
    line_amount_fcfa := v_amount::bigint;
    return next;
  end loop;
end;
$$;

revoke execute on function public.parse_quote_lines(jsonb) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- create_quote_estimate — CONTRACTOR actif, plan retenu, avant acceptation.
-- Un chantier sans devis est à la révision 0.
-- ----------------------------------------------------------------------------

create function public.create_quote_estimate(p_project_id uuid, p_lines jsonb, p_expected_revision integer)
returns public.quote_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership_id uuid;
  v_project public.projects;
  v_quote public.quotes;
  v_version public.quote_versions;
  v_total bigint;
  v_next integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('invitation_quota:' || p_project_id::text)::bigint);

  select id into v_membership_id
  from public.project_memberships
  where project_id = p_project_id and profile_id = v_uid and revoked_at is null and role = 'CONTRACTOR'
  for update;
  if v_membership_id is null then
    raise exception 'not_authorized';
  end if;

  select * into v_project from public.projects where id = p_project_id for update;
  select * into v_quote from public.quotes where project_id = p_project_id for update;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if coalesce(v_quote.revision, 0) is distinct from p_expected_revision then
    raise exception 'quote_conflict';
  end if;
  if v_quote.accepted_version_id is not null then
    raise exception 'quote_accepted';
  end if;
  if v_project.retained_plan_version_id is null then
    raise exception 'no_retained_plan';
  end if;

  -- Analyse complète (formats, bornes) AVANT toute écriture : une erreur est
  -- levée ici, rien n'est encore inséré.
  select sum(l.line_amount_fcfa) into v_total from public.parse_quote_lines(p_lines) l;

  if v_quote.id is null then
    insert into public.quotes (project_id, created_by_profile_id) values (p_project_id, v_uid) returning * into v_quote;
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next from public.quote_versions where quote_id = v_quote.id;

  insert into public.quote_versions (quote_id, project_id, version_number, plan_version_id, total_amount_fcfa, created_by_profile_id)
  values (v_quote.id, p_project_id, v_next, v_project.retained_plan_version_id, v_total, v_uid)
  returning * into v_version;

  insert into public.quote_version_lines (version_id, project_id, position, label, unit, quantity, unit_price_fcfa, line_amount_fcfa)
  select v_version.id, p_project_id, l.line_position, l.label, l.unit, l.quantity, l.unit_price_fcfa, l.line_amount_fcfa
  from public.parse_quote_lines(p_lines) l order by l.line_position;

  -- Toute création de version incrémente la révision du devis (déclencheur).
  update public.quotes set pending_version_id = pending_version_id where id = v_quote.id;

  return v_version;
end;
$$;

revoke execute on function public.create_quote_estimate(uuid, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.create_quote_estimate(uuid, jsonb, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- propose_quote_version — CONTRACTOR actif ; version liée retenue ET publiée ;
-- remplace explicitement une proposition en attente (SUPERSEDED).
-- ----------------------------------------------------------------------------

create function public.propose_quote_version(p_version_id uuid, p_expected_revision integer)
returns public.quote_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_membership_id uuid;
  v_project public.projects;
  v_quote public.quotes;
  v_target public.quote_versions;
  v_previous_pending uuid;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_expected_revision is null then
    raise exception 'expected_revision_required';
  end if;

  select project_id into v_project_id from public.quote_versions where id = p_version_id;
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

  select * into v_project from public.projects where id = v_project_id for update;
  select * into v_quote from public.quotes where project_id = v_project_id for update;
  perform 1 from public.quote_versions
  where id in (p_version_id, v_quote.pending_version_id) order by id for update;
  select * into v_target from public.quote_versions where id = p_version_id;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_quote.revision is distinct from p_expected_revision then
    raise exception 'quote_conflict';
  end if;
  if v_quote.accepted_version_id is not null then
    raise exception 'quote_accepted';
  end if;
  if v_target.status <> 'ESTIMATE' then
    raise exception 'version_not_estimate';
  end if;
  if v_project.retained_plan_version_id is distinct from v_target.plan_version_id
     or v_project.published_plan_version_id is distinct from v_target.plan_version_id then
    raise exception 'plan_not_retained_and_published';
  end if;
  if v_target.total_amount_fcfa <= 0 then
    raise exception 'quote_total_zero';
  end if;

  v_previous_pending := v_quote.pending_version_id;
  if v_previous_pending is not null then
    update public.quotes set pending_version_id = null where id = v_quote.id;
    update public.quote_versions set status = 'SUPERSEDED' where id = v_previous_pending;
  end if;

  update public.quote_versions set status = 'PROPOSED' where id = p_version_id returning * into v_target;

  insert into public.quote_proposals (version_id, project_id, proposed_by_profile_id, proposed_at_server, published_plan_version_id, supersedes_version_id)
  values (p_version_id, v_project_id, v_uid, clock_timestamp(), v_project.published_plan_version_id, v_previous_pending);

  update public.quotes set pending_version_id = p_version_id where id = v_quote.id;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_project_id, 'HUMAN', v_uid, 'QUOTE_PROPOSED', 'quote_versions', p_version_id, 'SUCCESS',
          jsonb_build_object('total_amount_fcfa', v_target.total_amount_fcfa, 'plan_version_id', v_target.plan_version_id, 'supersedes_version_id', v_previous_pending),
          'Proposition chiffrée du devis au client.');

  return v_target;
end;
$$;

revoke execute on function public.propose_quote_version(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.propose_quote_version(uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- decide_quote_version — OWNER/PRIMARY seul (D112) ; décision, montant
-- contractuel (accepted_version_id) et audit dans une seule transaction.
-- ----------------------------------------------------------------------------

create function public.decide_quote_version(p_version_id uuid, p_decision text, p_reason text, p_expected_revision integer)
returns public.quote_versions
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project_id uuid;
  v_membership_id uuid;
  v_project public.projects;
  v_quote public.quotes;
  v_target public.quote_versions;
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

  select project_id into v_project_id from public.quote_versions where id = p_version_id;
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

  select * into v_project from public.projects where id = v_project_id for update;
  select * into v_quote from public.quotes where project_id = v_project_id for update;
  select * into v_target from public.quote_versions where id = p_version_id for update;

  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  if v_quote.revision is distinct from p_expected_revision then
    raise exception 'quote_conflict';
  end if;
  -- Une estimation n'est jamais décidable ni révélée : même refus qu'une version absente.
  if v_target.status = 'ESTIMATE' then
    raise exception 'not_authorized';
  end if;
  if v_target.status <> 'PROPOSED' or v_quote.pending_version_id is distinct from p_version_id then
    raise exception 'version_not_pending';
  end if;
  if p_decision = 'ACCEPTED'
     and (v_project.retained_plan_version_id is distinct from v_target.plan_version_id
          or v_project.published_plan_version_id is distinct from v_target.plan_version_id) then
    raise exception 'plan_changed';
  end if;

  update public.quotes set pending_version_id = null where id = v_quote.id;
  update public.quote_versions set status = p_decision where id = p_version_id returning * into v_target;

  insert into public.quote_decisions (version_id, project_id, decision, decided_by_profile_id, decided_at_server, reason)
  values (p_version_id, v_project_id, p_decision, v_uid, clock_timestamp(), v_reason);

  if p_decision = 'ACCEPTED' then
    update public.quotes set accepted_version_id = p_version_id where id = v_quote.id;
  end if;

  insert into public.audit_events (project_id, actor_kind, actor_profile_id, action, target_table, target_id, result, context, reason)
  values (v_project_id, 'HUMAN', v_uid, case when p_decision = 'ACCEPTED' then 'QUOTE_ACCEPTED' else 'QUOTE_REFUSED' end,
          'quote_versions', p_version_id, 'SUCCESS',
          jsonb_build_object('total_amount_fcfa', v_target.total_amount_fcfa, 'plan_version_id', v_target.plan_version_id),
          coalesce(v_reason, 'Décision du client sur le devis proposé.'));

  return v_target;
end;
$$;

revoke execute on function public.decide_quote_version(uuid, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.decide_quote_version(uuid, text, text, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- Lectures.
-- ----------------------------------------------------------------------------

-- État du devis : la révision n'est fournie qu'aux acteurs qui agissent
-- (CONTRACTOR, OWNER/PRIMARY) ; elle ne désigne aucune version. pending ne
-- pointe que vers une version PROPOSED (déclencheur).
create type public.quote_state as (
  has_quote boolean,
  revision integer,
  pending_version_id uuid,
  accepted_version_id uuid,
  contract_amount_fcfa text
);

create function public.get_quote_state(p_project_id uuid)
returns public.quote_state
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_membership public.project_memberships;
  v_quote public.quotes;
  v_amount bigint;
  v_state public.quote_state;
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

  select * into v_quote from public.quotes where project_id = p_project_id;
  if v_quote.accepted_version_id is not null then
    select total_amount_fcfa into v_amount from public.quote_versions where id = v_quote.accepted_version_id;
  end if;

  v_state.has_quote := v_quote.id is not null;
  v_state.revision := case
    when v_membership.role = 'CONTRACTOR' or v_membership.owner_profile = 'PRIMARY' then coalesce(v_quote.revision, 0)
    else null end;
  v_state.pending_version_id := v_quote.pending_version_id;
  v_state.accepted_version_id := v_quote.accepted_version_id;
  v_state.contract_amount_fcfa := v_amount::text;
  return v_state;
end;
$$;

revoke execute on function public.get_quote_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_quote_state(uuid) to authenticated;

create type public.quote_version_view as (
  version_id uuid,
  version_number integer,
  status text,
  total_amount_fcfa text,
  plan_version_id uuid,
  created_at_server timestamptz,
  proposed_at_server timestamptz,
  decided_at_server timestamptz,
  decision_reason text
);

create function public.list_quote_versions(p_project_id uuid)
returns setof public.quote_version_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.project_memberships
    where project_id = p_project_id and profile_id = auth.uid() and revoked_at is null
      and (role = 'CONTRACTOR' or (role = 'OWNER' and owner_profile in ('PRIMARY', 'CO_OWNER')))
  ) then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select v.id, v.version_number, v.status, v.total_amount_fcfa::text, v.plan_version_id, v.created_at_server,
         p.proposed_at_server, d.decided_at_server, d.reason
  from public.quote_versions v
  left join public.quote_proposals p on p.version_id = v.id
  left join public.quote_decisions d on d.version_id = v.id
  where v.project_id = p_project_id
    and public.quote_version_readable(v.id, auth.uid())
  order by v.version_number desc;
end;
$$;

revoke execute on function public.list_quote_versions(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_quote_versions(uuid) to authenticated;

create type public.quote_version_line_view as (
  line_position integer,
  label text,
  unit text,
  quantity text,
  unit_price_fcfa text,
  line_amount_fcfa text
);

create function public.get_quote_version_lines(p_version_id uuid)
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
  if not public.quote_version_readable(p_version_id, auth.uid()) then
    raise exception 'not_authorized';
  end if;
  if public.is_account_provisional() is not false then
    raise exception 'account_provisional' using errcode = '42501';
  end if;

  return query
  select l.position, l.label, l.unit, l.quantity::text, l.unit_price_fcfa::text, l.line_amount_fcfa::text
  from public.quote_version_lines l
  where l.version_id = p_version_id
  order by l.position;
end;
$$;

revoke execute on function public.get_quote_version_lines(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_quote_version_lines(uuid) to authenticated;

commit;
