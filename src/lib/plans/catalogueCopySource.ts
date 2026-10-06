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
// - la demande est créée par create_plan_request_from_catalog_item (M035),
//   qui refait en base l'ensemble de ces contrôles et enregistre la VERSION
//   EXACTE du modèle à l'origine de la demande ; la variante 1 (la copie)
//   est enregistrée par le circuit M034 (attestation service_role +
//   save_plan_request_variant), qui revérifie les droits sur le chantier.
//
// Écritures et reprise (une même opération = un même identifiant) :
// - A. create_plan_request_from_catalog_item : UNE transaction (contrôles +
//   insertion de la demande avec son origine), idempotente par opération ;
// - B. attest_plan_request_variant_layout : UNE transaction, idempotente
//   pour le même fichier ;
// - C. save_plan_request_variant : UNE transaction (contrôles + consommation
//   de l'attestation + insertion de la variante), idempotente par opération.
// A, B et C sont des appels distincts, jamais une transaction commune :
// rejouer la même opération (même date de préparation, donc même fichier)
// reprend là où l'essai précédent s'est arrêté, sans doublon.

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

// `versionId` : version EXACTE vue par l'utilisateur. Elle doit être la
// version publiée — sauf reprise d'une opération dont la demande existe
// déjà avec cette origine (`allowUnpublished`) : une publication survenue
// entre-temps ne change ni l'origine ni la copie.
export async function loadCatalogueCopySource(
  supabase: SupabaseClient,
  organizationId: string,
  catalogItemId: string,
  options: { versionId?: string; allowUnpublished?: boolean } = {}
): Promise<{ ok: true; value: CopySource } | CopyFailure | { ok: false; flat: true; message: string; label: string }> {
  const { data: items, error } = await supabase.rpc("list_organization_catalog_items", { p_organization_id: organizationId });
  if (error) return { ok: false, message: "Ce catalogue n'est accessible qu'au propriétaire de l'organisation." };
  const item = ((items ?? []) as CatalogItemListRow[]).find((i) => i.id === catalogItemId);
  if (!item || item.archived_at) return { ok: false, message: "Modèle introuvable dans ce catalogue." };
  if (!item.published_version_id && !options.allowUnpublished) {
    return { ok: false, message: "Ce modèle n'a pas de version publiée : seule une version publiée peut être copiée vers un chantier." };
  }
  const versionId = options.versionId ?? (item.published_version_id as string);
  if (versionId !== item.published_version_id && !options.allowUnpublished) {
    return {
      ok: false,
      message: "Une autre version de ce modèle a été publiée depuis l'ouverture de cette page. Rechargez la page pour vérifier la copie avec la version publiée actuelle.",
    };
  }
  const { data: rows, error: fileErr } = await supabase.rpc("get_catalog_item_version_file", { p_version_id: versionId });
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
      versionId,
      versionNumber: versionId === item.published_version_id ? item.published_version_number : null,
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
  args: { organizationId: string; catalogItemId: string; versionId: string; projectId: string; params: unknown; savedAt?: string; allowUnpublished?: boolean }
): Promise<PreparedCopy | CopyFailure> {
  const source = await loadCatalogueCopySource(supabase, args.organizationId, args.catalogItemId, {
    versionId: args.versionId,
    allowUnpublished: args.allowUnpublished,
  });
  if (!source.ok) return { ok: false, message: source.message };
  const destination = await checkCatalogueCopyDestination(supabase, profileId, args.organizationId, args.projectId);
  if (!destination.ok) return destination;
  const params = parseDestinationParams(args.params);
  if (!params.ok) return { ok: false, message: params.error };
  const { report, copy } = prepareCatalogueCopy(source.value.file, params.value, { modelLabel: source.value.label, savedAt: args.savedAt });
  return { ok: true, source: source.value, destination: destination.value, params: params.value, report, copy };
}

