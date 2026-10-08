# Proposition B048 — déclaration de paiement de licence

Boucle 31, étape 1 (2026-10-08). Aucun code, aucune migration : des règles
manquent et deux règles existantes lient une capacité d'écriture à la
licence (§3, condition d'arrêt) ; décisions L1 à L9 attendues du fondateur.

## 1. Sources citées

- **Backlog (lot L08)**
  - **B048** « Déclarer paiement de licence » (dépend de B026, B014) ;
    done_when : « preuve et statut PENDING_REVIEW ».
  - **B049** « Créer activation manuelle administrateur » ; done_when :
    « payeur ne gagne aucun droit ».
  - **B050** « Créer interface admin à métadonnées minimales » ; done_when :
    « contenus privés absents ».
  - **B051** « Créer accès support limité et expirant » ; done_when : « motif
    périmètre et audit obligatoires ».
- **Règles**
  - **BR081** : prix affiché, durée, contenu, statut et référence de paiement
    présentés avant confirmation.
  - **BR082** : le payeur peut être OWNER ou CONTRACTOR ; la transaction ne
    modifie jamais rôle ou permission.
  - **BR083** : activation manuelle avec référence, montant, date, opérateur,
    vérificateur et audit ; aucun secret Mobile Money stocké.
  - **BR084** : expiration → notifications, grâce de 30 jours, **lecture
    seule**, le renouvellement réactive les écritures autorisées.
  - **BR085** : aucune suppression à l'expiration.
  - **BR088** : l'administrateur plateforme n'accède pas par défaut aux
    contenus privés.
- **Exigences**
  - FR141 (consulter les formules et payer par le moyen proposé), FR142
    (une seule partie paie sans modifier ses permissions), FR143 (activation
    manuelle par l'administrateur).
  - FR144 à FR147 (échéance, grâce, lecture seule, renouvellement), FR148
    (aucune suppression).
  - AC142 : « aucun rôle ou droit n'a changé ».
- **Décisions**
  - D003 : l'une des deux parties peut payer.
  - D004 et D081 : le paiement ne confère aucun droit.
  - D012 : licence de 12 mois, grâce de 30 jours, lecture seule ensuite.
  - D016 : activation Mobile Money manuelle au pilote.
  - D019 et D057 : l'administrateur n'a pas d'accès ordinaire aux contenus
    privés.
  - D034 (**PROPOSED**, non validée) : avertissements obligatoires pour le
    paiement de licence.
  - O005 (ouverte) : « prix final et volonté de payer ».
- **Droits (PERMISSIONS)**
  - LICENSE_PAY `A,C,A,N,N` : propriétaire principal A, copropriétaire **C**,
    entreprise A, chef de chantier N ; « le payeur ne gagne aucun droit ».
  - LICENSE_ACTIVATE : administrateur seul.
  - LICENSE_VIEW `A,A,A,C,A` : chef de chantier en « lecture simple de
    l'état ».
- **Modèle prévu**
  - STATE_MACHINES `license` : PENDING → ACTIVE (« paiement vérifié ou
    pilote ») → EXPIRING → GRACE → READ_ONLY, puis ACTIVE au renouvellement ;
    CANCELLED.
  - STATE_MACHINES `project` : DRAFT → ACTIVE exige « licence ou pilote » ;
    ACTIVE → READ_ONLY à la fin de la grâce.
  - Tables T034 `project_licenses`, T035 `license_payments` (insertion
    seule) ; MIGRATION_ORDER M017 (« droits indépendants du paiement »).
  - API057 `license.declare_payment` : operation_uuid, project_id, amount,
    operator, reference, paid_at, proof_asset_id → payment PENDING_REVIEW.
  - FORM_SCHEMAS `license_payment` : formule (verrouillée), nom du payeur,
    opérateur (Orange Money, Moov Money, autre), référence (4 à 120),
    date de paiement (pas dans le futur), reçu obligatoire (1).
  - Écrans SCR051 (licence du chantier), SCR052 (déclarer un paiement),
    SCR062 (licences à vérifier, admin).
  - Cas limites EC058 (paiement introuvable : rester en attente), EC060 (deux
    parties paient : ne pas doubler, signaler au support).
- **Existant** : aucune table de licence ni de paiement de licence en base ;
  aucun écran.

## 2. Ce qui est établi pour B048

- La déclaration ne détient ni ne transfère d'argent : elle enregistre une
  référence externe et une preuve, au statut PENDING_REVIEW.
- Le payeur ne gagne aucun droit (D004, BR082, AC142).
- Aucune donnée sensible : pas de numéro de carte ou de compte, pas de code ni
  de secret Mobile Money (BR083) ; seulement opérateur, référence externe,
  montant, date et preuve.
- La preuve est stockée dans un compartiment privé dédié, avec contrôle du
  type réel (comme M039 et M046).

## 3. Règle liant une capacité d'écriture à la licence (signalée)

- **BR084 / FR145** : après la grâce, le chantier passe en lecture seule pour
  tous ses membres ; le renouvellement réactive les écritures.
- **STATE_MACHINES `project`** : un chantier ne devient ACTIVE qu'avec
  « licence ou pilote ».
- Ces règles ne donnent aucun droit au payeur, mais elles font dépendre la
  **possibilité d'écrire sur le chantier** de l'état de la licence, donc
  indirectement d'un paiement. Elles ne sont pas nécessaires à B048
  (déclaration) ; elles le seront pour l'expiration.
- **L1** (à trancher avant toute tâche qui les applique) :
  - **A** : l'état de la licence peut restreindre les écritures de **tous**
    les membres, à l'identique (droit de service, non droit de rôle) ; le
    paiement ne donne jamais un droit à une partie plutôt qu'à une autre.
    BR084 conservée telle quelle.
  - **B** : aucune restriction liée à la licence au pilote (bandeau
    d'information seulement) ; BR084 reportée.
  - **C** : restriction limitée à la création de nouveaux chantiers, jamais
    sur un chantier existant.
  - *Recommandation A* : c'est la lettre de D012, et elle respecte « le
    payeur ne gagne aucun droit » ; à confirmer explicitement.

## 4. Règles manquantes pour B048 (A = recommandation)

- **L2. Formule, prix, durée affichés** (BR081, FR141) : aucun prix n'est
  défini (O005 ouverte) ; la règle R13 interdit d'en inventer.
  - **A** : une seule formule « Licence chantier 12 mois » (D012), au prix
    fixé par le fondateur dans un paramètre de plateforme ; sans prix fixé,
    la déclaration est impossible.
  - **B** : formule unique, montant saisi par le déclarant, prix affiché
    « à confirmer avec ChantierLive ».
  - **C** : reporter B048 jusqu'à la fixation du prix.
  - *Recommandation A*, avec le prix à me donner.
- **L3. Copropriétaire** (LICENSE_PAY « C ») : la condition n'est écrite
  nulle part.
  - **A** : non au MVP, comme QUOTE_DECIDE et CHANGE_ORDER_DECIDE (D112,
    D117) ; seuls le propriétaire principal et l'entreprise déclarent.
  - **B** : oui, comme le propriétaire principal.
  - *Recommandation A*.
- **L4. Qui voit une déclaration et sa preuve.**
  - **A** : le propriétaire principal et l'entreprise voient toutes les
    déclarations et preuves du chantier ; le copropriétaire voit les
    déclarations sans la preuve ; le chef de chantier voit seulement l'état
    de la licence (LICENSE_VIEW « C »).
  - **B** : chaque déclarant ne voit que sa propre déclaration.
  - *Recommandation A* : les deux parties savent si la licence est payée,
    ce qui évite un double paiement (EC060).
- **L5. Accès de l'administrateur à la preuve** (pour B049) : D019 et D057
  excluent l'accès ordinaire aux contenus privés.
  - **A** : la preuve de paiement de licence n'est pas un contenu de
    chantier ; elle est lisible par l'administrateur pour la vérification,
    avec audit, et seulement elle.
  - **B** : l'administrateur vérifie sans voir la preuve (référence et
    montant seulement).
  - *Recommandation A* (à appliquer en B049, pas en B048).
- **L6. Données du formulaire.** FORM_SCHEMAS demande le « nom du payeur ».
  - **A** : nom du payeur facultatif, opérateur, référence, montant, date,
    preuve ; jamais de numéro de téléphone, de carte ou de compte (refus
    explicite d'une référence qui ressemble à un numéro de carte).
  - **B** : nom du payeur obligatoire, comme FORM_SCHEMAS.
  - *Recommandation A* : moins de données personnelles.
- **L7. Avertissement** (D034 seulement PROPOSED).
  - **A** : avertissement obligatoire et accusé de lecture, comme pour les
    acomptes (« ChantierLive ne détient ni ne transfère d'argent ; la
    licence n'est active qu'après vérification »).
  - **B** : texte d'information sans accusé.
  - *Recommandation A* ; D034 validée pour la licence.
- **L8. Plusieurs déclarations** (EC060).
  - **A** : plusieurs déclarations possibles, chacune en PENDING_REVIEW,
    avec une alerte « une déclaration est déjà en attente » ; aucune durée
    doublée (B049 tranchera).
  - **B** : une seule déclaration en attente par chantier.
  - *Recommandation A*.
- **L9. Retrait d'une déclaration avant vérification.**
  - **A** : le déclarant peut l'annuler avec motif tant qu'elle est en
    PENDING_REVIEW (contre-écriture, comme D132 pour les acomptes) ; rien
    n'est supprimé.
  - **B** : aucune annulation ; seul l'administrateur rejette.
  - *Recommandation A*.

## 5. Réalisation prévue après décision

- **M048** (accord requis) :
  - tables `project_licenses` (état PENDING tant que rien n'est activé) et
    `license_payments` (insertion seule, statut PENDING_REVIEW, annulation
    par contre-écriture) ;
  - compartiment privé `license-proofs` et type d'envoi `license_proof`
    (branche ajoutée comme M039/M046) ;
  - fonctions `declare_license_payment`, `list_license_payments`,
    `get_license_proof_file_key`, `cancel_license_payment`,
    `get_project_license`.
- **Tests** :
  - droits : principal et entreprise déclarent, copropriétaire selon L3,
    chef de chantier, non-membre et ex-membre refusés ;
  - aucun rôle ni permission modifié après une déclaration (AC142) ;
  - refus des données sensibles ; type réel de la preuve ;
  - `test-file-cross-access` étendu à `license-proofs` ;
  - non-régression D183.
- **Écrans** SCR051 et SCR052 ; navigateur ordinateur et 390 px.
