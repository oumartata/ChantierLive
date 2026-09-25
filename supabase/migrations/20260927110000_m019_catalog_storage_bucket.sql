-- Bucket privé dédié au catalogue de plans (B061). Même principe
-- que project-media (M010) : public=false, RLS Storage par défaut (aucune
-- policy = refus par défaut), seul service_role (BYPASSRLS) y écrit/lit,
-- toujours après que les fonctions RPC ci-dessus ont statué sur les droits.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'organization-catalog',
  'organization-catalog',
  false,
  20971520,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

commit;
