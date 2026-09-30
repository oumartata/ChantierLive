import type { Layout, PlacedRoom, WallSide } from "./geometry";

const MARGIN = 70; // px, pour cotes, orientation et libellés
const STAMP = "Avant-projet — à faire vérifier par un professionnel";
// En dessous de ce seuil (m), le libellé complet ne tient pas lisiblement
// dans la pièce : un numéro suffit sur le plan, le détail va dans la légende
// externe (mêmes données `layout.rooms`, aucun calcul séparé).
const SMALL_ROOM_THRESHOLD = 2.2;

export function isSmallRoom(r: PlacedRoom): boolean {
  return r.w < SMALL_ROOM_THRESHOLD || r.d < SMALL_ROOM_THRESHOLD;
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

export function renderSvg(layout: Layout, orientation: string, scalePxPerMeter = 26): string {
  const w = layout.terrain.w * scalePxPerMeter + MARGIN * 2;
  const h = layout.terrain.d * scalePxPerMeter + MARGIN * 2 + 40;

  const X = (m: number) => MARGIN + m * scalePxPerMeter;
  const Y = (m: number) => MARGIN + m * scalePxPerMeter;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="max-width:100%;height:auto;display:block" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff" />`);

  parts.push(`<rect x="${X(0)}" y="${Y(0)}" width="${layout.terrain.w * scalePxPerMeter}" height="${layout.terrain.d * scalePxPerMeter}" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" />`);
  parts.push(`<text x="${X(0)}" y="${Y(0) - 8}" font-size="11" fill="#64748b">Terrain ${layout.terrain.w.toFixed(2)} × ${layout.terrain.d.toFixed(2)} m</text>`);

  if (layout.emprise) {
    parts.push(`<rect x="${X(layout.emprise.x)}" y="${Y(layout.emprise.y)}" width="${layout.emprise.w * scalePxPerMeter}" height="${layout.emprise.d * scalePxPerMeter}" fill="none" stroke="#0ea5e9" stroke-width="1.5" stroke-dasharray="6 3" />`);
  }

  for (const ext of layout.exteriorSpaces) {
    parts.push(`<rect x="${X(ext.rect.x)}" y="${Y(ext.rect.y)}" width="${ext.rect.w * scalePxPerMeter}" height="${ext.rect.d * scalePxPerMeter}" fill="#ecfccb" stroke="#84cc16" stroke-width="1" />`);
    parts.push(`<text x="${X(ext.rect.x) + 4}" y="${Y(ext.rect.y) + 14}" font-size="9" fill="#3f6212">${escapeXml(ext.label)} (${(ext.rect.w * ext.rect.d).toFixed(1)} m²)</text>`);
  }

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

  for (const r of layout.rooms) {
    const rx = X(r.x), ry = Y(r.y), rw = r.w * scalePxPerMeter, rd = r.d * scalePxPerMeter;
    parts.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rd}" fill="#e2e8f0" stroke="#1e293b" stroke-width="2" />`);

    const small = r.w < SMALL_ROOM_THRESHOLD || r.d < SMALL_ROOM_THRESHOLD;
    const cx = rx + rw / 2, cy = ry + rd / 2;
    if (small) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="11" fill="#ffffff" stroke="#1e293b" stroke-width="1.5" />`);
      parts.push(`<text x="${cx}" y="${cy + 4}" font-size="11" font-weight="700" fill="#0f172a" text-anchor="middle">${r.number}</text>`);
    } else {
      parts.push(`<text x="${cx}" y="${cy - 6}" font-size="11" font-weight="600" fill="#0f172a" text-anchor="middle">${escapeXml(r.label)} ${r.number}</text>`);
      parts.push(`<text x="${cx}" y="${cy + 9}" font-size="9" fill="#334155" text-anchor="middle">${r.w.toFixed(2)} × ${r.d.toFixed(2)} m — ${(r.w * r.d).toFixed(1)} m²</text>`);
    }

    // Fenêtre : trait bleu double sur le mur extérieur réel de la pièce.
    if (r.exteriorWall) {
      const wallX = r.exteriorWall === "left" ? rx : rx + rw;
      parts.push(`<line x1="${wallX}" y1="${ry + rd * 0.25}" x2="${wallX}" y2="${ry + rd * 0.75}" stroke="#0284c7" stroke-width="4" />`);
    } else {
      parts.push(`<text x="${cx}" y="${ry + rd - 6}" font-size="8" fill="#b91c1c" text-anchor="middle">⚠ aucune ouverture extérieure</text>`);
    }

    // Porte : ouverture dans le mur intérieur (corridor) + arc de battant.
    const doorHalfPx = (r.door.width * scalePxPerMeter) / 2;
    const doorX = X(r.door.cx), doorY = Y(r.door.cy);
    parts.push(`<line ${wallGapLine(doorX, doorY, r.door.wall, doorHalfPx)} stroke="#ffffff" stroke-width="3" />`);
    const hinge = r.door.wall === "right" ? { x: doorX, y: doorY - doorHalfPx } : { x: doorX, y: doorY - doorHalfPx };
    const sweepFlag = r.door.wall === "right" ? 1 : 0;
    parts.push(
      `<path d="M ${hinge.x} ${hinge.y} A ${doorHalfPx * 2} ${doorHalfPx * 2} 0 0 ${sweepFlag} ${hinge.x + (r.door.wall === "right" ? -doorHalfPx * 2 : doorHalfPx * 2)} ${hinge.y + doorHalfPx * 2}" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 2" />`
    );
    // Distingue explicitement un accès direct au salon d'un accès par le
    // dégagement (corridor) — un simple contact visuel entre deux pièces ne
    // suffit pas à le montrer, la mention le rend sans ambiguïté.
    if (r.connectsTo === "salon") {
      const labelX = r.door.wall === "right" ? doorX - 6 : doorX + 6;
      parts.push(`<text x="${labelX}" y="${doorY}" font-size="7" fill="#7c3aed" text-anchor="${r.door.wall === "right" ? "end" : "start"}">accès direct</text>`);
    }

    // Accès véhicule (garage) : ouverture large distincte, jamais confondue
    // avec une porte piétonne intérieure.
    if (r.vehicleDoor) {
      const vHalfPx = (r.vehicleDoor.width * scalePxPerMeter) / 2;
      const vx = X(r.vehicleDoor.cx), vy = Y(r.vehicleDoor.cy);
      parts.push(`<line ${wallGapLine(vx, vy, r.vehicleDoor.wall, vHalfPx)} stroke="#ffffff" stroke-width="5" />`);
      parts.push(`<line ${wallGapLine(vx, vy, r.vehicleDoor.wall, vHalfPx)} stroke="#7c2d12" stroke-width="1.5" stroke-dasharray="4 2" />`);
      const vLabelDy = r.vehicleDoor.wall === "top" ? -6 : r.vehicleDoor.wall === "bottom" ? 14 : 0;
      parts.push(`<text x="${vx}" y="${vy + vLabelDy}" font-size="8" fill="#7c2d12" text-anchor="middle">Accès véhicule</text>`);
    }
  }

  // Entrée
  if (layout.entryDoor) {
    const halfPx = (layout.entryDoor.width * scalePxPerMeter) / 2;
    const ex = X(layout.entryDoor.cx), ey = Y(layout.entryDoor.cy);
    parts.push(`<line ${wallGapLine(ex, ey, layout.entryDoor.wall, halfPx)} stroke="#ffffff" stroke-width="4" />`);
    const labelDx = layout.entryDoor.wall === "left" ? -55 : layout.entryDoor.wall === "right" ? 15 : -20;
    const labelDy = layout.entryDoor.wall === "top" ? -8 : layout.entryDoor.wall === "bottom" ? 16 : 4;
    parts.push(`<text x="${ex + labelDx}" y="${ey + labelDy}" font-size="10" font-weight="700" fill="#15803d">Entrée</text>`);
    parts.push(`<circle cx="${ex}" cy="${ey}" r="4" fill="#15803d" />`);
  }

  // Cotes terrain
  parts.push(dimensionLine(X(0), Y(0) - 24, X(layout.terrain.w), Y(0) - 24, `${layout.terrain.w.toFixed(2)} m`));
  parts.push(dimensionLine(X(0) - 24, Y(0), X(0) - 24, Y(layout.terrain.d), `${layout.terrain.d.toFixed(2)} m`, true));

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

export { STAMP };
