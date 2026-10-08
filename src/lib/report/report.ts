// B046 — rapport de suivi PDF (M053 ; D200, D034 ; BR079, BR080, BR057,
// BR098, D183, D186). Module serveur autonome (aucun import d'alias), compilé
// tel quel par scripts/test-report.mjs.
//
// - Un seul rapport de suivi pour les 4 rôles, chacun limité à ce qu'il voit :
//   toutes les données sont lues par les MÊMES fonctions que les écrans, avec
//   la session de la personne (jamais le rôle serveur). Aucune finance
//   interne, même pour l'entreprise ; pas de commentaires ; jamais un
//   brouillon, un document « Entreprise seulement » pour un autre rôle, ni un
//   commentaire masqué.
// - « Avancement déclaré » et « Avancement validé » : deux sections séparées,
//   chiffres repris tels que la base les calcule (R13).
// - Régénéré à chaque demande, jamais stocké : le PDF n'existe qu'en mémoire.
//   Identifiant et empreinte des données imprimés dans le document.
// - Police libre intégrée : Noto Sans (SIL Open Font License 1.1, The Noto
//   Project Authors), jeux latin et latin étendu. Un caractère non couvert est
//   remplacé par « � » ET signalé dans le document, jamais supprimé en
//   silence.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";

type RpcResult = { data: unknown; error: { message: string } | null };
export interface ReportClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

export class ReportError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type Party = "CONTRACTOR" | "OWNER_PRIMARY" | "CO_OWNER" | "SITE_MANAGER";
type Row = Record<string, unknown>;

export interface ReportData {
  reportId: string;
  party: Party;
  projectName: string;
  projectRef: string;
  generatedAt: string;
  from: string;
  to: string;
  progress: {
    planStatus: string;
    declaredPercent: string | null;
    validated: { computable: boolean; percent: string | null; validatedCount: number; applicableCount: number };
    phases: { position: number; label: string; progression: string; status: string; declaredCompletedAt: string | null; validatedAt: string | null }[];
  };
  logs: { logDate: string; worksDone: string; difficulties: string | null; team: string | null; nextActions: string | null; phase: string | null; version: number }[];
  incidents: { type: string; severity: string; status: string; occurredAt: string; description: string; resolution: string | null; createdAt: string }[];
  documents: { title: string; type: string; visibility: string; version: number | null; publishedAt: string }[];
  photos: { publishedAt: string; origin: string }[];
  finance: null | {
    contractAmount: string | null;
    quoteAmount: string | null;
    changeOrdersAmount: string | null;
    recognized: string | null;
    pending: string | null;
    disputed: string | null;
    remainingDue: string | null;
    overpaid: string | null;
    payments: { declaredRole: string; amount: string; paymentDate: string; mode: string; status: string; declaredAt: string }[];
  };
}

// ---------------------------------------------------------------------------
// Période et nom de fichier.
// ---------------------------------------------------------------------------
const DAY = 86400000;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// D200 : 30 derniers jours par défaut (aujourd'hui compris), 12 mois au plus.
export function defaultPeriod(today: Date = new Date()): { from: string; to: string } {
  return { from: isoDay(new Date(today.getTime() - 29 * DAY)), to: isoDay(today) };
}

export function reportFileName(data: Pick<ReportData, "projectRef" | "from" | "to">): string {
  return `rapport-chantier-${data.projectRef.toLowerCase()}-${data.from}_${data.to}.pdf`;
}

// ---------------------------------------------------------------------------
// Collecte, avec la session de la personne.
// ---------------------------------------------------------------------------
async function call(client: ReportClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new ReportError(error.message);
  return data;
}
const one = (d: unknown): Row => (Array.isArray(d) ? (d[0] as Row) : (d as Row)) ?? {};
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const dayOf = (ts: unknown) => String(ts ?? "").slice(0, 10);
const inPeriod = (d: string, from: string, to: string) => d >= from && d <= to;

