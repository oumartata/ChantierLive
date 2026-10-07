# Proposition D4 — Finances internes (ESPACES-4 / B030, B031, B032)

**Statut : proposition, aucune décision prise sur le contenu ci-dessous.**
Rédigée le 2026-10-07 (boucle 22b). Aucun code, aucune migration, aucune
donnée modifiés.

**Cadre déjà décidé (D183, 2026-10-07)** : le propriétaire (principal et
copropriétaire) n'accède jamais aux dépenses internes, budgets internes,
justificatifs, marges, ni à aucun total, compteur, tableau de bord, rapport
ou export qui en dérive ; aucune exception de seuil ni d'activation. Les
décisions sur les dépenses sont internes à l'entreprise : le chef de
chantier saisit et demande, l'entreprise approuve, refuse ou conteste.

## 1. Ce que disent les règles

### 1.1 Backlog

| Tâche | Libellé | Dépend de | done_when |
|---|---|---|---|
| B030 | Créer budget prévisionnel interne et révisions (privé, distinct du montant contractuel) | B014 | « montants bigint FCFA; budget privé par défaut sans exception de seuil (BR099) » |
| B031 | Créer et publier dépenses | B030 | « totaux dérivés des écritures actives » |
| B032 | Associer reçus facultatifs | B026 ; B031 | « absence et justification gérées » |
| B034 (anticipation) | Créer demandes et décisions d'approbation | B031 | « décision vise version exacte » |
| B035 (anticipation) | Corriger ou annuler finance validée | B031 | « contre-écriture liée obligatoire » |

### 1.2 Décisions et règles liées

- **D085** : le montant contractuel vient du seul devis accepté, augmenté
  des avenants acceptés ; une estimation reste non contractuelle.
- **D086, D090, D183** : dépenses, justificatifs et budget internes privés
  envers le client. Depuis D183, il n'y a plus aucune exception.
- **Règles métier**
  - BR045 : budget déclaratif, en FCFA ; une révision conserve l'ancienne
    valeur.
  - BR046 : totaux dérivés des écritures actives ; écritures annulées
    exclues mais consultables.
  - BR047 : montant positif, devise, date, catégorie et déclarant
    obligatoires ; fournisseur facultatif.
  - BR048 : reçu facultatif ; son absence peut exiger une justification
    écrite, selon le chantier.
  - BR049 : le chef de chantier prépare, l'entreprise publie, sauf
    délégation.
  - BR050 (révisée par D183) : décisions internes à l'entreprise.
  - BR051 : une opération validée n'est jamais modifiée sur place ; on
    corrige par une contre-écriture liée.
  - BR052 : le dépassement du budget informe sans bloquer.
  - BR098 (révisée par D183) : privé sans exception, totaux, compteurs et
    rapports compris.
  - BR099 : budget interne sans exception de seuil.
- **Droits (PERMISSIONS, après D183)**

  | Code | Propriétaire principal | Copropriétaire | Entreprise | Chef de chantier | Plateforme |
  |---|---|---|---|---|---|
  | BUDGET_VIEW | N | N | A | C | B |
  | BUDGET_SET_INITIAL | N | N | A | N | N |
  | BUDGET_CHANGE_REQUEST | N | N | A | N | N |
  | EXPENSE_CREATE_DRAFT | N | N | A | A | N |
  | EXPENSE_PUBLISH | N | N | A | C (délégation) | N |
  | EXPENSE_VIEW | N | N | A | A | B |
  | EXPENSE_DECIDE (ajouté par D183) | N | N | A | N | N |
  | EXPENSE_CORRECT_VALIDATED | N | N | A | N | B |

- **STATE_MACHINES `financial_record`** (dépenses et versions de budget) :
  brouillon → publiée → approuvée, refusée ou contestée → remplacée ou
  annulée. Depuis D183, les décisions sont internes à l'entreprise,
  contestation comprise.
- **D7 (question `approval_status`)**
  - Tranché par D183 : les approbations de dépenses sont internes.
  - Reste ouvert : la forme générale des demandes d'approbation (T030 et
    T031) pour les autres objets, et la suppression de compte.
