-- M052 — B045 : notifications internes et e-mail (done_when : « aucun e-mail
-- non vérifié »). Décisions du fondateur 2026-10-08 : D199 (N1 à N12 de
-- PROPOSITION_B045_NOTIFICATIONS.md dans le cadre de la boucle 36b), D198
-- (bandeau support pour tous les membres), BR061, BR062, BR071, BR073,
-- FR119 à FR124, FR144, AC104, D183, D185, D187.
--
-- - Création dans la MÊME transaction que l'action : déclencheurs sur
--   audit_events (chantier), platform_audit_events (licence) et
--   support_access_events (support). Si l'action échoue, rien n'est créé.
-- - Destinataires calculés à cet instant d'après les droits réels (adhésion
--   active, partie, visibilité) ; jamais l'auteur ; une seule notification
--   par événement et par destinataire.
-- - Jamais une finance interne ni un document « Entreprise seulement » vers un
--   propriétaire ; texte minimal, sans montant, sans nom ni identifiant de
--   personne ; le nom du chantier est joint à l'affichage seulement.
-- - Ex-membre : plus aucune notification du chantier visible (filtre à la
--   lecture, droit revérifié) ; personne retirée : un message unique sans nom
--   de chantier.
-- - E-mail : file en base, adresse e-mail VÉRIFIÉE seulement ; texte
--   « Nouvelle notification » et un lien ; aucun envoi depuis la base.
-- - Échéances (licence à 30 jours, 7 jours, le jour même ; fin d'accès
--   support) : calculées à l'ouverture de l'application, sans doublon.
-- - Préférences par catégorie (interne, e-mail), sauf alertes obligatoires :
--   incident urgent, décision attendue, échéance de licence.

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles (id) on delete restrict,
  project_id uuid null references public.projects (id) on delete restrict,
  kind text not null,
  category text not null check (category in ('CHANTIER', 'FINANCES', 'LICENCE', 'SUPPORT', 'COMPTE', 'OBLIGATOIRE', 'ADMIN')),
  mandatory boolean not null,
  audience text not null check (audience in ('MEMBER', 'PRINCIPAUX', 'ENTREPRISE', 'INTERNAL', 'FINANCE', 'OWNER_PRIMARY', 'CONTRACTOR', 'PRINCIPAL', 'ACCOUNT')),
  title text not null check (char_length(title) between 1 and 200),
  link text null check (link is null or (link like '/%' and char_length(link) <= 300)),
  group_count integer not null default 1 check (group_count >= 1),
  dedup_key text null,
  created_at_server timestamptz not null default clock_timestamp(),
  updated_at_server timestamptz not null default clock_timestamp(),
  read_at_server timestamptz null,
  constraint notifications_account_scope check ((audience = 'ACCOUNT') = (project_id is null))
);

create unique index notifications_dedup_idx on public.notifications (recipient_profile_id, dedup_key) where dedup_key is not null;
create index notifications_recipient_idx on public.notifications (recipient_profile_id, updated_at_server desc);

create table public.notification_preferences (
  profile_id uuid not null references public.profiles (id) on delete restrict,
  category text not null check (category in ('CHANTIER', 'FINANCES', 'LICENCE', 'SUPPORT', 'COMPTE')),
  in_app boolean not null default true,
  email boolean not null default true,
  updated_at_server timestamptz not null default clock_timestamp(),
  primary key (profile_id, category)
);

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete restrict,
  recipient_profile_id uuid not null references public.profiles (id) on delete restrict,
  to_address text not null,
  subject text not null,
  body text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'DELIVERED_LOCAL')),
  created_at_server timestamptz not null default clock_timestamp(),
  delivered_at_server timestamptz null,
  constraint email_outbox_delivery check ((status = 'DELIVERED_LOCAL') = (delivered_at_server is not null))
);

create index email_outbox_pending_idx on public.email_outbox (status, created_at_server);

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.email_outbox enable row level security;
revoke all privileges on table public.notifications, public.notification_preferences, public.email_outbox from public, anon, authenticated;

