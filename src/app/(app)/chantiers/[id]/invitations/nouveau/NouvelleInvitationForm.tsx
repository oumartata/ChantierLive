"use client";

import { useActionState, useState } from "react";
import { Button, TextField, AlertBanner, Card } from "@/components/ui";
import { createInvitation, type CreateInvitationState } from "../actions";

export interface NouvelleInvitationFormProps {
  projectId: string;
  emitterRole: "OWNER" | "CONTRACTOR";
}

const ROLE_CHOICES: Record<
  "OWNER" | "CONTRACTOR",
  { value: string; label: string }[]
> = {
  // p_role="OWNER" ici propose un CO_OWNER (l'émetteur est déjà OWNER
  // PRIMARY) — la distinction PRIMARY/CO_OWNER est dérivée côté serveur
  // (create_invitation, M006), jamais choisie ici.
  OWNER: [
    { value: "CONTRACTOR", label: "Entrepreneur" },
    { value: "OWNER", label: "Copropriétaire" },
  ],
  // p_role="OWNER" ici propose le PRIMARY manquant (l'émetteur est
  // CONTRACTOR, aucun propriétaire actif n'existe encore).
  CONTRACTOR: [
    { value: "OWNER", label: "Propriétaire principal" },
    { value: "SITE_MANAGER", label: "Chef de chantier" },
  ],
};

function shareLink(token: string): string {
  if (typeof window === "undefined") return `/invitations/${token}`;
  return `${window.location.origin}/invitations/${token}`;
}

export function NouvelleInvitationForm({ projectId, emitterRole }: NouvelleInvitationFormProps) {
  const [state, formAction, pending] = useActionState<CreateInvitationState, FormData>(
    createInvitation,
    null
  );
  const choices = ROLE_CHOICES[emitterRole];
  const [role, setRole] = useState(choices[0].value);
  const [hasTarget, setHasTarget] = useState(false);
  const [targetKind, setTargetKind] = useState<"EMAIL" | "PHONE">("EMAIL");
  const [copied, setCopied] = useState(false);

  // Succès : le jeton n'est disponible qu'une seule fois, dans cette réponse
  // — jamais persisté côté client au-delà de cet état de composant, jamais
  // relu depuis le serveur ensuite (seul son hash existe en base).
  if (state && "token" in state) {
    const link = shareLink(state.token);
    return (
      <Card className="flex flex-col gap-4 p-6">
        <AlertBanner
          variant="information"
          title="Invitation créée"
          explanation="Transmettez ce lien à la personne concernée. Il ne sera plus jamais affiché après avoir quitté cette page."
        />
        <TextField label="Lien à partager" name="share_link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copié" : "Copier le lien"}
        </Button>
        <p className="text-caption text-muted">
          Expire le {new Date(state.expiresAt).toLocaleString("fr-FR")}.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-6">
      {state?.error ? (
        <AlertBanner variant="error" title="Création impossible" explanation={state.error} />
      ) : null}
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="project_id" value={projectId} />

        <div className="flex flex-col gap-2">
          <span className="text-label font-semibold text-ink">Rôle proposé</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            {choices.map((choice) => (
              <label key={choice.value} className="flex items-center gap-2 text-body text-ink">
                <input
                  type="radio"
                  name="role"
                  value={choice.value}
                  checked={role === choice.value}
                  onChange={() => setRole(choice.value)}
                  className="h-4 w-4 accent-primary"
                />
                {choice.label}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-body text-ink">
            <input
              type="checkbox"
              checked={hasTarget}
              onChange={(e) => setHasTarget(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Cibler une personne précise (sinon lien partagé)
          </label>
        </div>

        {hasTarget ? (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-label font-semibold text-ink">Type d&apos;identifiant</span>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-body text-ink">
                  <input
                    type="radio"
                    name="target_kind"
                    value="EMAIL"
                    checked={targetKind === "EMAIL"}
                    onChange={() => setTargetKind("EMAIL")}
                    className="h-4 w-4 accent-primary"
                  />
                  E-mail
                </label>
                <label className="flex items-center gap-2 text-body text-ink">
                  <input
                    type="radio"
                    name="target_kind"
                    value="PHONE"
                    checked={targetKind === "PHONE"}
                    onChange={() => setTargetKind("PHONE")}
                    className="h-4 w-4 accent-primary"
                  />
                  Téléphone
                </label>
              </div>
            </div>
            <TextField
              label={targetKind === "EMAIL" ? "E-mail de la personne invitée" : "Téléphone de la personne invitée"}
              name="target_value"
              required
              type={targetKind === "EMAIL" ? "email" : "tel"}
            />
          </>
        ) : (
          <>
            <input type="hidden" name="target_kind" value="" />
            <input type="hidden" name="target_value" value="" />
          </>
        )}

        <Button type="submit" loading={pending}>
          Créer l&apos;invitation
        </Button>
      </form>
    </Card>
  );
}
