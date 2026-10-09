// L06 — référence minimale envoyée à l'appareil (O1 ; D202). Construite côté
// serveur avec la session de la personne : ses chantiers actifs (identifiant,
// nom, partie), les brouillons qu'elle peut créer hors ligne (O2) et les
// étapes PUBLIÉES (identifiant, libellé) pour les rattacher. Rien d'autre :
// ni document, ni finance, ni contenu publié, ni identité, ni brouillon.
// Module sans alias, compilé tel quel par scripts/test-offline-local.mjs.

import type { DraftKind } from "./queue";
import type { Reference, ReferenceProject } from "./account";

type Result = { data: unknown; error: { message: string } | null };
interface Query extends PromiseLike<Result> {
  select(cols: string): Query;
  eq(col: string, v: unknown): Query;
  is(col: string, v: null): Query;
  in(col: string, v: unknown[]): Query;
}
export interface ReferenceClient {
  from(table: string): Query;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Result>;
}

type Party = ReferenceProject["party"];
// O2 : journal pour l'entreprise et le chef de chantier ; incident pour tous.
export const OFFLINE_KINDS: Record<Party, DraftKind[]> = {
  CONTRACTOR: ["JOURNAL", "INCIDENT"],
  SITE_MANAGER: ["JOURNAL", "INCIDENT"],
  OWNER_PRIMARY: ["INCIDENT"],
  CO_OWNER: ["INCIDENT"],
};

export async function buildOfflineReference(client: ReferenceClient, profileId: string): Promise<Reference> {
  const ms = await client.from("project_memberships").select("project_id, role, owner_profile").eq("profile_id", profileId).is("revoked_at", null);
  if (ms.error) throw new Error(ms.error.message);
  const rows = (ms.data ?? []) as { project_id: string; role: string; owner_profile: string | null }[];
  const ids = rows.map((r) => r.project_id);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const ps = await client.from("projects").select("id, name").in("id", ids);
    if (ps.error) throw new Error(ps.error.message);
    for (const p of (ps.data ?? []) as { id: string; name: string }[]) names.set(p.id, p.name);
  }
  const projects: ReferenceProject[] = [];
  for (const r of rows) {
    const party: Party =
      r.role === "CONTRACTOR" ? "CONTRACTOR" : r.role === "SITE_MANAGER" ? "SITE_MANAGER" : r.owner_profile === "CO_OWNER" ? "CO_OWNER" : "OWNER_PRIMARY";
    let phases: { id: string; label: string }[] = [];
    const plan = await client.rpc("get_project_phase_plan", { p_project_id: r.project_id });
    const planRow = (Array.isArray(plan.data) ? plan.data[0] : plan.data) as { status?: string } | null;
    if (!plan.error && planRow?.status === "PUBLIE") {
      const det = await client.rpc("list_project_phase_details", { p_project_id: r.project_id });
      if (!det.error) phases = ((det.data ?? []) as { phase_id: string; label: string }[]).map((p) => ({ id: p.phase_id, label: p.label }));
    }
    projects.push({ projectId: r.project_id, name: names.get(r.project_id) ?? "", party, kinds: OFFLINE_KINDS[party], phases });
  }
  return { fetchedAt: new Date().toISOString(), projects };
}