// Crée la demande (paramètres du CHANTIER, origine = version exacte) puis
// la variante 1 = la copie. Voir en tête de fichier pour les écritures A/B/C
// et la reprise par opération.
export async function createCatalogueCopy(
  supabase: SupabaseClient,
  service: SupabaseClient,
  profileId: string,
  args: { organizationId: string; catalogItemId: string; versionId: string; projectId: string; params: unknown; savedAt: string; operationUuid: string }
): Promise<{ ok: true; requestId: string; variantId: string; report: CatalogueCopyReport } | (CopyFailure & { report?: CatalogueCopyReport; code?: string })> {
  // Reprise : demande déjà créée par CETTE opération, pour CE profil et
  // CETTE version (lecture serveur ; la base revérifie tout en A).
  const { data: prior } = await service
    .from("project_plan_requests")
    .select("id, created_by_profile_id, source_catalog_item_version_id")
    .eq("catalog_copy_operation_uuid", args.operationUuid)
    .maybeSingle();
  const resuming = !!prior && prior.created_by_profile_id === profileId && prior.source_catalog_item_version_id === args.versionId;

  const prepared = await prepareCatalogueCopyFor(supabase, profileId, { ...args, allowUnpublished: resuming });
  if (!prepared.ok) return prepared;
  if (!prepared.copy) {
    return { ok: false, message: "La copie n'est pas créée : des incompatibilités doivent d'abord être levées.", report: prepared.report };
  }

  // A — demande avec origine (idempotente par opération).
  const { data: request, error } = await supabase.rpc("create_plan_request_from_catalog_item", {
    p_project_id: args.projectId,
    p_catalog_item_version_id: args.versionId,
    p_generation_params: prepared.params,
    p_operation_uuid: args.operationUuid,
  });
  if (error || !request) return { ok: false, message: "La demande de plan n'a pas pu être créée.", code: error?.message };

  // B + C — variante 1 = la copie (M034).
  const saved = await attestAndSaveVariant(supabase, service, {
    profileId,
    requestId: request.id as string,
    parentVariantId: null,
    operationUuid: args.operationUuid,
    file: prepared.copy,
  });
  if (!saved.ok) return { ok: false, message: "La copie n'a pas pu être enregistrée.", code: saved.code };
  return { ok: true, requestId: request.id as string, variantId: saved.value.id, report: prepared.report };
}

