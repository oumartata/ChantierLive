import type { SupabaseClient } from "@supabase/supabase-js";
import { validateProjectFile, type ProjectFile } from "../../app/prototype-plans/projectFile";
import { parseDestinationParams, prepareCatalogueCopy, type CatalogueCopyReport, type DestinationParams } from "../../app/prototype-plans/catalogueCopy";
import { attestAndSaveVariant } from "./variantAttestation";

// Catalogue modifiable — copie d'un modèle vers un chantier, premier
// sous-lot SANS migration ni droit nouveau. Chaque contrôle repose sur une
// fonction ou une règle d'accès déjà en place, appelée avec la SESSION de
// l'utilisateur :
// - le modèle n'est lisible que par le propriétaire de son organisation
//   (list_organization_catalog_items, get_catalog_item_version_file — M019/
//   M032) ; seule sa version PUBLIÉE, munie d'un fichier structuré, sert de
//   source (règle du Lot B) ;
// - le chantier destinataire exige une adhésion ACTIVE de l'utilisateur
//   comme CONTRACTOR ou OWNER/PRIMARY (mêmes rôles que create_plan_request)
//   ET son rattachement à l'organisation du modèle (double condition D107,
//   identique à attach_catalog_plan_to_project) : posséder l'organisation
//   ne donne accès à aucun de ses chantiers ;
// - la demande et la variante 1 sont créées par create_plan_request et le
//   circuit M034 (attestation service_role + save_plan_request_variant),
//   qui revérifient eux-mêmes les droits sur le chantier.
// Limite connue, sans migration : la demande créée ne conserve PAS la
// version source du modèle (colonne source_catalog_item_version_id du Lot B,
// non créée).

export type CopyFailure = { ok: false; message: string };

export interface CopySource {
  organizationId: string;
  catalogItemId: string;
  label: string;
  versionId: string;
  versionNumber: number | null;
  file: ProjectFile;
}

export interface CopyDestination {
  id: string;
  name: string;
}

interface CatalogItemListRow {
  id: string;
  label: string;
  published_version_id: string | null;
  published_version_number: number | null;
  archived_at: string | null;
}

export async function loadCatalogueCopySource(
  supabase: SupabaseClient,
  organizationId: string,
  catalogItemId: string
): Promise<{ ok: true; value: CopySource } | CopyFailure | { ok: false; flat: true; message: string; label: string }> {
  const { data: items, error } = await supabase.rpc("list_organization_catalog_items", { p_organization_id: organizationId });
  if (error) return { ok: false, message: "Ce catalogue n'est accessible qu'au propriétaire de l'organisation." };
  const item = ((items ?? []) as CatalogItemListRow[]).find((i) => i.id === catalogItemId);
  if (!item || item.archived_at) return { ok: false, message: "Modèle introuvable dans ce catalogue." };
  if (!item.published_version_id) {
    return { ok: false, message: "Ce modèle n'a pas de version publiée : seule une version publiée peut être copiée vers un chantier." };
  }
  const { data: rows, error: fileErr } = await supabase.rpc("get_catalog_item_version_file", { p_version_id: item.published_version_id });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (fileErr || !row) return { ok: false, message: "Le fichier de la version publiée n'est pas disponible." };
  if (row.layout === null || row.layout === undefined) {
    return {
      ok: false,
      flat: true,
      label: item.label,
      message: "Modèle plat (PDF ou image seulement) : il ne contient pas de fichier structuré et ne peut pas être ouvert dans l'éditeur.",
    };
  }
  const validated = validateProjectFile(row.layout);
  if (!validated.ok) return { ok: false, message: `Le fichier structuré du modèle est illisible : ${validated.error}` };
  return {
    ok: true,
    value: {
      organizationId,
      catalogItemId,
      label: item.label,
      versionId: item.published_version_id,
      versionNumber: item.published_version_number,
      file: validated.value,
    },
  };
}

