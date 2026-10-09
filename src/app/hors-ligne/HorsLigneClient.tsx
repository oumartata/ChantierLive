"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertBanner, Button, Card, ConfirmDialog, EmptyState, StatusChip } from "@/components/ui";
import { indexedDbBackend, storageStatus } from "@/lib/offline/idb";
import { getOfflineReference } from "@/app/(app)/offline-actions";
import {
  applyReferenceForSession,
  currentAccountDb,
  exportDrafts,
  listDrafts,
  removeDraft,
  saveDraft,
  type IncidentFields,
  type JournalFields,
  type LocalDraft,
  type Reference,
} from "@/lib/offline/account";
import { listOps, type DraftKind, type QueueOp } from "@/lib/offline/queue";
import type { LocalStore } from "@/lib/offline/store";
import { INCIDENT_TYPES, SEVERITIES } from "@/app/(app)/chantiers/[id]/incidents/labels";
import { downloadText } from "@/components/offline/OfflineLogoutForm";

// L06 (B036, B037 ; O1 à O4, O7, O13 ; D202) — brouillons créés sans réseau,
// gardés sur cet appareil dans la base du compte. L'envoi au serveur arrive
// avec la tranche suivante (B038) : rien n'est présenté comme envoyé.

const FIELD = "w-full rounded-small border border-muted/40 bg-surface px-4 py-2 text-body font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
const REFUSAL: Record<string, string> = { access_revoked: "Refusé : accès retiré — jamais envoyé" };
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const localStamp = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
const when = (ts: string) => new Date(ts).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

