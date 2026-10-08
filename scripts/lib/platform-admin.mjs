// Retrait d'une désignation d'administrateur de plateforme créée par un test
// (décision du fondateur, boucle 35 : chaque test qui désigne un
// administrateur retire cette désignation à la fin). Opération serveur
// LOCALE : la ligne de platform_admins est supprimée et le retrait est inscrit
// au journal de plateforme (PLATFORM_ADMIN_REVOKED), qui reste en insertion
// seule ; la désignation d'origine y demeure.

export async function revokeTestAdmin(service, profileId, reason) {
  const del = await service.from("platform_admins").delete().eq("profile_id", profileId).select("profile_id");
  if (del.error) return { ok: false, error: del.error.message };
  if ((del.data ?? []).length !== 1) return { ok: false, error: "designation_absente" };
  const audit = await service.from("platform_audit_events").insert({
    actor_kind: "SERVER_OPERATION",
    action: "PLATFORM_ADMIN_REVOKED",
    target_table: "platform_admins",
    target_id: profileId,
    reason,
  });
  if (audit.error) return { ok: false, error: audit.error.message };
  return { ok: true };
}
