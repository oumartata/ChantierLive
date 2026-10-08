// Opération serveur LOCALE (B045, D199) : remet la file d'e-mails au capteur
// d'e-mails de Supabase local (Mailpit). Aucun envoi vers Internet ; le
// service d'envoi réel est un point ouvert avant le pilote. N'affiche qu'un
// compte.
//
// Usage : node --env-file=.env.local scripts/deliver-email-outbox-local.mjs
import { createClient } from "@supabase/supabase-js";
import { deliverOutboxLocal } from "./lib/email-outbox-local.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Destination non locale refusée.");
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const n = await deliverOutboxLocal(service);
console.log(`e-mails remis au capteur local : ${n}`);
