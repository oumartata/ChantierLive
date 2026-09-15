export type AppEnv = "development" | "test" | "staging" | "production";

const APP_ENVS: readonly AppEnv[] = ["development", "test", "staging", "production"];

export function resolveAppEnv(): AppEnv {
  const raw = process.env.NEXT_PUBLIC_APP_ENV;
  if (raw && (APP_ENVS as readonly string[]).includes(raw)) {
    return raw as AppEnv;
  }
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/**
 * Guards against a service_role (or other privileged) secret accidentally
 * leaking into a NEXT_PUBLIC_* variable, which Next.js inlines into the
 * client bundle. See TECH_ARCHITECTURE.yaml: security.privileged_logic.
 */
export function validateEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value && /service_role/i.test(value)) {
      throw new Error(
        `La variable publique "${key}" semble contenir une clé service_role Supabase. ` +
          "Une clé privilégiée ne doit jamais être exposée au client via NEXT_PUBLIC_*."
      );
    }
  }
}
