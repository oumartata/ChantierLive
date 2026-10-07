import type { ReactNode } from "react";
import Link from "next/link";
import { Card, StatusChip } from "@/components/ui";
import { formatFcfa } from "@/lib/entreprise/chantierSummary";
import type { ContractorCard, OwnerCard, Section, SiteManagerCard } from "@/lib/dashboard/dashboard";

// B044 (D189) — cartes du tableau de bord, une par chantier et par rôle.
// Chaque indicateur ouvre l'écran détaillé correspondant (FR116) ; une
// section en erreur le dit, distinctement d'une absence de données (BR070).

const STATUS_LABEL: Record<string, { label: string; variant: "neutral" | "info" | "success" | "attention" }> = {
  DRAFT: { label: "Brouillon", variant: "neutral" },
  ACTIVE: { label: "Actif", variant: "success" },
  SUSPENDED: { label: "Suspendu", variant: "attention" },
  COMPLETED: { label: "Terminé", variant: "info" },
  ARCHIVED: { label: "Archivé", variant: "neutral" },
  READ_ONLY: { label: "Lecture seule", variant: "neutral" },
};

export const statusOf = (s: string) => STATUS_LABEL[s] ?? { label: s, variant: "neutral" as const };

export const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function Indicator({ label, href, children, testId }: { label: string; href: string; children: ReactNode; testId?: string }) {
  return (
    <Link href={href} className="flex flex-col gap-0.5 rounded-small border border-muted/30 px-3 py-2 hover:border-primary" data-testid={testId}>
      <span className="text-caption font-semibold text-muted">{label}</span>
      <span className="text-body text-ink">{children}</span>
    </Link>
  );
}

function Unavailable() {
  return <span className="text-muted">Lecture impossible pour l&apos;instant</span>;
}

function show<T>(s: Section<T>, render: (v: T) => ReactNode): ReactNode {
  return s.kind === "ok" ? render(s.value) : <Unavailable />;
}

function Header({ name, status, role, href }: { name: string; status: string; role: string; href: string }) {
  const st = statusOf(status);
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex flex-col gap-1">
        <Link href={href} className="text-label font-semibold text-ink hover:text-primary">
          {name}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip variant={st.variant} label={st.label} />
          <span className="text-caption text-muted">{role}</span>
        </div>
      </div>
    </div>
  );
}

function DeclaredIndicator({ card, base }: { card: OwnerCard | ContractorCard; base: string }) {
  return (
    <Indicator label="Avancement déclaré par l'entreprise" href={`${base}/avancement`} testId="avancement-declare">
      {show(card.declared, (v) => (v.planPublished && v.percent !== null ? `${Math.round(v.percent)} %` : "Aucun plan d'étapes publié"))}
    </Indicator>
  );
}

function ValidatedIndicator({ card, base }: { card: OwnerCard | ContractorCard; base: string }) {
  return (
    <Indicator label="Avancement validé" href={`${base}/avancement`} testId="avancement-valide">
      {show(card.validated, (v) => (v.computable ? `${v.validated} étape${v.validated > 1 ? "s" : ""} validée${v.validated > 1 ? "s" : ""} sur ${v.applicable}` : "Aucune étape applicable"))}
    </Indicator>
  );
}

function IncidentsIndicator({ card, base }: { card: OwnerCard | ContractorCard | SiteManagerCard; base: string }) {
  return (
    <Indicator label="Incidents ouverts" href={`${base}/incidents`} testId="incidents-ouverts">
      {show(card.incidents, (v) =>
        v.open === 0 ? "Aucun incident ouvert" : `${plural(v.open, "incident ouvert", "incidents ouverts")}${v.high > 0 ? `, dont ${v.high} de gravité élevée ou urgente` : ""}`
      )}
    </Indicator>
  );
}

function Activity({ at }: { at: string | null }) {
  return <p className="text-caption text-muted">Dernière activité visible : {at ? stamp(at) : "aucune pour l'instant"}</p>;
}