- **Exigences**
  - FR069 et FR070 : budget et vue interne complète.
  - FR071 à FR075 : brouillon, champs, reçu, hors connexion, publication.
  - FR076 : décision.
  - FR077 : historique.
  - FR078 : correction.
  - FR079 : totaux.
  - FR080 : alerte de dépassement.
  - FR081 et FR082 : filtres et export.
  - FR083 : quota média sans effet sur les écritures.
  - Critères d'acceptation AC069 à AC083.
- **Conception technique**
  - Tables : T022 `budgets`, T023 `budget_versions`, T024
    `expense_categories`, T025 `expenses`, T026 `expense_versions`, T027
    `receipts`, T030 et T031 (approbations génériques).
  - MIGRATION_ORDER : M012 (budgets), M013 (dépenses, versions, reçus), M015
    (approbations). Ces identifiants de conception ne sont jamais réutilisés
    comme noms de fichier.

## 2. Reprise de l'existant

- **`PREPARATION_ETAPES_DEPENSES_INTERNES.md` §2**
  - La lecture conditionnelle d'EXPENSE_VIEW par le propriétaire principal
    était ambiguë (BR050 contre D086).
  - Votre décision du 2026-10-03 (§2.2) l'a remplacée par un refus sans
    condition ; D183 l'a consignée et étendue.
  - Matrice proposée (§2.3) : propriétaire N en lecture, sur les
    justificatifs et sur les marges.
  - Exigences techniques (§2.3) :
    - refus côté serveur avant toute sélection, comme
      `get_project_financial_summary` ;
    - lien signé émis seulement après le même contrôle ;
    - RLS excluant explicitement le propriétaire.
  - Budget (§2.4) : déjà strictement privé.
- **État d'ESPACES-4 : non commencé.**
  - Aucune table de budget interne, de dépense, de reçu de dépense ou
    d'approbation n'existe en base ou dans les migrations.
  - `/entreprise/depenses` est une page d'attente qui n'affiche aucun
    montant. Son texte cite encore l'exception de BR050, devenue caduque :
    il est à corriger au premier lot de code.
- **Garanties déjà en place, réutilisables**
  - `get_project_financial_summary` (M028) ne lit ni budget ni dépense,
    selon son en-tête.
  - Le stockage n'a aucune politique d'accès direct, et les liens signés
    passent par une fonction de contrôle (B029, `test-file-cross-access`).
  - Le modèle « justificatif privé » des acomptes (M014,
    `advance-receipts`) est un modèle d'envoi éprouvé.

## 3. Modèle proposé

### 3.1 Tables

| Table | Rôle | Mutabilité |
|---|---|---|
| `budgets` | Un budget interne par chantier : pointeur vers la version courante | Pointeur seulement |
| `budget_versions` | Montant en FCFA (entier `bigint`), motif, auteur, date serveur | Insertion seule |
| `expenses` | Identité d'une dépense : chantier, état, révision, version courante | État et pointeur |
| `expense_versions` | Montant, date, catégorie, fournisseur facultatif, note, étape facultative, auteur et rôle ; lien vers la version remplacée ; contre-écriture d'annulation | Insertion seule |
| `expense_decisions` | Décision interne : approuvée, refusée ou contestée, sur une version exacte, avec motif | Insertion seule |
| `expense_receipts` + `private_object_uploads` (type `expense_receipt`, compartiment privé `expense-receipts`) | Justificatif lié à une version de dépense | Insertion seule, retrait visible |

Les totaux ne sont jamais stockés : ils sont calculés à chaque lecture sur
les écritures actives (BR046, AC079), dans des fonctions réservées à
l'entreprise et au chef de chantier.

### 3.2 Droits

| Action | Propriétaire principal | Copropriétaire | Entreprise | Chef de chantier |
|---|---|---|---|---|
| Voir budget, dépenses, totaux, reçus | **N** | **N** | A | A pour les dépenses ; budget : C (BUDGET_VIEW) |
| Déclarer ou réviser le budget | N | N | A | N |
| Créer un brouillon de dépense | N | N | A | A |
| Publier, ou soumettre à l'entreprise | N | N | A (publie) | soumet (F4) |
| Approuver, refuser, contester | N | N | A | N (variante F4 : contester) |
| Corriger ou annuler (contre-écriture) | N | N | A | N |
| Joindre un reçu | N | N | A | A (ses dépenses) |

