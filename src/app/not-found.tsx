import Link from "next/link";
import { Card } from "@/components/ui";
import { buttonClassName } from "@/components/ui/Button";

// Page « introuvable » (404), en français. Sert aux adresses inconnues et à
// notFound() — notamment pour tout rôle refusé sur un contenu réservé
// (D183) : elle ne dit jamais pourquoi la page est introuvable ni ce
// qu'elle contiendrait.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center gap-6 p-4 sm:p-6">
      <Card className="flex flex-col gap-3" data-testid="page-introuvable">
        <p className="text-caption font-semibold text-muted">Erreur 404</p>
        <h1 className="text-h1 font-bold text-ink">Page introuvable</h1>
        <p className="text-body text-muted">Cette page n&apos;existe pas ou n&apos;est pas accessible avec votre compte.</p>
        <div>
          <Link href="/" className={buttonClassName("primary", "regular")}>
            Retour à l&apos;accueil
          </Link>
        </div>
      </Card>
    </main>
  );
}
