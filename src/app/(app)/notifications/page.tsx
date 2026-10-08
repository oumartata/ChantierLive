import { redirect } from "next/navigation";
import { createClient, getVerifiedUser } from "@/lib/supabase/server";
import { AlertBanner, Button, EmptyState, StatusChip } from "@/components/ui";
import { markAllReadAction, openNotificationAction } from "./actions";
import { PreferencesForm, type Preference } from "./PreferencesForm";

// SCR012 « Notifications » — B045 (M052 ; D199). Seules les notifications du
// compte connecté, et seulement celles qu'il a encore le droit de voir (un
// ex-membre ne voit plus rien du chantier). Le nom du chantier est joint à
// l'affichage, jamais stocké ni envoyé par e-mail.

interface Row {
  id: string;
  kind: string;
  category: string;
  mandatory: boolean;
  title: string;
  project_name: string | null;
  link: string | null;
  group_count: number;
  created_at_server: string;
  updated_at_server: string;
  read_at_server: string | null;
}

const stamp = (ts: string) =>
  new Date(ts).toLocaleString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + " (UTC)";

export default async function NotificationsPage() {
  const user = await getVerifiedUser();
  if (!user) redirect("/connexion");
  const supabase = await createClient();
  const [{ data, error }, { data: prefs }] = await Promise.all([
    supabase.rpc("list_my_notifications", { p_limit: 100, p_offset: 0 }),
    supabase.rpc("get_my_notification_preferences"),
  ]);
  const rows = (data ?? []) as Row[];
  const unread = rows.filter((r) => !r.read_at_server).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-h1 font-bold text-ink">Notifications</h1>
          <p className="text-body text-muted">{unread > 0 ? `${unread} non lue(s).` : "Tout est lu."}</p>
        </div>
        {unread > 0 ? (
          <form action={markAllReadAction}>
            <Button type="submit" size="compact" variant="secondary">
              Tout marquer comme lu
            </Button>
          </form>
        ) : null}
      </div>

      {error ? (
        <AlertBanner variant="error" title="Lecture impossible" explanation="Réessayez plus tard." />
      ) : rows.length === 0 ? (
        <EmptyState title="Aucune notification" description="Les nouveautés de vos chantiers apparaîtront ici." />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="liste-notifications">
          {rows.map((n) => (
            <li key={n.id}>
              <form action={openNotificationAction}>
                <input type="hidden" name="notification_id" value={n.id} />
                <input type="hidden" name="link" value={n.link ?? ""} />
                <button
                  type="submit"
                  className={`flex w-full flex-col gap-1 rounded-medium border px-4 py-3 text-left ${n.read_at_server ? "border-muted/20 bg-surface" : "border-primary/40 bg-sand"}`}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`text-body text-ink ${n.read_at_server ? "" : "font-semibold"}`}>{n.title}</span>
                    {n.mandatory ? <StatusChip variant="attention" label="Important" /> : null}
                  </span>
                  <span className="text-caption text-muted">
                    {n.project_name ? `${n.project_name} · ` : ""}
                    {stamp(n.updated_at_server)}
                    {n.read_at_server ? "" : " · non lue"}
                  </span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Préférences</h2>
        <p className="text-caption text-muted">
          Les alertes importantes (incident urgent, décision attendue, échéance de licence) arrivent toujours. Les e-mails ne contiennent jamais le nom
          du chantier ni son contenu : seulement « Nouvelle notification » et un lien.
        </p>
        <PreferencesForm preferences={(prefs ?? []) as Preference[]} />
      </section>
    </div>
  );
}
