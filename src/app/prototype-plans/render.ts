import type { Layout } from "./geometry";

const MARGIN = 60; // px, pour cotes et libellés
const STAMP = "Avant-projet — à faire vérifier par un professionnel";

// Rendu SVG — SEULE source de vérité graphique. Le tableau de surfaces
// affiché dans l'UI lit les mêmes champs `layout.surfaces` / `layout.rooms`
// que ce rendu, jamais un calcul recalculé séparément : dessin, cotes et
// surfaces proviennent donc toujours exactement des mêmes données.
export function renderSvg(layout: Layout, scalePxPerMeter = 22): string {
  const w = layout.terrain.w * scalePxPerMeter + MARGIN * 2;
  const h = layout.terrain.d * scalePxPerMeter + MARGIN * 2 + 40; // +40 pour le tampon en bas

  const X = (m: number) => MARGIN + m * scalePxPerMeter;
  const Y = (m: number) => MARGIN + m * scalePxPerMeter;

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="max-width:100%;height:auto;display:block" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">`
  );
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff" />`);

  // Terrain
  parts.push(
    `<rect x="${X(0)}" y="${Y(0)}" width="${layout.terrain.w * scalePxPerMeter}" height="${
      layout.terrain.d * scalePxPerMeter
    }" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" />`
  );
  parts.push(
    `<text x="${X(0)}" y="${Y(0) - 8}" font-size="11" fill="#64748b">Terrain ${layout.terrain.w.toFixed(2)} × ${layout.terrain.d.toFixed(2)} m</text>`
  );

  if (layout.emprise) {
    parts.push(
      `<rect x="${X(layout.emprise.x)}" y="${Y(layout.emprise.y)}" width="${
        layout.emprise.w * scalePxPerMeter
      }" height="${layout.emprise.d * scalePxPerMeter}" fill="none" stroke="#0ea5e9" stroke-width="1.5" stroke-dasharray="6 3" />`
    );
  }

  // Espaces extérieurs
  for (const ext of layout.exteriorSpaces) {
    parts.push(
      `<rect x="${X(ext.rect.x)}" y="${Y(ext.rect.y)}" width="${ext.rect.w * scalePxPerMeter}" height="${
        ext.rect.d * scalePxPerMeter
      }" fill="#ecfccb" stroke="#84cc16" stroke-width="1" />`
    );
    parts.push(
      `<text x="${X(ext.rect.x) + 4}" y="${Y(ext.rect.y) + 14}" font-size="9" fill="#3f6212">${escapeXml(ext.label)} (${(ext.rect.w * ext.rect.d).toFixed(1)} m², accès : ${escapeXml(ext.accessFrom)})</text>`
    );
  }

  // Circulation (une bande par rangée de pièces)
  for (const corridor of layout.corridors) {
    parts.push(
      `<rect x="${X(corridor.x)}" y="${Y(corridor.y)}" width="${corridor.w * scalePxPerMeter}" height="${
        corridor.d * scalePxPerMeter
      }" fill="#fef9c3" stroke="#eab308" stroke-width="1" />`
    );
    parts.push(`<text x="${X(corridor.x) + 4}" y="${Y(corridor.y) + 14}" font-size="9" fill="#854d0e">Circulation</text>`);
  }

  // Pièces
  for (const r of layout.rooms) {
    parts.push(
      `<rect x="${X(r.x)}" y="${Y(r.y)}" width="${r.w * scalePxPerMeter}" height="${
        r.d * scalePxPerMeter
      }" fill="#e2e8f0" stroke="#1e293b" stroke-width="2" />`
    );
    const cx = X(r.x) + (r.w * scalePxPerMeter) / 2;
    const cy = Y(r.y) + (r.d * scalePxPerMeter) / 2;
    parts.push(`<text x="${cx}" y="${cy - 6}" font-size="11" font-weight="600" fill="#0f172a" text-anchor="middle">${escapeXml(r.label)}</text>`);
    parts.push(
      `<text x="${cx}" y="${cy + 9}" font-size="9" fill="#334155" text-anchor="middle">${r.w.toFixed(2)} × ${r.d.toFixed(2)} m — ${(r.w * r.d).toFixed(1)} m²</text>`
    );
    // Porte : petit arc sur le côté touchant la circulation.
    if (r.doorOk && layout.corridors.length > 0) {
      const doorX = X(r.x) + (r.w * scalePxPerMeter) / 2 - 12;
      const doorY = Y(r.y + r.d);
      parts.push(`<line x1="${doorX}" y1="${doorY}" x2="${doorX + 24}" y2="${doorY}" stroke="#ffffff" stroke-width="3" />`);
    }
    if (!r.hasExteriorWall) {
      parts.push(
        `<text x="${cx}" y="${cy + 22}" font-size="8" fill="#b91c1c" text-anchor="middle">⚠ aucune ouverture extérieure</text>`
      );
    }
  }

  // Cote largeur terrain (en haut)
  parts.push(dimensionLine(X(0), Y(0) - 24, X(layout.terrain.w), Y(0) - 24, `${layout.terrain.w.toFixed(2)} m`));
  // Cote profondeur terrain (à gauche)
  parts.push(dimensionLine(X(0) - 24, Y(0), X(0) - 24, Y(layout.terrain.d), `${layout.terrain.d.toFixed(2)} m`, true));

  // Tampon "avant-projet" — gravé dans le SVG exporté, pas seulement affiché dans l'UI.
  parts.push(
    `<text x="${w / 2}" y="${h - 14}" font-size="11" fill="#b91c1c" text-anchor="middle" font-weight="600">${escapeXml(STAMP)}</text>`
  );

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
