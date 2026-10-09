"use client";

import { useState } from "react";
import { AlertBanner, Button } from "@/components/ui";
import { buttonClassName } from "@/components/ui/Button";
import { buildSharePayload, canShareFile, fileNameFromDisposition } from "@/lib/report/share";

// B046 + B047 (D200 ; BR072, AC123) — période, téléchargement et partage du
// rapport de suivi. Le partage joint le PDF généré à la demande au menu de
// partage natif de l'appareil (d'où l'on choisit WhatsApp) ; aucun lien n'est
// jamais créé. En deux temps (« préparer » puis « partager ») : le menu de
// partage doit être ouvert directement par un geste de la personne.

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body text-ink h-12";
const ERRORS: Record<string, string> = {
  period_invalid: "Choisissez une date de début antérieure ou égale à la date de fin.",
  period_too_long: "La période ne peut pas dépasser 12 mois.",
  period_in_future: "La date de fin ne peut pas être dans le futur.",
};

type State =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "ready"; file: File }
  | { kind: "downloaded" }
  | { kind: "shared" }
  | { kind: "error"; message: string };

export function ReportActions({ projectId, defaultFrom, defaultTo }: { projectId: string; defaultFrom: string; defaultTo: string }) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [state, setState] = useState<State>({ kind: "idle" });
  const href = `/chantiers/${projectId}/rapports/pdf?du=${encodeURIComponent(from)}&au=${encodeURIComponent(to)}`;

  const download = (file: File) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const prepare = async () => {
    setState({ kind: "preparing" });
    try {
      const res = await fetch(href, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok || res.headers.get("content-type") !== "application/pdf") {
        const code = new URL(res.url).searchParams.get("erreur") ?? "";
        setState({ kind: "error", message: ERRORS[code] ?? "Le rapport n'a pas pu être préparé. Réessayez." });
        return;
      }
      const blob = await res.blob();
      const file = new File([blob], fileNameFromDisposition(res.headers.get("content-disposition")), { type: "application/pdf" });
      if (canShareFile(typeof navigator === "undefined" ? undefined : navigator, file)) {
        setState({ kind: "ready", file });
      } else {
        // Repli : téléchargement, puis envoi manuel depuis WhatsApp.
        download(file);
        setState({ kind: "downloaded" });
      }
    } catch {
      setState({ kind: "error", message: "Le rapport n'a pas pu être préparé. Vérifiez la connexion et réessayez." });
    }
  };

  const share = async (file: File) => {
    try {
      await navigator.share(buildSharePayload(file));
      setState({ kind: "shared" });
    } catch (e) {
      // Partage annulé par la personne : on reste prêt, sans message d'erreur.
      if (e instanceof DOMException && e.name === "AbortError") return;
      download(file);
      setState({ kind: "downloaded" });
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="actions-rapport">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-label font-semibold text-ink">
          Du
          <input type="date" name="du" required value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 text-label font-semibold text-ink">
          Au
          <input type="date" name="au" required value={to} max={defaultTo} onChange={(e) => setTo(e.target.value)} className={FIELD} />
        </label>
      </div>
      <p className="text-caption text-muted">Par défaut, les 30 derniers jours ; 12 mois au plus.</p>
      <div className="flex flex-wrap gap-2">
        <a href={href} className={buttonClassName("primary", "regular")} data-testid="telecharger-rapport">
          Générer le rapport
        </a>
        {state.kind === "ready" ? (
          <Button type="button" variant="secondary" onClick={() => share(state.file)} data-testid="partager-rapport">
            Partager via WhatsApp
          </Button>
        ) : (
          <Button type="button" variant="secondary" loading={state.kind === "preparing"} onClick={prepare} data-testid="preparer-partage">
            Préparer le partage
          </Button>
        )}
      </div>
      <p className="text-caption text-muted">
        Le partage ouvre le menu de votre téléphone (WhatsApp ou une autre application) avec le fichier PDF seulement : aucun lien n&apos;est créé et le
        rapport ne contient que ce que vous voyez.
      </p>
      {state.kind === "ready" ? (
        <AlertBanner variant="information" title="Rapport prêt" explanation={`${state.file.name} (${(state.file.size / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Ko). Touchez « Partager via WhatsApp ».`} />
      ) : null}
      {state.kind === "downloaded" ? (
        <AlertBanner
          variant="information"
          title="Rapport téléchargé"
          explanation="Le partage direct n'est pas disponible sur cet appareil. Ouvrez WhatsApp, puis joignez le fichier téléchargé comme document."
        />
      ) : null}
      {state.kind === "shared" ? <AlertBanner variant="information" title="Menu de partage ouvert" explanation="Le rapport a été remis au menu de partage." /> : null}
      {state.kind === "error" ? <AlertBanner variant="error" title="Rapport non préparé" explanation={state.message} /> : null}
    </div>
  );
}
