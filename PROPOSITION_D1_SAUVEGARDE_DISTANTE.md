# Proposition — décision D1 : sauvegarde distante de la branche de travail

Rédigé le 2026-10-06, en lecture seule, à HEAD `4c78703`
(`claude/plans-generator`). **Rien n'a été poussé, aucun bundle créé, aucune
connexion à GitHub.** Ce document prépare la décision du fondateur ; il ne
la prend pas.

---

## 1. Constat

- La branche `claude/plans-generator` compte **110 commits d'avance sur
  `main`** (`git rev-list --count main..HEAD`), sans aucune branche
  distante correspondante. Le travail n'existe que sur ce poste et dans
  `.local_backups/` (sauvegardes de la base, pas du dépôt Git).
- Les branches locales `claude/b014-geoloc-tranche1` (2 commits) et
  `claude/ux-demo-fixes` (10 commits) n'ont **aucun commit absent** de
  `claude/plans-generator` : sauvegarder cette dernière les couvre
  entièrement.
- **Pousser ne déploie aucune migration.** M029–M035 restent locales tant
  que la décision D2 n'est pas prise ; une branche sur GitHub n'applique
  rien à aucune base.

## 2. Visibilité du dépôt distant `oumartata/ChantierLive`

**Indéterminée.** L'outil `gh` n'est pas installé ; aucune connexion n'a
été tentée. Le fondateur peut la vérifier sur la page du dépôt (badge
« Private » ou « Public »).

Conséquence : si le dépôt est **public**, tout ce qui est poussé devient
lisible par tous (code, documents de conception, noms des comptes de
démonstration en `.test`). Le contrôle ci-dessous n'a trouvé aucun secret,
mais une publication reste un choix distinct d'une sauvegarde.

## 3. Contrôle des secrets dans ce qui serait poussé (`main..HEAD`)

Aucune valeur n'a été affichée ni recopiée ; seuls des comptes, chemins et
commits sont rapportés.

### 3.1 Couverture de `.gitignore`

| Chemin | Ignoré | Règle |
|---|---|---|
| `.env`, `.env.local`, `.env.*` | oui | `.gitignore:34` `.env*` |
| `.local_backups/` | oui | `.gitignore:60` |
| `scripts/.demo-credentials*.json` | oui | `.gitignore:41` |
| `exports/` (dont `exports/preuves/**/.compte-demo.json`) | oui | `.gitignore:56` |
| un `.compte-demo.json` placé **hors** de `exports/` | **non** | aucune règle générique |

Seul fichier de ce type suivi par Git : `.env.example` (modèle sans
valeur, présent avant cette branche).

**Point d'attention (non corrigé, hors périmètre)** : ajouter une règle
générique `**/.compte-demo.json` éviterait un oubli futur.

### 3.2 Chemins sensibles dans l'historique

`git log main..HEAD --name-only --diff-filter=A` : **aucun** fichier
`.env*`, `.local_backups/`, `.demo-credentials*`, `exports/` ni
`.compte-demo.json` ajouté par ces 110 commits.

### 3.3 Motifs sensibles dans les lignes ajoutées (`git log -p main..HEAD`)

| Motif recherché | Correspondances | Classement |
|---|---|---|
| Jeton JWT (`eyJ…`) | 0 | — |
| `service_role` suivi d'une valeur | 0 | — |
| `sb_secret_…` / `sb_publishable_…` | 0 | — |
| Clé privée (`BEGIN … PRIVATE KEY`) | 0 | — |
| Mot de passe littéral (`password: "…"`) | 0 | — |
| `…_KEY = <valeur>` | 10 | **toutes des références `process.env`, aucune valeur** (faux positifs) |
| Adresses e-mail | 11 | toutes en domaines de test (`chantierlive.test` ×9, `example.test` ×2) |
| Numéro `+223` | 1 | exemple fictif (`+223 70 00 00 00`), texte d'aide de saisie |

Détail des 10 références `process.env` (`ANON_KEY = process.env…`) :
`scripts/demo_seed_chantierlive.mjs` (f9206a1),
`scripts/seed-demo-avancement.mjs` (b12ba1d),
`scripts/test-catalog-item-layout.mjs` (0ba7627),
`scripts/test-catalogue-copy-source.mjs` (aaeaa13),
`scripts/test-phase-plan-actions.mjs` (b12ba1d),
`scripts/test-plan-request-variant-attestation.mjs` (16e434d),
`scripts/test-plan-requests.mjs` (7b5fcda),
`scripts/test-project-location.mjs` (25ce620),
`scripts/test-project-phases.mjs` (bf05e20),
`scripts/test-prototype-plans-bridge.mjs` (9d4d046).

