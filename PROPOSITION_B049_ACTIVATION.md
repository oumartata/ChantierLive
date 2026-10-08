# Proposition B049 — activation manuelle de licence et rôle administrateur

Boucle 32, étape 1 (2026-10-08). Aucun code, aucune migration : des règles
manquent (§3), dont la façon de créer l'administrateur ; décisions A1 à A9
attendues du fondateur.

## 1. Sources citées

- **Backlog (lot L08)**
  - **B049** « Créer activation manuelle administrateur » (dépend de B048) ;
    done_when : « payeur ne gagne aucun droit ».
  - **B050** « Créer interface admin à métadonnées minimales » ; done_when :
    « contenus privés absents ».
  - **B051** « Créer accès support limité et expirant » ; done_when : « motif
    périmètre et audit obligatoires ».
- **Règles**
  - **BR083** : activation manuelle avec référence, montant, date,
    **opérateur**, **vérificateur** et audit ; aucun secret Mobile Money.
  - **BR084** : 30 jours de grâce, puis lecture seule ; renouvellement.
  - **BR088** : l'administrateur gère la plateforme par des métadonnées
    minimales, sans accès par défaut aux contenus privés.
  - **BR089** : accès exceptionnel avec motif, dossier, périmètre, durée,
    approbateur et journal, expiration automatique (B051).
  - **BR090** : suspension (hors B049).
- **Exigences** : FR143 / AC143 (« paiement vérifiable en attente », « admin
  confirme les éléments » → « licence activée avec audit complet ») ; FR153
  (événements techniques sans contenu privé) ; FR155 (gérer licences et
  paramètres globaux, AC155 « validé et audité »).
- **Architecture** : **A016** (VALIDATED) « Activation Mobile Money manuelle
  au MVP » — garde-fou : « Journal d'activation, justificatif et **double
  contrôle** ».
- **Décisions**
  - D004 et D081 : le paiement ne donne aucun droit.
  - D012 : 12 mois, 30 jours de grâce, lecture seule ensuite.
  - D016 : activation Mobile Money manuelle au pilote.
  - D019 et D057 : aucun accès ordinaire aux contenus privés ; jamais de
    contournement automatique.
  - D026 (**PROPOSED**) : interface d'administration séparée.
  - D193 L5 : l'administrateur lit la preuve de paiement pour vérification,
    avec audit, et seulement elle.
- **Modèle prévu**
  - DATA_MODEL : `platform_admin` = « rôle plateforme séparé, absent des
    adhésions métier ordinaires ».
  - STATE_MACHINES `license` : PENDING → ACTIVE (« paiement vérifié ou
    pilote »), puis EXPIRING, GRACE, READ_ONLY ; renouvellement vers ACTIVE.
  - API058 `license.activate` (PLATFORM_ADMIN : operation_uuid, payment_id,
    verification_note → license, audit_event).
  - SCR062 « Licences à vérifier » (`/admin/licences`) ; INFORMATION_ARCHITECTURE :
    coquille d'administration séparée.
  - PERMISSIONS : LICENSE_ACTIVATE (administrateur seul) ;
    SUPPORT_METADATA_VIEW ; SUPPORT_PRIVATE_ACCESS (B051).
  - EC058 (paiement introuvable : rester en attente, ne pas activer) ; EC060
    (deux parties paient : ne pas doubler la durée).
- **Existant** : aucun rôle d'administrateur en base ; M048 (déclarations
  PENDING_REVIEW, statuts PENDING_REVIEW et CANCELLED seulement).

## 2. Ce qui est établi

- L'administrateur n'est jamais membre d'un chantier et ne voit aucun contenu
  de chantier (journal, photos, documents, dépenses, budget…), seulement la
  déclaration et sa preuve (D193 L5).
- Le rôle ne s'obtient jamais par l'application : ni inscription, ni
  promotion par soi-même ; seulement une opération serveur explicite du
  fondateur.
- Toute action d'administration est auditée.
- Activer une licence ne modifie aucun rôle ni aucune permission (D004,
  AC142) : c'est le done_when de B049.

## 3. Décisions attendues (A = recommandation)

