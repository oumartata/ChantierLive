// Remise LOCALE de la file d'e-mails (B045, D199) : chaque e-mail EN_ATTENTE
// est remis au capteur d'e-mails de Supabase local (Mailpit, API HTTP sur
// 127.0.0.1), puis marqué DELIVERED_LOCAL. Aucun envoi vers Internet : toute
// adresse de capteur qui n'est pas 127.0.0.1 ou localhost est refusée, et
// Mailpit local ne relaie rien (aucun relais configuré).

export const MAILPIT_URL = process.env.LOCAL_MAILPIT_URL || "http://127.0.0.1:54324";

function assertLocal(url) {
  const { hostname } = new URL(url);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") throw new Error(`Capteur non local refusé : ${url}`);
}

export async function deliverOutboxLocal(service, { notificationIds = null, limit = 200 } = {}) {
  assertLocal(MAILPIT_URL);
  let q = service.from("email_outbox").select("id, to_address, subject, body").eq("status", "PENDING").order("created_at_server").limit(limit);
  if (notificationIds) q = q.in("notification_id", notificationIds);
  const { data, error } = await q;
  if (error) throw new Error(`lecture de la file : ${error.message}`);
  let delivered = 0;
  for (const m of data ?? []) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ From: { Email: "notifications@chantierlive.local", Name: "ChantierLive" }, To: [{ Email: m.to_address }], Subject: m.subject, Text: m.body }),
    });
    if (!res.ok) throw new Error(`capteur local : HTTP ${res.status}`);
    const upd = await service.from("email_outbox").update({ status: "DELIVERED_LOCAL", delivered_at_server: new Date().toISOString() }).eq("id", m.id);
    if (upd.error) throw new Error(`marquage : ${upd.error.message}`);
    delivered += 1;
  }
  return delivered;
}

export async function mailpitMessagesTo(address) {
  assertLocal(MAILPIT_URL);
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  if (!res.ok) throw new Error(`capteur local : HTTP ${res.status}`);
  const list = (await res.json()).messages ?? [];
  const full = [];
  for (const m of list) {
    const r = await fetch(`${MAILPIT_URL}/api/v1/message/${m.ID}`);
    if (r.ok) full.push(await r.json());
  }
  return full;
}
