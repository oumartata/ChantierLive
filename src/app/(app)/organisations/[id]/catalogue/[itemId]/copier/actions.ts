"use server";

import { revalidatePath } from "next/cache";
import { createClient, requireVerifiedAccount } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { CatalogueCopyReport, DestinationParams } from "@/app/prototype-plans/catalogueCopy";
import { checkCatalogueCopyDestination, createCatalogueCopy, latestDestinationParams, prepareCatalogueCopyFor } from "@/lib/plans/catalogueCopySource";

// Catalogue modifiable — copie d'un modèle vers un chantier (premier sous-lot,
// sans migration). Toutes les vérifications d'accès sont faites ici, côté
// serveur, avec la session réelle (catalogueCopySource.ts) ; rien n'est
// déduit d'une valeur envoyée par le navigateur.

type ActionResult<T> = { ok: true; value: T } | { ok: false; message: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function readParams(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapCopyError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "not_authorized":
      return "Vous n'êtes pas autorisé à préparer un plan sur ce chantier.";
    case "account_provisional":
      return "Vérifiez votre identifiant (e-mail ou téléphone) avant de continuer.";
    case "request_not_open":
      return "La demande de plan n'est plus ouverte. Relancez la copie.";
    case "attestation_conflict":
      return "Un enregistrement différent est déjà en cours pour cette opération. Rechargez la page puis réessayez.";
    case "layout_too_large":
      return "Le plan est trop volumineux pour être enregistré.";
    default:
      return fallback;
  }
}

export async function prefillCatalogueCopyAction(
  organizationId: string,
  projectId: string
): Promise<ActionResult<{ params: DestinationParams; createdAt: string } | null>> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };
  if (!isUuid(organizationId) || !isUuid(projectId)) return { ok: false, message: "Requête invalide." };
  const supabase = await createClient();
  const destination = await checkCatalogueCopyDestination(supabase, guard.user.id, organizationId, projectId);
  if (!destination.ok) return { ok: false, message: destination.message };
  return { ok: true, value: await latestDestinationParams(supabase, projectId) };
}

// Vérification SANS écriture : aucune demande, aucune variante, aucun
// brouillon touché.
export async function previewCatalogueCopyAction(formData: FormData): Promise<ActionResult<{ report: CatalogueCopyReport; canCreate: boolean }>> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };
  const organizationId = formData.get("organization_id");
  const catalogItemId = formData.get("catalog_item_id");
  const projectId = formData.get("project_id");
  if (!isUuid(organizationId) || !isUuid(catalogItemId) || !isUuid(projectId)) return { ok: false, message: "Choisissez un chantier destinataire." };
  const supabase = await createClient();
  const prepared = await prepareCatalogueCopyFor(supabase, guard.user.id, {
    organizationId,
    catalogItemId,
    projectId,
    params: readParams(formData.get("params")),
  });
  if (!prepared.ok) return { ok: false, message: prepared.message };
  return { ok: true, value: { report: prepared.report, canCreate: prepared.copy !== null } };
}

export async function createCatalogueCopyAction(
  formData: FormData
): Promise<{ ok: true; value: { requestId: string; variantId: string; projectId: string } } | { ok: false; message: string; requestId?: string; report?: CatalogueCopyReport }> {
  const guard = await requireVerifiedAccount();
  if (!guard.ok) return { ok: false, message: guard.message };
  const organizationId = formData.get("organization_id");
  const catalogItemId = formData.get("catalog_item_id");
  const projectId = formData.get("project_id");
  const operationUuid = formData.get("operation_uuid");
  const requestIdRaw = formData.get("request_id");
  const savedAt = formData.get("saved_at");
  if (!isUuid(organizationId) || !isUuid(catalogItemId) || !isUuid(projectId) || !isUuid(operationUuid)) {
    return { ok: false, message: "Requête invalide." };
  }
  const savedAtMs = typeof savedAt === "string" ? Date.parse(savedAt) : NaN;
  if (!Number.isFinite(savedAtMs) || Math.abs(Date.now() - savedAtMs) > 24 * 3600 * 1000 || new Date(savedAtMs).toISOString() !== savedAt) {
    return { ok: false, message: "Requête invalide (date de préparation)." };
  }

  const created = await createCatalogueCopy(await createClient(), createServiceClient(), guard.user.id, {
    organizationId,
    catalogItemId,
    projectId,
    params: readParams(formData.get("params")),
    savedAt,
    operationUuid,
    requestId: isUuid(requestIdRaw) ? requestIdRaw : null,
  });
  if (!created.ok) {
    return { ok: false, message: mapCopyError(created.code, created.message), requestId: created.requestId, report: created.report };
  }
  revalidatePath(`/chantiers/${projectId}/plans`);
  return { ok: true, value: { requestId: created.requestId, variantId: created.variantId, projectId } };
}
