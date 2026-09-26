-- M028 — B068 : synthèse financière consolidée (D140-D142, BR094, BR102,
-- BR112). Schéma seulement : un type et une fonction, AUCUNE table, aucune
-- fonction existante modifiée.
--
-- Droits : advance_require_reader (M014) — adhésion active, rôle CONTRACTOR,
-- OWNER/PRIMARY ou CO_OWNER, compte vérifié, revérifiés à chaque appel.
-- Cohérence : tous les agrégats sont lus dans UNE instruction SQL d'une
-- fonction STABLE, donc dans un même instantané de base.
-- Confidentialité : aucune lecture de budget, de dépense ni de contact.

create type public.financial_summary_view as (
  -- Montant contractuel courant (BR094) ; NULL sans devis accepté.
  quote_amount_fcfa text,
  change_orders_amount_fcfa text,
  accepted_change_order_count integer,
  contract_amount_fcfa text,
  -- Versements : une seule catégorie par état (BR112).
  recognized_count integer,
  recognized_fcfa text,
  pending_count integer,
  pending_fcfa text,
  disputed_count integer,
  disputed_fcfa text,
  cancelled_count integer,
  -- Solde signé (D142) ; NULL sans devis accepté, jamais 0 de substitution.
  balance_fcfa text,
  remaining_due_fcfa text,
  overpaid_fcfa text,
  -- Démarrage (B067) : valeurs HISTORIQUES figées à l'autorisation.
  work_start_authorized boolean,
  work_start_at timestamptz,
  start_contract_amount_fcfa text,
  start_advance_required_fcfa text,
  start_advance_recognized_fcfa text,
  -- Déficit COURANT (recalculé à chaque lecture) de la somme reconnue par
  -- rapport à l'avance figée ; NULL = non applicable (aucune autorisation).
  current_advance_shortfall_fcfa text
);

create function public.get_project_financial_summary(p_project_id uuid)
returns public.financial_summary_view
language plpgsql
security definer
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := public.advance_require_reader(p_project_id);
  v_view public.financial_summary_view;
begin
  with q as (
    select v.total_amount_fcfa::numeric as amount
    from public.quotes qu
    join public.quote_versions v on v.id = qu.accepted_version_id and v.status = 'ACCEPTED'
    where qu.project_id = p_project_id
  ),
  co as (
    select coalesce(sum(cv.total_amount_fcfa), 0)::numeric as amount, count(*)::integer as n
    from public.change_orders o
    join public.change_order_versions cv on cv.id = o.accepted_version_id and cv.status = 'ACCEPTED'
    where o.project_id = p_project_id
  ),
  pay as (
    select
      count(*) filter (where a.status = 'RECEIVED')::integer as rc,
      coalesce(sum(a.amount_fcfa) filter (where a.status = 'RECEIVED'), 0)::numeric as rs,
      count(*) filter (where a.status = 'DECLARED')::integer as pc,
      coalesce(sum(a.amount_fcfa) filter (where a.status = 'DECLARED'), 0)::numeric as ps,
      count(*) filter (where a.status = 'DISPUTED')::integer as dc,
      coalesce(sum(a.amount_fcfa) filter (where a.status = 'DISPUTED'), 0)::numeric as ds,
      count(*) filter (where a.status = 'CANCELLED')::integer as cc
    from public.advances a
    where a.project_id = p_project_id
  ),
  base as (
    select q.amount as quote_amount,
           case when q.amount is not null then co.amount end as co_amount,
           case when q.amount is not null then co.n end as co_count,
           q.amount + co.amount as contract,
           pay.*,
           w.id as ws_id, w.authorized_at_server, w.contract_amount_fcfa as ws_contract,
           w.advance_required_fcfa as ws_required, w.advance_recognized_fcfa as ws_recognized
    from pay
    cross join co
    left join q on true
    left join public.work_start_authorizations w on w.project_id = p_project_id
  )
  select
    b.quote_amount::text, b.co_amount::text, b.co_count, b.contract::text,
    b.rc, b.rs::text, b.pc, b.ps::text, b.dc, b.ds::text, b.cc,
    (b.contract - b.rs)::text,
    case when b.contract is not null then greatest(b.contract - b.rs, 0)::text end,
    case when b.contract is not null then greatest(b.rs - b.contract, 0)::text end,
    b.ws_id is not null, b.authorized_at_server,
    b.ws_contract::text, b.ws_required::text, b.ws_recognized::text,
    case when b.ws_id is not null then greatest(b.ws_required - b.rs, 0)::text end
  into v_view
  from base b;
  return v_view;
end;
$$;

revoke execute on function public.get_project_financial_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_project_financial_summary(uuid) to authenticated;
