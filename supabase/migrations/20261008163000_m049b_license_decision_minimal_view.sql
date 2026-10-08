-- M049b — correction de M049 (boucle 32b) : activate_license_payment et
-- reject_license_payment renvoyaient la ligne complète de la déclaration,
-- dont l'identifiant du membre déclarant (declared_by_profile_id) : une
-- identité de membre transmise à l'administrateur, contraire à D194 A9.
-- Elles renvoient désormais une vue minimale (identifiant de la déclaration,
-- statut, identifiant court du chantier, état et dates de la licence,
-- décision). Corps, contrôles, audit et droits inchangés.

begin;

drop function public.activate_license_payment(uuid, text);
drop function public.reject_license_payment(uuid, text);

create function public.activate_license_payment(p_payment_id uuid, p_verification_note text)
returns table (payment_id uuid, status text, project_ref text, license_status text, starts_on date, ends_on date, decided_at_server timestamptz, decision_note text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_row public.license_payments;
  v_license public.project_licenses;
  v_note text := nullif(btrim(coalesce(p_verification_note, '')), '');
  v_today date := (now() at time zone 'utc')::date;
begin
  select * into v_row from public.license_payments where id = p_payment_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'PENDING_REVIEW' then
    raise exception 'invalid_transition';
  end if;
  if v_note is not null and char_length(v_note) < 3 then
    raise exception 'note_invalid';
  end if;
  select * into v_license from public.project_licenses where project_id = v_row.project_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- A7 : jamais sur une licence déjà active ; renouvellement hors B049.
  if v_license.status in ('ACTIVE', 'EXPIRING') then
    raise exception 'license_already_active';
  end if;
  if v_license.status <> 'PENDING' then
    raise exception 'renewal_not_supported';
  end if;
  update public.license_payments
  set status = 'ACTIVATED', decided_at_server = clock_timestamp(), decided_by_profile_id = v_admin, decision_note = v_note
  where id = v_row.id
  returning * into v_row;
  -- A4 : du jour pour 12 mois ; A8 : le chantier n'est pas touché.
  update public.project_licenses
  set status = 'ACTIVE', starts_on = v_today, ends_on = (v_today + make_interval(months => v_row.offer_duration_months))::date, revision = revision + 1
  where project_id = v_row.project_id;
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, project_id, target_table, target_id, reason, context)
  values (v_admin, 'ADMIN', 'LICENSE_ACTIVATED', v_row.project_id, 'license_payments', v_row.id, v_note,
          jsonb_build_object('starts_on', v_today, 'duration_months', v_row.offer_duration_months, 'amount_fcfa', v_row.amount_fcfa,
                             'operator', v_row.operator, 'payment_reference', v_row.payment_reference));
  return query
    select v_row.id, v_row.status, upper(left(v_row.project_id::text, 8)), l.status, l.starts_on, l.ends_on, v_row.decided_at_server, v_row.decision_note
    from public.project_licenses l where l.project_id = v_row.project_id;
end;
$$;

create function public.reject_license_payment(p_payment_id uuid, p_reason text)
returns table (payment_id uuid, status text, project_ref text, license_status text, starts_on date, ends_on date, decided_at_server timestamptz, decision_note text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_admin uuid := public.require_platform_admin();
  v_row public.license_payments;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_row from public.license_payments where id = p_payment_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'PENDING_REVIEW' then
    raise exception 'invalid_transition';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required';
  end if;
  update public.license_payments
  set status = 'REJECTED', decided_at_server = clock_timestamp(), decided_by_profile_id = v_admin, decision_note = v_reason
  where id = v_row.id
  returning * into v_row;
  insert into public.platform_audit_events (actor_profile_id, actor_kind, action, project_id, target_table, target_id, reason)
  values (v_admin, 'ADMIN', 'LICENSE_PAYMENT_REJECTED', v_row.project_id, 'license_payments', v_row.id, v_reason);
  return query
    select v_row.id, v_row.status, upper(left(v_row.project_id::text, 8)), l.status, l.starts_on, l.ends_on, v_row.decided_at_server, v_row.decision_note
    from public.project_licenses l where l.project_id = v_row.project_id;
end;
$$;

revoke execute on function public.activate_license_payment(uuid, text), public.reject_license_payment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.activate_license_payment(uuid, text), public.reject_license_payment(uuid, text)
  to authenticated;

commit;