-- Gardes : une notification n'est jamais réécrite (lecture une seule fois ;
-- regroupement des photos tant qu'elle n'est pas lue) ; la file d'e-mail ne
-- change que de PENDING à DELIVERED_LOCAL ; aucune suppression.
create function public.notif_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'notification_immutable';
  end if;
  if new.id <> old.id or new.recipient_profile_id <> old.recipient_profile_id or new.project_id is distinct from old.project_id
     or new.kind <> old.kind or new.category <> old.category or new.mandatory <> old.mandatory or new.audience <> old.audience
     or new.link is distinct from old.link or new.dedup_key is distinct from old.dedup_key or new.created_at_server <> old.created_at_server
     or (old.read_at_server is not null and new.read_at_server is distinct from old.read_at_server)
     or ((new.title <> old.title or new.group_count <> old.group_count) and (old.kind <> 'PHOTOS_PUBLISHED' or old.read_at_server is not null)) then
    raise exception 'notification_immutable';
  end if;
  return new;
end;
$$;

create trigger guard_notification before update or delete on public.notifications
for each row execute function public.notif_guard();

create function public.email_outbox_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' or old.status <> 'PENDING' or new.status <> 'DELIVERED_LOCAL'
     or new.to_address <> old.to_address or new.subject <> old.subject or new.body <> old.body
     or new.notification_id <> old.notification_id or new.recipient_profile_id <> old.recipient_profile_id then
    raise exception 'email_outbox_immutable';
  end if;
  return new;
end;
$$;

create trigger guard_email_outbox before update or delete on public.email_outbox
for each row execute function public.email_outbox_guard();

