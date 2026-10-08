# Proposition B051 — accès support limité et expirant

Boucle 35, étape 2 (2026-10-08). Aucun code B051, aucune migration : le
cadre de l'accès exceptionnel existe (motif, dossier, périmètre, durée,
expiration, audit), mais **qui l'approuve**, **ce qu'il ouvre** et **qui en
est informé** ne sont fixés nulle part, et deux règles se contredisent
(§3). Décisions S1 à S10 attendues du fondateur.

## 1. Sources citées

- **B051** (MVP_BACKLOG, lot L08, P0, dépend de B050) : « Créer accès
  support limité et expirant ». done_when : « motif périmètre et audit
  obligatoires ».
- **B052** (dépend de B051) : matrice RLS complète.
- **Exigences**
  - FR154 / AC154 : accès exceptionnel temporaire et motivé ; « périmètre,
    durée et motif sont appliqués et audités ».
  - FR157 / AC157 : consulter les signalements et demandes de support,
    « liste minimisée » (reporté à B051 par D195 E1).
  - FR159 / AC159 : l'administrateur « définit dossier, motif, périmètre et
    durée » ; « autorisation limitée créée ».
  - FR160 / AC160 : notifier et journaliser tout accès exceptionnel « selon
    la politique applicable » ; « audit et notification conformes ».
- **Règles**
  - BR088 : métadonnées minimales, aucun accès par défaut aux contenus
    privés.
  - BR089 : l'accès exceptionnel précise « motif ; dossier support ;
    périmètre ; durée ; approbateur et journal ; il expire
    automatiquement ».
- **Décisions**
  - D019 : administrateur sans accès ordinaire aux contenus privés.
  - D020 : accès support exceptionnel, temporaire, motivé et audité.
  - D057 : l'administrateur ne contourne jamais automatiquement les
    données privées.
  - D183, D185, D187 : finances internes réservées à l'entreprise (et au
    chef de chantier pour les dépenses) ; jamais au propriétaire.
  - D186 : le propriétaire ne lit jamais directement l'audit du chantier.
  - D195 E6 : l'administrateur lit le journal de plateforme, « jamais
    l'audit des chantiers ».
- **Cas limites**
  - EC061 : un administrateur sans dossier est refusé, et la tentative
    journalisée.
  - EC062 : expiration pendant la session : périmètre privé révoqué
    immédiatement.
- **Modèle et contrats**
  - T010 `support_access_grants` (« append-only + révocation ») ; R026 :
    lisible par le « demandeur concerné et l'admin autorisé ».
  - API062 `support.grant_access` (dossier, chantier, périmètre, motif,
    expiration, **approbateur**).
  - API063 `support.revoke_access` (approbateur ou administrateur).
  - OP017 (« aucun accès global implicite »).
  - RLS_HELPERS `has_support_scope` (« autorisation active, non expirée et
    périmètre exact »).
- **Écrans** : SCR063 tickets (`/admin/support`) ; SCR064 accès
  exceptionnel (`/admin/support/:ticketId/acces`).
  - Gardes : `support_ticket`, `strong_admin_auth`, `approval_policy`,
    `limited_scope`.
  - Effets : audit, expiration, notification.