**Valeur à examiner : aucune.** Limite : la recherche porte sur des motifs
connus ; elle ne prouve pas l'absence de tout secret sous une forme
inattendue.

### 3.4 Autres fichiers à signaler

- `.claude/launch.json` (modifié dans f835ee5 et d679a36) : configuration
  du serveur de développement (noms, commandes, ports), sans secret.
- Push = exécution du workflow `.github/workflows/ci.yml` (déclenché sur
  tout `push`), qui lance le pipeline qualité ; il n'utilise aucun secret.

## 4. Les 110 commits regroupés par thème

Ordre chronologique ; les groupes sont contigus, sauf mention.

| # | Groupe | Commits | Premier → dernier | Migrations | Dépend de |
|---|---|---|---|---|---|
| G1 | Socle chantier et ergonomie de démonstration (localisation, coquille hors ligne, navigation, invitations, D143, limite d'envoi des plans) | 11 | `25ce620` → `1419bdb` | M029, M030 | `main` |
| G2 | Moteur de plans 2D (prototype T0) : génération, éditeur, régénération, 4 façades, suivi | 53 | `94cdb1e` → `fb7fe6f` | — | G1 (page Plans) |
| G3 | Intégration métier du générateur (Lots 1/2/3, demandes et variantes, B069) | 6 | `3186671` → `3ed6e5b` | M031, M031b/c/d, correction M029 | G2 |
| G4 | Catalogue modifiable, Lot A | 3 | `0ba7627` → `5915719` | M032, M032b | G2, G3 |
| G5 | ESPACES-1 (séparation propriétaire/entreprise) et proposition étapes/dépenses | 2 | `d679a36` → `90e69b3` | — | G1 |
| G6 | Avancement des travaux | 4 | `b9d7903` → `2fc3d4c` | M033 | G5 (navigation) |
| G7 | Éditeur de plans, suite (diagnostic d'usage, B1/B2, B4/B5, façades, B3, comparaison, F1, fenêtres, F2) | 19 | `8396683` → `bb8a93c` | — | G2, G3 |
| G8 | Catalogue, option A (plan F2 sans ses autorisations) | 1 | `b863907` | — | G4, G7 |
| G9 | Validation à l'écriture des variantes (M034) | 4 | `b3aafd8` → `cdcee7d` | M034 | G3, G7 |
| G10 | Catalogue, Lot B (copie vers un chantier, origine, reprise) | 3 | `aaeaa13` → `ee61dac` | M035 | G4, G9 |
| G11 | ESPACES-3/5 (chantier sélectionné, preuve des versements) | 2 | `636ed30` → `d56386a` | — | G5, G6 |
| G12 | Pilotage (passation, synchronisation de l'état) | 2 | `9b6e105` → `4c78703` | — | tous |
| | **Total** | **110** | | | |

Vérification : 11 + 53 + 6 + 3 + 2 + 4 + 19 + 1 + 4 + 3 + 2 + 2 = **110**,
soit exactement `main..HEAD` (le commit de ce document n'est pas compté).

### 4.1 Commits qui mélangent plusieurs thèmes

| Commit | Ce qu'il mélange | Effet sur le découpage |
|---|---|---|
| `2a6c7b7` (G1) | coquille hors ligne + ~15 zones (chantier, plans, organisations, authentification, invitations) | gros commit transversal, à relire seul |
| `c5b0112` (G1) | décision D143 + modification d'écrans | documentation et code mêlés |
| `7b5fcda` (G3) | M031 **et** un nouveau fichier de correction de M029 (`20260930105000_m029_correction_idempotence.sql`) | la correction de M029 arrive avec G3, pas avec G1 |
| `3ed6e5b` (G3) | clôture de l'intégration + ajout de B069 au backlog + préparation du catalogue | frontière G3/G4 floue |
| `5915719` (G4) | clôture du Lot A + analyse des espaces propriétaire/entreprise | frontière G4/G5 floue |
| `b9d7903` (G6) | préparation de l'avancement + précision EXPENSE_VIEW + clôture d'une vérification des espaces | frontière G5/G6 floue |
| `37de14f` (G7) | correctif de l'éditeur + document d'avancement | léger |
| `b863907` (G8) | moteur (`prototype-plans`) + catalogue (`organisations`) | rattaché au catalogue |
| `f835ee5`, `d679a36` | modifient aussi `.claude/launch.json` | sans risque, à noter |

L'historique est **linéaire** : aucun groupe ne peut être séparé sans
réécriture. Le découpage proposé ci-dessous **n'en réécrit aucun**.

## 5. Découpage proposé en PR relisables (sans réécriture d'historique)

Principe : des **PR empilées**. Une branche de revue est posée sur le
dernier commit de chaque tranche ; chaque PR a pour base la tranche
précédente (la première : `main`). L'ordre suit celui des migrations
(M029 → M035).

| PR | Contenu | Commits | Base | Migrations | Remarque |
|---|---|---|---|---|---|
| PR1 | G1 | 11 | `main` | M029, M030 | relire `2a6c7b7` à part |
| PR2 | G2, moteur T0 | 53 | PR1 | — | volumineuse mais homogène (prototype isolé `src/app/prototype-plans`) ; peut être scindée à `bdd22fd`/`0a6b9d1` (génération) puis `37fea69`→`fb7fe6f` (4 façades) |
| PR3 | G3 | 6 | PR2 | M031–M031d + correction M029 | signaler la correction de M029 dans la description |
| PR4 | G4 + G5 | 5 | PR3 | M032, M032b | frontières floues regroupées |
| PR5 | G6 | 4 | PR4 | M033 | |
| PR6 | G7 | 19 | PR5 | — | éditeur et moteur |
| PR7 | G8 + G9 | 5 | PR6 | M034 | |
| PR8 | G10 | 3 | PR7 | M035 | |
| PR9 | G11 + G12 | 4 | PR8 | — | espaces et documents de pilotage |

Prérequis : branches de revue posées sur les commits frontières (`1419bdb`,
`fb7fe6f`, `3ed6e5b`, `90e69b3`, `2fc3d4c`, `bb8a93c`, `cdcee7d`,
`ee61dac`, HEAD), créées sans checkout ni réécriture, **seulement après
accord** ; fusion PR par PR dans l'ordre, chacune revue et avec CI verte.
**Fusionner ≠ déployer** : D2 reste distincte.

## 6. Options de sauvegarde

| | A — pousser la branche telle quelle | B — `git bundle` sur un support externe | C — A et B |
|---|---|---|---|
| Ce que c'est | `git push origin claude/plans-generator`, sans PR ni fusion | un fichier unique contenant tout l'historique de la branche, copié sur une clé USB ou un disque externe (pas `E:`) | les deux |
| Avantages | copie hors du poste, consultable, base des PR (§5) ; CI exécutée sur GitHub | aucune dépendance au réseau ni à la visibilité du dépôt ; restauration simple (`git clone` depuis le fichier) | deux copies indépendantes |
| Risques | si le dépôt est **public**, tout devient lisible (aucun secret trouvé, §3) ; la CI se déclenche | support perdu, volé ou non mis à jour ; ne sert pas aux PR | cumul, mais faibles |
| Prérequis | confirmer la visibilité du dépôt (§2) ; accès en écriture configuré sur le poste | choisir le support (pas `E:`) ; vérifier le bundle (`git bundle verify`) | les deux |
| Couvre les migrations ? | les fichiers seulement ; **ne les applique nulle part** | idem | idem |
| Couvre la base locale et le stockage ? | **non** (voir `.local_backups/` et la restauration du 2026-10-04) | non, sauf si les sauvegardes `.local_backups/` sont copiées à part | non, idem |

**Recommandation du chef de projet** : **C**, dans cet ordre :
1. bundle vérifié sur support externe (immédiat, sans exposition) ;
2. confirmation de la visibilité du dépôt ;
3. push de la branche **sans PR ni fusion** si le dépôt est privé (ou si
   la publication est acceptée en connaissance de cause) ;
4. découpage en PR (§5) dans une boucle ultérieure, sur décision.

Les sauvegardes de la base (`.local_backups/`) et le stockage local ne
sont couverts par aucune option Git : leur copie hors poste est une
question à part, à décider avec D1.

## 7. Décision attendue du fondateur

1. Option retenue : A, B ou C.
2. Visibilité confirmée du dépôt.
3. Support externe pour le bundle (si B ou C).
4. Copie hors poste de `.local_backups/` : oui ou non.
5. Découpage en PR : maintenant ou plus tard.
