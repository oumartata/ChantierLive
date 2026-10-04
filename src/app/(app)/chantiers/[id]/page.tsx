import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, Button, StatusChip } from "@/components/ui";
import { formatPercent } from "./avancement/phasePlanDiff";

interface FinancialSummary {
  contract_amount_fcfa: string | null;
  recognized_fcfa: string;
  remaining_due_fcfa: string | null;
}

// Montants reçus en texte (numeric côté serveur) : formatés via BigInt, jamais Number.
const fcfa = (amount: string) => `${BigInt(amount).toLocaleString("fr-FR")} FCFA`;

const STATUS_LABEL: Record<string, { label: string; variant: "neutral" | "info" | "success" | "attention" }> = {
  DRAFT: { label: "Brouillon", variant: "neutral" },
  ACTIVE: { label: "Actif", variant: "success" },
  SUSPENDED: { label: "Suspendu", variant: "attention" },
  COMPLETED: { label: "Terminé", variant: "info" },
  ARCHIVED: { label: "Archivé", variant: "neutral" },
  READ_ONLY: { label: "Lecture seule", variant: "neutral" },
};

function field(label: string, value: string | null) {
  return (
    <div>
      <p className="text-caption text-muted">{label}</p>
      <p className="text-body text-ink">{value ?? "—"}</p>
    </div>
  );
}

