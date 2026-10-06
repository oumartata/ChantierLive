// F2 — autorisations d'adaptation des dimensions, côté plan (2026-10-06).
// Fonctions PURES sur le plan (jamais de mutation de l'argument) ; la
// recherche elle-même est regenerateWithAllowances (geometry.ts).
//
// Règles :
// - aucune autorisation par défaut ; seule une confirmation explicite en
//   crée (confirmAllowances) ;
// - la référence d'une pièce = ses dimensions au moment de l'accord ; elle
//   est CONSERVÉE après le choix d'un résultat adapté (applyAdaptedProposal
//   ne met à jour que les dimensions connues `confirmedW/D`) ;
// - une modification manuelle des dimensions, une mise de côté ou une pièce
//   qui n'est plus la même rend l'autorisation « à reconfirmer » ; une pièce
//   verrouillée est « exclue » ; seules les autorisations « valides »
//   alimentent la recherche — jamais d'élargissement silencieux ;
// - les minima du moteur sont un plancher technique, jamais un accord.
import { cloneLayout, validateDimensionAllowances, type DimensionAllowance, type Layout, type PlacedRoom, type StoredDimensionAllowance } from "./geometry";

const EPS = 1e-6;

export function roomKeyOf(room: PlacedRoom): string {
  return `${room.type}|${room.label}|${room.number}`;
}

export type AllowanceStatus =
  | { kind: "valide" }
  | { kind: "a_reconfirmer"; reason: string }
  | { kind: "exclue"; reason: string };

export interface AllowanceState {
  entry: StoredDimensionAllowance;
  status: AllowanceStatus;
}

export function allowanceStates(layout: Layout): AllowanceState[] {
  return (layout.dimensionAllowances ?? []).map((entry) => {
    const room = layout.rooms[entry.roomIndex];
    if (!room || roomKeyOf(room) !== entry.roomKey) return { entry, status: { kind: "a_reconfirmer", reason: "la pièce autorisée n'existe plus ou a changé" } };
    if (room.parked) return { entry, status: { kind: "a_reconfirmer", reason: "pièce mise de côté" } };
    if (room.locked) return { entry, status: { kind: "exclue", reason: "pièce verrouillée — jamais adaptée tant qu'elle l'est" } };
    if (Math.abs(room.w - entry.confirmedW) > EPS || Math.abs(room.d - entry.confirmedD) > EPS) {
      return { entry, status: { kind: "a_reconfirmer", reason: "dimensions modifiées depuis l'accord" } };
    }
    return { entry, status: { kind: "valide" } };
  });
}

// Autorisations transmises à la recherche : seulement les valides, et
// TOUJOURS depuis la référence enregistrée (jamais depuis les dimensions
// actuelles, éventuellement déjà réduites).
export function engineAllowances(layout: Layout): DimensionAllowance[] {
  return allowanceStates(layout)
    .filter((s) => s.status.kind === "valide")
    .map(({ entry }) => ({
      roomIndex: entry.roomIndex,
      referenceW: entry.referenceW,
      referenceD: entry.referenceD,
      ...(entry.minW !== null ? { minW: entry.minW } : {}),
      ...(entry.minD !== null ? { minD: entry.minD } : {}),
    }));
}

export interface AllowanceInput {
  roomIndex: number;
  // Bornes saisies (m) ; null = dimension non autorisée.
  minW: number | null;
  minD: number | null;
}

// Confirme EXPLICITEMENT un ensemble d'autorisations. Les pièces non listées
// (ou listées sans aucune borne) n'en ont plus. Référence : celle de
// l'autorisation encore VALIDE de la pièce si elle existe (référence
// stable), sinon ses dimensions actuelles. Toute autorisation invalide est
// refusée avec le motif du moteur (validateDimensionAllowances), jamais
// corrigée.
export function confirmAllowances(layout: Layout, inputs: AllowanceInput[], now: string): { ok: true; layout: Layout } | { ok: false; reason: string } {
  const states = new Map(allowanceStates(layout).map((s) => [s.entry.roomIndex, s]));
  const entries: StoredDimensionAllowance[] = [];
  for (const input of inputs) {
    if (input.minW === null && input.minD === null) continue;
    const room = layout.rooms[input.roomIndex];
    if (!room) return { ok: false, reason: `Pièce n° ${input.roomIndex} introuvable.` };
    const previous = states.get(input.roomIndex);
    const keep = previous && previous.status.kind === "valide";
    entries.push({
      roomIndex: input.roomIndex,
      roomKey: roomKeyOf(room),
      referenceW: keep ? previous.entry.referenceW : room.w,
      referenceD: keep ? previous.entry.referenceD : room.d,
      minW: input.minW,
      minD: input.minD,
      confirmedW: room.w,
      confirmedD: room.d,
      confirmedAt: now,
    });
  }
  if (entries.length === 0) return { ok: false, reason: "Aucune borne saisie : rien à autoriser (utilisez « Révoquer » pour retirer les autorisations)." };
  const invalid = validateDimensionAllowances(layout, {
    allowances: entries.map((e) => ({ roomIndex: e.roomIndex, referenceW: e.referenceW, referenceD: e.referenceD, ...(e.minW !== null ? { minW: e.minW } : {}), ...(e.minD !== null ? { minD: e.minD } : {}) })),
  });
  if (invalid) return { ok: false, reason: invalid };
  const next = cloneLayout(layout);
  next.dimensionAllowances = entries;
  return { ok: true, layout: next };
}

// Révoque toutes les autorisations, ou celle d'une seule pièce.
export function revokeAllowances(layout: Layout, roomIndex?: number): Layout {
  const next = cloneLayout(layout);
  const kept = roomIndex === undefined ? [] : (next.dimensionAllowances ?? []).filter((a) => a.roomIndex !== roomIndex);
  if (kept.length === 0) delete next.dimensionAllowances;
  else next.dimensionAllowances = kept;
  return next;
}

// Plan à enregistrer quand l'utilisateur CHOISIT une proposition adaptée :
// la géométrie de la proposition, les autorisations du plan courant avec la
// MÊME référence et les mêmes bornes, seules les dimensions connues étant
// mises à jour pour les autorisations valides (les autres gardent leur
// statut).
export function applyAdaptedProposal(current: Layout, proposal: Layout): Layout {
  const next = cloneLayout(proposal);
  const states = allowanceStates(current);
  if (states.length === 0) {
    delete next.dimensionAllowances;
    return next;
  }
  next.dimensionAllowances = states.map(({ entry, status }) => {
    if (status.kind !== "valide") return { ...entry };
    const r = next.rooms[entry.roomIndex];
    return { ...entry, confirmedW: r.w, confirmedD: r.d };
  });
  return next;
}

// Plan à enregistrer pour une proposition ORDINAIRE (sans réduction) : la
// géométrie de la proposition et les autorisations du plan courant
// inchangées (les dimensions des pièces ne changent pas).
export function applyOrdinaryProposal(current: Layout, proposal: Layout): Layout {
  const next = cloneLayout(proposal);
  if (current.dimensionAllowances && current.dimensionAllowances.length > 0) next.dimensionAllowances = current.dimensionAllowances.map((a) => ({ ...a }));
  else delete next.dimensionAllowances;
  return next;
}