async function paged(client: ReportClient, fn: string, projectId: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = rows(await call(client, fn, { p_project_id: projectId, p_limit: 100, p_offset: offset }));
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

export async function collectReport(client: ReportClient, projectId: string, from: string, to: string): Promise<ReportData> {
  const prep = one(await call(client, "report_prepare", { p_project_id: projectId, p_from: from, p_to: to }));
  const party = String(prep.party) as Party;

  const plan = one(await call(client, "get_project_phase_plan", { p_project_id: projectId }));
  const published = plan.status === "PUBLIE";
  const phases = published ? rows(await call(client, "list_project_phase_details", { p_project_id: projectId })) : [];
  const validated = one(await call(client, "get_project_validated_progress", { p_project_id: projectId }));

  const logs = (await paged(client, "list_published_daily_logs", projectId)).filter((l) => inPeriod(dayOf(l.log_date), from, to));
  const incidents = (await paged(client, "list_project_incidents", projectId)).filter(
    (i) => inPeriod(dayOf(i.created_at_server), from, to) || !["CLOS", "ANNULE"].includes(String(i.status)),
  );
  // Documents partagés : publiés et en vigueur (jamais un brouillon, même le sien).
  const documents = rows(await call(client, "list_project_documents", { p_project_id: projectId })).filter(
    (d) => d.status === "PUBLIE" && !!d.published_at_server && dayOf(d.published_at_server) <= to,
  );
  // Photos publiées dans la période (jamais un brouillon, même le sien).
  const photos = rows(await call(client, "list_project_media", { p_project_id: projectId })).filter(
    (m) => m.status === "PUBLIE" && !!m.published_at_server && inPeriod(dayOf(m.published_at_server), from, to),
  );

  // Prix convenu, versements et reste dû : seulement pour les rôles qui les
  // voient dans l'application (jamais le chef de chantier).
  let finance: ReportData["finance"] = null;
  if (party !== "SITE_MANAGER") {
    const f = one(await call(client, "get_project_financial_summary", { p_project_id: projectId }));
    const payments = rows(await call(client, "list_advance_payments", { p_project_id: projectId })).filter((p) =>
      inPeriod(dayOf(p.declared_at_server), from, to),
    );
    finance = {
      contractAmount: s(f.contract_amount_fcfa),
      quoteAmount: s(f.quote_amount_fcfa),
      changeOrdersAmount: s(f.change_orders_amount_fcfa),
      recognized: s(f.recognized_fcfa),
      pending: s(f.pending_fcfa),
      disputed: s(f.disputed_fcfa),
      remainingDue: s(f.remaining_due_fcfa),
      overpaid: s(f.overpaid_fcfa),
      payments: payments.map((p) => ({
        declaredRole: String(p.declared_role),
        amount: String(p.amount_fcfa),
        paymentDate: String(p.external_payment_date),
        mode: String(p.mode),
        status: String(p.status),
        declaredAt: String(p.declared_at_server),
      })),
    };
  }

  return {
    reportId: String(prep.report_id),
    party,
    projectName: String(prep.project_name),
    projectRef: String(prep.project_ref),
    generatedAt: String(prep.generated_at_server),
    from,
    to,
    progress: {
      planStatus: String(plan.status ?? "ABSENT"),
      declaredPercent: published ? s(plan.global_progress) : null,
      validated: {
        computable: validated.computable === true,
        percent: s(validated.validated_progress),
        validatedCount: Number(validated.validated_count ?? 0),
        applicableCount: Number(validated.applicable_count ?? 0),
      },
      phases: phases
        .map((p) => ({
          position: Number(p.position),
          label: String(p.label),
          progression: String(p.progression),
          status: String(p.status),
          declaredCompletedAt: s(p.declared_completed_at),
          validatedAt: s(p.validated_at),
        }))
        .sort((a, b) => a.position - b.position),
    },
    logs: logs
      .map((l) => ({
        logDate: dayOf(l.log_date),
        worksDone: String(l.works_done ?? ""),
        difficulties: s(l.difficulties),
        team: s(l.team),
        nextActions: s(l.next_actions),
        phase: s(l.phase_label),
        version: Number(l.current_version_number ?? 1),
      }))
      .sort((a, b) => a.logDate.localeCompare(b.logDate)),
    incidents: incidents.map((i) => ({
      type: String(i.incident_type),
      severity: String(i.severity),
      status: String(i.status),
      occurredAt: String(i.occurred_at),
      description: String(i.description ?? ""),
      resolution: s(i.resolution),
      createdAt: String(i.created_at_server),
    })),
    documents: documents.map((d) => ({
      title: String(d.title),
      type: String(d.document_type),
      visibility: String(d.visibility),
      version: d.current_version_number === null || d.current_version_number === undefined ? null : Number(d.current_version_number),
      publishedAt: String(d.published_at_server),
    })),
    photos: photos.map((m) => ({ publishedAt: String(m.published_at_server), origin: String(m.origin) })),
    finance,
  };
}

// Empreinte des données du rapport (instantané, BR079) : SHA-256 d'une
// sérialisation à clés triées, sans l'identifiant ni l'heure de génération.
export function contentSha256(data: ReportData): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Row)[k])])) : v;
  const { reportId: _r, generatedAt: _g, ...rest } = data;
  void _r;
  void _g;
  return createHash("sha256").update(JSON.stringify(canon(rest))).digest("hex");
}

