-- M053 — B046 : rapport PDF simple (done_when : « instantané identifié et
-- autorisé »). Décisions du fondateur 2026-10-08 : D200 (R1 à R10 de
-- PROPOSITION_B046_RAPPORT.md dans le cadre de la boucle 37b), D034
-- (validée pour les rapports), BR079, BR080, D183, D186.
--
-- Le PDF est régénéré à chaque demande et JAMAIS conservé : seule une trace
-- de génération est gardée (identifiant, chantier, partie, période, empreinte
-- des données, empreinte et taille du fichier, date). Cette trace n'est
-- lisible que par son auteur (R7) : elle n'est jamais écrite dans l'audit du
-- chantier, ni visible de l'entreprise ou d'une autre partie (D186).
-- Le contenu du rapport est lu par les fonctions existantes des écrans, avec
-- la session de la personne : il ne contient que ce que son rôle voit.

begin;

create table public.report_generations (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete restrict,
  generated_by_profile_id uuid not null references public.profiles (id) on delete restrict,
  party text not null check (party in ('CONTRACTOR', 'OWNER_PRIMARY', 'CO_OWNER', 'SITE_MANAGER')),
  period_from date not null,
  period_to date not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size_bytes integer not null check (file_size_bytes > 0),
  generated_at_server timestamptz not null,
  recorded_at_server timestamptz not null default clock_timestamp(),
  constraint report_period_order check (period_from <= period_to),
  constraint report_period_max check (period_from >= (period_to - interval '12 months')::date)
);

create index report_generations_author_idx on public.report_generations (generated_by_profile_id, project_id, recorded_at_server desc);

alter table public.report_generations enable row level security;
revoke all privileges on table public.report_generations from public, anon, authenticated;

create function public.report_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'report_record_immutable';
end;
$$;

create trigger reject_mutation before update or delete on public.report_generations
for each row execute function public.report_reject_mutation();

-- Contrôle de la demande : membre actif, période valide (au plus 12 mois,
-- jamais dans le futur). Ne trace rien : la trace n'est écrite qu'une fois le
-- PDF produit (report_record_generation).
create function public.report_check_period(p_from date, p_to date)
returns void
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'period_invalid';
  end if;
  if p_from < (p_to - interval '12 months')::date then
    raise exception 'period_too_long';
  end if;
end;
$$;

revoke execute on function public.report_check_period(date, date) from public, anon, authenticated, service_role;

create function public.report_prepare(p_project_id uuid, p_from date, p_to date)
returns table (report_id uuid, party text, project_name text, project_ref text, generated_at_server timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_party text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_party := public.document_party(p_project_id, v_uid);
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  perform public.report_check_period(p_from, p_to);
  if p_to > (clock_timestamp() at time zone 'UTC')::date then
    raise exception 'period_in_future';
  end if;
  return query
    select gen_random_uuid(), v_party, p.name, upper(left(p.id::text, 8)), clock_timestamp()
    from public.projects p where p.id = p_project_id;
end;
$$;

create function public.report_record_generation(p_report_id uuid, p_project_id uuid, p_from date, p_to date, p_generated_at timestamptz,
                                                p_content_sha256 text, p_file_sha256 text, p_file_size_bytes integer)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_party text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  v_party := public.document_party(p_project_id, v_uid);
  if v_party is null then
    raise exception 'not_authorized';
  end if;
  perform public.report_check_period(p_from, p_to);
  if p_generated_at is null or p_generated_at > clock_timestamp() or p_generated_at < clock_timestamp() - interval '10 minutes' then
    raise exception 'generation_time_invalid';
  end if;
  insert into public.report_generations (id, project_id, generated_by_profile_id, party, period_from, period_to, content_sha256, file_sha256,
                                         file_size_bytes, generated_at_server)
  values (p_report_id, p_project_id, v_uid, v_party, p_from, p_to, lower(p_content_sha256), lower(p_file_sha256), p_file_size_bytes, p_generated_at);
end;
$$;

-- Traces de l'appelant seulement (R7).
create function public.list_my_report_generations(p_project_id uuid)
returns table (report_id uuid, party text, period_from date, period_to date, content_sha256 text, file_sha256 text, file_size_bytes integer,
               generated_at_server timestamptz)
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
  if public.document_party(p_project_id, v_uid) is null then
    raise exception 'not_authorized';
  end if;
  return query
    select r.id, r.party, r.period_from, r.period_to, r.content_sha256, r.file_sha256, r.file_size_bytes, r.generated_at_server
    from public.report_generations r
    where r.project_id = p_project_id and r.generated_by_profile_id = v_uid
    order by r.recorded_at_server desc
    limit 50;
end;
$$;

revoke execute on function public.report_prepare(uuid, date, date),
  public.report_record_generation(uuid, uuid, date, date, timestamptz, text, text, integer),
  public.list_my_report_generations(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.report_prepare(uuid, date, date),
  public.report_record_generation(uuid, uuid, date, date, timestamptz, text, text, integer),
  public.list_my_report_generations(uuid)
  to authenticated;

commit;