- **Formulaire et textes**
  - FORM_SCHEMAS `break_glass` : dossier, périmètre (au moins un),
    motif de 10 à 1000 caractères, durée **15, 30 ou 60 minutes**,
    authentification renforcée.
  - Textes : TXT079 à TXT082 (« Demander de l'aide », compte à rebours,
    « L'accès exceptionnel est terminé »).
- **Permissions**
  - SUPPORT_REQUEST : les 4 rôles.
  - SUPPORT_METADATA_VIEW : administrateur.
  - SUPPORT_PRIVATE_ACCESS : administrateur sous condition (« motif,
    durée, périmètre, journal et notification selon politique »).
  - AUDIT_VIEW, BUDGET_VIEW, EXPENSE_VIEW et MEDIA_VIEW : administrateur
    sous condition.
- **Tests prévus** : TST017 (autorisation limitée ouvre l'objet permis,
  auditée) ; TST018 (autorisation expirée refusée) ; SEC014.
- **Existant** : aucun dossier support, aucune table
  `support_access_grants`, aucune notification (B045 non faite), aucune
  authentification renforcée.

## 2. Ce qui est établi

- Aucun accès sans dossier, sans motif ni périmètre. La tentative refusée
  est journalisée (EC061).
- Durée de 15, 30 ou 60 minutes, avec expiration automatique contrôlée en
  base à chaque lecture (EC062).
- Révocable à tout moment (API063).
- Chaque ouverture et chaque lecture est auditée.
- Aucun accès global implicite (OP017) ; l'administrateur n'est jamais
  membre du chantier (D194 A2).

## 3. Règles manquantes ou contradictoires

1. **Approbateur** exigé (BR089, API062, `approval_policy`) mais jamais
   désigné. Avec un seul administrateur (le fondateur), une approbation
   par un second administrateur est impossible.
2. **Dossier support** exigé (BR089, EC061, `support_ticket`) mais
   inexistant. Rien ne fixe qui l'ouvre, ce qu'il contient, ni ce que
   l'administrateur en voit (FR157 : « liste minimisée »).
3. **Périmètre** : la liste des modules ouvrables n'existe pas.
4. **Finances internes** : AUDIT_VIEW, BUDGET_VIEW et EXPENSE_VIEW donnent
   « B » à l'administrateur, mais D183, D185 et D187 réservent ces données
   à l'entreprise sans prévoir le support.
5. **Lecture seule ou intervention** : UC030 dit « intervenir » ; la piste
   du fondateur dit « lecture seule ».
6. **Audit du chantier** : R025 et AUDIT_VIEW ouvrent l'audit au
   « support exceptionnel », alors que D195 E6 dit « jamais l'audit des
   chantiers ». **Contradiction.**
7. **Visibilité pour les membres** : D186 interdit au propriétaire la
   lecture de l'audit, alors que la piste veut des accès « visibles des
   membres ». Il faut un canal dédié.
8. **Notification** (FR160, AC160) : B045 n'est pas faite, et D195 E1 a
   reporté les notifications.
9. **Authentification renforcée** (`strong_admin_auth`) : aucun mécanisme
   n'existe.

## 4. Décisions attendues (A = recommandation)

- **S1. Déclenchement et approbation.**
  - **A** : un membre habilité **demande** l'aide et **donne son accord**
    dans l'application. L'accord vaut approbation (BR089). L'administrateur
    ne peut rien ouvrir sans cet accord.
  - **B** : l'administrateur ouvre seul, avec dossier et motif ;
    approbation a posteriori.
  - **C** : approbation par un second administrateur.
  - *Recommandation A.* C'est le seul choix réaliste avec un administrateur
    unique, et il respecte D057.
- **S2. Qui peut demander et accorder.**
  - **A** : l'entreprise et le propriétaire principal, chacun pour ce
    qu'il voit lui-même. Un membre ne peut jamais ouvrir ce qu'il ne voit
    pas.
  - **B** : tout membre actif, y compris le copropriétaire et le chef de
    chantier, limité à ce qu'il voit.
  - **C** : le propriétaire principal seul.
  - *Recommandation A* : les deux parties principales, comme pour les
    licences (D193).
- **S3. Dossier support (FR157).**
  - **A** : la demande d'aide **est** le dossier. Elle contient :
    catégorie (problème technique, accès, données, autre), description de
    10 à 1000 caractères, modules proposés, et accord oui/non.
    L'administrateur voit la catégorie, l'identifiant court du chantier,
    le rôle du demandeur, les dates et le statut. Il ne voit la
    description qu'après avoir pris le dossier en charge, et cette lecture
    est auditée.
  - **B** : dossier créé par l'administrateur à partir d'un échange hors
    application.
  - *Recommandation A.*
- **S4. Périmètre ouvrable** (choix de plusieurs modules, au moins un).
  - **A** : journal publié, incidents, photos publiées, documents (selon
    la visibilité du demandeur), avancement et étapes, commentaires,
    équipe (rôles seulement, sans coordonnées). Les plans validés en plus
    si utiles.
  - **B** : A plus les devis, avenants et versements.
  - *Recommandation A* : le contractuel reste hors support au MVP.
- **S5. Finances internes** (budget, dépenses, reçus, synthèse interne).
  - **A** : jamais ouvrables au MVP, quel que soit l'accord.
  - **B** : seulement par l'entreprise, module « finances internes »
    coché explicitement, avec une mention rappelant que le propriétaire
    n'en saura rien.
  - *Recommandation A* au MVP. B peut être ajouté plus tard sans rien
    casser.
- **S6. Lecture seule.**
  - **A** : lecture seule stricte. Aucune écriture, aucune correction pour
    le compte d'un membre ; « intervenir » (UC030) signifie diagnostiquer
    et expliquer.
  - **B** : quelques gestes de dépannage audités, par exemple relancer un
    envoi bloqué.
  - *Recommandation A.*
- **S7. Durée et fin.**
  - **A** : 15, 30 ou 60 minutes (FORM_SCHEMAS), choisies par le membre
    dans son accord ; l'administrateur ne peut pas prolonger (un nouvel
    accord est nécessaire). Le membre qui a accordé l'accès, ou
    l'administrateur, peut révoquer à tout moment. L'expiration est
    contrôlée en base à chaque lecture. Les liens de fichiers expirent au
    plus tard à la fin de l'accès.
  - **B** : durée choisie par l'administrateur dans ces mêmes bornes.
  - *Recommandation A.*