// État réseau du navigateur (FR125).
function subscribeNetwork(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function HorsLigneClient() {
  const [db, setDb] = useState<LocalStore | null | undefined>(undefined);
  const [reference, setReference] = useState<Reference | null>(null);
  const [drafts, setDrafts] = useState<LocalDraft[]>([]);
  const [ops, setOps] = useState<QueueOp[]>([]);
  const online = useSyncExternalStore(subscribeNetwork, () => navigator.onLine, () => true);
  const [storage, setStorage] = useState<{ persisted: boolean; usage: number | null; quota: number | null } | null>(null);
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState<DraftKind>("INCIDENT");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<string | null>(null);

  const reload = useCallback(async (store: LocalStore) => {
    setReference((await store.get<Reference>("reference", "current")) ?? null);
    setDrafts(await listDrafts(store));
    setOps(await listOps(store));
  }, []);

  useEffect(() => {
    currentAccountDb(indexedDbBackend).then(async (store) => {
      setDb(store);
      if (!store) return;
      await reload(store);
      // En ligne : référence rafraîchie, seulement pour le compte de cette base.
      if (navigator.onLine) {
        const res = await getOfflineReference().catch(() => ({ ok: false as const }));
        if (res.ok && (await applyReferenceForSession(indexedDbBackend, res.profileId, res.reference)).applied) await reload(store);
      }
    }, () => setDb(null));
    storageStatus().then(setStorage, () => undefined);
  }, [reload]);

  const projects = reference?.projects ?? [];
  const project = projects.find((p) => p.projectId === projectId) ?? projects[0];
  const kinds = project?.kinds ?? [];
  const activeKind = kinds.includes(kind) ? kind : (kinds[0] ?? "INCIDENT");

  const submit = async (form: HTMLFormElement) => {
    if (!db || !project) return;
    const f = new FormData(form);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    setError(null);
    try {
      if (activeKind === "JOURNAL") {
        const fields: JournalFields = { logDate: s("logDate"), worksDone: s("worksDone"), difficulties: s("difficulties"), team: s("team"), nextActions: s("nextActions"), phaseId: s("phaseId") || null };
        if (!fields.worksDone) throw new Error("Décrivez les travaux réalisés.");
        await saveDraft(db, { projectId: project.projectId, kind: "JOURNAL", fields });
      } else {
        const fields: IncidentFields = { incidentType: s("incidentType"), severity: s("severity"), occurredAt: new Date(s("occurredAt")).toISOString(), description: s("description"), phaseId: s("phaseId") || null };
        if (fields.description.length < 3) throw new Error("Décrivez l'incident.");
        await saveDraft(db, { projectId: project.projectId, kind: "INCIDENT", fields });
      }
      form.reset();
      setSaved(activeKind === "JOURNAL" ? "Brouillon de journal gardé sur cet appareil." : "Incident gardé sur cet appareil : alerte non envoyée tant qu'il n'est pas transmis.");
      await reload(db);
    } catch (e) {
      setError(e instanceof Error && e.message !== "not_allowed_offline" ? e.message : "Ce brouillon n'est pas autorisé hors ligne pour votre rôle sur ce chantier.");
    }
  };

  if (db === undefined) return <div className="p-6 text-body text-muted">Chargement…</div>;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-h1 font-bold text-ink">Hors ligne</h1>
        <StatusChip variant={online ? "success" : "attention"} label={online ? "En ligne" : "Hors ligne"} />
      </div>
      <p className="text-body text-muted">
        Brouillons créés sans réseau, gardés sur cet appareil pour votre seul compte. Ils ne sont pas encore envoyés au serveur : l&apos;envoi arrive avec
        une prochaine version. À la déconnexion, ils sont effacés de cet appareil (export proposé).
      </p>
      <Link href="/tableau-de-bord" className="text-label font-semibold text-primary underline">
        Retour au tableau de bord
      </Link>

      {!db || !reference ? (
        <AlertBanner
          variant="information"
          title="Aucun compte prêt sur cet appareil"
          explanation="Connectez-vous une première fois avec du réseau : vos chantiers sont alors préparés pour travailler hors ligne."
        />
      ) : (
        <>
          <Card className="flex flex-col gap-3">
            <h2 className="text-h2 font-semibold text-ink">Nouveau brouillon</h2>
            {projects.length === 0 ? (
              <p className="text-body text-muted">Aucun chantier disponible.</p>
            ) : (
              <form
                className="flex flex-col gap-3"
                data-testid="form-hors-ligne"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(e.currentTarget);
                }}
              >
                <label className="flex flex-col gap-1 text-label font-semibold text-ink">
                  Chantier
                  <select className={`${FIELD} h-12`} value={project?.projectId ?? ""} onChange={(e) => setProjectId(e.target.value)} name="projectId">
                    {projects.map((p) => (
                      <option key={p.projectId} value={p.projectId}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type de brouillon">
                  {kinds.map((k) => (
                    <Button key={k} type="button" size="compact" variant={k === activeKind ? "primary" : "secondary"} onClick={() => setKind(k)} data-testid={`type-${k}`}>
                      {k === "JOURNAL" ? "Journal" : "Incident"}
                    </Button>
                  ))}
                </div>
                {activeKind === "JOURNAL" ? (
                  <>
                    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
                      Date
                      <input type="date" name="logDate" defaultValue={localDay()} required className={`${FIELD} h-12`} />
                    </label>
                    {(["worksDone", "difficulties", "team", "nextActions"] as const).map((n) => (
                      <label key={n} className="flex flex-col gap-1 text-label font-semibold text-ink">
                        {{ worksDone: "Travaux réalisés", difficulties: "Difficultés", team: "Équipe", nextActions: "Prochaines actions" }[n]}
                        <textarea name={n} rows={n === "worksDone" ? 3 : 2} maxLength={4000} required={n === "worksDone"} className={FIELD} />
                      </label>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
                        Type
                        <select name="incidentType" className={`${FIELD} h-12`} defaultValue="AUTRE">
                          {INCIDENT_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-label font-semibold text-ink">
                        Gravité
                        <select name="severity" className={`${FIELD} h-12`} defaultValue="MOYENNE">
                          {SEVERITIES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
                      Survenu le
                      <input type="datetime-local" name="occurredAt" defaultValue={localStamp()} required className={`${FIELD} h-12`} />
                    </label>
                    <label className="flex flex-col gap-1 text-label font-semibold text-ink">
                      Description
                      <textarea name="description" rows={3} maxLength={4000} required className={FIELD} />
                    </label>
                  </>
                )}
                {project && project.phases.length > 0 ? (
                  <label className="flex flex-col gap-1 text-label font-semibold text-ink">
                    Étape (facultatif)
                    <select name="phaseId" className={`${FIELD} h-12`} defaultValue="">
                      <option value="">—</option>
                      {project.phases.map((ph) => (
                        <option key={ph.id} value={ph.id}>
                          {ph.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {error ? <AlertBanner variant="error" title="Brouillon non gardé" explanation={error} /> : null}
                {saved ? <AlertBanner variant="information" title="Gardé sur cet appareil" explanation={saved} /> : null}
                <div>
                  <Button type="submit" data-testid="garder-brouillon">
                    Garder sur cet appareil
                  </Button>
                </div>
              </form>
            )}
          </Card>

          <section className="flex flex-col gap-3" data-testid="file-hors-ligne">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-h2 font-semibold text-ink">Brouillons sur cet appareil ({drafts.length})</h2>
              {drafts.length > 0 ? (
                <Button type="button" size="compact" variant="secondary" onClick={async () => downloadText(`brouillons-hors-ligne-${localDay()}.json`, await exportDrafts(db))}>
                  Exporter mes brouillons
                </Button>
              ) : null}
            </div>
            {drafts.length === 0 ? (
              <EmptyState title="Aucun brouillon" description="Les brouillons créés sans réseau apparaîtront ici." />
            ) : (
              <ul className="flex flex-col gap-2">
                {drafts.map((d) => {
                  const last = ops.filter((o) => o.entityId === d.entityId).at(-1);
                  const name = projects.find((p) => p.projectId === d.projectId)?.name ?? "Chantier retiré";
                  const refused = last?.status === "REFUSED";
                  const text = d.kind === "JOURNAL" ? (d.fields as JournalFields).worksDone : (d.fields as IncidentFields).description;
                  return (
                    <li key={d.entityId}>
                      <Card className="flex flex-col gap-1" data-testid="brouillon-local">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-label font-semibold text-ink">
                            {d.kind === "JOURNAL" ? "Journal" : "Incident"} · {name}
                          </p>
                          <StatusChip variant={refused ? "danger" : "attention"} label={refused ? REFUSAL[last?.refusal ?? ""] ?? "Refusé" : "En attente d'envoi"} />
                        </div>
                        <p className="break-words text-body text-ink">{text}</p>
                        {d.kind === "INCIDENT" && !refused ? (
                          <p className="text-caption font-semibold text-danger" data-testid="alerte-non-envoyee">
                            Alerte non envoyée : l&apos;incident n&apos;est pas encore transmis aux membres du chantier.
                          </p>
                        ) : null}
                        <p className="text-caption text-muted">
                          Créé le {when(d.createdAtClient)} (heure du téléphone) · opération {last?.operationUuid.slice(0, 8)}
                        </p>
                        <div>
                          <Button type="button" size="compact" variant="ghost" onClick={() => setToRemove(d.entityId)}>
                            Retirer de cet appareil
                          </Button>
                        </div>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {storage ? (
            <p className="text-caption text-muted">
              Stockage de l&apos;appareil : {storage.persisted ? "persistant" : "non garanti (le navigateur peut l'effacer)"}
              {storage.usage !== null && storage.quota !== null ? ` · ${(storage.usage / 1048576).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo utilisés` : ""}.
            </p>
          ) : null}
          <ConfirmDialog
            open={toRemove !== null}
            title="Retirer ce brouillon de l'appareil ?"
            consequence="Le brouillon et son opération en attente sont supprimés de cet appareil."
            permanence="Il n'a jamais été envoyé : il ne pourra pas être retrouvé."
            confirmLabel="Retirer"
            onCancel={() => setToRemove(null)}
            onConfirm={async () => {
              if (toRemove) await removeDraft(db, toRemove);
              setToRemove(null);
              await reload(db);
            }}
          />
        </>
      )}
    </div>
  );
}
