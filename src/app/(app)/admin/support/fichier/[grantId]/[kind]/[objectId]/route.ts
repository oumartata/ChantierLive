import { NextResponse } from "next/server";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// B051 (M051 ; D197 S7) — fichier d'une photo publiée ou d'un document
// lisible sous un accès support. La base revérifie l'accord et trace
// l'ouverture ; l'URL signée dure au plus 60 s et jamais au-delà de la fin de
// l'accès (expires_in calculé en base).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ grantId: string; kind: string; objectId: string }> }) {
  const { grantId, kind, objectId } = await params;
  const user = await getVerifiedUser();
  if (!user || !UUID_RE.test(grantId) || !UUID_RE.test(objectId) || !["PHOTO", "DOCUMENT"].includes(kind)) return new NextResponse("Introuvable", { status: 404 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("support_get_file", { p_grant_id: grantId, p_kind: kind, p_object_id: objectId });
  const file = data as { ok: boolean; bucket?: string; storage_key?: string; expires_in?: number } | null;
  if (error || !file?.ok || !file.bucket || !file.storage_key) return new NextResponse("Introuvable", { status: 404 });
  const { data: signed } = await createServiceClient().storage.from(file.bucket).createSignedUrl(file.storage_key, Math.max(1, Math.min(60, file.expires_in ?? 1)));
  if (!signed?.signedUrl) return new NextResponse("Introuvable", { status: 404 });
  return NextResponse.redirect(signed.signedUrl, { status: 303 });
}
