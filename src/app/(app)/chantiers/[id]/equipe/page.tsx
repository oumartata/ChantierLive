import { redirect } from "next/navigation";
import { getVerifiedUser, createClient } from "@/lib/supabase/server";
import { AlertBanner, Card, StatusChip } from "@/components/ui";
import { RemoveParticipantButton } from "./RemoveParticipantButton";
import { GrantDelegationForm } from "./GrantDelegationForm";
import { RevokeDelegationButton } from "./RevokeDelegationButton";
import { RequestRoleTransferButton } from "./RequestRoleTransferButton";
import { TransferContractorRoleButton } from "./TransferContractorRoleButton";
import { RoleTransferRequestCard } from "./RoleTransferRequestCard";

const ROLE_LABEL: Record<string, string> = {
  OWNER_PRIMARY: "Propriétaire principal",
  OWNER_CO_OWNER: "Copropriétaire",
  CONTRACTOR: "Entrepreneur principal",
  SITE_MANAGER: "Chef de chantier",
};

const ROLE_TRANSFER_STATUS_LABEL: Record<string, string> = {
  PENDING: "En attente de confirmation",
  CONFIRMED: "Confirmée",
  REFUSED: "Refusée",
  CANCELLED: "Annulée",
  EXPIRED: "Expirée",
  INVALIDATED: "Invalidée",
};

const PERMISSION_LABEL: Record<string, string> = {
  PHASE_EDIT_DRAFT: "Modifier les phases en brouillon",
  EXPENSE_PUBLISH: "Publier des dépenses",
  PHASE_VALIDATE: "Valider les phases",
  APPROVAL_DECIDE: "Décider des approbations",
};

function roleKey(role: string, ownerProfile: string | null): string {
  return role === "OWNER" ? `OWNER_${ownerProfile}` : role;
}

function roleLabel(role: string, ownerProfile: string | null): string {
  return ROLE_LABEL[roleKey(role, ownerProfile)] ?? role;
}

// B017 (corrections post-revue, 2026-09-24) : repère technique stable et
// commun aux participants et aux délégations (l'identifiant d'adhésion
// project_membership_id AFFICHÉ EN ENTIER, jamais tronqué — un simple
// segment, même le dernier, n'offre aucune garantie d'unicité entre deux
// UUID distincts qui le partageraient par coïncidence) — nécessaire dès que
// deux participants partagent le même rôle (ex. deux SITE_MANAGER), sans
// quoi rien ne les distingue à l'écran. Volontairement PAS un nom : profiles
// ne porte aucune colonne de nom affichable (M002), et les identifiants de
// contact (e-mail/téléphone, profile_identifiers) sont des données privées
// jamais exposées à d'autres membres du chantier ici. LIMITE EXPLICITE :
// ceci reste un identifiant technique, pas un nom lisible — une vraie
// solution (pseudonyme choisi, initiales) nécessiterait une colonne dédiée,
// hors périmètre de ce lot. `break-all` (appliqué à l'affichage) évite tout
// débordement horizontal sur mobile.

interface Membership {
  id: string;
  profile_id: string;
  role: string;
  owner_profile: string | null;
  created_at_server: string;
}

interface RoleTransfer {
  id: string;
  role: string;
  status: string;
  initiator_membership_id: string;
  successor_membership_id: string;
  requested_at_server: string;
  expires_at: string | null;
  decided_at_server: string | null;
  request_reason: string;
  decision_reason: string | null;
  is_pending: boolean;
}

interface Delegation {
  id: string;
  permission_code: string;
  project_membership_id: string;
  beneficiary_role: string;
  beneficiary_owner_profile: string | null;
  beneficiary_active: boolean;
  granted_at_server: string;
  expires_at: string | null;
  revoked_at_server: string | null;
  effective: boolean;
}

// Couples déjà validés (M004) — reproduits ici uniquement pour l'affichage
// (quels codes proposer, quelle révocation autoriser) ; grant_delegation/
// revoke_delegation (M004c) revérifient indépendamment la même matrice côté
// SQL, cette page n'est jamais l'autorité finale.
function delegationCodesFor(role: string, ownerProfile: string | null): string[] {
  if (role === "SITE_MANAGER") return ["PHASE_EDIT_DRAFT", "EXPENSE_PUBLISH"];
  if (role === "OWNER" && ownerProfile === "CO_OWNER") return ["PHASE_VALIDATE", "APPROVAL_DECIDE"];
  return [];
}