// Terminer une copie INTERROMPUE après l'étape A (demande créée avec son
// origine, aucune variante) — par exemple page fermée avant l'enregistrement.
// L'identifiant d'opération, perdu côté navigateur, est relu côté serveur
// sur la demande elle-même (jamais transmis au navigateur). Même demande,
// même version source, mêmes paramètres du chantier (ceux ENREGISTRÉS sur
// la demande, jamais reconstruits depuis la version publiée actuelle) :
// - A est rejouée avec la même opération (M035 : droits sur le chantier et
//   sur la source revérifiés, auteur identique exigé, aucune écriture) ;
// - B/C enregistrent la variante 1 (M034) ; un fichier déjà attesté pour
//   cette opération est réutilisé tel quel, sinon la copie est préparée à
//   nouveau depuis la version source exacte.
// Rejouer ou cliquer deux fois renvoie la même variante, sans doublon.
export async function resumeCatalogueCopy(
  supabase: SupabaseClient,
  service: SupabaseClient,
  profileId: string,
  requestId: string
): Promise<{ ok: true; projectId: string; requestId: string; variantId: string } | (CopyFailure & { code?: string })> {
  const refused: CopyFailure = { ok: false, message: "Demande introuvable ou non autorisée." };
  const { data: request } = await service
    .from("project_plan_requests")
    .select("id, project_id, created_by_profile_id, status, generation_params, source_catalog_item_version_id, catalog_copy_operation_uuid")
    .eq("id", requestId)
    .maybeSingle();
  if (!request) return refused;
  // Lecteur habilité de la demande (mêmes règles que la page Plans).
  const { data: readable, error: readErr } = await supabase.rpc("list_plan_requests", { p_project_id: request.project_id });
  const listed = !readErr && Array.isArray(readable) ? readable.find((r) => r.id === requestId) : undefined;
  if (!listed) return refused;
  if (!request.source_catalog_item_version_id || !request.catalog_copy_operation_uuid) {
    return { ok: false, message: "Cette demande ne provient pas d'une copie de modèle : il n'y a pas de copie à terminer." };
  }
  if (request.created_by_profile_id !== profileId) {
    return { ok: false, message: "Seule la personne qui a lancé cette copie peut la terminer." };
  }
  const operationUuid = request.catalog_copy_operation_uuid as string;
  const versionId = request.source_catalog_item_version_id as string;

  // Copie déjà enregistrée (réponse perdue, double clic) : même variante.
  const { data: done } = await service
    .from("project_plan_request_variants")
    .select("id")
    .eq("request_id", requestId)
    .eq("operation_uuid", operationUuid)
    .maybeSingle();
  if (done) return { ok: true, projectId: request.project_id, requestId, variantId: done.id };
  if (Number(listed.variant_count) > 0) {
    return { ok: false, message: "Cette demande contient déjà d'autres variantes : la copie d'origine ne peut plus y être ajoutée comme première variante." };
  }
  if (request.status !== "OPEN") return { ok: false, message: "Cette demande n'est plus ouverte : la copie ne peut plus être terminée." };

  // Fichier à enregistrer : celui déjà attesté pour cette opération, sinon
  // une copie préparée depuis la version source EXACTE.
  const attested = async () => {
    const { data } = await service
      .from("project_plan_request_variant_attestations")
      .select("request_id, profile_id, layout")
      .eq("operation_uuid", operationUuid)
      .maybeSingle();
    return data && data.request_id === requestId && data.profile_id === profileId ? (data.layout as unknown) : null;
  };
  let file: unknown = await attested();
  if (!file) {
    const { data: version } = await service
      .from("plan_catalog_item_versions")
      .select("organization_id, catalog_item_id")
      .eq("id", versionId)
      .maybeSingle();
    if (!version) return refused;
    // Lecture de la source avec la SESSION : propriétaire de l'organisation.
    const source = await loadCatalogueCopySource(supabase, version.organization_id, version.catalog_item_id, { versionId, allowUnpublished: true });
    if (!source.ok) return { ok: false, message: source.message };
    const params = parseDestinationParams(request.generation_params);
    if (!params.ok) return { ok: false, message: `Paramètres enregistrés sur la demande illisibles : ${params.error}` };
    const { report, copy } = prepareCatalogueCopy(source.value.file, params.value, { modelLabel: source.value.label, savedAt: new Date().toISOString() });
    if (!copy) return { ok: false, message: `La copie ne peut pas être terminée : ${report.blocking.join(" ")}` };
    file = copy;
  }

  // A — rejouée avec la même opération : aucune écriture, droits revérifiés.
  const { data: replay, error: replayErr } = await supabase.rpc("create_plan_request_from_catalog_item", {
    p_project_id: request.project_id,
    p_catalog_item_version_id: versionId,
    p_generation_params: request.generation_params,
    p_operation_uuid: operationUuid,
  });
  if (replayErr || !replay) return { ok: false, message: "La copie ne peut pas être terminée.", code: replayErr?.message };
  if (replay.id !== requestId) return refused;

  // B + C — variante 1 (M034). Une préparation concurrente a pu attester un
  // autre fichier (date différente) : on termine alors avec celui-là.
  let saved = await attestAndSaveVariant(supabase, service, { profileId, requestId, parentVariantId: null, operationUuid, file });
  if (!saved.ok && saved.code === "attestation_conflict") {
    const concurrent = await attested();
    if (concurrent) saved = await attestAndSaveVariant(supabase, service, { profileId, requestId, parentVariantId: null, operationUuid, file: concurrent });
  }
  if (!saved.ok) return { ok: false, message: "La copie n'a pas pu être enregistrée.", code: saved.code };
  return { ok: true, projectId: request.project_id, requestId, variantId: saved.value.id };
}
