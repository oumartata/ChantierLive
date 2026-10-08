"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";

// B045 (M052 ; D199) — ouvrir (marque lue puis mène à l'objet, dont la page
// revérifie elle-même le droit, EC051), tout marquer lu, préférences par
// catégorie. Les alertes obligatoires ne se règlent pas.

export type NotificationPrefState = { error: string } | { ok: true } | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ["CHANTIER", "FINANCES", "LICENCE", "SUPPORT", "COMPTE"];

export async function openNotificationAction(formData: FormData) {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const id = formData.get("notification_id");
  const link = formData.get("link");
  if (typeof id !== "string" || !UUID_RE.test(id)) redirect("/notifications");
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_notification_read", { p_notification_id: id });
  revalidatePath("/", "layout");
  // Lien relatif interne seulement ; sinon retour à la liste (écran sûr).
  if (error || typeof link !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(link)) redirect("/notifications");
  redirect(link);
}

export async function markAllReadAction() {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  await supabase.rpc("mark_all_my_notifications_read");
  revalidatePath("/", "layout");
}

export async function savePreferencesAction(_prev: NotificationPrefState, formData: FormData): Promise<NotificationPrefState> {
  const user = await getVerifiedUser();
  if (!user) return { error: "Session expirée. Reconnectez-vous." };
  const supabase = await createClient();
  for (const c of CATEGORIES) {
    const { error } = await supabase.rpc("set_my_notification_preference", {
      p_category: c,
      p_in_app: formData.get(`${c}_in_app`) === "on",
      p_email: formData.get(`${c}_email`) === "on",
    });
    if (error) return { error: "Enregistrement impossible. Réessayez." };
  }
  revalidatePath("/notifications");
  return { ok: true };
}