- **S8. Audit et visibilité pour les membres** (corrige les contradictions
  §3.6 et §3.7).
  - **A** :
    - chaque accord, ouverture, lecture (module et objet consulté), fin
      et révocation est inscrit dans un journal d'accès support dédié ;
    - les **deux parties principales** voient ce journal sur une page
      « Accès support » du chantier, par une fonction filtrée qui ne passe
      pas par l'audit du chantier, ce qui respecte D186 ;
    - l'administrateur ne lit jamais l'audit du chantier (D195 E6
      maintenue) ; AUDIT_VIEW et R025 sont corrigées en ce sens.
  - **B** : visible de tous les membres actifs.
  - *Recommandation A.*
- **S9. Notification** (FR160).
  - **A** : au MVP, avis dans l'application : bandeau « Accès support en
    cours jusqu'à HH:MM » sur le chantier, et ligne dans la page « Accès
    support ». E-mail et notification interne avec B045. FR160 est
    précisée en ce sens.
  - **B** : attendre B045 avant B051.
  - *Recommandation A.*
- **S10. Authentification renforcée** (`strong_admin_auth`).
  - **A** : au MVP, une session administrateur de moins de 15 minutes
    est exigée pour ouvrir un accès, contrôlée côté serveur ; au-delà,
    reconnexion. La double authentification est notée avant la mise en
    ligne (rejoint le point ouvert « compte administrateur dédié »).
  - **B** : double authentification dès B051.
  - *Recommandation A.*

## 5. Réalisation prévue après décision

- **M051** (accord requis) :
  - tables : `support_requests` (dossier) ; `support_access_grants`
    (accord, périmètre, durée, insertion seule plus révocation) ;
    `support_access_events` (journal d'accès, insertion seule) ;
  - fonctions de demande et d'accord (membre) ; de prise en charge,
    d'ouverture et de lecture par module (administrateur, lecture seule,
    `has_support_scope` contrôlé à chaque appel) ; de révocation ; de
    lecture du journal d'accès (parties principales).
- **Tests**
  - Aucun accès sans dossier, motif ou accord, ni hors périmètre ; aucun
    accès après expiration ou révocation (verrou réel si une attente est
    testée).
  - Lecture seule : toute écriture de l'administrateur est refusée.
  - Finances internes jamais ouvertes (S5 A).
  - Audit complet de chaque lecture.
  - Le scanner de `test-admin-console` est étendu aux fonctions support,
    avec un contrôle positif capable d'échouer (R15).
- **Écrans**
  - Membre : « Demander de l'aide » et page « Accès support » du chantier,
    avec bandeau.
  - Administrateur : `/admin/support` (SCR063) et accès exceptionnel avec
    compte à rebours (SCR064).
  - Vérification navigateur sur ordinateur et à 390 px.