// ---------------------------------------------------------------------------
// Libellés.
// ---------------------------------------------------------------------------
const PARTY_LABEL: Record<Party, string> = {
  CONTRACTOR: "l'entreprise",
  OWNER_PRIMARY: "le propriétaire principal",
  CO_OWNER: "le copropriétaire",
  SITE_MANAGER: "le chef de chantier",
};
const PHASE_STATUS: Record<string, string> = { PUBLIEE: "Publiée", TERMINEE: "Déclarée terminée", VALIDEE: "Validée", REFUSEE: "Refusée", BROUILLON: "Brouillon" };
const INCIDENT_TYPE: Record<string, string> = { SECURITE: "Sécurité", MALFACON: "Malfaçon ou qualité", RETARD: "Retard", MATERIAUX: "Matériaux", INTEMPERIES: "Intempéries", AUTRE: "Autre" };
const SEVERITY: Record<string, string> = { FAIBLE: "faible", MOYENNE: "moyenne", ELEVEE: "élevée", URGENTE: "urgente" };
const INCIDENT_STATUS: Record<string, string> = { OUVERT: "Ouvert", AFFECTE: "Affecté", EN_COURS: "En cours", RESOLU: "Résolu", CLOS: "Clos", ANNULE: "Annulé" };
const DOC_TYPE: Record<string, string> = { PLAN: "Plan", DEVIS: "Devis", CONTRAT: "Contrat", RECU: "Reçu", FACTURE: "Facture", AUTORISATION: "Autorisation", RAPPORT: "Rapport", PROCES_VERBAL: "Procès-verbal", AUTRE: "Autre" };
const VISIBILITY: Record<string, string> = { TOUS: "tous les membres", PRINCIPAUX: "rôles principaux", ENTREPRISE: "entreprise seulement" };
const ORIGIN: Record<string, string> = { CAPTURED: "prise depuis l'application", IMPORTED: "importée" };
const ADVANCE_STATUS: Record<string, string> = { DECLARED: "déclaré, en attente de confirmation", RECEIVED: "confirmé par les deux parties", DISPUTED: "contesté", CANCELLED: "annulé (contre-écriture)" };
const MODE: Record<string, string> = { ORANGE_MONEY: "Orange Money", MOOV_MONEY: "Moov Money", CASH: "Espèces", BANK: "Virement bancaire", OTHER: "Autre" };
const DECLARER: Record<string, string> = { OWNER_PRIMARY: "le client", CONTRACTOR: "l'entreprise" };

const NBSP = " ";
const PERCENT = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const pct = (v: string | null) => (v === null ? "—" : `${PERCENT.format(Number(v))}${NBSP}%`);
const fcfa = (v: string | null) => (v === null || !/^-?\d+$/.test(v) ? "—" : `${BigInt(v).toLocaleString("fr-FR")}${NBSP}FCFA`);
const dLong = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