// Chantiers où l'utilisateur peut recevoir la copie : adhésion active
// CONTRACTOR ou OWNER/PRIMARY, chantier rattaché à l'organisation du
// modèle. Jamais « tous les chantiers de l'organisation ».
export async function listCatalogueCopyDestinations(supabase: SupabaseClient, profileId: string, organizationId: string): Promise<CopyDestination[]> {
  const { data: memberships } = await supabase
    .from("project_memberships")
    .select("project_id, role, owner_profile")
    .eq("profile_id", profileId)
    .is("revoked_at", null);
  const eligible = (memberships ?? [])
    .filter((m) => m.role === "CONTRACTOR" || (m.role === "OWNER" && m.owner_profile === "PRIMARY"))
    .map((m) => m.project_id as string);
  if (eligible.length === 0) return [];
  const { data: projects } = await supabase.from("projects").select("id, name, organization_id").in("id", eligible);
  return (projects ?? [])
    .filter((p) => p.organization_id === organizationId)
    .map((p) => ({ id: p.id as string, name: p.name as string }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

export async function checkCatalogueCopyDestination(
  supabase: SupabaseClient,
  profileId: string,
  organizationId: string,
  projectId: string
): Promise<{ ok: true; value: CopyDestination } | CopyFailure> {
  const { data: membership } = await supabase
    .from("project_memberships")
    .select("role, owner_profile")
    .eq("project_id", projectId)
    .eq("profile_id", profileId)
    .is("revoked_at", null)
    .maybeSingle();
  const { data: project } = await supabase.from("projects").select("id, name, organization_id").eq("id", projectId).maybeSingle();
  if (!membership || !project) return { ok: false, message: "Chantier introuvable ou non autorisé." };
  if (!(membership.role === "CONTRACTOR" || (membership.role === "OWNER" && membership.owner_profile === "PRIMARY"))) {
    return { ok: false, message: "Votre rôle sur ce chantier ne permet pas d'y préparer un plan (entreprise ou propriétaire principal requis)." };
  }
  if (project.organization_id !== organizationId) {
    return { ok: false, message: "Ce chantier n'est pas rattaché à l'organisation de ce modèle." };
  }
  return { ok: true, value: { id: project.id as string, name: project.name as string } };
}

// Paramètres du chantier tels qu'enregistrés par sa dernière demande de plan
// (proposés pour confirmation, jamais appliqués sans validation explicite).
export async function latestDestinationParams(
  supabase: SupabaseClient,
  projectId: string
): Promise<{ params: DestinationParams; createdAt: string } | null> {
  const { data, error } = await supabase.rpc("list_plan_requests", { p_project_id: projectId });
  if (error || !Array.isArray(data)) return null;
  const sorted = [...data].sort((a, b) => String(b.created_at_server).localeCompare(String(a.created_at_server)));
  for (const r of sorted) {
    const parsed = parseDestinationParams(r.generation_params);
    if (parsed.ok) return { params: parsed.value, createdAt: r.created_at_server };
  }
  return null;
}

export type PreparedCopy = { ok: true; source: CopySource; destination: CopyDestination; params: DestinationParams; report: CatalogueCopyReport; copy: ProjectFile | null };

export async function prepareCatalogueCopyFor(
  supabase: SupabaseClient,
  profileId: string,
  args: { organizationId: string; catalogItemId: string; projectId: string; params: unknown; savedAt?: string }
): Promise<PreparedCopy | CopyFailure> {
  const source = await loadCatalogueCopySource(supabase, args.organizationId, args.catalogItemId);
  if (!source.ok) return { ok: false, message: source.message };
  const destination = await checkCatalogueCopyDestination(supabase, profileId, args.organizationId, args.projectId);
  if (!destination.ok) return destination;
  const params = parseDestinationParams(args.params);
  if (!params.ok) return { ok: false, message: params.error };
  const { report, copy } = prepareCatalogueCopy(source.value.file, params.value, { modelLabel: source.value.label, savedAt: args.savedAt });
  return { ok: true, source: source.value, destination: destination.value, params: params.value, report, copy };
}

// Crée la demande (paramètres du CHANTIER, jamais ceux du modèle) puis la
// variante 1 = la copie. Reprise : `requestId` d'un essai précédent est
// réutilisé seulement s'il désigne une demande OUVERTE de ce chantier aux
// mêmes paramètres ; même opération et même savedAt ⇒ même fichier ⇒ aucune
// variante en double (M034).
export async function createCatalogueCopy(
  supabase: SupabaseClient,
  service: SupabaseClient,
  profileId: string,
  args: { organizationId: string; catalogItemId: string; projectId: string; params: unknown; savedAt: string; operationUuid: string; requestId: string | null }
): Promise<{ ok: true; requestId: string; variantId: string; report: CatalogueCopyReport } | (CopyFailure & { requestId?: string; report?: CatalogueCopyReport; code?: string })> {
  const prepared = await prepareCatalogueCopyFor(supabase, profileId, args);
  if (!prepared.ok) return prepared;
  if (!prepared.copy) {
    return { ok: false, message: "La copie n'est pas créée : des incompatibilités doivent d'abord être levées.", report: prepared.report };
  }

  // Réponse perdue après un premier essai : l'opération a peut-être déjà été
  // attestée pour une demande de CE profil — la reprendre plutôt que d'en
  // créer une seconde (lecture serveur, service_role, jamais exposée).
  let requestId = args.requestId;
  const { data: priorAttestation } = await service
    .from("project_plan_request_variant_attestations")
    .select("request_id, profile_id")
    .eq("operation_uuid", args.operationUuid)
    .maybeSingle();
  if (priorAttestation) {
    if (priorAttestation.profile_id !== profileId) return { ok: false, message: "Opération invalide. Rechargez la page puis réessayez." };
    requestId = priorAttestation.request_id as string;
  }
  if (requestId) {
    const { data: requests } = await supabase.rpc("list_plan_requests", { p_project_id: args.projectId });
    const existing = (Array.isArray(requests) ? requests : []).find((r) => r.id === requestId);
    const sameParams = existing && JSON.stringify(canon(existing.generation_params)) === JSON.stringify(canon(prepared.params));
    if (!existing || existing.status !== "OPEN" || !sameParams) requestId = null;
  }
  if (!requestId) {
    const { data: created, error } = await supabase.rpc("create_plan_request", { p_project_id: args.projectId, p_generation_params: prepared.params });
    if (error || !created) return { ok: false, message: "La demande de plan n'a pas pu être créée.", code: error?.message };
    requestId = created.id as string;
  }

  const saved = await attestAndSaveVariant(supabase, service, {
    profileId,
    requestId,
    parentVariantId: null,
    operationUuid: args.operationUuid,
    file: prepared.copy,
  });
  if (!saved.ok) return { ok: false, message: "La copie n'a pas pu être enregistrée.", code: saved.code, requestId };
  return { ok: true, requestId, variantId: saved.value.id, report: prepared.report };
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}
