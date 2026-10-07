-- M044 — fermeture de la fuite de l'audit (décision du fondateur D186,
-- 2026-10-07 ; accord d'application en local). Constat de la boucle 23b :
-- la règle de M005 « audit_events_select_owner_primary_or_contractor »
-- laissait le propriétaire principal lire directement tout l'audit du
-- chantier, y compris les traces d'éléments privés (budget interne et motif
-- de révision, documents « Entreprise seulement », brouillons de journal).
--
-- Correctif : la lecture directe est réservée à l'entreprise active ; le
-- propriétaire (principal et copropriétaire), le chef de chantier, le
-- non-membre et l'ex-membre n'ont plus aucune ligne. Aucune donnée
-- d'audit modifiée (append-only intact) ; jamais une réécriture de M005.

begin;

drop policy audit_events_select_owner_primary_or_contractor on public.audit_events;

create policy audit_events_select_contractor
on public.audit_events
for select
to authenticated
using (public.has_project_role(project_id, array['CONTRACTOR']::public.membership_role[]));

commit;
