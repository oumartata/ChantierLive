"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { Card } from "@/components/ui/Card";
import { StatusChip } from "@/components/ui/StatusChip";
import { AlertBanner } from "@/components/ui/AlertBanner";
import { Toast } from "@/components/ui/Toast";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";

// Page technique de vérification des tokens et composants de base (lot
// B003). Ce n'est pas un écran métier : aucune donnée réelle, aucune
// logique de chantier.
export default function Home() {
  const [standardOpen, setStandardOpen] = useState(false);
  const [doubleOpen, setDoubleOpen] = useState(false);
  const [fieldValue, setFieldValue] = useState("");

  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-4 py-8 md:px-8">
      <header className="flex flex-col gap-1">
        <p className="text-caption font-semibold text-muted">Socle technique</p>
        <h1 className="text-display font-bold text-ink">Composants d&apos;interface</h1>
        <p className="text-body text-muted">
          Vérification des tokens visuels. Ce n&apos;est pas un écran métier.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Boutons</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Continuer</Button>
          <Button variant="secondary">Annuler</Button>
          <Button variant="ghost">Ignorer</Button>
          <Button variant="danger">Supprimer</Button>
          <Button variant="primary" disabled>
            Désactivé
          </Button>
          <Button variant="primary" loading>
            Envoi en cours
          </Button>
          <Button variant="primary" size="compact">
            Compact
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Champs de texte</h2>
        <div className="grid gap-4 md:max-w-md">
          <TextField
            label="Nom du chantier"
            value={fieldValue}
            onChange={(event) => setFieldValue(event.target.value)}
          />
          <TextField label="Champ désactivé" disabled defaultValue="Valeur fixe" />
          <TextField
            label="Numéro de téléphone"
            error="Ce numéro n'est pas valide."
            defaultValue="00 00"
          />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Carte</h2>
        <Card className="max-w-sm">
          <p className="text-label font-semibold text-ink">Exemple de carte</p>
          <p className="text-body text-muted">
            Contenu générique utilisant les tokens de fond, de rayon et d&apos;ombre.
          </p>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">États (chip)</h2>
        <div className="flex flex-wrap gap-2">
          <StatusChip variant="neutral" label="Brouillon" />
          <StatusChip variant="info" label="En attente" />
          <StatusChip variant="attention" label="À vérifier" />
          <StatusChip variant="success" label="Synchronisé" />
          <StatusChip variant="danger" label="Refusé" />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Bandeaux d&apos;alerte</h2>
        <div className="flex flex-col gap-3">
          <AlertBanner
            variant="information"
            title="Information"
            explanation="Message neutre pour l'utilisateur."
          />
          <AlertBanner
            variant="warning"
            title="Avertissement"
            explanation="Action possible mais à vérifier."
          />
          <AlertBanner
            variant="error"
            title="Erreur"
            explanation="L'action n'a pas pu être effectuée."
          />
          <AlertBanner
            variant="offline"
            title="Hors ligne"
            explanation="Les modifications seront envoyées au retour du réseau."
          />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Confirmations brèves (toast)</h2>
        <div className="flex flex-col gap-3 md:max-w-sm">
          <Toast variant="success" message="Enregistré avec succès." />
          <Toast variant="info" message="Synchronisation en cours." />
          <Toast variant="error" message="Échec de l'envoi." />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">État vide</h2>
        <EmptyState
          title="Aucun élément pour le moment"
          description="Revenez plus tard ou modifiez vos filtres."
          action={
            <Button variant="secondary" size="compact">
              Réinitialiser
            </Button>
          }
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Chargement (squelette)</h2>
        <div className="grid max-w-md gap-3">
          <Skeleton variant="list" />
          <Skeleton variant="card" />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h2 font-semibold text-ink">Boîtes de confirmation</h2>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setStandardOpen(true)}>
            Ouvrir (standard)
          </Button>
          <Button variant="secondary" onClick={() => setDoubleOpen(true)}>
            Ouvrir (double confirmation)
          </Button>
        </div>
        <ConfirmDialog
          open={standardOpen}
          title="Quitter sans enregistrer ?"
          consequence="Les modifications non enregistrées seront perdues."
          onConfirm={() => setStandardOpen(false)}
          onCancel={() => setStandardOpen(false)}
        />
        <ConfirmDialog
          open={doubleOpen}
          variant="double_confirmation"
          title="Supprimer définitivement ?"
          consequence="Cette action ne peut pas être annulée."
          permanence="Aucune récupération possible après confirmation."
          onConfirm={() => setDoubleOpen(false)}
          onCancel={() => setDoubleOpen(false)}
        />
      </section>
    </main>
  );
}
