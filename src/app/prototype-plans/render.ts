import type { Door, Layout, PlacedRoom, WallSide } from "./geometry";

const MARGIN = 70; // px, pour cotes, orientation et libellés
const STAMP = "Avant-projet — à faire vérifier par un professionnel";
// En dessous de ce seuil (m), le libellé complet ne tient pas lisiblement
// dans la pièce : un numéro suffit sur le plan, le détail va dans la légende
// externe (mêmes données `layout.rooms`, aucun calcul séparé).
const SMALL_ROOM_THRESHOLD = 2.2;

export function isSmallRoom(r: PlacedRoom): boolean {
  return r.w < SMALL_ROOM_THRESHOLD || r.d < SMALL_ROOM_THRESHOLD;
}

// Estimation de largeur de texte (sans mesure DOM réelle, impossible dans un
// générateur de chaîne SVG pur) : approximation par nombre de caractères,
// volontairement PESSIMISTE (facteur large) — mieux vaut basculer une pièce
// vers le renvoi numéroté un peu plus tôt que laisser un texte réellement
// coupé. Jamais utilisée pour réduire la police : seulement pour décider
// d'un renvoi vers la légende (voir roomTextFits ci-dessous).
function estimateTextWidth(text: string, fontSizePx: number, bold = false): number {
  return text.length * fontSizePx * (bold ? 0.64 : 0.56);
}

// Une pièce affiche son libellé et ses dimensions EN CLAIR seulement si les
// trois lignes (libellé, dimensions, surface) tiennent réellement dans sa
// largeur au tracé — jamais en réduisant la police pour "faire rentrer"
// un texte qui ne tient pas. Sinon, un simple numéro renvoie à la légende
// (mêmes entrées que legendFor, pour que la légende affichée corresponde
// toujours exactement à ce qui est numéroté sur le dessin).
function roomTextFits(r: PlacedRoom, rwPx: number, rdPx: number): boolean {
  const pad = 10;
  const line1 = estimateTextWidth(`${r.label} ${r.number}`, 11, true);
  const line2 = estimateTextWidth(`${r.w.toFixed(2)} × ${r.d.toFixed(2)} m`, 9);
  const line3 = estimateTextWidth(`${(r.w * r.d).toFixed(1)} m²`, 9);
  const neededHeight = 11 + 9 + 9 + 14; // trois lignes + interlignes approximatifs
  return Math.max(line1, line2, line3) <= rwPx - pad && neededHeight <= rdPx - pad;
}

export interface LegendEntry {
  key: string;
  label: string;
  w: number;
  d: number;
  area: number;
}

// Légende externe — dérivée des MÊMES objets `layout.rooms` que le dessin,
// jamais une liste ou un calcul séparé.
export function legendFor(layout: Layout): LegendEntry[] {
  return layout.rooms
    .filter((r) => !r.parked)
    .filter(isSmallRoom)
    .map((r) => ({ key: `${r.type}-${r.number}`, label: `${r.label} ${r.number}`, w: r.w, d: r.d, area: r.w * r.d }));
}

const ORIENTATION_LABEL: Record<string, string> = { N: "Nord", S: "Sud", E: "Est", O: "Ouest" };

function wallGapLine(x: number, y: number, wall: WallSide, halfWidthPx: number): string {
  // Retourne un segment (en px déjà) représentant l'ouverture (porte/fenêtre)
  // sur le mur indiqué, centré en (x,y).
  if (wall === "left" || wall === "right") {
    return `x1="${x}" y1="${y - halfWidthPx}" x2="${x}" y2="${y + halfWidthPx}"`;
  }
  return `x1="${x - halfWidthPx}" y1="${y}" x2="${x + halfWidthPx}" y2="${y}"`;
}