export function OwnerProjectCard({ card }: { card: OwnerCard }) {
  const base = `/chantiers/${card.project.id}`;
  const envelope = formatFcfa(card.project.budget);
  return (
    <Card className="flex flex-col gap-3 p-5" data-testid={`carte-proprietaire-${card.project.id}`}>
      <Header name={card.project.name} status={card.project.status} role={card.role === "OWNER_PRIMARY" ? "Propriétaire principal" : "Copropriétaire"} href={base} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DeclaredIndicator card={card} base={base} />
        <ValidatedIndicator card={card} base={base} />
        <Indicator label="Décisions qui vous attendent" href={base} testId="decisions">
          {show(card.decisions, (v) => {
            const items = [v.quotePending ? "un devis proposé" : null, v.changeOrdersPending > 0 ? plural(v.changeOrdersPending, "avenant proposé", "avenants proposés") : null, v.phasesToValidate > 0 ? plural(v.phasesToValidate, "étape à valider", "étapes à valider") : null].filter(Boolean);
            if (items.length === 0) return "Aucune décision en attente";
            return `${items.join(", ")}${v.canDecide ? "" : " — décision du propriétaire principal"}`;
          })}
        </Indicator>
        <IncidentsIndicator card={card} base={base} />
        <Indicator label="Montant contractuel et reste dû" href={`${base}/acomptes`} testId="finances-partagees">
          {show(card.finance, (v) =>
            v.contract ? `${formatFcfa(v.contract)} — payé ${formatFcfa(v.recognized ?? "0")}, reste dû ${formatFcfa(v.remainingDue ?? "0")}` : "Aucun devis accepté"
          )}
        </Indicator>
        <Indicator label="Enveloppe indicative du projet" href={base} testId="enveloppe">
          {envelope ? `${envelope} (indicative, partagée)` : "Non renseignée"}
        </Indicator>
      </div>
      <Activity at={card.lastActivityAt} />
    </Card>
  );
}

export function ContractorProjectCard({ card }: { card: ContractorCard }) {
  const base = `/chantiers/${card.project.id}`;
  return (
    <Card className="flex flex-col gap-3 p-5" data-testid={`carte-entreprise-${card.project.id}`}>
      <Header name={card.project.name} status={card.project.status} role="Entreprise" href={base} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DeclaredIndicator card={card} base={base} />
        <ValidatedIndicator card={card} base={base} />
        <Indicator label="Fin prévue dépassée" href={`${base}/avancement`} testId="fin-prevue-depassee">
          {show(card.overdue, (v) => (v.count === 0 ? "Aucune étape" : `${plural(v.count, "étape non validée", "étapes non validées")} : ${v.labels.join(", ")}`))}
        </Indicator>
        <IncidentsIndicator card={card} base={base} />
        <Indicator label="Demandes à traiter" href={`${base}/depenses`} testId="demandes">
          {show(card.requests, (v) => {
            const items = [
              v.expensesSubmitted > 0 ? plural(v.expensesSubmitted, "dépense soumise", "dépenses soumises") : null,
              v.paymentsToConfirm > 0 ? plural(v.paymentsToConfirm, "versement à confirmer", "versements à confirmer") : null,
              v.phasesAwaitingValidation > 0 ? plural(v.phasesAwaitingValidation, "étape en attente de validation", "étapes en attente de validation") : null,
            ].filter(Boolean);
            return items.length === 0 ? "Aucune demande en attente" : items.join(", ");
          })}
        </Indicator>
      </div>
      <Activity at={card.lastActivityAt} />
    </Card>
  );
}

export function SiteManagerProjectCard({ card }: { card: SiteManagerCard }) {
  const base = `/chantiers/${card.project.id}`;
  return (
    <Card className="flex flex-col gap-3 p-5" data-testid={`carte-chef-${card.project.id}`}>
      <Header name={card.project.name} status={card.project.status} role="Chef de chantier" href={base} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Indicator label="Journal du jour" href={`${base}/journal`} testId="journal-du-jour">
          {show(card.journalToday, (v) => (v.published ? "Publié" : v.draft ? "Brouillon en cours, à publier" : "Pas encore commencé"))}
        </Indicator>
        <IncidentsIndicator card={card} base={base} />
        <Indicator label="Mes dépenses" href={`${base}/depenses`} testId="mes-depenses">
          {show(card.myExpenses, (v) =>
            v.drafts + v.submitted === 0 ? "Aucune en cours" : [v.drafts > 0 ? plural(v.drafts, "brouillon", "brouillons") : null, v.submitted > 0 ? plural(v.submitted, "en attente de décision", "en attente de décision") : null].filter(Boolean).join(", ")
          )}
        </Indicator>
        <Indicator label="Fin prévue dépassée" href={`${base}/avancement`} testId="fin-prevue-depassee">
          {show(card.overdue, (v) => (v.count === 0 ? "Aucune étape" : `${plural(v.count, "étape non validée", "étapes non validées")} : ${v.labels.join(", ")}`))}
        </Indicator>
      </div>
    </Card>
  );
}