### 3.3 Garantie « jamais, à aucun niveau » pour le propriétaire

| Surface | Mécanisme | Preuve prévue |
|---|---|---|
| Tables | RLS activée, tous privilèges révoqués (comme M033 à M042) | Lecture directe refusée (42501) |
| Listes, détail, versions, décisions | Fonction serveur : rôle vérifié avant toute sélection ; le propriétaire reçoit `not_authorized`, comme un non-membre | Test des droits pour chaque fonction |
| Totaux, compteurs, alerte de dépassement | Calculés seulement dans les fonctions de l'entreprise ; aucune fonction lisible par le propriétaire ne les contient | Test : `get_project_financial_summary` et les fonctions de la fiche chantier n'en contiennent aucune trace |
| Justificatifs (fichiers) | Compartiment dédié `expense-receipts` ; aucune politique d'accès direct ; clé délivrée seulement à l'entreprise et au chef de chantier | Extension de `test-file-cross-access` (propriétaire, non-membre, chemin forgé) |
| Menus et écrans | Aucun lien « Dépenses » dans le menu propriétaire ; écrans dans l'espace entreprise | Parcours navigateur propriétaire : absent du code de la page |
| Tableaux de bord (B044) | Sources du tableau de bord propriétaire limitées au montant contractuel, aux paiements, au reste dû, aux étapes et aux photos (FR172, D143) | Test du futur tableau de bord |
| Rapports et exports (B046, FR082) | Périmètre calculé au moment de la génération (BR053) ; aucune donnée interne dans un rapport propriétaire | Test du futur rapport |
| Notifications (B045) | Aucun événement de dépense notifié au propriétaire | Test de B045 |
| Historique des étapes (M040) | Les dépenses liées à une étape n'apparaissent jamais dans l'historique ni dans les mesures d'avancement visibles du propriétaire | Test : historique d'étape inchangé après liaison d'une dépense |
| Journal d'audit | `audit_events` jamais exposé au propriétaire (déjà le cas) | Inchangé |

## 4. Liens avec les étapes (M040) et les documents (M039)

- **Étapes** : FR072 et FR081 prévoient l'étape d'une dépense.
  - Je propose un lien facultatif `expense_versions.phase_id`, avec les
    mêmes règles que D182 : étape active, plan publié, même chantier, clé
    étrangère composite.
  - Le lien suit les versions : le changer passe par une correction.
  - Il sert seulement aux filtres internes et n'entre jamais dans les
    mesures d'avancement de D177.
- **Documents** : le reçu de dépense **n'est pas** un document M039.
  - Un document « Entreprise seulement » reste lisible par toute
    l'entreprise, mais il vit dans un compartiment et un circuit pensés pour
    être partageables. Le justificatif interne doit rester dans un
    compartiment dédié, sans visibilité réglable, pour qu'aucune erreur de
    réglage ne l'expose.
  - Une facture fournisseur peut toujours être déposée en plus comme
    document « Entreprise seulement ». Aucun lien automatique n'est prévu.

## 5. Décisions attendues (A = recommandation)

- **F1. Catégories de dépenses** (BR047, T024).
  - **A** : liste système fermée : matériaux, main-d'œuvre, transport,
    location de matériel, sous-traitance, frais divers, autre.
  - **B** : liste système plus catégories propres au chantier (T024).
  - **C** : texte libre.
  - *Recommandation A* : des totaux par catégorie fiables, et rien à
    administrer.
- **F2. Forme du budget interne** (B030).
  - **A** : un montant global par chantier, versionné avec motif (D090).
  - **B** : un montant par catégorie.
  - **C** : un montant par étape.
  - *Recommandation A* : le done_when ne demande pas plus ; B et C
    pourront venir en V1.
- **F3. Chef de chantier** (BR049, EXPENSE_PUBLISH C).
  - **A** : il saisit et soumet ; seule l'entreprise publie ; aucune
    délégation pour l'instant.
  - **B** : délégation de publication dès maintenant.
  - **C** : il ne saisit pas.
  - *Recommandation A*, cohérente avec D179 pour les étapes.
