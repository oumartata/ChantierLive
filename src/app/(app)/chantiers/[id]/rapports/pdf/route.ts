import { NextResponse } from "next/server";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { ReportError, generateReport } from "@/lib/report/report";

// B046 (M053 ; D200) — rapport de suivi PDF. Généré à chaque demande avec la
// session de la personne (mêmes fonctions que les écrans : seulement ce que
// son rôle voit), en mémoire seulement : jamais écrit sur disque ni dans le
// stockage. Seule une trace de génération, visible de son auteur, est gardée.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getVerifiedUser();
  const url = new URL(request.url);
  const from = url.searchParams.get("du") ?? "";
  const to = url.searchParams.get("au") ?? "";
  if (!user || !UUID_RE.test(id)) return new NextResponse("Introuvable", { status: 404 });
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return NextResponse.redirect(new URL(`/chantiers/${id}/rapports?erreur=period_invalid`, request.url), 303);
  try {
    const supabase = await createClient();
    const report = await generateReport(supabase, id, from, to);
    return new NextResponse(new Uint8Array(report.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${report.fileName}"`,
        "Content-Length": String(report.bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = e instanceof ReportError ? e.code : "generation_failed";
    if (code === "not_authorized") return new NextResponse("Introuvable", { status: 404 });
    return NextResponse.redirect(new URL(`/chantiers/${id}/rapports?erreur=${encodeURIComponent(code)}`, request.url), 303);
  }
}
