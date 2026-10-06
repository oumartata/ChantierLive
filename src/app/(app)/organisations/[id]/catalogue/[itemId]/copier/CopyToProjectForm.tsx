"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertBanner, Button, Card } from "@/components/ui";
import { DEFAULT_PRESETS, type AccessSide } from "@/app/prototype-plans/geometry";
import { ACCESS_LABELS, type CatalogueCopyReport, type DestinationParams, type ModelReference } from "@/app/prototype-plans/catalogueCopy";
import { createCatalogueCopyAction, prefillCatalogueCopyAction, previewCatalogueCopyAction } from "./actions";

// Paramètres du CHANTIER destinataire : saisis ou confirmés explicitement,
// jamais pré-remplis depuis le modèle (dont les paramètres restent affichés
// à part, en lecture seule). Seule source de pré-remplissage : la dernière
// demande de plan de CE chantier, présentée comme telle.

type NeedRow = { type: string; label: string; count: string; minWidth: string; minDepth: string };
type FormState = {
  terrainWidth: string;
  terrainDepth: string;
  front: string;
  back: string;
  left: string;
  right: string;
  accessSide: AccessSide;
  orientation: "N" | "S" | "E" | "O";
  needs: NeedRow[];
};

const EMPTY: FormState = {
  terrainWidth: "",
  terrainDepth: "",
  front: "",
  back: "",
  left: "",
  right: "",
  accessSide: "front",
  orientation: "N",
  needs: Object.values(DEFAULT_PRESETS).map((p) => ({ type: p.type, label: p.label, count: "0", minWidth: String(p.minWidth), minDepth: String(p.minDepth) })),
};

const fmt = (n: number) => n.toFixed(2).replace(".", ",");
const num = (s: string) => (s.trim() === "" ? NaN : Number(s.replace(",", ".")));

function fromParams(p: DestinationParams): FormState {
  return {
    terrainWidth: String(p.terrainWidth),
    terrainDepth: String(p.terrainDepth),
    front: String(p.setbacks.front),
    back: String(p.setbacks.back),
    left: String(p.setbacks.left),
    right: String(p.setbacks.right),
    accessSide: p.accessSide,
    orientation: p.orientation,
    needs: EMPTY.needs.map((row) => {
      const n = p.needs.find((x) => x.type === row.type);
      return n ? { ...row, count: String(n.count), minWidth: String(n.minWidth), minDepth: String(n.minDepth) } : row;
    }),
  };
}

function toParams(f: FormState) {
  return {
    terrainWidth: num(f.terrainWidth),
    terrainDepth: num(f.terrainDepth),
    setbacks: { front: num(f.front), back: num(f.back), left: num(f.left), right: num(f.right) },
    accessSide: f.accessSide,
    orientation: f.orientation,
    needs: f.needs.map((n) => ({ type: n.type, count: num(n.count), minWidth: num(n.minWidth), minDepth: num(n.minDepth) })),
  };
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-caption text-ink">
      {label}
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 rounded-small border border-muted/40 bg-white px-2 py-1 text-body"
      />
    </label>
  );
}

