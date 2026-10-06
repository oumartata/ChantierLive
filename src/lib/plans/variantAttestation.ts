import type { SupabaseClient } from "@supabase/supabase-js";

// M034 — enregistrement d'une variante de demande à partir d'un fichier DÉJÀ
// validé (validateProjectFile, par l'appelant). Frontière de confiance : le
// fichier transite par attest_plan_request_variant_layout, exécutable
// UNIQUEMENT par service_role, lié au profil de la SESSION SERVEUR (jamais
// une valeur du formulaire), à la demande et à l'opération ;
// l'enregistrement, appelé avec la session de l'utilisateur (droits
// inchangés), ne reçoit plus de plan : il consomme l'attestation. Partagé
// par savePlanRequestVariantAction et la copie d'un modèle de catalogue.
// Ne s'utilise que depuis du code serveur (le client service_role n'est
// jamais transmis au navigateur).
export async function attestAndSaveVariant(
  supabase: SupabaseClient,
  service: SupabaseClient,
  args: { profileId: string; requestId: string; parentVariantId: string | null; operationUuid: string; file: unknown }
): Promise<{ ok: true; value: { id: string; variant_number: number } } | { ok: false; code: string | undefined }> {
  const { error: attestErr } = await service.rpc("attest_plan_request_variant_layout", {
    p_operation_uuid: args.operationUuid,
    p_request_id: args.requestId,
    p_profile_id: args.profileId,
    p_layout: args.file,
  });
  if (attestErr) return { ok: false, code: attestErr.message };

  const { data, error } = await supabase.rpc("save_plan_request_variant", {
    p_request_id: args.requestId,
    p_parent_variant_id: args.parentVariantId,
    p_operation_uuid: args.operationUuid,
  });
  if (error) return { ok: false, code: error.message };
  return { ok: true, value: { id: data.id, variant_number: data.variant_number } };
}