// Arc du battant, en pixels déjà convertis — "flip" (sens d'ouverture)
// choisit l'AUTRE diagonale du même carré balayé (doorSwingRect, inchangé) :
// jamais un dépassement hors de la pièce, seul le battant visuel change de
// côté.
function doorArc(
  door: Door,
  doorX: number,
  doorY: number,
  doorHalfPx: number,
  doorFullPx: number
): { arcStart: { x: number; y: number }; arcEnd: { x: number; y: number }; sweepFlag: 0 | 1 } {
  const f = door.flip ?? false;
  switch (door.wall) {
    case "right":
      return {
        arcStart: f ? { x: doorX, y: doorY + doorHalfPx } : { x: doorX, y: doorY - doorHalfPx },
        arcEnd: f ? { x: doorX - doorFullPx, y: doorY - doorHalfPx } : { x: doorX - doorFullPx, y: doorY + doorHalfPx },
        sweepFlag: f ? 0 : 1,
      };
    case "left":
      return {
        arcStart: f ? { x: doorX, y: doorY + doorHalfPx } : { x: doorX, y: doorY - doorHalfPx },
        arcEnd: f ? { x: doorX + doorFullPx, y: doorY - doorHalfPx } : { x: doorX + doorFullPx, y: doorY + doorHalfPx },
        sweepFlag: f ? 1 : 0,
      };
    case "top":
      return {
        arcStart: f ? { x: doorX + doorHalfPx, y: doorY } : { x: doorX - doorHalfPx, y: doorY },
        arcEnd: f ? { x: doorX - doorHalfPx, y: doorY + doorFullPx } : { x: doorX + doorHalfPx, y: doorY + doorFullPx },
        sweepFlag: f ? 0 : 1,
      };
    case "bottom":
      return {
        arcStart: f ? { x: doorX + doorHalfPx, y: doorY } : { x: doorX - doorHalfPx, y: doorY },
        arcEnd: f ? { x: doorX - doorHalfPx, y: doorY - doorFullPx } : { x: doorX + doorHalfPx, y: doorY - doorFullPx },
        sweepFlag: f ? 1 : 0,
      };
  }
}