function delegantRoleFor(code: string): { role: string; ownerProfile: string | null } | null {
  if (code === "PHASE_EDIT_DRAFT" || code === "EXPENSE_PUBLISH") return { role: "CONTRACTOR", ownerProfile: null };
  if (code === "PHASE_VALIDATE" || code === "APPROVAL_DECIDE") return { role: "OWNER", ownerProfile: "PRIMARY" };
  return null;
}

// B017 : consultation de l'équipe (FR041), retrait de participants non
// principaux (FR037/040) et gestion des délégations (M004, contrôle
// transactionnel délégant/bénéficiaire différé depuis B009, enfin livré
// ici). Aucun transfert de rôle principal (B018, non implémenté).
export default async function EquipePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getVerifiedUser();
  if (!user) {
    redirect("/connexion");
  }

  const supabase = await createClient();

  const { data: project } = await supabase.from("projects").select("id, name").eq("id", id).maybeSingle();

  if (!project) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1 font-bold text-ink">Équipe</h1>
        <AlertBanner
          variant="error"
          title="Chantier inaccessible"
          explanation="Ce chantier n'existe pas ou vous n'y avez pas accès."
        />
      </div>
    );
  }

  // RLS (project_memberships_select_participants, M004a) ne retourne que
  // les adhésions ACTIVES du chantier à un membre actif — jamais élargi ici.
  const { data: membershipsData } = await supabase
    .from("project_memberships")
    .select("id, profile_id, role, owner_profile, created_at_server")
    .eq("project_id", id)
    .order("created_at_server", { ascending: true });
  const memberships: Membership[] = membershipsData ?? [];

  const caller = memberships.find((m) => m.profile_id === user.id) ?? null;

  const { data: delegationsData, error: delegationsError } = await supabase.rpc("list_project_delegations", {
    p_project_id: id,
  });
  const delegations: Delegation[] = Array.isArray(delegationsData) ? delegationsData : [];

  const { data: transfersData, error: transfersError } = await supabase.rpc("list_role_transfers", {
    p_project_id: id,
  });
  const roleTransfers: RoleTransfer[] = Array.isArray(transfersData) ? transfersData : [];
  const hasPendingOwnerTransfer = roleTransfers.some((t) => t.role === "OWNER" && t.is_pending);

  const canRemove = (target: Membership): boolean => {
    if (!caller) return false;
    if (caller.role === "OWNER" && caller.owner_profile === "PRIMARY") {
      return target.role === "OWNER" && target.owner_profile === "CO_OWNER";
    }
    if (caller.role === "CONTRACTOR") {
      return target.role === "SITE_MANAGER";
    }
    return false;
  };

  const grantableCodesFor = (target: Membership): string[] => {
    const eligible = delegationCodesFor(target.role, target.owner_profile);
    if (eligible.length === 0 || !caller) return [];
    const delegant = delegantRoleFor(eligible[0]);
    const callerIsDelegant =
      delegant !== null && caller.role === delegant.role && caller.owner_profile === delegant.ownerProfile;
    if (!callerIsDelegant) return [];
    const activeCodes = new Set(
      delegations
        .filter((d) => d.project_membership_id === target.id && d.revoked_at_server === null)
        .map((d) => d.permission_code)
    );
    return eligible.filter((code) => !activeCodes.has(code));
  };

  const canRevoke = (delegation: Delegation): boolean => {
    if (!caller) return false;
    const delegant = delegantRoleFor(delegation.permission_code);
    return delegant !== null && caller.role === delegant.role && caller.owner_profile === delegant.ownerProfile;
  };

  // B018 : successeur éligible = adhésion active CO_OWNER (pour OWNER/
  // PRIMARY) ou SITE_MANAGER (pour CONTRACTOR) — même matrice que
  // role_transfer_couple (M006b), reproduite ici pour l'affichage uniquement
  // (jamais l'autorité finale).
  const canRequestOwnerTransfer = (target: Membership): boolean =>
    !!caller &&
    caller.role === "OWNER" &&
    caller.owner_profile === "PRIMARY" &&
    target.role === "OWNER" &&
    target.owner_profile === "CO_OWNER" &&
    !hasPendingOwnerTransfer;

  const canTransferContractorRole = (target: Membership): boolean =>
    !!caller && caller.role === "CONTRACTOR" && target.role === "SITE_MANAGER";

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-h1 font-bold text-ink">Équipe — {project.name}</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Participants</h2>
        {memberships.length === 0 ? (
          <AlertBanner variant="information" title="Aucun participant" explanation="Aucune adhésion active sur ce chantier." />
        ) : (
          memberships.map((m) => (
            <Card key={m.id} className="flex flex-col gap-2 p-6">
              <p className="text-body text-ink">
                Rôle : <span className="font-semibold">{roleLabel(m.role, m.owner_profile)}</span>
                {m.profile_id === user.id ? " (vous)" : ""}
              </p>
              <p className="text-caption text-muted break-all">Repère : {m.id}</p>
              {canRemove(m) ? <RemoveParticipantButton projectId={id} membershipId={m.id} /> : null}
              {canRequestOwnerTransfer(m) ? (
                <RequestRoleTransferButton projectId={id} successorMembershipId={m.id} />
              ) : null}
              {canTransferContractorRole(m) ? (
                <TransferContractorRoleButton projectId={id} successorMembershipId={m.id} />
              ) : null}
              <GrantDelegationForm
                projectId={id}
                projectMembershipId={m.id}
                codes={grantableCodesFor(m)}
                labels={PERMISSION_LABEL}
              />
            </Card>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Délégations</h2>
        {delegationsError ? (
          <AlertBanner variant="error" title="Lecture impossible" explanation="Les délégations n'ont pas pu être chargées." />
        ) : delegations.length === 0 ? (
          <AlertBanner variant="information" title="Aucune délégation" explanation="Aucune délégation n'a été accordée sur ce chantier." />
        ) : (
          delegations.map((d) => (
            <Card key={d.id} className="flex flex-col gap-2 p-6">
              <p className="text-body text-ink">
                {PERMISSION_LABEL[d.permission_code] ?? d.permission_code} —{" "}
                <span className="text-caption text-muted">
                  {roleLabel(d.beneficiary_role, d.beneficiary_owner_profile)}
                </span>
              </p>
              <p className="text-caption text-muted break-all">
                Bénéficiaire — Repère : {d.project_membership_id}
              </p>
              {/* B017 : "effective" (M004c) distingue une délégation réellement
                  utilisable d'une ligne devenue inopérante (bénéficiaire retiré,
                  expirée, ou déjà révoquée) — jamais présentée comme un droit
                  utilisable dans ce dernier cas, même si revoked_at_server est
                  encore null (retrait du bénéficiaire ne révoque jamais la
                  ligne, voir remove_participant). */}
              <StatusChip
                variant={d.effective ? "success" : "neutral"}
                label={d.effective ? "Active" : "Inopérante"}
              />
              {!d.beneficiary_active ? (
                <p className="text-caption text-danger">Bénéficiaire retiré du chantier.</p>
              ) : null}
              {/* Corrigé après revue ZIP (2026-09-24) : le bouton ne doit
                  JAMAIS dépendre de "effective" — une délégation expirée
                  (ou dont le bénéficiaire a été retiré) reste explicitement
                  révocable tant que revoked_at_server est null (décision
                  confirmée : une délégation expirée doit être révoquée
                  explicitement avant tout remplacement, jamais contournée).
                  "effective" ne sert qu'à l'affichage du statut ci-dessus. */}
              {d.revoked_at_server === null && canRevoke(d) ? (
                <RevokeDelegationButton projectId={id} delegationId={d.id} />
              ) : null}
            </Card>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold text-ink">Transfert de rôle principal</h2>
        {transfersError ? (
          <AlertBanner
            variant="error"
            title="Lecture impossible"
            explanation="Les demandes de transfert n'ont pas pu être chargées."
          />
        ) : roleTransfers.length === 0 ? (
          <AlertBanner
            variant="information"
            title="Aucune demande"
            explanation="Aucun transfert de rôle principal n'a été demandé sur ce chantier."
          />
        ) : (
          roleTransfers.map((t) => (
            <Card key={t.id} className="flex flex-col gap-2 p-6">
              <p className="text-body text-ink">
                {roleLabel(t.role, t.role === "OWNER" ? "PRIMARY" : null)} —{" "}
                <span className="text-caption text-muted">{ROLE_TRANSFER_STATUS_LABEL[t.status] ?? t.status}</span>
              </p>
              <StatusChip
                variant={t.is_pending ? "success" : "neutral"}
                label={t.is_pending ? "En attente" : "Terminée"}
              />
              <RoleTransferRequestCard
                projectId={id}
                transferId={t.id}
                role={t.role}
                isInitiator={caller?.id === t.initiator_membership_id}
                isSuccessor={caller?.id === t.successor_membership_id}
                isPending={t.is_pending}
              />
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
