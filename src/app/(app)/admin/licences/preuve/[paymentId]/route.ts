import { NextResponse } from "next/server";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// B049 (D193 L5, D194) — preuve de paiement pour l'administrateur. La
// fonction en base revérifie le rôle d'administrateur et trace CHAQUE
// lecture dans le journal de plateforme ; l'URL signée (60 s) n'est émise
// qu'ensuite, au clic, jamais à l'affichage de la liste.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const user = await getVerifiedUser();
  if (!user || !UUID_RE.test(paymentId)) return new NextResponse("Introuvable", { status: 404 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_license_proof_file_key_for_admin", { p_payment_id: paymentId });
  const key = Array.isArray(data) ? data[0] : data;
  if (error || !key?.storage_key) return new NextResponse("Introuvable", { status: 404 });
  const { data: signed } = await createServiceClient().storage.from(key.bucket).createSignedUrl(key.storage_key, 60);
  if (!signed?.signedUrl) return new NextResponse("Introuvable", { status: 404 });
  return NextResponse.redirect(signed.signedUrl, { status: 303 });
}
