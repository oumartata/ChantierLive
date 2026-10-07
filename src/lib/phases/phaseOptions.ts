import type { createClient } from "@/lib/supabase/server";

// D182 (M042) : étapes proposées pour lier un journal ou un incident —
// étapes actives d'un plan PUBLIÉ du chantier, lues avec la session de
// l'utilisateur (list_project_phase_details, PHASE_VIEW). Le serveur
// revérifie toujours le lien (phase_link_check) ; cette liste ne sert qu'à
// l'affichage.
export interface PhaseOption {
  value: string;
  label: string;
}

export async function getPhaseOptions(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string): Promise<{ options: PhaseOption[]; labels: Map<string, string> }> {
  const [plan, details] = await Promise.all([
    supabase.rpc("get_project_phase_plan", { p_project_id: projectId }),
    supabase.rpc("list_project_phase_details", { p_project_id: projectId }),
  ]);
  const planRow = Array.isArray(plan.data) ? plan.data[0] : plan.data;
  const rows = (details.data ?? []) as { phase_id: string; position: number; label: string }[];
  const labels = new Map(rows.map((r) => [r.phase_id, r.label]));
  const options = planRow?.status === "PUBLIE" ? rows.map((r) => ({ value: r.phase_id, label: `${r.position}. ${r.label}` })) : [];
  return { options, labels };
}

// Libellé affiché d'un lien : étape active, ou mention d'une étape retirée.
export function phaseLinkLabel(phaseId: string | null | undefined, labels: Map<string, string>, serverLabel?: string | null, archived?: boolean | null): string | null {
  if (!phaseId) return null;
  const label = serverLabel ?? labels.get(phaseId) ?? null;
  if (!label) return "étape retirée";
  return archived ? `${label} (étape retirée)` : label;
}