// ---------------------------------------------------------------------------
// Rendu PDF (en mémoire seulement).
// ---------------------------------------------------------------------------
type Glyphs = { hasGlyphForCodePoint(cp: number): boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fontkit: { create(buf: Buffer): Glyphs } = require("fontkit");

const FONT_DIR = () => join(process.cwd(), "node_modules", "@fontsource", "noto-sans", "files");
let fontCache: null | { buffers: Record<string, Buffer>; latin: Glyphs; ext: Glyphs } = null;
function fonts() {
  if (!fontCache) {
    const read = (f: string) => readFileSync(join(FONT_DIR(), f));
    const buffers = {
      L: read("noto-sans-latin-400-normal.woff"),
      X: read("noto-sans-latin-ext-400-normal.woff"),
      LB: read("noto-sans-latin-700-normal.woff"),
      XB: read("noto-sans-latin-ext-700-normal.woff"),
    };
    fontCache = { buffers, latin: fontkit.create(buffers.L), ext: fontkit.create(buffers.X) };
  }
  return fontCache;
}

export interface RenderResult {
  bytes: Buffer;
  unsupported: { codePoint: string; count: number }[];
}

export async function renderReportPdf(data: ReportData): Promise<RenderResult> {
  const f = fonts();
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 56, bottom: 64, left: 50, right: 50 },
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: `Rapport de suivi ${data.projectRef} ${data.from} au ${data.to}`, Author: "ChantierLive", Creator: "ChantierLive" },
  });
  doc.registerFont("L", f.buffers.L);
  doc.registerFont("X", f.buffers.X);
  doc.registerFont("LB", f.buffers.LB);
  doc.registerFont("XB", f.buffers.XB);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));

  const unsupported = new Map<string, number>();
  // Découpe un texte en segments selon la police qui couvre chaque caractère ;
  // un caractère non couvert devient « � » et est compté (jamais supprimé).
  const segments = (text: string): { font: "L" | "X"; text: string }[] => {
    const out: { font: "L" | "X"; text: string }[] = [];
    for (const ch of Array.from(text.replace(/\r\n?/g, "\n"))) {
      const cp = ch.codePointAt(0) ?? 0;
      let font: "L" | "X";
      let t = ch;
      if (ch === "\n" || f.latin.hasGlyphForCodePoint(cp)) font = "L";
      else if (f.ext.hasGlyphForCodePoint(cp)) font = "X";
      else {
        font = "L";
        t = "�";
        const key = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
        unsupported.set(key, (unsupported.get(key) ?? 0) + 1);
      }
      const last = out[out.length - 1];
      if (last && last.font === font) last.text += t;
      else out.push({ font, text: t });
    }
    return out;
  };
  const write = (text: string, opts: { size?: number; bold?: boolean; color?: string; gap?: number } = {}) => {
    const segs = segments(text);
    doc.fontSize(opts.size ?? 10).fillColor(opts.color ?? "#1f2933");
    if (segs.length === 0) segs.push({ font: "L", text: " " });
    segs.forEach((seg, i) => {
      doc.font(opts.bold ? (seg.font === "L" ? "LB" : "XB") : seg.font);
      doc.text(seg.text, { continued: i < segs.length - 1, lineGap: 2 });
    });
    if (opts.gap) doc.moveDown(opts.gap);
  };
  const h1 = (t: string) => write(t, { size: 18, bold: true, gap: 0.3 });
  const h2 = (t: string) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 80) doc.addPage();
    doc.moveDown(0.6);
    write(t, { size: 13, bold: true, color: "#0b3954", gap: 0.3 });
  };
  const p = (t: string) => write(t, { size: 10, gap: 0.2 });
  const note = (t: string) => write(t, { size: 9, color: "#52606d", gap: 0.2 });
  const item = (title: string, lines: (string | null)[]) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
    write(title, { size: 10, bold: true });
    for (const l of lines) if (l) write(l, { size: 10 });
    doc.moveDown(0.4);
  };

  // En-tête et mentions obligatoires (D034, BR080, TXT061).
  h1("Rapport de suivi de chantier");
  write(data.projectName, { size: 13, bold: true, gap: 0.2 });
  p(`Période : du ${dLong(data.from)} au ${dLong(data.to)}`);
  p(`Établi pour ${PARTY_LABEL[data.party]}, avec les seules informations que ce rôle voit dans ChantierLive.`);
  p(`Rapport généré le ${stamp(data.generatedAt)} à partir des données synchronisées disponibles.`);
  note(`Identifiant du rapport : ${data.reportId}`);
  note(`Empreinte des données (SHA-256) : ${contentSha256(data)}`);
  note("Outil de suivi : ni expertise, ni certification, ni garantie de conformité. Aucune preuve n'est garantie authentique par ChantierLive.");
  note("Rapport régénéré à chaque demande et jamais conservé par ChantierLive : un rapport généré plus tard peut différer si les données ont changé.");
  note("Police : Noto Sans, The Noto Project Authors, sous licence SIL Open Font License 1.1.");

  // 1. Avancement déclaré.
  h2("Avancement déclaré par l'entreprise");
  if (data.progress.planStatus !== "PUBLIE") p("Avancement pas encore publié.");
  else {
    p(`Avancement déclaré : ${pct(data.progress.declaredPercent)} (moyenne des progressions déclarées, pondérée par le poids de chaque étape ; aucune validation automatique).`);
    for (const ph of data.progress.phases) {
      item(`${ph.position}. ${ph.label}`, [
        `Progression déclarée : ${pct(ph.progression)} · statut : ${PHASE_STATUS[ph.status] ?? ph.status}`,
        ph.declaredCompletedAt ? `Déclarée terminée le ${dLong(ph.declaredCompletedAt)}` : null,
      ]);
    }
  }

  // 2. Avancement validé (jamais fusionné avec le déclaré).
  h2("Avancement validé par le propriétaire principal");
  if (!data.progress.validated.computable) p("Non calculable : aucune étape publiée.");
  else {
    p(
      `Avancement validé : ${pct(data.progress.validated.percent)} — ${data.progress.validated.validatedCount} étape(s) validée(s) sur ${data.progress.validated.applicableCount} étape(s) publiée(s).`,
    );
    const validatedPhases = data.progress.phases.filter((ph) => ph.validatedAt);
    if (validatedPhases.length === 0) p("Aucune étape validée.");
    for (const ph of validatedPhases) p(`${ph.position}. ${ph.label} — validée le ${dLong(String(ph.validatedAt))}`);
  }

  // 3. Journaux publiés.
  h2(`Journaux publiés (${data.logs.length})`);
  if (data.logs.length === 0) p("Aucun journal publié sur la période.");
  for (const l of data.logs) {
    item(`Journal du ${dLong(l.logDate)}${l.version > 1 ? ` (version ${l.version})` : ""}`, [
      `Travaux : ${l.worksDone}`,
      l.difficulties ? `Difficultés : ${l.difficulties}` : null,
      l.team ? `Équipe : ${l.team}` : null,
      l.nextActions ? `Prochaines actions : ${l.nextActions}` : null,
      l.phase ? `Étape : ${l.phase}` : null,
    ]);
  }

  // 4. Incidents.
  h2(`Incidents (${data.incidents.length})`);
  note("Incidents signalés pendant la période, et ceux encore ouverts.");
  if (data.incidents.length === 0) p("Aucun incident.");
  for (const i of data.incidents) {
    item(`${INCIDENT_TYPE[i.type] ?? i.type} — gravité ${SEVERITY[i.severity] ?? i.severity} — ${INCIDENT_STATUS[i.status] ?? i.status}`, [
      `Survenu le ${stamp(i.occurredAt)}`,
      `Description : ${i.description}`,
      i.resolution ? `Résolution : ${i.resolution}` : null,
    ]);
  }

  // 5. Documents partagés visibles du rôle.
  h2(`Documents partagés (${data.documents.length})`);
  note("Documents publiés et en vigueur que vous voyez dans l'application.");
  if (data.documents.length === 0) p("Aucun document partagé.");
  for (const d of data.documents) {
    p(`${d.title} — ${DOC_TYPE[d.type] ?? d.type}${d.version ? `, version ${d.version}` : ""} — visible de : ${VISIBILITY[d.visibility] ?? d.visibility} — publié le ${dLong(d.publishedAt)}`);
  }

  // 6. Photos (liste).
  h2(`Photos publiées (${data.photos.length})`);
  if (data.photos.length === 0) p("Aucune photo publiée sur la période.");
  for (const ph of data.photos) p(`${stamp(ph.publishedAt)} — ${ORIGIN[ph.origin] ?? ph.origin}`);

  // 7. Prix convenu, versements, reste dû (rôles qui les voient).
  if (data.finance) {
    const fin = data.finance;
    h2("Prix convenu, versements et reste dû");
    note("Versements : déclarations entre les parties ; ChantierLive n'encaisse rien et ne garantit aucun paiement.");
    if (fin.contractAmount === null) p("Aucun prix convenu : pas de devis accepté.");
    else {
      p(`Prix convenu : ${fcfa(fin.contractAmount)} (devis accepté ${fcfa(fin.quoteAmount)}, avenants acceptés ${fcfa(fin.changeOrdersAmount)}).`);
      p(`Versements confirmés par les deux parties : ${fcfa(fin.recognized)}. En attente de confirmation : ${fcfa(fin.pending)}. Contestés : ${fcfa(fin.disputed)}.`);
      p(`Reste dû : ${fcfa(fin.remainingDue)}${fin.overpaid && fin.overpaid !== "0" ? ` (trop-versé déclaré : ${fcfa(fin.overpaid)})` : ""}.`);
    }
    if (fin.payments.length === 0) p("Aucun versement déclaré sur la période.");
    for (const pay of fin.payments) {
      p(`${dLong(pay.paymentDate)} — ${fcfa(pay.amount)} — ${MODE[pay.mode] ?? pay.mode} — déclaré par ${DECLARER[pay.declaredRole] ?? pay.declaredRole} — ${ADVANCE_STATUS[pay.status] ?? pay.status}`);
    }
  }

  // Caractères non affichables : signalés, jamais supprimés en silence.
  if (unsupported.size > 0) {
    h2("Remarque sur les caractères");
    p(
      `Certains caractères saisis ne sont pas couverts par la police du rapport et sont remplacés par « � » : ${[...unsupported.entries()]
        .map(([k, n]) => `${k} (${n})`)
        .join(", ")}.`,
    );
  }

  // Pied de page sur chaque page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("L").fontSize(7.5).fillColor("#52606d");
    doc.text(
      `ChantierLive — rapport ${data.reportId.slice(0, 8)} — ${data.projectRef} — du ${data.from} au ${data.to} — généré le ${stamp(data.generatedAt)} — outil de suivi, ni expertise ni certification — page ${i - range.start + 1} / ${range.count}`,
      50,
      doc.page.height - 44,
      { width: doc.page.width - 100, align: "center", lineBreak: true },
    );
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  await done;
  return { bytes: Buffer.concat(chunks), unsupported: [...unsupported.entries()].map(([codePoint, count]) => ({ codePoint, count })) };
}

export function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Génération complète : collecte, rendu en mémoire, trace (auteur seul).
export async function generateReport(client: ReportClient, projectId: string, from: string, to: string) {
  const data = await collectReport(client, projectId, from, to);
  const { bytes, unsupported } = await renderReportPdf(data);
  const contentHash = contentSha256(data);
  const fileHash = fileSha256(bytes);
  await call(client, "report_record_generation", {
    p_report_id: data.reportId,
    p_project_id: projectId,
    p_from: from,
    p_to: to,
    p_generated_at: data.generatedAt,
    p_content_sha256: contentHash,
    p_file_sha256: fileHash,
    p_file_size_bytes: bytes.length,
  });
  return { data, bytes, unsupported, contentHash, fileHash, fileName: reportFileName(data) };
}
