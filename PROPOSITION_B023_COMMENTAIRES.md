# Proposition B023 — commentaires attribués

Boucle 30, étape 1 (2026-10-08). Aucun code, aucune migration : des règles
manquent et une règle contredit le principe du fondateur (§3) ; décisions
C1 à C7 attendues.

## 1. Sources citées

- **B023** (MVP_BACKLOG, lot L03, P1, dépend de B022) : « Ajouter
  commentaires attribués » ; done_when : « modération reste visible ».
- **BR039** : « Un commentaire conserve auteur et heure; retrait ou
  modération reste visible comme événement. »
- **FR059** (journal, SHOULD) : « Commenter un journal publié. » — acteurs :
  Owner|Contractor. **AC059** : « OWNER ou CONTRACTOR commente » →
  « commentaire attribué apparaît dans le fil ».
- **FR103** (incident, MUST) : « Ajouter photos et commentaires à un
  incident. » — acteurs : AuthorizedMember. **AC103** : « élément est lié et
  visible selon permissions ».
- **T017** (DATABASE_TABLES) : `comments`, « Commentaires attribués sur
  objets autorisés », append-only + modération visible.
- **MIGRATION_ORDER M009** : « daily_logs versions comments » (conception ;
  les journaux sont réalisés par M036/M037, sans commentaires).
- **PERMISSIONS** : aucune ligne pour les commentaires (ni créer, ni voir, ni
  corriger, ni modérer).
- **Visibilité des éléments candidats** (PERMISSIONS) : JOURNAL_VIEW
  (publiés) et INCIDENT_VIEW : les quatre rôles actifs ; MEDIA_VIEW publié :
  quatre rôles ; DOCUMENT_VIEW : selon la visibilité de chaque document.
- **Principe du fondateur (boucle 30)** : un commentaire ne porte que sur un
  élément partagé visible par son auteur, jamais sur un élément interne
  (dépenses, budget, reçus, documents « Entreprise seulement », brouillons) ;
  un commentaire hérite au plus de la visibilité de l'élément commenté.
- **D183, D186** : confidentialité des finances internes ; audit lisible par
  l'entreprise seule.

## 2. Ce qui est établi

- Auteur et heure conservés ; retrait et modération visibles comme
  événements (BR039, B023).
- Aucun commentaire sur un élément interne ni sur un brouillon (principe).
- Visibilité du commentaire = visibilité de l'élément commenté, au plus.
- Insertion seule (T017) : aucune correction n'efface l'original.

## 3. Décisions attendues (A = recommandation)

- **C1. Éléments commentables.**
  - **A** : journaux publiés (FR059) et incidents (FR103) ; les deux sont
    lisibles par les quatre rôles actifs.
  - **B** : journaux publiés seulement (B023 dépend de B022).
  - **C** : A + photos publiées et documents partagés (visibilité par
    document).
  - *Recommandation A* : les deux exigences écrites, sur deux éléments déjà
    partagés à tous ; C plus tard.
- **C2. Qui commente** — contradiction : FR059 réserve le commentaire du
  journal au propriétaire et à l'entreprise, alors que le principe ouvre le
  commentaire à quiconque voit l'élément, et que FR103 l'ouvre à tout membre
  autorisé.
  - **A** : tout membre actif qui voit l'élément (propriétaire principal,
    copropriétaire, entreprise, chef de chantier) ; FR059 révisée.
  - **B** : FR059 à la lettre pour les journaux (propriétaires et
    entreprise, pas le chef de chantier) ; FR103 pour les incidents.
  - *Recommandation A* : une seule règle, celle du principe.
- **C3. Correction.**
  - **A** : par l'auteur seul, nouvelle version ; l'original reste lisible
    dans l'historique du commentaire, mention « modifié » dans le fil.
  - **B** : aucune correction ; retrait puis nouveau commentaire.
  - *Recommandation A*.
- **C4. Retrait et modération** (BR039, done_when).
  - **A** : l'auteur retire son commentaire ; l'entreprise et le
    propriétaire principal peuvent le modérer avec un motif obligatoire ;
    dans les deux cas le fil garde un événement « retiré par … le … »
    (motif pour la modération) et le texte n'y est plus affiché ; le texte
    reste conservé en base, jamais supprimé.
  - **B** : seul l'auteur retire ; aucune modération par un tiers.
  - **C** : comme A, mais le texte modéré reste lisible, barré.
  - *Recommandation A*.
- **C5. Attribution.**
  - **A** : rôle de l'auteur au moment du commentaire (« le chef de
    chantier », « le propriétaire principal »…) et « vous » ; aucun nom,
    comme les journaux, incidents et documents actuels.
  - **B** : nom affiché du profil.
  - *Recommandation A* : aucune nouvelle donnée personnelle exposée.
- **C6. Élément qui change d'état.**
  - **A** : on peut commenter un journal publié (même corrigé ; le
    commentaire note la version en vigueur) et un incident quel que soit son
    état, clos et annulé compris (historique).
  - **B** : plus de commentaire sur un incident clos ou annulé.
  - *Recommandation B pour les incidents* (un incident clos ne se rouvre
    pas, D162 : le fil reste lisible) *et A pour les journaux*.
- **C7. Ex-membre.**
  - **A** : ses commentaires restent visibles, attribués à son rôle d'alors
    avec la mention « ancien membre » ; il n'a plus aucun accès.
  - *Recommandation A* (BR039 : l'auteur est conservé).

## 4. Réalisation prévue après décision

- **M047** (accord requis) : `comments` (élément commenté par type et
  identifiant, chantier, auteur, rôle), `comment_versions` (texte, insertion
  seule), `comment_events` (retrait, modération, motif) ; fonctions
  `add_comment`, `correct_comment`, `retract_comment`, `moderate_comment`,
  `list_comments` qui revérifient que l'appelant voit l'élément (fonctions de
  lecture existantes du journal et de l'incident) ; tables fermées ; audit.
- Tests des droits : auteur attribué ; élément invisible ou interne →
  commentaire refusé et jamais listé ; non-membre et ex-membre : rien ;
  aucune correction n'efface l'original ; modération visible.
- Non-régression D183 : test-file-cross-access, test-internal-budget,
  test-expenses, test-dashboard.
- Écran : fil de commentaires sous chaque journal publié et chaque incident ;
  navigateur ordinateur et 390 px pour les quatre rôles.