export function CopyToProjectForm({
  organizationId,
  catalogItemId,
  modelLabel,
  reference,
  destinations,
}: {
  organizationId: string;
  catalogItemId: string;
  modelLabel: string;
  reference: ModelReference;
  destinations: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [prefillNote, setPrefillNote] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"prefill" | "preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; report: CatalogueCopyReport; canCreate: boolean } | null>(null);
  // Reprise sans doublon : même opération, même date de préparation et
  // même demande tant que le chantier et les paramètres sont identiques.
  const operationRef = useRef<{ key: string; uuid: string; savedAt: string; requestId: string | null } | null>(null);

  const paramsJson = JSON.stringify(toParams(form));
  const key = `${projectId}|${paramsJson}`;
  const previewIsCurrent = preview !== null && preview.key === key;
  const destinationName = destinations.find((d) => d.id === projectId)?.name ?? "";

  function update(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
    setConfirmed(false);
  }
  function updateNeed(index: number, patch: Partial<NeedRow>) {
    setForm((f) => ({ ...f, needs: f.needs.map((n, i) => (i === index ? { ...n, ...patch } : n)) }));
    setConfirmed(false);
  }

  async function chooseProject(id: string) {
    setProjectId(id);
    setConfirmed(false);
    setPreview(null);
    setError(null);
    setPrefillNote(null);
    setForm(EMPTY);
    if (!id) return;
    setBusy("prefill");
    const result = await prefillCatalogueCopyAction(organizationId, id);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.value) {
      setForm(fromParams(result.value.params));
      setPrefillNote(
        `Valeurs reprises de la dernière demande de plan de ce chantier (${new Date(result.value.createdAt).toLocaleDateString("fr-FR")}). Vérifiez-les avant de confirmer.`
      );
    } else {
      setPrefillNote("Aucune demande de plan précédente sur ce chantier : renseignez son terrain, ses reculs, son accès et son programme.");
    }
  }

  function baseFormData() {
    const fd = new FormData();
    fd.set("organization_id", organizationId);
    fd.set("catalog_item_id", catalogItemId);
    fd.set("project_id", projectId);
    fd.set("params", paramsJson);
    return fd;
  }

  async function handlePreview() {
    setBusy("preview");
    setError(null);
    try {
      const result = await previewCatalogueCopyAction(baseFormData());
      if (!result.ok) {
        setError(result.message);
        setPreview(null);
        return;
      }
      setPreview({ key, ...result.value });
    } catch {
      setError("Réponse du serveur non reçue. Réessayez.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    if (!previewIsCurrent || !preview?.canCreate) return;
    if (operationRef.current?.key !== key) {
      operationRef.current = { key, uuid: crypto.randomUUID(), savedAt: new Date().toISOString(), requestId: null };
    }
    const op = operationRef.current;
    const fd = baseFormData();
    fd.set("operation_uuid", op.uuid);
    fd.set("saved_at", op.savedAt);
    if (op.requestId) fd.set("request_id", op.requestId);
    setBusy("create");
    setError(null);
    try {
      const result = await createCatalogueCopyAction(fd);
      if (!result.ok) {
        if (result.requestId) op.requestId = result.requestId;
        setError(result.message);
        if (result.report) setPreview({ key, report: result.report, canCreate: false });
        return;
      }
      operationRef.current = null;
      router.push(`/prototype-plans?retour=${result.value.projectId}&demande=${result.value.requestId}&variante=${result.value.variantId}`);
    } catch {
      setError("Réponse du serveur non reçue. Réessayez : une même copie n'est jamais enregistrée deux fois.");
    } finally {
      setBusy(null);
    }
  }

  const empriseW = num(form.terrainWidth) - num(form.left) - num(form.right);
  const empriseD = num(form.terrainDepth) - num(form.front) - num(form.back);

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">1. Chantier destinataire</h2>
        {destinations.length === 0 ? (
          <AlertBanner
            variant="warning"
            title="Aucun chantier destinataire"
            explanation="Il faut être entreprise ou propriétaire principal d'un chantier rattaché à cette organisation pour y copier un modèle."
          />
        ) : (
          <label className="flex flex-col gap-1 text-label text-ink">
            Chantier
            <select
              value={projectId}
              onChange={(e) => chooseProject(e.target.value)}
              className="rounded-small border border-muted/40 bg-white px-2 py-2 text-body"
            >
              <option value="">— Choisir un chantier —</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-caption text-muted">
          Seuls les chantiers où vous êtes entreprise ou propriétaire principal, et qui sont rattachés à cette
          organisation, sont proposés.
        </p>
      </Card>

      {projectId ? (
        <div className="grid gap-6 md:grid-cols-2">
          <Card className="flex flex-col gap-3">
            <h2 className="text-h2 font-semibold text-ink">2. Paramètres du chantier</h2>
            {busy === "prefill" ? <p className="text-caption text-muted">Lecture du chantier…</p> : null}
            {prefillNote ? <p className="text-caption text-ink">{prefillNote}</p> : null}
            <div className="flex flex-wrap gap-3">
              <Field label="Terrain — largeur (m)" value={form.terrainWidth} onChange={(v) => update({ terrainWidth: v })} />
              <Field label="Terrain — profondeur (m)" value={form.terrainDepth} onChange={(v) => update({ terrainDepth: v })} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Field label="Recul avant (m)" value={form.front} onChange={(v) => update({ front: v })} />
              <Field label="Recul arrière (m)" value={form.back} onChange={(v) => update({ back: v })} />
              <Field label="Recul gauche (m)" value={form.left} onChange={(v) => update({ left: v })} />
              <Field label="Recul droit (m)" value={form.right} onChange={(v) => update({ right: v })} />
            </div>
            <p className="text-caption text-muted">
              Emprise constructible :{" "}
              {Number.isFinite(empriseW) && Number.isFinite(empriseD) ? `${fmt(empriseW)} × ${fmt(empriseD)} m` : "à renseigner"}
            </p>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-caption text-ink">
                Façade d&apos;accès
                <select
                  value={form.accessSide}
                  onChange={(e) => update({ accessSide: e.target.value as AccessSide })}
                  className="rounded-small border border-muted/40 bg-white px-2 py-1 text-body"
                >
                  {(Object.keys(ACCESS_LABELS) as AccessSide[]).map((s) => (
                    <option key={s} value={s}>
                      {ACCESS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-caption text-ink">
                Orientation
                <select
                  value={form.orientation}
                  onChange={(e) => update({ orientation: e.target.value as FormState["orientation"] })}
                  className="rounded-small border border-muted/40 bg-white px-2 py-1 text-body"
                >
                  {["N", "S", "E", "O"].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <h3 className="text-label font-semibold text-ink">Programme</h3>
            <div className="flex flex-col gap-2">
              {form.needs.map((n, i) => (
                <div key={n.type} className="flex flex-wrap items-end gap-2">
                  <span className="w-20 text-caption font-semibold text-ink">{n.label}</span>
                  <Field label="Nombre" value={n.count} onChange={(v) => updateNeed(i, { count: v })} />
                  <Field label="Larg. min (m)" value={n.minWidth} onChange={(v) => updateNeed(i, { minWidth: v })} />
                  <Field label="Prof. min (m)" value={n.minDepth} onChange={(v) => updateNeed(i, { minDepth: v })} />
                </div>
              ))}
            </div>
            <label className="flex items-start gap-2 text-label text-ink">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
              <span>
                Je confirme que ces paramètres sont ceux du chantier « {destinationName} » (terrain réel), et non ceux du
                modèle.
              </span>
            </label>
          </Card>

          <Card className="flex flex-col gap-2">
            <h2 className="text-h2 font-semibold text-ink">Référence : paramètres du modèle</h2>
            <p className="text-caption text-muted">
              Lecture seule — ces valeurs décrivent le terrain pour lequel « {modelLabel} » a été conçu. Elles ne sont
              jamais reprises comme paramètres du chantier.
            </p>
            <ul className="flex flex-col gap-1 text-caption text-ink">
              <li>
                Terrain : {fmt(reference.terrainWidth)} × {fmt(reference.terrainDepth)} m
              </li>
              {reference.setbacks ? (
                <li>
                  Reculs : avant {fmt(reference.setbacks.front)} · arrière {fmt(reference.setbacks.back)} · gauche{" "}
                  {fmt(reference.setbacks.left)} · droit {fmt(reference.setbacks.right)} m
                </li>
              ) : null}
              <li>Façade d&apos;accès : {ACCESS_LABELS[reference.accessSide]}</li>
              <li>Orientation : {reference.orientation}</li>
              {reference.program.map((p) => (
                <li key={p.type}>
                  {p.label} × {p.count} : {p.rooms.map((r) => `${fmt(r.w)} × ${fmt(r.d)} m`).join(", ")}
                </li>
              ))}
              {reference.parkedRooms > 0 ? <li>{reference.parkedRooms} pièce(s) mise(s) de côté</li> : null}
            </ul>
          </Card>
        </div>
      ) : null}

      {projectId ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-h2 font-semibold text-ink">3. Vérifier puis créer la copie</h2>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" loading={busy === "preview"} disabled={!confirmed || busy !== null} onClick={handlePreview}>
              Vérifier la copie avec ces paramètres
            </Button>
            <Button
              type="button"
              loading={busy === "create"}
              disabled={!confirmed || !previewIsCurrent || !preview?.canCreate || busy !== null}
              onClick={handleCreate}
            >
              Créer la copie dans ce chantier et l&apos;ouvrir
            </Button>
          </div>
          {!confirmed ? <p className="text-caption text-muted">Confirmez d&apos;abord les paramètres du chantier.</p> : null}
          {preview && !previewIsCurrent ? (
            <p className="text-caption text-muted">Paramètres modifiés depuis la vérification : vérifiez à nouveau.</p>
          ) : null}
          {error ? <AlertBanner variant="error" title="Action impossible" explanation={error} /> : null}
          {preview && previewIsCurrent ? (
            <div className="flex flex-col gap-3" data-testid="copy-report">
              {preview.report.blocking.length > 0 ? (
                <div className="rounded-medium border border-danger/40 bg-danger/10 p-3">
                  <p className="text-label font-semibold text-ink">Copie impossible en l&apos;état ({preview.report.blocking.length})</p>
                  <ul className="mt-1 list-disc pl-5 text-caption text-ink">
                    {preview.report.blocking.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.report.toAdapt.length > 0 ? (
                <div className="rounded-medium border border-action/40 bg-action/10 p-3">
                  <p className="text-label font-semibold text-ink">À adapter dans l&apos;éditeur ({preview.report.toAdapt.length})</p>
                  <p className="text-caption text-muted">Le dépôt restera refusé tant que ces points ne sont pas corrigés.</p>
                  <ul className="mt-1 list-disc pl-5 text-caption text-ink">
                    {preview.report.toAdapt.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.report.warnings.length > 0 ? (
                <ul className="list-disc pl-5 text-caption text-ink">
                  {preview.report.warnings.map((b) => (
                    <li key={b}>Avertissement : {b}</li>
                  ))}
                </ul>
              ) : null}
              <ul className="list-disc pl-5 text-caption text-muted">
                {preview.report.notes.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {preview.report.blocking.length === 0 && preview.report.toAdapt.length === 0 ? (
                <p className="text-caption text-ink">Aucun écart relevé par ces contrôles automatiques.</p>
              ) : null}
              <p className="text-caption text-muted">
                Ces contrôles ne valent pas validation : la copie n&apos;est ni déposée ni considérée comme admissible. Elle
                reste soumise aux contrôles de l&apos;éditeur, puis à la validation technique du chantier.
              </p>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