- **F4. Circuit d'approbation** (B034, D183).
  - **A** : une dépense saisie par le chef de chantier est soumise à
    l'entreprise, qui l'approuve (elle devient publiée et approuvée) ou la
    refuse avec motif. Une dépense saisie par l'entreprise est publiée
    approuvée directement. La contestation, motivée, est réservée à
    l'entreprise (EXPENSE_DECIDE, D183). Variante à trancher : ouvrir aussi
    la contestation au chef de chantier, ce qui demanderait de réviser
    EXPENSE_DECIDE.
  - **B** : toute dépense est publiée, puis approuvée à part, y compris
    celles de l'entreprise.
  - **C** : aucune approbation : la publication vaut validation.
  - *Recommandation A* : elle respecte « décision vise version exacte » sans
    double saisie pour l'entreprise.
- **F5. Reçu absent** (BR048, done_when de B032).
  - **A** : justification écrite toujours facultative.
  - **B** : justification obligatoire dès qu'il n'y a pas de reçu.
  - **C** : réglage par chantier, désactivé par défaut, qui rend la
    justification obligatoire.
  - *Recommandation C* : c'est la lettre de BR048 (« selon le chantier »).
- **F6. Stockage des reçus.**
  - **A** : compartiment dédié `expense-receipts`, sur le modèle de M014.
  - **B** : documents M039 en « Entreprise seulement ».
  - **C** : compartiment des photos.
  - *Recommandation A* (voir §4).
- **F7. Correction et annulation** (B035, BR051).
  - **A** : contre-écriture liée : nouvelle version ou écriture
    d'annulation, motif obligatoire ; l'original reste consultable ; les
    totaux l'excluent. Faite par l'entreprise.
  - **B** : modification sur place avec motif.
  - **C** : annulation seulement, sans correction.
  - *Recommandation A* : BR051 l'impose.
- **F8. Dépassement du budget** (FR080, BR052).
  - **A** : alerte affichée dans l'espace entreprise seulement, sans
    blocage.
  - **B** : alerte, plus une notification interne (B045, plus tard).
  - **C** : blocage.
  - *Recommandation A*, puis B quand B045 existera.
- **F9. Hors connexion** (FR074) : reporté avec le hors-ligne général, comme
  pour le journal (D161).
- **F10. Étape d'une dépense** (FR072) : lien facultatif selon les règles de
  D182 (§4). *Recommandation : oui.*

## 6. Découpage proposé

| Boucle | Tâche | Migration probable | Contenu | Preuves |
|---|---|---|---|---|
| 1 | B030 | M043 | `budgets`, `budget_versions`, fonctions entreprise, écran Budget interne dans l'espace entreprise ; correction du texte de `/entreprise/depenses` | Droits : propriétaire et non-membre refusés partout ; montants entiers ; versions immuables |
| 2 | B031 | M044 | `expenses`, `expense_versions`, catégories (F1), totaux dérivés, lien d'étape (F10), écrans liste, création et détail | Totaux = écritures actives ; propriétaire refusé (liste, total, compteur) ; synthèse financière inchangée |
| 3 | B032 | M045 | Compartiment `expense-receipts`, type d'envoi `expense_receipt` (branche ajoutée comme M039), reçu facultatif, justification (F5) | `test-file-cross-access` étendu ; type réel contrôlé |
| 4 | B034 et B035 | M046 | `expense_decisions` (F4), contre-écritures (F7), historique | Décision sur une version exacte ; contre-écriture obligatoire ; aucune trace côté propriétaire |

Chaque boucle reprendra le contrôle de non-régression de
`test-file-cross-access` et un parcours propriétaire vérifiant l'absence de
toute donnée interne, jusque dans le code de la page.

## 7. Risques

- **Fuite par un agrégat** : un total ou un compteur ajouté plus tard dans
  une fonction lisible du propriétaire. Parade : test dédié qui scrute les
  fonctions de la fiche et de la synthèse du propriétaire.
- **Confusion entre l'enveloppe indicative partagée (D143) et le budget
  interne** : libellés distincts imposés à l'écran (« Enveloppe indicative »
  contre « Budget interne »).
- **Délégation future du chef de chantier (F3 B)** : elle ne doit jamais
  ouvrir de lecture au propriétaire.