- **A1. Créer l'administrateur sans afficher d'identifiant** (condition
  d'arrêt de la boucle).
  - **A** : table `platform_admins` (insertion par une opération serveur
    seulement : script local exécuté par le fondateur, avec le
    `service_role`), qui **désigne un compte existant** par son identifiant
    de profil ; aucune fonction de l'application ne peut l'écrire. En local,
    un compte de démonstration « administrateur » dédié, mot de passe
    aléatoire enregistré seulement dans
    `scripts/.demo-credentials.avancement.json`, jamais affiché.
  - **B** : même table, mais le fondateur désigne son propre compte ; aucun
    compte de démonstration.
  - *Recommandation A* pour le local (tests et navigateur sans toucher à votre
    compte) ; B au pilote.
- **A2. Compte administrateur et chantiers.**
  - **A** : un compte administrateur ne peut avoir aucune adhésion de
    chantier active ; la désignation est refusée sinon, et une adhésion
    ultérieure est refusée tant qu'il est administrateur.
  - **B** : un même compte peut être administrateur et membre d'un chantier ;
    les deux accès restent séparés.
  - *Recommandation A* : aucune confusion possible entre les deux rôles.
- **A3. « Opérateur » et « vérificateur » (BR083) et « double contrôle »
  (A016).**
  - **A** : « opérateur » = moyen de paiement déclaré (Orange Money…) ;
    « vérificateur » = l'administrateur qui active ; un seul administrateur
    suffit au pilote ; le double contrôle est assuré par la preuve et
    l'audit.
  - **B** : quatre yeux : un administrateur propose l'activation, un second
    administrateur différent la confirme.
  - *Recommandation B si vous aurez deux administrateurs au pilote, sinon A* ;
    A016 le demande littéralement.
- **A4. Dates de la licence.**
  - **A** : début = date d'activation ; fin = début + 12 mois (D012).
  - **B** : début = date de paiement déclarée.
  - *Recommandation A* : la durée ne commence que lorsque le service est
    effectivement ouvert.
- **A5. Rejet.**
  - **A** : l'administrateur rejette une déclaration avec un motif obligatoire
    (nouveau statut REJECTED) ; la licence reste en l'état ; le déclarant voit
    le motif ; rien n'est supprimé.
  - *Recommandation A* (EC058 : un paiement introuvable est rejeté ou laissé
    en attente, jamais activé).
- **A6. Plusieurs déclarations (EC060).**
  - **A** : activer une déclaration n'en active jamais une autre ; les autres
    restent en attente, l'administrateur les rejette avec le motif « doublon,
    à régler hors application » ; jamais de durée doublée.
  - **B** : à l'activation, les autres déclarations en attente passent
    automatiquement au statut « doublon ».
  - *Recommandation A* : chaque décision reste explicite et motivée.
- **A7. Renouvellement.**
  - **A** : hors B049 (avec l'expiration) ; au MVP, l'activation n'est
    possible que si la licence n'est pas déjà active.
  - **B** : activer sur une licence active prolonge la fin de 12 mois.
  - *Recommandation A* : l'expiration et le renouvellement viendront ensemble.
- **A8. Chantier en brouillon** (STATE_MACHINES `project` : DRAFT → ACTIVE
  exige « licence ou pilote »).
  - **A** : l'activation de la licence ne change pas le statut du chantier ;
    le passage à « actif » reste une action de ses membres.
  - **B** : l'activation fait passer le chantier en ACTIVE.
  - *Recommandation A* : l'administrateur n'agit jamais sur le chantier
    lui-même.
- **A9. Ce que l'administrateur voit d'une déclaration** (B050 « contenus
  privés absents »).
  - **A** : identifiant court du chantier, rôle du déclarant (« entreprise »,
    « propriétaire principal »), montant, opérateur, référence, date, nom du
    payeur s'il est donné, preuve (lecture auditée) ; **ni le nom du
    chantier, ni son adresse, ni l'identité des membres** ; contact par le
    canal support (B051).
  - **B** : en plus, le nom du chantier, pour le reconnaître.
  - *Recommandation A*.

## 4. Réalisation prévue après décision

- **M049** (accord requis) :
  - `platform_admins` (désignation serveur seulement, audit) ;
  - statut REJECTED et décisions sur `license_payments` ;
  - fonctions administrateur `list_license_payments_to_review`,
    `get_license_proof_file_key_admin` (audit de chaque lecture),
    `activate_license_payment`, `reject_license_payment` — refusées à tout
    compte non administrateur.
- **Tests** :
  - activation et rejet motivé par l'administrateur seul ;
  - payeur sans droit nouveau (adhésions, rôles, permissions identiques) ;
  - administrateur sans aucun accès aux contenus de chantier ni aux finances
    internes (toutes les fonctions de chantier : not_authorized) ;
  - impossible de devenir administrateur par l'application ;
  - audit de chaque action ;
  - test-file-cross-access et non-régression D183.
- **Écran** : `/admin/licences` minimal (SCR062), hors du menu des chantiers ;
  navigateur ordinateur et 390 px.
