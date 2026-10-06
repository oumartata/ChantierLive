"use client";

import { useRouter } from "next/navigation";

// Changement de chantier dans l'espace entreprise : simple navigation vers
// la page du chantier choisi, dont le serveur revérifie l'accès.
export function ChantierSelector({ currentId, projects }: { currentId: string; projects: { id: string; name: string }[] }) {
  const router = useRouter();
  return (
    <label className="flex flex-col gap-1 text-caption font-semibold text-muted">
      Chantier
      <select
        value={currentId}
        onChange={(e) => router.push(`/entreprise/chantiers/${e.target.value}`)}
        className="w-full rounded-small border border-muted/40 bg-white px-3 py-2 text-body text-ink sm:w-auto"
        data-testid="selecteur-chantier"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