insert into public.platform_settings (key, value)
values ('app_base_url', '{"url": "http://localhost:3001"}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Aides internes (révoquées pour tous).
-- ---------------------------------------------------------------------------
create function public.notif_audience_ok(p_audience text, p_party text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(case p_audience
    when 'ACCOUNT' then true
    when 'MEMBER' then p_party is not null
    when 'PRINCIPAUX' then p_party in ('CONTRACTOR', 'OWNER_PRIMARY', 'CO_OWNER')
    when 'ENTREPRISE' then p_party = 'CONTRACTOR'
    when 'CONTRACTOR' then p_party = 'CONTRACTOR'
    when 'INTERNAL' then p_party in ('CONTRACTOR', 'SITE_MANAGER')
    when 'FINANCE' then p_party in ('CONTRACTOR', 'OWNER_PRIMARY', 'CO_OWNER')
    when 'OWNER_PRIMARY' then p_party = 'OWNER_PRIMARY'
    when 'PRINCIPAL' then p_party in ('CONTRACTOR', 'OWNER_PRIMARY')
  end, false);
$$;

-- Ajoute une notification (et, si permis, un e-mail en file) pour UN
-- destinataire, après revérification de ses droits à cet instant.
create function public.notif_push(p_recipient uuid, p_project uuid, p_kind text, p_category text, p_mandatory boolean, p_audience text,
                                  p_title text, p_link text, p_dedup text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pref public.notification_preferences;
  v_id uuid;
  v_email text;
  v_base text;
begin
  if p_recipient is null or p_recipient is not distinct from p_actor then
    return;
  end if;
  if p_project is not null and not public.notif_audience_ok(p_audience, public.document_party(p_project, p_recipient)) then
    return;
  end if;
  select * into v_pref from public.notification_preferences np where np.profile_id = p_recipient and np.category = p_category;
  if not p_mandatory and v_pref.in_app is false then
    return;
  end if;
  insert into public.notifications (recipient_profile_id, project_id, kind, category, mandatory, audience, title, link, dedup_key)
  values (p_recipient, p_project, p_kind, p_category, p_mandatory, case when p_project is null then 'ACCOUNT' else p_audience end, p_title, p_link, p_dedup)
  on conflict (recipient_profile_id, dedup_key) where dedup_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    return;
  end if;
  if not p_mandatory and v_pref.email is false then
    return;
  end if;
  select i.value_normalized into v_email from public.profile_identifiers i
  where i.profile_id = p_recipient and i.kind::text = 'EMAIL' and i.verified_at_server is not null and i.archived_at is null
  order by i.verified_at_server desc limit 1;
  if v_email is null then
    return;
  end if;
  select coalesce(s.value->>'url', 'http://localhost:3001') into v_base from public.platform_settings s where s.key = 'app_base_url';
  insert into public.email_outbox (notification_id, recipient_profile_id, to_address, subject, body)
  values (v_id, p_recipient, v_email, 'Nouvelle notification',
          'Vous avez une nouvelle notification dans ChantierLive.' || chr(10) || chr(10) || 'Pour la consulter : '
          || coalesce(v_base, 'http://localhost:3001') || '/notifications');
end;
$$;

-- Tous les membres actifs du chantier correspondant à l'audience.
create function public.notif_push_members(p_project uuid, p_audience text, p_kind text, p_category text, p_mandatory boolean,
                                          p_title text, p_link text, p_dedup text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_member uuid;
begin
  for v_member in
    select distinct m.profile_id from public.project_memberships m where m.project_id = p_project and m.revoked_at is null
  loop
    perform public.notif_push(v_member, p_project, p_kind, p_category, p_mandatory, p_audience, p_title, p_link, p_dedup, p_actor);
  end loop;
end;
$$;

-- Photos regroupées : une notification non lue par destinataire, chantier et
-- jour (UTC), « N nouvelles photos ».
create function public.notif_push_photos(p_project uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_member uuid;
  v_existing public.notifications;
begin
  for v_member in
    select distinct m.profile_id from public.project_memberships m where m.project_id = p_project and m.revoked_at is null
  loop
    continue when v_member is not distinct from p_actor;
    select * into v_existing from public.notifications n
    where n.recipient_profile_id = v_member and n.project_id = p_project and n.kind = 'PHOTOS_PUBLISHED' and n.read_at_server is null
      and (n.created_at_server at time zone 'UTC')::date = (clock_timestamp() at time zone 'UTC')::date
    order by n.created_at_server desc limit 1
    for update;
    if found then
      update public.notifications n set group_count = v_existing.group_count + 1,
             title = (v_existing.group_count + 1) || ' nouvelles photos', updated_at_server = clock_timestamp()
       where n.id = v_existing.id;
    else
      perform public.notif_push(v_member, p_project, 'PHOTOS_PUBLISHED', 'CHANTIER', false, 'MEMBER', '1 nouvelle photo',
                                '/chantiers/' || p_project || '/photos', null, p_actor);
    end if;
  end loop;
end;
$$;

revoke execute on function public.notif_audience_ok(text, text),
  public.notif_push(uuid, uuid, text, text, boolean, text, text, text, text, uuid),
  public.notif_push_members(uuid, text, text, text, boolean, text, text, text, uuid),
  public.notif_push_photos(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Événements du chantier (audit_events).
-- ---------------------------------------------------------------------------
create function public.notif_on_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  p uuid := new.project_id;
  a uuid := new.actor_profile_id;
  k text := 'A:' || new.id;
  base text := '/chantiers/' || new.project_id;
  v_text text;
  v_uuid uuid;
  v_uuid2 uuid;
  v_role text;
begin
  if p is null and new.action not in ('LICENSE_PAYMENT_DECLARED') then
    return null;
  end if;
  case new.action
    when 'DAILY_LOG_PUBLISH' then
      perform public.notif_push_members(p, 'MEMBER', 'DAILY_LOG_PUBLISHED', 'CHANTIER', false, 'Nouveau journal publié', base || '/journal', k, a);
    when 'INCIDENT_CREATE' then
      select i.severity into v_text from public.incidents i where i.id = new.target_id;
      if v_text = 'URGENTE' then
        perform public.notif_push_members(p, 'MEMBER', 'INCIDENT_URGENT', 'OBLIGATOIRE', true, 'Incident URGENT signalé', base || '/incidents', k, a);
      else
        perform public.notif_push_members(p, 'MEMBER', 'INCIDENT_CREATED', 'CHANTIER', false,
          'Incident signalé (gravité ' || case v_text when 'FAIBLE' then 'faible' when 'MOYENNE' then 'moyenne' when 'ELEVEE' then 'élevée' else 'inconnue' end || ')',
          base || '/incidents', k, a);
      end if;
    when 'INCIDENT_ASSIGN' then
      v_uuid := nullif(new.context->>'assignee_profile_id', '')::uuid;
      perform public.notif_push(v_uuid, p, 'INCIDENT_ASSIGNED', 'CHANTIER', false, 'MEMBER', 'Un incident vous est affecté', base || '/incidents', k, a);
    when 'INCIDENT_TRANSITION' then
      if new.context->>'to' in ('RESOLU', 'CLOS') then
        select i.reporter_profile_id, i.assignee_profile_id into v_uuid, v_uuid2 from public.incidents i where i.id = new.target_id;
        v_text := case new.context->>'to' when 'RESOLU' then 'Incident résolu' else 'Incident clos' end;
        perform public.notif_push(v_uuid, p, 'INCIDENT_' || (new.context->>'to'), 'CHANTIER', false, 'MEMBER', v_text, base || '/incidents', k, a);
        perform public.notif_push(v_uuid2, p, 'INCIDENT_' || (new.context->>'to'), 'CHANTIER', false, 'MEMBER', v_text, base || '/incidents', k, a);
      end if;
    when 'COMMENT_ADDED' then
      v_text := new.context->>'target_type';
      perform public.notif_push_members(p, 'MEMBER', 'COMMENT_ADDED', 'CHANTIER', false,
        case when v_text = 'INCIDENT' then 'Nouveau commentaire sur un incident' else 'Nouveau commentaire sur un journal' end,
        base || case when v_text = 'INCIDENT' then '/incidents' else '/journal' end, k, a);
    when 'DOCUMENT_PUBLISH' then
      select d.visibility into v_text from public.documents d where d.id = new.target_id;
      perform public.notif_push_members(p, case v_text when 'TOUS' then 'MEMBER' when 'PRINCIPAUX' then 'PRINCIPAUX' else 'ENTREPRISE' end,
        'DOCUMENT_PUBLISHED', 'CHANTIER', false, 'Nouveau document', base || '/documents', k, a);
    when 'MEDIA_PUBLISHED' then
      perform public.notif_push_photos(p, a);
    when 'PHASE_DECLARED_COMPLETE' then
      perform public.notif_push_members(p, 'OWNER_PRIMARY', 'PHASE_TO_VALIDATE', 'OBLIGATOIRE', true, 'Étape à valider', base || '/avancement', k, a);
    when 'PHASE_VALIDATED' then
      perform public.notif_push_members(p, 'INTERNAL', 'PHASE_VALIDATED', 'CHANTIER', false, 'Étape validée', base || '/avancement', k, a);
    when 'PHASE_REFUSED' then
      perform public.notif_push_members(p, 'INTERNAL', 'PHASE_REFUSED', 'CHANTIER', false, 'Étape refusée', base || '/avancement', k, a);
    when 'QUOTE_PROPOSED' then
      perform public.notif_push_members(p, 'OWNER_PRIMARY', 'QUOTE_TO_DECIDE', 'OBLIGATOIRE', true, 'Devis à examiner', base || '/devis', k, a);
    when 'QUOTE_ACCEPTED' then
      perform public.notif_push_members(p, 'CONTRACTOR', 'QUOTE_ACCEPTED', 'FINANCES', false, 'Devis accepté', base || '/devis', k, a);
    when 'QUOTE_REFUSED' then
      perform public.notif_push_members(p, 'CONTRACTOR', 'QUOTE_REFUSED', 'FINANCES', false, 'Devis refusé', base || '/devis', k, a);
    when 'CHANGE_ORDER_PROPOSED' then
      perform public.notif_push_members(p, 'OWNER_PRIMARY', 'CHANGE_ORDER_TO_DECIDE', 'OBLIGATOIRE', true, 'Avenant à examiner', base || '/avenants', k, a);
    when 'CHANGE_ORDER_ACCEPTED' then
      perform public.notif_push_members(p, 'CONTRACTOR', 'CHANGE_ORDER_ACCEPTED', 'FINANCES', false, 'Avenant accepté', base || '/avenants', k, a);
    when 'CHANGE_ORDER_REFUSED' then
      perform public.notif_push_members(p, 'CONTRACTOR', 'CHANGE_ORDER_REFUSED', 'FINANCES', false, 'Avenant refusé', base || '/avenants', k, a);
    when 'ADVANCE_DECLARED' then
      select ad.declared_role into v_role from public.advances ad where ad.id = new.target_id;
      perform public.notif_push_members(p, case when v_role = 'CONTRACTOR' then 'OWNER_PRIMARY' else 'CONTRACTOR' end,
        'ADVANCE_TO_CONFIRM', 'OBLIGATOIRE', true, 'Versement déclaré à confirmer', base || '/acomptes', k, a);
    when 'ADVANCE_CONFIRMED', 'ADVANCE_DISPUTED' then
      select ad.declared_by_profile_id into v_uuid from public.advances ad where ad.id = new.target_id;
      perform public.notif_push(v_uuid, p, new.action, 'FINANCES', false, 'PRINCIPAL',
        case when new.action = 'ADVANCE_CONFIRMED' then 'Versement confirmé' else 'Versement contesté' end, base || '/acomptes', k, a);
    when 'EXPENSE_SUBMITTED' then
      perform public.notif_push_members(p, 'CONTRACTOR', 'EXPENSE_TO_DECIDE', 'OBLIGATOIRE', true, 'Dépense à examiner', base || '/depenses', k, a);
    when 'EXPENSE_APPROUVEE', 'EXPENSE_REFUSEE', 'EXPENSE_CONTESTEE' then
      select e.created_by_profile_id into v_uuid from public.expenses e where e.id = nullif(new.context->>'expense_id', '')::uuid;
      perform public.notif_push(v_uuid, p, new.action, 'FINANCES', false, 'INTERNAL',
        case new.action when 'EXPENSE_APPROUVEE' then 'Dépense approuvée' when 'EXPENSE_REFUSEE' then 'Dépense refusée' else 'Dépense contestée' end,
        base || '/depenses', k, a);
    when 'LICENSE_PAYMENT_DECLARED' then
      for v_uuid in select pa.profile_id from public.platform_admins pa loop
        perform public.notif_push(v_uuid, null, 'LICENSE_PAYMENT_TO_REVIEW', 'ADMIN', true, 'ACCOUNT', 'Déclaration de licence à vérifier', '/admin/licences', k, a);
      end loop;
    when 'PARTICIPANT_REMOVED' then
      select m.profile_id into v_uuid from public.project_memberships m where m.id = new.target_id;
      perform public.notif_push(v_uuid, null, 'ACCESS_REMOVED', 'COMPTE', false, 'ACCOUNT', 'Votre accès à un chantier a été retiré', '/tableau-de-bord', k, a);
    when 'ROLE_TRANSFER_REQUESTED' then
      select m.profile_id into v_uuid from public.role_transfers t join public.project_memberships m on m.id = t.successor_membership_id where t.id = new.target_id;
      perform public.notif_push(v_uuid, p, 'ROLE_TRANSFER_TO_CONFIRM', 'OBLIGATOIRE', true, 'MEMBER', 'Transfert de rôle à confirmer', base, k, a);
    when 'ROLE_TRANSFER_CONFIRMED' then
      select m.profile_id into v_uuid from public.role_transfers t join public.project_memberships m on m.id = t.initiator_membership_id where t.id = new.target_id;
      perform public.notif_push(v_uuid, p, 'ROLE_TRANSFER_CONFIRMED', 'COMPTE', false, 'MEMBER', 'Transfert de rôle confirmé', base, k, a);
    else
      null;
  end case;
  return null;
end;
$$;

create trigger notify_after_audit after insert on public.audit_events
for each row execute function public.notif_on_audit();

-- Décisions de licence (journal de plateforme) : le déclarant seulement.
create function public.notif_on_platform_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pay public.license_payments;
begin
  if new.action not in ('LICENSE_ACTIVATED', 'LICENSE_PAYMENT_REJECTED') then
    return null;
  end if;
  select * into v_pay from public.license_payments lp where lp.id = new.target_id;
  if not found then
    return null;
  end if;
  perform public.notif_push(v_pay.declared_by_profile_id, v_pay.project_id, new.action, 'LICENCE', false, 'MEMBER',
    case when new.action = 'LICENSE_ACTIVATED' then 'Licence activée' else 'Déclaration de licence rejetée' end,
    '/chantiers/' || v_pay.project_id || '/licence', 'P:' || new.id, new.actor_profile_id);
  return null;
end;
$$;

create trigger notify_after_platform_audit after insert on public.platform_audit_events
for each row execute function public.notif_on_platform_audit();

-- Accès support : les deux parties principales (D197 S8) ; prise en charge :
-- la personne qui a demandé.
create function public.notif_on_support()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  base text := '/chantiers/' || new.project_id || '/support';
  v_uuid uuid;
begin
  if new.action = 'ACCESS_GRANTED' then
    perform public.notif_push_members(new.project_id, 'PRINCIPAL', 'SUPPORT_ACCESS_OPENED', 'SUPPORT', false, 'Accès support ouvert', base, 'S:' || new.id, new.actor_profile_id);
  elsif new.action = 'ACCESS_REVOKED' then
    perform public.notif_push_members(new.project_id, 'PRINCIPAL', 'SUPPORT_ACCESS_STOPPED', 'SUPPORT', false, 'Accès support arrêté', base, 'S:' || new.id, new.actor_profile_id);
  elsif new.action = 'REQUEST_TAKEN' then
    select r.requester_profile_id into v_uuid from public.support_requests r where r.id = new.request_id;
    perform public.notif_push(v_uuid, new.project_id, 'SUPPORT_REQUEST_TAKEN', 'SUPPORT', false, 'PRINCIPAL', 'Votre demande d''aide est prise en charge', base, 'S:' || new.id, new.actor_profile_id);
  end if;
  return null;
end;
$$;

create trigger notify_after_support_event after insert on public.support_access_events
for each row execute function public.notif_on_support();

revoke execute on function public.notif_on_audit(), public.notif_on_platform_audit(), public.notif_on_support()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Échéances calculées à l'ouverture (licence J-30, J-7, jour même ; fin
--    d'accès support), pour l'appelant seulement, sans doublon.
-- ---------------------------------------------------------------------------
create function public.notif_sync_due(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_today date := (clock_timestamp() at time zone 'UTC')::date;
  r record;
  v_left integer;
  v_step text;
begin
  for r in
    select l.project_id, l.ends_on from public.project_licenses l
    join public.project_memberships m on m.project_id = l.project_id and m.profile_id = p_uid and m.revoked_at is null
    where l.status = 'ACTIVE' and l.ends_on is not null
  loop
    v_left := r.ends_on - v_today;
    v_step := case when v_left <= 0 then 'J0' when v_left <= 7 then 'J7' when v_left <= 30 then 'J30' end;
    continue when v_step is null;
    perform public.notif_push(p_uid, r.project_id, 'LICENSE_REMINDER_' || v_step, 'OBLIGATOIRE', true, 'MEMBER',
      case v_step when 'J0' then 'La licence du chantier expire aujourd''hui'
                  when 'J7' then 'La licence du chantier expire dans 7 jours ou moins'
                  else 'La licence du chantier expire dans 30 jours ou moins' end,
      '/chantiers/' || r.project_id || '/licence', 'L:' || r.project_id || ':' || r.ends_on || ':' || v_step, null);
  end loop;
  for r in
    select g.id, g.project_id from public.support_access_grants g
    where g.revoked_at_server is null and g.expires_at_server <= clock_timestamp()
      and public.support_principal_party(g.project_id, p_uid) is not null
  loop
    perform public.notif_push(p_uid, r.project_id, 'SUPPORT_ACCESS_EXPIRED', 'SUPPORT', false, 'PRINCIPAL', 'Accès support terminé',
      '/chantiers/' || r.project_id || '/support', 'SX:' || r.id, null);
  end loop;
end;
$$;

revoke execute on function public.notif_sync_due(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Lecture par le destinataire (R020) ; droit revérifié à l'affichage.
-- ---------------------------------------------------------------------------
create function public.notif_visible(p_n public.notifications, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select p_n.recipient_profile_id = p_uid
     and (p_n.project_id is null or public.notif_audience_ok(p_n.audience, public.document_party(p_n.project_id, p_uid)));
$$;

revoke execute on function public.notif_visible(public.notifications, uuid) from public, anon, authenticated, service_role;

create function public.list_my_notifications(p_limit integer, p_offset integer)
returns table (id uuid, kind text, category text, mandatory boolean, title text, project_name text, link text, group_count integer,
               created_at_server timestamptz, updated_at_server timestamptz, read_at_server timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  perform public.notif_sync_due(v_uid);
  return query
    select n.id, n.kind, n.category, n.mandatory, n.title, pr.name, n.link, n.group_count, n.created_at_server, n.updated_at_server, n.read_at_server
    from public.notifications n
    left join public.projects pr on pr.id = n.project_id
    where n.recipient_profile_id = v_uid and public.notif_visible(n, v_uid)
    order by n.updated_at_server desc, n.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create function public.count_my_unread_notifications()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return 0;
  end if;
  perform public.notif_sync_due(v_uid);
  return (select count(*)::integer from public.notifications n
          where n.recipient_profile_id = v_uid and n.read_at_server is null and public.notif_visible(n, v_uid));
end;
$$;

create function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_n public.notifications;
begin
  select * into v_n from public.notifications n where n.id = p_notification_id for update;
  if not found or v_uid is null or not public.notif_visible(v_n, v_uid) then
    raise exception 'not_authorized';
  end if;
  if v_n.read_at_server is null then
    update public.notifications n set read_at_server = clock_timestamp() where n.id = v_n.id;
  end if;
end;
$$;

create function public.mark_all_my_notifications_read()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  update public.notifications n set read_at_server = clock_timestamp()
   where n.recipient_profile_id = v_uid and n.read_at_server is null and public.notif_visible(n, v_uid);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.get_my_notification_preferences()
returns table (category text, in_app boolean, email boolean)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  return query
    select c.cat, coalesce(np.in_app, true), coalesce(np.email, true)
    from unnest(array['CHANTIER', 'FINANCES', 'LICENCE', 'SUPPORT', 'COMPTE']) with ordinality as c(cat, pos)
    left join public.notification_preferences np on np.profile_id = v_uid and np.category = c.cat
    order by c.pos;
end;
$$;

create function public.set_my_notification_preference(p_category text, p_in_app boolean, p_email boolean)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_category is null or p_category not in ('CHANTIER', 'FINANCES', 'LICENCE', 'SUPPORT', 'COMPTE') then
    raise exception 'category_invalid';
  end if;
  if p_in_app is null or p_email is null then
    raise exception 'preference_invalid';
  end if;
  insert into public.notification_preferences (profile_id, category, in_app, email)
  values (v_uid, p_category, p_in_app, p_email)
  on conflict (profile_id, category) do update set in_app = excluded.in_app, email = excluded.email, updated_at_server = clock_timestamp();
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Bandeau d'accès support pour tous les membres actifs (D198) : réponse
--    complète pour les parties principales, réduite à l'heure de fin pour
--    les autres (ni module, ni dossier, ni partie).
-- ---------------------------------------------------------------------------
create or replace function public.support_active_access(p_project_id uuid)
returns table (grant_id uuid, modules text[], expires_at_server timestamptz, granted_by_party text)
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_party text;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_party := public.document_party(p_project_id, auth.uid());
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  if v_party in ('CONTRACTOR', 'OWNER_PRIMARY') then
    return query
      select g.id, g.modules, g.expires_at_server, g.granted_by_party
      from public.support_access_grants g
      where g.project_id = p_project_id and g.revoked_at_server is null and g.expires_at_server > clock_timestamp()
      order by g.expires_at_server;
  else
    return query
      select null::uuid, null::text[], max(g.expires_at_server), null::text
      from public.support_access_grants g
      where g.project_id = p_project_id and g.revoked_at_server is null and g.expires_at_server > clock_timestamp()
      having count(*) > 0;
  end if;
end;
$$;

revoke execute on function public.list_my_notifications(integer, integer), public.count_my_unread_notifications(),
  public.mark_notification_read(uuid), public.mark_all_my_notifications_read(), public.get_my_notification_preferences(),
  public.set_my_notification_preference(text, boolean, boolean), public.support_active_access(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_my_notifications(integer, integer), public.count_my_unread_notifications(),
  public.mark_notification_read(uuid), public.mark_all_my_notifications_read(), public.get_my_notification_preferences(),
  public.set_my_notification_preference(text, boolean, boolean), public.support_active_access(uuid)
  to authenticated;

commit;