export function renderSvg(layout: Layout, orientation: string, scalePxPerMeter = 26): string {
  const activeRooms = layout.rooms.filter((r) => !r.parked);
  // Légendes BAKED-IN (dans le fichier exporté lui-même, jamais seulement
  // dans la page web autour) : une pièce numérotée sur le dessin ou un
  // espace extérieur au libellé trop long pour tenir en clair reçoivent une
  // entrée ici — mêmes données que le dessin, jamais une liste séparée qui
  // pourrait diverger. Construites ICI (avant le tracé), pas dans les
  // boucles de dessin plus bas, pour pouvoir calculer leur retour à la
  // ligne et la hauteur réservée AVANT d'émettre l'en-tête <svg>.
  const EXT_REFS = ["A", "B", "C", "D", "E", "F"];
  const legendLineHeight = 13;

  const X = (m: number) => MARGIN + m * scalePxPerMeter;
  const Y = (m: number) => MARGIN + m * scalePxPerMeter;
  const w = layout.terrain.w * scalePxPerMeter + MARGIN * 2;

  const roomLegendRaw = activeRooms
    .filter((r) => isSmallRoom(r) || !roomTextFits(r, r.w * scalePxPerMeter, r.d * scalePxPerMeter))
    .map((r) => ({ ref: String(r.number), text: `${r.label} ${r.number} : ${r.w.toFixed(2)} × ${r.d.toFixed(2)} m (${(r.w * r.d).toFixed(1)} m²)` }));
  const extLegendRaw = layout.exteriorSpaces.map((ext, i) => ({
    ref: EXT_REFS[i] ?? `#${i + 1}`,
    text: `${ext.label} — ${(ext.rect.w * ext.rect.d).toFixed(1)} m²`,
  }));

  // Retour à la ligne des entrées de légende trop longues pour la largeur du
  // document — jamais une police réduite : une entrée qui ne tient pas sur
  // une ligne se poursuit sur la suivante. Même estimation pessimiste que
  // roomTextFits (estimateTextWidth) : mieux vaut couper une ligne un peu
  // tôt que laisser un texte réellement tronqué hors du document.
  const maxLegendWidthPx = w - MARGIN - 16;
  function wrapLegendLine(ref: string, text: string): string[] {
    const full = `${ref} — ${text}`;
    if (estimateTextWidth(full, 9) <= maxLegendWidthPx) return [full];
    const words = full.split(" ");
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && estimateTextWidth(candidate, 9) > maxLegendWidthPx) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines;
  }
  const roomLegendLines = roomLegendRaw.map((e) => wrapLegendLine(e.ref, e.text));
  const extLegendLines = extLegendRaw.map((e) => wrapLegendLine(e.ref, e.text));
  const legendLineCount = (entries: string[][]) => entries.reduce((sum, lines) => sum + lines.length, 0);
  const legendBlockHeight = (entries: string[][]) => (entries.length > 0 ? 26 + legendLineCount(entries) * legendLineHeight : 0);
  // Hauteur réservée calculée AVANT le tracé (nécessaire pour la hauteur du
  // canevas) : le nombre de LIGNES (après retour à la ligne) de chaque
  // légende est connu dès ici — jamais un texte ajouté après coup qui
  // déborderait du document.
  const legendsHeight = legendBlockHeight(roomLegendLines) + legendBlockHeight(extLegendLines);

  const h = layout.terrain.d * scalePxPerMeter + MARGIN * 2 + 40 + legendsHeight;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="max-width:100%;height:auto;display:block" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff" />`);

  parts.push(`<rect x="${X(0)}" y="${Y(0)}" width="${layout.terrain.w * scalePxPerMeter}" height="${layout.terrain.d * scalePxPerMeter}" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" />`);
  parts.push(`<text x="${X(0)}" y="${Y(0) - 8}" font-size="11" fill="#64748b">Terrain ${layout.terrain.w.toFixed(2)} × ${layout.terrain.d.toFixed(2)} m</text>`);

  if (layout.emprise) {
    parts.push(`<rect x="${X(layout.emprise.x)}" y="${Y(layout.emprise.y)}" width="${layout.emprise.w * scalePxPerMeter}" height="${layout.emprise.d * scalePxPerMeter}" fill="none" stroke="#0ea5e9" stroke-width="1.5" stroke-dasharray="6 3" />`);
  }

  // Libellé COURT sur le plan (lettre de renvoi + surface seulement) — le
  // texte complet, parfois long ("Espace extérieur non bâti (latéral
  // gauche)"), ne tient pas toujours dans le rectangle qu'il décrit et
  // risquait de déborder hors du document ; renvoyé en légende ci-dessous.
  layout.exteriorSpaces.forEach((ext, i) => {
    const ref = extLegendRaw[i]?.ref ?? `#${i + 1}`;
    const shortLabel = `${ref} — ${(ext.rect.w * ext.rect.d).toFixed(1)} m²`;
    parts.push(`<rect x="${X(ext.rect.x)}" y="${Y(ext.rect.y)}" width="${ext.rect.w * scalePxPerMeter}" height="${ext.rect.d * scalePxPerMeter}" fill="#ecfccb" stroke="#84cc16" stroke-width="1" />`);
    // Ancré à droite de son propre rectangle (jamais au bord du document)
    // quand le placement par défaut à gauche du rectangle déborderait à
    // droite — même estimation pessimiste que la légende ci-dessous.
    const shortLabelX = X(ext.rect.x) + 4;
    const overflowsRight = shortLabelX + estimateTextWidth(shortLabel, 9) > w - 8;
    const labelX = overflowsRight ? X(ext.rect.x) + ext.rect.w * scalePxPerMeter - 4 : shortLabelX;
    parts.push(`<text x="${labelX}" y="${Y(ext.rect.y) + 14}" font-size="9" fill="#3f6212" text-anchor="${overflowsRight ? "end" : "start"}">${escapeXml(shortLabel)}</text>`);
  });

  if (layout.courtyard) {
    parts.push(`<rect x="${X(layout.courtyard.x)}" y="${Y(layout.courtyard.y)}" width="${layout.courtyard.w * scalePxPerMeter}" height="${layout.courtyard.d * scalePxPerMeter}" fill="#fef3c7" stroke="#d97706" stroke-width="1.5" stroke-dasharray="3 2" />`);
    parts.push(`<text x="${X(layout.courtyard.x) + 4}" y="${Y(layout.courtyard.y) + 14}" font-size="9" fill="#92400e">Cour d'entrée (${(layout.courtyard.w * layout.courtyard.d).toFixed(1)} m²)</text>`);
  }
  if (layout.streetDoor) {
    const halfPx = (layout.streetDoor.width * scalePxPerMeter) / 2;
    const sx = X(layout.streetDoor.cx), sy = Y(layout.streetDoor.cy);
    parts.push(`<line ${wallGapLine(sx, sy, layout.streetDoor.wall, halfPx)} stroke="#ffffff" stroke-width="4" />`);
    parts.push(`<text x="${sx - 16}" y="${sy - 8}" font-size="9" font-weight="700" fill="#92400e">Rue</text>`);
  }

  if (layout.corridor) {
    parts.push(`<rect x="${X(layout.corridor.x)}" y="${Y(layout.corridor.y)}" width="${layout.corridor.w * scalePxPerMeter}" height="${layout.corridor.d * scalePxPerMeter}" fill="#fef9c3" stroke="#eab308" stroke-width="1" />`);
    parts.push(`<text x="${X(layout.corridor.x) + 3}" y="${Y(layout.corridor.y) + 12}" font-size="8" fill="#854d0e" transform="rotate(90 ${X(layout.corridor.x) + 3} ${Y(layout.corridor.y) + 12})">Circulation</text>`);
  }
  for (const filler of layout.corridorFillers) {
    parts.push(`<rect x="${X(filler.x)}" y="${Y(filler.y)}" width="${filler.w * scalePxPerMeter}" height="${filler.d * scalePxPerMeter}" fill="#fef9c3" stroke="#eab308" stroke-width="0.5" />`);
  }
  // Espaces de circulation supplémentaires (Layout.circulations) — mêmes
  // données que le corridor historique, dessinées de façon identique :
  // jamais un singleton supposé unique (voir une disposition en L, où ce
  // tableau porte le second segment de circulation).
  for (const extra of layout.circulations ?? []) {
    parts.push(`<rect x="${X(extra.x)}" y="${Y(extra.y)}" width="${extra.w * scalePxPerMeter}" height="${extra.d * scalePxPerMeter}" fill="#fef9c3" stroke="#eab308" stroke-width="1" />`);
  }
  // Trajet(s) extérieur(s) réel(s) (Layout.exteriorPaths) reliant l'entrée
  // au bâti — couleur et pointillé distincts de la circulation intérieure :
  // jamais confondu avec elle au premier coup d'oeil, même si les deux
  // comptent pour l'accessibilité du graphe.
  for (const path of layout.exteriorPaths ?? []) {
    parts.push(
      `<rect x="${X(path.x)}" y="${Y(path.y)}" width="${path.w * scalePxPerMeter}" height="${path.d * scalePxPerMeter}" fill="#dcfce7" stroke="#16a34a" stroke-width="1" stroke-dasharray="4 2" />`
    );
    parts.push(`<text x="${X(path.x) + 3}" y="${Y(path.y) + 10}" font-size="7" fill="#166534">Chemin d&apos;entrée</text>`);
  }

  // Une pièce mise de côté (zone de rangement) n'occupe aucune place réelle
  // sur le terrain tant qu'elle n'est pas replacée — jamais dessinée ici.
  layout.rooms.forEach((r, roomIndex) => {
    if (r.parked) return;
    const roomDoors = layout.doors.filter((d) => d.roomIndex === roomIndex);
    const roomWindows = layout.windows.filter((wn) => wn.roomIndex === roomIndex);
    const rx = X(r.x), ry = Y(r.y), rw = r.w * scalePxPerMeter, rd = r.d * scalePxPerMeter;
    parts.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rd}" fill="#e2e8f0" stroke="#1e293b" stroke-width="2" />`);

    // Renvoi numéroté (jamais une police réduite pour forcer le texte en
    // clair à tenir) dès que la pièce est petite OU que les trois lignes
    // (libellé, dimensions, surface) ne tiennent pas réellement à l'échelle
    // actuelle — même critère que roomLegendRaw ci-dessus, pour que la
    // légende corresponde toujours exactement à ce qui est numéroté ici.
    const useBadge = isSmallRoom(r) || !roomTextFits(r, rw, rd);
    const cx = rx + rw / 2, cy = ry + rd / 2;
    if (useBadge) {
      // Entrée déjà construite dans roomLegendRaw (même filtre ci-dessus,
      // avant le tracé) : jamais reconstruite ici, pour qu'elle ne puisse
      // pas diverger de la hauteur déjà réservée pour le canevas.
      parts.push(`<circle cx="${cx}" cy="${cy}" r="11" fill="#ffffff" stroke="#1e293b" stroke-width="1.5" />`);
      parts.push(`<text x="${cx}" y="${cy + 4}" font-size="11" font-weight="700" fill="#0f172a" text-anchor="middle">${r.number}</text>`);
    } else {
      // Trois lignes distinctes (jamais "W × D m — surface m²" sur une seule
      // ligne, trop large pour une pièce étroite) : libellé, dimensions,
      // surface — chacune revérifiée tenir par roomTextFits ci-dessus.
      parts.push(`<text x="${cx}" y="${cy - 12}" font-size="11" font-weight="600" fill="#0f172a" text-anchor="middle">${escapeXml(r.label)} ${r.number}</text>`);
      parts.push(`<text x="${cx}" y="${cy + 2}" font-size="9" fill="#334155" text-anchor="middle">${r.w.toFixed(2)} × ${r.d.toFixed(2)} m</text>`);
      parts.push(`<text x="${cx}" y="${cy + 14}" font-size="9" fill="#334155" text-anchor="middle">${(r.w * r.d).toFixed(1)} m²</text>`);
    }

    // Fenêtres INDÉPENDANTES : chacune son propre trait, sur son propre mur —
    // sauf si une porte occupe déjà ce même mur (entrée extérieure) : les
    // deux ne se superposent jamais visuellement.
    if (roomWindows.length === 0 && !r.exteriorWall) {
      parts.push(`<text x="${cx}" y="${ry + rd - 6}" font-size="8" fill="#b91c1c" text-anchor="middle">⚠ aucune ouverture extérieure</text>`);
    }
    for (const win of roomWindows) {
      const doorOnSameWall = roomDoors.some((d) => d.wall === win.wall && d.to.kind === "exterior");
      if (doorOnSameWall) continue;
      const wHalfPx = (win.width * scalePxPerMeter) / 2;
      const wx = X(win.cx), wy = Y(win.cy);
      const vertical = win.wall === "left" || win.wall === "right";
      parts.push(
        vertical
          ? `<line x1="${wx}" y1="${wy - wHalfPx}" x2="${wx}" y2="${wy + wHalfPx}" stroke="#0284c7" stroke-width="4" />`
          : `<line x1="${wx - wHalfPx}" y1="${wy}" x2="${wx + wHalfPx}" y2="${wy}" stroke="#0284c7" stroke-width="4" />`
      );
    }

    // Portes — plusieurs possibles par pièce. Ouverture dans le mur +
    // arc de battant. Le carré balayé (voir doorArc ci-dessous) est le MÊME
    // que doorSwingRect (geometry.ts), utilisé par la vérification
    // indépendante — jamais un second calcul qui pourrait diverger du
    // premier. Aucune porte : mur fermé, jamais une baie fantôme dessinée.
    if (roomDoors.length === 0) {
      parts.push(`<text x="${cx}" y="${ry + rd / 2 + 20}" font-size="8" fill="#b91c1c" text-anchor="middle">⚠ aucune porte</text>`);
    }
    for (const d of roomDoors) {
      const doorHalfPx = (d.width * scalePxPerMeter) / 2;
      const doorFullPx = doorHalfPx * 2;
      const doorX = X(d.cx), doorY = Y(d.cy);
      parts.push(`<line ${wallGapLine(doorX, doorY, d.wall, doorHalfPx)} stroke="#ffffff" stroke-width="3" />`);
      const { arcStart, arcEnd, sweepFlag } = doorArc(d, doorX, doorY, doorHalfPx, doorFullPx);
      parts.push(
        `<path d="M ${arcStart.x} ${arcStart.y} A ${doorFullPx} ${doorFullPx} 0 0 ${sweepFlag} ${arcEnd.x} ${arcEnd.y}" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 2" />`
      );
      // Distingue explicitement le type de porte — un simple contact visuel
      // entre deux pièces, ou avec le mur extérieur, ne suffit pas à le
      // montrer ; la mention le rend sans ambiguïté. Jamais une porte
      // intérieure confondue avec une entrée extérieure.
      const doorLabel = d.to.kind === "exterior" ? "entrée extérieure" : d.to.kind === "courtyard" ? "accès cour" : d.to.kind === "room" ? "porte intérieure" : null;
      if (doorLabel) {
        const labelX = d.wall === "right" ? doorX - 6 : doorX + 6;
        const labelColor = d.to.kind === "exterior" || d.to.kind === "courtyard" ? "#16a34a" : "#7c3aed";
        parts.push(`<text x="${labelX}" y="${doorY}" font-size="7" fill="${labelColor}" text-anchor="${d.wall === "right" ? "end" : "start"}">${doorLabel}</text>`);
      }
    }

    // Accès véhicule (garage) : ouverture large distincte, jamais confondue
    // avec une porte piétonne intérieure.
    if (r.vehicleDoor) {
      const vHalfPx = (r.vehicleDoor.width * scalePxPerMeter) / 2;
      const vx = X(r.vehicleDoor.cx), vy = Y(r.vehicleDoor.cy);
      parts.push(`<line ${wallGapLine(vx, vy, r.vehicleDoor.wall, vHalfPx)} stroke="#ffffff" stroke-width="5" />`);
      parts.push(`<line ${wallGapLine(vx, vy, r.vehicleDoor.wall, vHalfPx)} stroke="#7c2d12" stroke-width="1.5" stroke-dasharray="4 2" />`);
      const vLabelDy = r.vehicleDoor.wall === "top" ? -6 : r.vehicleDoor.wall === "bottom" ? 14 : 0;
      parts.push(`<text x="${vx}" y="${vy + vLabelDy}" font-size="8" fill="#7c2d12" text-anchor="middle">Accès véhicule — ${r.vehicleDoor.width.toFixed(2)} m dégagés</text>`);
    }
  });

  // Entrée
  if (layout.entryDoor) {
    const halfPx = (layout.entryDoor.width * scalePxPerMeter) / 2;
    const ex = X(layout.entryDoor.cx), ey = Y(layout.entryDoor.cy);
    parts.push(`<line ${wallGapLine(ex, ey, layout.entryDoor.wall, halfPx)} stroke="#ffffff" stroke-width="4" />`);
    // Mur "right" : le libellé grandit vers l'INTÉRIEUR du terrain (ancrage
    // à droite, décalage négatif), jamais vers la droite du document où il
    // ne reste que la marge (MARGIN=70px, bien plus étroite que le texte) —
    // sans ce changement d'ancrage, "Entrée (limite constructible)" dépasse
    // le bord droit du SVG/PNG exporté. Mur "left" : symétrique, grandit
    // déjà vers l'intérieur avec l'ancrage par défaut, inchangé.
    const entryWall = layout.entryDoor.wall;
    const labelDx = entryWall === "left" ? -55 : entryWall === "right" ? -15 : -20;
    const labelDy = entryWall === "top" ? -8 : entryWall === "bottom" ? 16 : 4;
    const labelAnchor = entryWall === "right" ? "end" : "start";
    // "Entrée (limite constructible)" — jamais "portail de parcelle" :
    // entryDoor marque le seuil de l'EMPRISE (terrain moins reculs), pas la
    // limite réelle du terrain ni un portail sur rue, qu'aucun trajet ne
    // modélise au-delà de ce seuil.
    parts.push(`<text x="${ex + labelDx}" y="${ey + labelDy}" font-size="9" font-weight="700" fill="#15803d" text-anchor="${labelAnchor}">Entrée (limite constructible)</text>`);
    parts.push(`<circle cx="${ex}" cy="${ey}" r="4" fill="#15803d" />`);
  }

  // Cotes terrain
  parts.push(dimensionLine(X(0), Y(0) - 24, X(layout.terrain.w), Y(0) - 24, `${layout.terrain.w.toFixed(2)} m`));
  parts.push(dimensionLine(X(0) - 24, Y(0), X(0) - 24, Y(layout.terrain.d), `${layout.terrain.d.toFixed(2)} m`, true));

  // Légendes bâties dans le document exporté lui-même (jamais seulement dans
  // la page web autour, un export SVG/PNG doit rester lisible isolément) —
  // dérivées des mêmes `roomLegendRaw`/`extLegendRaw` (donc `roomLegendLines`/
  // `extLegendLines`) construits avant le tracé ci-dessus, jamais une liste
  // recalculée séparément qui pourrait diverger de ce qui est réellement
  // numéroté/référencé sur le plan.
  let legendY = Y(layout.terrain.d) + 24;
  if (roomLegendLines.length > 0) {
    parts.push(`<text x="${X(0)}" y="${legendY}" font-size="10" font-weight="700" fill="#334155">Légende — pièces numérotées</text>`);
    legendY += legendLineHeight;
    for (const lines of roomLegendLines) {
      for (const line of lines) {
        parts.push(`<text x="${X(0)}" y="${legendY}" font-size="9" fill="#334155">${escapeXml(line)}</text>`);
        legendY += legendLineHeight;
      }
    }
    legendY += 6;
  }
  if (extLegendLines.length > 0) {
    parts.push(`<text x="${X(0)}" y="${legendY}" font-size="10" font-weight="700" fill="#3f6212">Légende — espaces extérieurs</text>`);
    legendY += legendLineHeight;
    for (const lines of extLegendLines) {
      for (const line of lines) {
        parts.push(`<text x="${X(0)}" y="${legendY}" font-size="9" fill="#3f6212">${escapeXml(line)}</text>`);
        legendY += legendLineHeight;
      }
    }
  }

  // Orientation (indicative, saisie par l'utilisateur — pas une boussole réelle)
  const oCx = w - 36, oCy = 30;
  parts.push(`<circle cx="${oCx}" cy="${oCy}" r="18" fill="#ffffff" stroke="#64748b" stroke-width="1" />`);
  parts.push(`<line x1="${oCx}" y1="${oCy + 12}" x2="${oCx}" y2="${oCy - 12}" stroke="#334155" stroke-width="1.5" marker-end="url(#arrow)" />`);
  parts.push(`<text x="${oCx}" y="${oCy - 16}" font-size="9" fill="#334155" text-anchor="middle">${orientation}</text>`);
  parts.push(`<text x="${oCx}" y="${oCy + 30}" font-size="8" fill="#64748b" text-anchor="middle">${ORIENTATION_LABEL[orientation] ?? orientation} (indicatif)</text>`);
  parts.push(`<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#334155" /></marker></defs>`);

  parts.push(`<text x="${w / 2}" y="${h - 14}" font-size="11" fill="#b91c1c" text-anchor="middle" font-weight="600">${escapeXml(STAMP)}</text>`);

  parts.push(`</svg>`);
  return parts.join("");
}

function dimensionLine(x1: number, y1: number, x2: number, y2: number, label: string, vertical = false): string {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const textTransform = vertical ? `transform="rotate(-90 ${midX} ${midY})"` : "";
  return `<g stroke="#475569" stroke-width="1">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
    <line x1="${x1}" y1="${y1 - 3}" x2="${x1}" y2="${y1 + 3}" />
    <line x1="${x2}" y1="${y2 - 3}" x2="${x2}" y2="${y2 + 3}" />
  </g><text x="${midX}" y="${midY - 4}" font-size="10" fill="#334155" text-anchor="middle" ${textTransform}>${escapeXml(label)}</text>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { escapeXml, STAMP };