// Fiche chantier — écran de LECTURE par défaut à l'ouverture (constat
// fondateur : "Ouvrir" menait directement au formulaire /modifier, sans que
// l'utilisateur sache ce qui était consultable ou modifiable). "Modifier"
// reste un clic explicite, réservé aux mêmes personnes déjà autorisées par
// update_draft_project aujourd'hui (CONTRACTOR ou OWNER/PRIMARY, chantier en
// DRAFT) — aucun droit serveur changé ici, seulement son reflet dans l'UI.
export default async function ChantierFichePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ enregistre?: string; invitation?: string }>;
}) {
  const { id } = await params;
  const { enregistre, invitation } = await searchParams;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "name, country, address, latitude, longitude, planned_start_date, planned_end_date, budget::text, status"
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("project_memberships")
      .select("role, owner_profile")
      .eq("project_id", id)
      .eq("profile_id", user.id)
      .is("revoked_at", null)
      .maybeSingle(),
  ]);

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Chantier</h1>
        <AlertBanner
          variant="error"
          title="Chantier inaccessible"
          explanation="Ce chantier n'existe pas ou vous n'y avez pas accès."
        />
      </div>
    );
  }

  // Même garde EXACTE que update_draft_project (M004b) : CONTRACTOR ou
  // OWNER/PRIMARY, chantier en DRAFT — reflet, pas une nouvelle règle.
  const canEdit =
    project.status === "DRAFT" &&
    (membership?.role === "CONTRACTOR" ||
      (membership?.role === "OWNER" && membership.owner_profile === "PRIMARY"));

  const status = STATUS_LABEL[project.status] ?? { label: project.status, variant: "neutral" as const };
  const budgetLabel = project.budget ? `${Number(project.budget).toLocaleString("fr-FR")} FCFA` : null;
  const locationLabel =
    project.latitude != null && project.longitude != null ? `${project.latitude}, ${project.longitude}` : null;

  // Séparation de navigation (maquettes fondateur 2026-10-03) : pour le
  // propriétaire (OWNER, PRIMARY ou CO_OWNER) uniquement, cette fiche
  // regroupe désormais le résumé financier (déjà lu par get_project_financial_summary,
  // M028, inchangée) et les fonctions Équipe/Devis/Avenants/Invitations
  // retirées du menu persistant — mêmes gardes canInvite/canSeeFinancials
  // que chantiers/[id]/layout.tsx, jamais un droit nouveau. CONTRACTOR et
  // SITE_MANAGER voient cette fiche exactement comme avant (inchangée).
  const isOwner = membership?.role === "OWNER";
  const isOwnerPrimary = isOwner && membership?.owner_profile === "PRIMARY";
  let financialSummary: FinancialSummary | null = null;
  let phasePlan: { status: string; global_progress: string | number | null } | null = null;
  if (isOwner) {
    const [{ data: fsData }, { data: ppData }] = await Promise.all([
      supabase.rpc("get_project_financial_summary", { p_project_id: id }),
      supabase.rpc("get_project_phase_plan", { p_project_id: id }),
    ]);
    financialSummary = Array.isArray(fsData) ? fsData[0] ?? null : fsData ?? null;
    phasePlan = Array.isArray(ppData) ? ppData[0] ?? null : ppData ?? null;
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      {enregistre ? (
        <AlertBanner
          variant="information"
          title="Enregistré"
          explanation="Vos modifications ont été enregistrées."
        />
      ) : null}
      {invitation === "acceptee" ? (
        <AlertBanner
          variant="information"
          title="Invitation acceptée"
          explanation="Vous êtes désormais membre de ce chantier."
        />
      ) : null}

      <div className="flex items-center justify-between">
        <h1 className="text-h1 font-bold text-ink">Chantier</h1>
        <StatusChip variant={status.variant} label={status.label} />
      </div>

      <Card className="flex flex-col gap-4 p-6">
        {field("Nom du chantier", project.name)}
        {field("Pays", project.country)}
        {field("Adresse", project.address)}
        {field("Position (latitude, longitude)", locationLabel)}
        {field("Date de début prévue", project.planned_start_date)}
        {field("Date de fin prévue", project.planned_end_date)}
        <div>
          {field("Enveloppe indicative du projet", budgetLabel)}
          {/* D143 : ni le montant contractuel (devis accepté), ni le budget
              prévisionnel interne (B030, séparée, non démarrée) — exclue de
              tout calcul de reste dû, d'acomptes ou de synthèse. */}
          <p className="mt-1 text-caption text-muted">
            Simple ordre de grandeur indicatif, distinct du devis accepté (montant contractuel) et du futur budget prévisionnel interne de l&apos;entreprise.
          </p>
        </div>
      </Card>

      {canEdit ? (
        <Link href={`/chantiers/${id}/modifier`}>
          <Button className="w-full">Modifier</Button>
        </Link>
      ) : null}

      {isOwner ? (
        <>
          <Card className="flex flex-col gap-2" data-testid="fiche-financial-summary">
            <h2 className="text-h2 font-semibold text-ink">Résumé financier</h2>
            {financialSummary && financialSummary.contract_amount_fcfa !== null ? (
              <dl className="flex flex-col gap-1">
                <div className="flex justify-between gap-3">
                  <dt className="text-body text-muted">Prix convenu</dt>
                  <dd className="text-body text-ink">{fcfa(financialSummary.contract_amount_fcfa)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-body text-muted">Versements confirmés</dt>
                  <dd className="text-body text-ink">{fcfa(financialSummary.recognized_fcfa)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-body text-muted">Reste à payer</dt>
                  <dd className="text-body text-ink">{fcfa(financialSummary.remaining_due_fcfa as string)}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-body text-muted">Non défini : aucun devis n&apos;est encore accepté.</p>
            )}
            <Link href={`/chantiers/${id}/acomptes`} className="text-label font-semibold text-primary">
              Voir les versements
            </Link>
          </Card>

          {/* M033 — avancement réel (déclaré par l'entreprise), plus de teaser
              « indisponible » : si aucun plan n'est encore publié, l'écran
              dédié l'explique lui-même, jamais un pourcentage inventé ici. */}
          <Card className="flex flex-col gap-2" data-testid="fiche-avancement-teaser">
            <h2 className="text-h2 font-semibold text-ink">Avancement</h2>
            {phasePlan?.status === "PUBLIE" ? (
              <>
                <p className="text-display font-bold text-ink">{formatPercent(phasePlan.global_progress)}</p>
                <StatusChip variant="info" label="Déclaré par l'entreprise" className="self-start" />
              </>
            ) : (
              <StatusChip variant="neutral" label="Pas encore publié par l'entreprise" className="self-start" />
            )}
            <Link href={`/chantiers/${id}/avancement`} className="text-label font-semibold text-primary">
              Voir le détail
            </Link>
          </Card>

          <Card className="flex flex-col gap-3" data-testid="fiche-gestion">
            <h2 className="text-h2 font-semibold text-ink">Gestion du chantier</h2>
            <div className="flex flex-col gap-2">
              <Link href={`/chantiers/${id}/equipe`} className="text-label font-semibold text-primary">
                Équipe
              </Link>
              <Link href={`/chantiers/${id}/devis`} className="text-label font-semibold text-primary">
                Devis
              </Link>
              <Link href={`/chantiers/${id}/avenants`} className="text-label font-semibold text-primary">
                Avenants
              </Link>
              {isOwnerPrimary ? (
                <>
                  <Link href={`/chantiers/${id}/invitations/nouveau`} className="text-label font-semibold text-primary">
                    Inviter un membre
                  </Link>
                  <Link href={`/chantiers/${id}/invitations`} className="text-label font-semibold text-primary">
                    Invitations
                  </Link>
                </>
              ) : null}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
