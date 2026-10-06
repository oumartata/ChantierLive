# Passation — ChantierLive : Claude Chat chef de projet, fondateur décideur

Document de reprise établi le **2026-10-06**, à la tête de branche
`d56386a`. À charger en premier dans le projet Claude Chat, avec les
fichiers cités en §10 si possible.

---

## 1. Rôles et fonctionnement

| Rôle | Qui | Responsabilités |
|---|---|---|
| **Décideur** | Le fondateur (Oumar Touré) | Choisit les priorités, accepte ou refuse chaque lot, tranche les décisions bloquantes (droits, migrations, fusion, mise en ligne, données réelles). Seul à pouvoir déclarer une tâche du backlog terminée. |
| **Chef de projet** | Claude Chat | Tient l'état du projet, propose l'ordre des lots, rédige pour chaque tâche une **boucle** (§3) à transmettre à l'agent d'exécution, relit les bilans, vérifie qu'ils répondent aux critères, signale les écarts et prépare les décisions du fondateur. |
| **Agent d'exécution** | Un agent de code sur le poste du fondateur (Claude Code ou équivalent) | Seul à accéder au dépôt `C:\Projets\ChantierLive`, à la base Supabase locale et au navigateur. Exécute une boucle à la fois et rend un bilan. |

**Limites de Claude Chat à garder en tête** : il ne voit ni le dépôt, ni la
base, ni le navigateur. Il ne doit jamais affirmer un état sans un bilan
de l'agent d'exécution ou un fichier fourni par le fondateur. En cas de
doute, la boucle commence par une vérification de l'état réel (§3).

**Langue** : tout en français simple. Les bilans de l'agent sont en
français.

---

## 2. Le projet en bref

- **Mission** : rendre l'avancement, les dépenses, les preuves et les
  décisions d'un chantier consultables et traçables à distance.
  Marché initial : Bamako, Kati et la diaspora malienne.
- **Produit** : une PWA responsive (mobile et ordinateur), en français
  simple, pour Android modeste et faible connexion.
- **Principes fondateurs** (`PROJECT_STATE.yaml`) :
  - l'application ne détient ni ne transfère jamais d'argent ;
  - aucune preuve n'est garantie authentique ;
  - toute correction importante reste visible, datée et attribuée ;
  - les droits viennent du rôle, jamais du paiement ;
  - le montant contractuel vient uniquement du devis et des avenants
    acceptés (D085) ;
  - les dépenses et justificatifs internes de l'entreprise sont privés
    envers le client (D086/D090).
- **Rôles applicatifs** : propriétaire (principal ou copropriétaire),
  entreprise, chef de chantier, administrateur de plateforme. Ingénieur
  habilité pour la validation technique des plans.
- **Pile technique** :
  - **Next.js 16** (Turbopack). Attention : version récente, avec des
    ruptures. Lire `node_modules/next/dist/docs/` avant d'écrire du code
    (règle de `AGENTS.md`).
  - **Supabase** local (Docker, ports 54321/54322), PostgreSQL : RLS et
    fonctions `security definer`.
  - TypeScript strict.

---

## 3. Méthode de travail : une boucle par tâche

Chaque tâche suit une boucle **bornée**. Claude Chat rédige la consigne,
le fondateur la transmet à l'agent d'exécution, l'agent rend un bilan,
Claude Chat le relit et prépare la décision du fondateur.

### 3.1 Cycle d'une boucle

1. **Cadrer** (Claude Chat) : objectif unique, critères de fin mesurables,
   périmètre exclu, nombre maximal de cycles (3 à 5).
2. **Valider le cadrage** (fondateur) : accord, ou correction.
3. **Exécuter** (agent) : vérifier l'état réel, réaliser, prouver, rendre
   le bilan.
4. **Relire** (Claude Chat) : confronter le bilan aux critères ; distinguer
   « prouvé », « affirmé sans preuve » et « absent » ; repérer les
   contradictions.
5. **Décider** (fondateur) : accepté, à reprendre, ou bloqué sur une
   décision.
6. **Consigner** (Claude Chat) : mettre à jour l'état de passation (§5 et
   §7) et proposer la boucle suivante.

### 3.2 Modèle de consigne à transmettre à l'agent d'exécution

```
OBJECTIF : <une phrase, un seul résultat utilisateur>

Point de départ attendu :
C:\Projets\ChantierLive — branche claude/plans-generator — HEAD <hash>
Confirme l'état réel (branche, HEAD, statut Git) et préserve tout travail présent.

1. <étape>
2. <étape>
...

Garanties à respecter : <liste>
Hors périmètre : <liste>
Vérifications attendues : <tests ciblés, npm run verify si le code change, parcours navigateur ordinateur + 390 px>

Maximum <N> cycles, arrêt dès l'objectif atteint.
Aucun push, fusion, déploiement, migration (sauf accord explicite), donnée réelle, intervention sur E: ou FuturePro.

Bilan : réellement utilisable / préparé non implémenté / bloqué sur une décision ;
preuves ; limites ; données de démonstration ajoutées ; commit ; statut Git ; progression.
Ligne finale : <compteur global> / <jalons moteur> / <cycles> / <résultat> / <commit>
Arrêt après le bilan.
```

### 3.3 Format de bilan attendu (à exiger)

- Ce qui **existait** ; ce qui devient **réellement utilisable** ; ce qui
  est **préparé mais non implémenté** ; ce qui est **bloqué sur une
  décision**.
- Preuves exactes : tests (nombre réussi/total), `npm run verify`,
  parcours navigateur.
- Limites, sans formuler de garantie absolue.
- Données de démonstration ajoutées.
- Commit local, statut Git.
- Ligne finale, par exemple :
  `29/69 / 7/7 jalons moteur / 2 cycle(s) / <résultat> / <commit>`.

### 3.4 Règles de relecture pour Claude Chat

- Une tâche du backlog ne compte comme terminée **que** si son critère
  `done_when` (`MVP_BACKLOG.csv`) est satisfait **et** que le fondateur
  la valide. Un commit, un test vert ou un lot hors backlog ne fait
  jamais avancer le compteur.
- Un statut « partiel » reste partiel tant qu'un critère écrit manque.
- Toujours distinguer : **zéro**, **information absente** et **lecture
  impossible**.
- Aucune heuristique présentée comme une norme réglementaire.
- Ne jamais demander à l'agent d'afficher un secret.

---

## 4. Règles permanentes (à reprendre dans chaque consigne)

1. **Aucun push, fusion, déploiement** sans décision explicite du
   fondateur pour ce cas précis.
2. **Aucun accès à une base distante**, aucune donnée réelle. Tout se
   fait sur Supabase **local**.
3. **Ne jamais toucher** au disque `E:` ni au projet `FuturePro`.
4. **Migrations** :
   - uniquement avec l'accord explicite du fondateur, appliquées en
     **local** seulement ;
   - avant application : cible locale confirmée et sauvegarde schéma +
     données **vérifiée** dans `.local_backups/` (non versionné) ;
   - jamais de réinitialisation ni de purge ;
   - jamais de modification d'une migration déjà appliquée : nouveau
     fichier, nouvel identifiant.
   - **Prochain identifiant libre : M036.**
5. **Secrets** : ne jamais afficher de mot de passe ni de clé.
   - Ne pas lire ni afficher les fichiers d'identifiants
     (`scripts/.demo-credentials*.json`,
     `exports/preuves/f2-demandes-2026-10-06/.compte-demo.json`).
   - Connexion de démonstration par un serveur local à usage unique qui
     sert les identifiants au navigateur sans les afficher (exemple :
     `exports/preuves/versements-2026-10-06/serve-creds-avancement.mjs`).
   - Ne réinitialiser aucun mot de passe existant.
6. **Comptes** : n'en créer que si nécessaire et autorisé ; toujours
   réutiliser d'abord les comptes de démonstration existants (§9).
7. **Préserver le travail présent** : ne jamais utiliser `git stash` ;
   pas de nettoyage automatique.
8. **Documents** : les écrire sans laisser le shell interpréter les
   accents graves ni les substitutions de commande (outils d'édition, ou
   heredoc entre guillemets simples).
9. **Vérification** :
   - `npm run verify` (lint, typecheck, tests, build) sur la version
     finale avant chaque commit de code ;
   - si le code change après un `verify`, le relancer ;
   - sans changement de code, ne pas relancer toute la campagne.
10. **Preuves navigateur** : rangées hors Git dans
    `exports/preuves/<sujet>-<date>/`, sans secret. Contrôles sur
    ordinateur et à 390 px de large.
11. **Brouillons** : ne jamais remplacer un brouillon local sans
    confirmation explicite ; préserver les possibilités de récupération.
12. **Séparation métier** :
    - le propriétaire voit le prix convenu, les versements, l'avancement
      et les médias partagés ;
    - les dépenses internes, achats et justificatifs de l'entreprise ne
      lui sont **jamais** exposés ;
    - être propriétaire ou membre d'une organisation ne donne accès à
      aucun chantier : seule l'adhésion active au chantier compte.
13. **Accès toujours vérifiés côté serveur**, jamais déduits d'un
    paramètre envoyé par le navigateur.
14. **Interface** : composants existants (`src/components/ui`), aucun
    compteur ni pourcentage inventé, aucun total financier entre
    chantiers sans signification établie.
15. **Commits** : locaux, identifiables, en français
    (`feat(...)`, `docs(...)`), terminés par la ligne d'attribution de
    l'agent.

---

## 5. État réel au 2026-10-06

### 5.1 Dépôt et base

- **Dépôt** : `C:\Projets\ChantierLive`. Distant :
  `https://github.com/oumartata/ChantierLive`.
- **Branche de travail** : `claude/plans-generator`, tête `d56386a`,
  arbre propre.
- **⚠️ Risque principal** : cette branche a **108 commits d'avance sur
  `main`** et **n'a jamais été poussée** (aucune branche distante). Le
  travail n'existe que sur ce poste et dans les sauvegardes locales. Une
  décision de sauvegarde distante s'impose (§7, décision D1).
- **Supabase local** :
  - migrations **M001 à M035** appliquées ;
  - **M029 à M035 sont locales uniquement** (jamais déployées) ;
  - dernières : M034 (validation des variantes à l'écriture), M035
    (origine des demandes copiées depuis le catalogue).
- **Sauvegardes récentes** (`.local_backups/`) : `pre_m034_*`,
  `pre_m035_*`, `pre_versements_demo_*_20261006_054910`.
- **Restauration du 2026-10-04** : poste réinstallé, base restaurée.
  Stockage partiel : 135 fichiers manquants (71 catalogue, 64 plans).
  Détail : `C:/Projets/RESTAURATION_PROJETS_C.md`.
- **`PROJECT_STATE.yaml` n'est pas à jour** : arrêté au 2026-10-04, il ne
  mentionne ni M034 ni M035 ni les derniers lots. À mettre à jour en
  première boucle (§8, boucle 1).

### 5.2 Compteur global (backlog officiel)

**29/69 tâches validées (42 %), 40 restantes.**
- Source : `MVP_BACKLOG.csv` (critère `done_when` par tâche) et
  `PROJECT_STATE.yaml` (`completed_build_items`).
- **Terminées** : B001–B018, B026, B033, B061–B069.
- **Restantes**, par lot (dépendances entre parenthèses) :
  - **L03 suivi de chantier** :
    - B019 modèles et phases (B014) — **SUSPENDUE** ;
    - B020 publier, corriger et valider une phase (B019) ;
    - B021 journal quotidien en brouillon (B014) ;
    - B022 publier et corriger le journal (B021) ;
    - B023 commentaires attribués (B022, P1) ;
    - B024 incidents (B014).
  - **L04 médias** :
    - B025 compression photo côté PWA (B004) ;
    - B027 galerie avec origine et métadonnées (B026) — partielle ;
    - B028 documents et versions (B026) ;
    - B029 test d'accès croisé aux fichiers (B026).
  - **L05 finances internes** :
    - B030 budget prévisionnel interne privé (B014) ;
    - B031 dépenses (B030) ;
    - B032 reçus facultatifs (B026, B031) ;
    - B034 demandes et décisions d'approbation (B031) ;
    - B035 corriger ou annuler une finance validée (B031).
  - **L06 hors ligne et synchronisation** :
    - B036 IndexedDB (B021, B031) ;
    - B037 file à identifiants (B036) ;
    - B038 envoi idempotent (B037) ;
    - B039 réception par curseur (B038) ;
    - B040 écran de file (B037) ;
    - B041 conflits de brouillons (B038) ;
    - B042 correction liée en cas de conflit financier (B035, B041) ;
    - B043 reprise des médias (B026, B037).
  - **L07 tableaux de bord et rapports** :
    - B044 tableaux de bord par rôle (B020, B031) ;
    - B045 notifications (B016, B034) ;
    - B046 rapport PDF (B028, B031) ;
    - B047 partage WhatsApp (B046, P1).
  - **L08 licences et administration** :
    - B048 déclaration de paiement de licence (B026, B014) ;
    - B049 activation manuelle (B048) ;
    - B050 interface admin (B010) ;
    - B051 accès support (B050).
  - **L09 qualité** :
    - B052 matrice RLS complète (B029, B035, B051) ;
    - B053 parcours E2E (B043, B049) ;
    - B054 Android modeste et faible réseau (B053) ;
    - B055 accessibilité (B044) ;
    - B056 journaux, alertes et métriques (B053) ;
    - B057 sauvegardes et restauration (B011, B028).
  - **L10 pilote** :
    - B058 anomalies bloquantes (B052–B054) ;
    - B059 données et comptes Alpha (B058) ;
    - B060 formation des pilotes (B059).

### 5.3 Travaux hors backlog (ne font pas avancer le compteur)

| Chantier | État | Référence |
|---|---|---|
| Moteur de plans 2D (`src/app/prototype-plans`) | **7/7 jalons terminés**. Limites ouvertes : régénération non dédiée (familles guidée et en L) ; empaquetage libre gauche/droite non admissible sur 2 terrains (15×20, 16×18). | `SUIVI_MOTEUR_PLANS_2D.md` |
| F1 fenêtres, F2 adaptation volontaire des dimensions (fichier v5) | Livrés | `SUIVI_MOTEUR_PLANS_2D.md` |
| Intégration métier du générateur (demande → variantes → dépôt) | Lots 1/2/3 livrés (dont B069) | `PREPARATION_INTEGRATION_METIER.md` |
| M034 : validation des variantes à l'écriture | Livré en local (`16e434d`, clôture `cdcee7d`) | `PREPARATION_VALIDATION_VARIANTES.md` |
| Catalogue modifiable, Lot A (fichier de projet sur un modèle, M032/M032b) | Livré | `PREPARATION_CATALOGUE_MODIFIABLE.md` §3 |
| Catalogue, option A (plan F2 déposé sans ses autorisations) | Livré (`b863907`) | idem |
| Catalogue, Lot B (copie d'un modèle vers un chantier) | Sous-lot 1 sans migration (`aaeaa13`) ; origine immuable M035 (`e629fcd`) ; reprise d'une copie interrompue (`ee61dac`) | idem §9, §10, §11 |
| Catalogue : consultation par le propriétaire du chantier | **Bloqué sur décision** (lien chantier → organisation absent) | idem §8 |
| Avancement des travaux (M033) | Livré (`bf05e20`) | `PREPARATION_AVANCEMENT_TRAVAUX.md` |
| ESPACES-1 (navigation propriétaire épurée) | Livré (`d679a36`) | `PREPARATION_ESPACES_PROPRIETAIRE_ENTREPRISE.md` |
| **ESPACES-3** (coquille entreprise) | **Partiel** | idem §4 |
| **ESPACES-5** (versements clients, vue entreprise) | **Partiel** | idem §4 |
| ESPACES-4 (dépenses internes) | Non commencé ; recoupe B030–B032 | idem §3.3 |

### 5.4 ESPACES-3 et ESPACES-5 : ce qui reste exactement

- **Livré** : `/entreprise/chantiers/[id]` (`636ed30`).
  - Accès sur adhésion entreprise active, vérifiée côté serveur.
  - Sélecteur de chantier.
  - Avancement déclaré.
  - Prix convenu, montants reconnu et en attente, reste dû.
  - Versements avec leurs statuts.
  - Liens vers les pages existantes.
- **Preuve métier** (`d56386a`), sur « DÉMO AVANCEMENT » : devis de
  10 000 000 FCFA accepté, versement de 2 500 000 FCFA déclaré puis
  confirmé. Reste dû : 10 000 000, puis 7 500 000. Propriétaire refusé
  sur la synthèse entreprise.
- **Reste pour ESPACES-5** :
  1. le menu « Versements clients » (`/entreprise/versements`) mène
     encore à la page générique `chantiers/[id]/acomptes` ;
  2. l'historique des versements n'est visible que sur la page
     générique ;
  3. la fidélité à la maquette n'est pas vérifiée (maquettes absentes du
     dépôt).
- **Reste pour ESPACES-3** :
  - compteurs et activité récente du tableau de bord (sans compteur
    inventé ; une fonction dédiée nécessiterait une migration, donc une
    proposition d'abord) ;
  - passage des pages Équipe et Photos au sélecteur unique ;
  - fidélité aux maquettes.

---

## 6. Repères techniques pour cadrer les boucles

- **Commandes** (exécutées par l'agent) :
  - `npm run verify` (pipeline complet) ; `npm test` (tests purs) ;
  - `npx supabase migration list --local` et
    `npx supabase migration up --local` ;
  - sauvegarde :
    `docker exec supabase_db_ChantierLive pg_dump -U postgres -d postgres --schema-only`
    puis `--data-only`, vers `.local_backups/` ;
  - tests d'intégration locaux, hors `npm test` :
    `node --env-file=.env.local scripts/test-<nom>.mjs` ;
  - serveur de développement : configuration `dev` de
    `.claude/launch.json`, port 3000.
- **Tests de référence** :
  - dans `npm test` : géométrie 1059, `test-plans-catalogue-copy` 35,
    `test-entreprise-chantier-summary` 13, etc. ;
  - intégration locale : `test-plan-requests` 30,
    `test-plan-request-variant-attestation` 39,
    `test-catalogue-copy-source` 72.
- **Frontière de confiance du plan** (à préserver) : un plan n'est jamais
  écrit en base sans passer par une attestation `service_role`, posée par
  l'action serveur après `validateProjectFile`.
  - catalogue : M032b ;
  - variantes : M034 ;
  - copie catalogue → chantier : M035 + M034.
- **Règles métier rencontrées en démonstration** (ne pas les contourner) :
  - estimer un devis exige un plan **retenu** ;
  - proposer le devis exige un plan **validé par un ingénieur et
    publié** ;
  - déclarer un versement exige une **avance exigée**, qui exige un
    **devis accepté** ;
  - un montant en attente n'est pas déduit du reste dû.

---

## 7. Décisions en attente du fondateur

| # | Décision | Pourquoi c'est important | Recommandation du chef de projet sortant |
|---|---|---|---|
| D1 | **Sauvegarde distante** des 108 commits locaux et des migrations M029–M035 | Tout le travail est sur un seul poste | Pousser la branche sans fusion (sauvegarde), puis découper en PR relues avant toute fusion ; décider séparément du déploiement des migrations |
| D2 | Appliquer ou non M029–M035 ailleurs qu'en local | Aucune n'est déployée | Pas avant la revue des PR (D1) |
| D3 | Priorité du prochain lot du backlog (§8) | 40 tâches restantes | L04 médias (B025, B027–B029) ou L03 journal (B021–B022), dépendances satisfaites |
| D4 | ESPACES-4 / B030–B032 (dépenses internes) | Exige des migrations et des droits | Préparer d'abord la proposition (tables, droits, confidentialité D086/D090) |
| D5 | Lien chantier → organisation pour la consultation du catalogue par le propriétaire | Bloque cette consultation | Proposition déjà rédigée (`PREPARATION_CATALOGUE_MODIFIABLE.md` §8.1) |
| D6 | B019 (phases) suspendue alors que M033 (avancement) existe | Recouvrement possible | Faire comparer `done_when` de B019/B020 avec M033 avant toute décision |
| D7 | Questions ouvertes de `PROJECT_STATE.yaml` | `approval_status` (bloque B034) ; suppression de compte | À trancher avant les migrations concernées |
| D8 | Fournir les **huit maquettes** du 2026-10-03 au dépôt | La fidélité visuelle d'ESPACES ne peut pas être vérifiée sans elles | Les déposer dans le dépôt (dossier dédié) |

---

## 8. Boucles proposées pour la suite (ordre recommandé, à valider)

1. **Boucle 1 — Remise à jour de l'état officiel** (documents seuls).
   - Synchroniser `PROJECT_STATE.yaml` avec l'état réel : M034, M035, lots
     catalogue, ESPACES, liste des migrations locales, nombre de commits
     d'avance, prochain identifiant M036.
   - Fin : fichier à jour, commit local `docs(...)`, aucune modification
     de code.
2. **Boucle 2 — Décision D1 préparée**.
   - L'agent liste les commits par thème et propose un découpage en PR.
     Il ne pousse rien sans accord.
   - Fin : proposition écrite ; décision du fondateur.
3. **Boucle 3 — ESPACES-5, compléments sans migration**.
   - Faire mener le menu « Versements clients » à la présentation
     entreprise (sélecteur), et y afficher l'historique existant
     (lecture seule).
   - Fin : critères écrits d'ESPACES-5 satisfaits, hors fidélité aux
     maquettes (dépend de D8).
4. **Boucle 4 — Premier lot du backlog choisi en D3**.
   - Exemples : B025 (compression photo PWA, P0, dépendance B004
     satisfaite) ; ou B021 puis B022 (journal quotidien).
   - Fin : critère `done_when` de la tâche, validé par le fondateur ; le
     compteur passe alors à 30/69.
5. **Boucle 5 — Proposition ESPACES-4 / B030–B032** (aucune migration
   appliquée).
   - Fin : proposition chiffrée de tables, droits et tests ; décision D4.

---

## 9. Données et comptes de démonstration (local uniquement, aucun secret ici)

| Usage | Compte / chantier | Où sont les identifiants (ne jamais les afficher) |
|---|---|---|
| Entreprise + catalogue + plans F2 | Compte de démonstration F2 ; « Chantier démo F2 v5 (2026-10-06) » (`bd7c356a…`), « Chantier démo entreprise — 2e chantier (2026-10-06) » ; organisation « Espace professionnel » `84f330be…` ; modèle « Modèle démo F2 v5 (2026-10-06) » (v1 publiée) | `exports/preuves/f2-demandes-2026-10-06/.compte-demo.json` |
| Entreprise + propriétaire principal + avancement + versements | `demo-avancement-entreprise@chantierlive.test`, `demo-avancement-proprietaire@chantierlive.test` ; « DÉMO AVANCEMENT — validation navigateur » (`100c28c0…`) : plan publié, devis accepté, versement reconnu | `scripts/.demo-credentials.avancement.json` |
| Ingénieur habilité | `demo-ingenieur@chantierlive.test` (désigné dans l'organisation de « DÉMO AVANCEMENT ») | `scripts/.demo-credentials.json` (clé `accounts.ingenieur`) |
| Ingénieur du catalogue F2 | `demo-ingenieur-catalogue@example.test` | **Mot de passe non conservé** : compte inutilisable sans réinitialisation, qui demanderait l'accord du fondateur |

Les scripts de test créent leurs propres données jetables
(`…@example.test`). Ce ne sont pas des comptes de démonstration.

---

## 10. Documents de référence (à fournir à Claude Chat si possible)

**Priorité 1** :
- `PASSATION_CLAUDE_CHAT.md` (ce document) ;
- `PROJECT_STATE.yaml` ;
- `MVP_BACKLOG.csv` ;
- `PREPARATION_ESPACES_PROPRIETAIRE_ENTREPRISE.md` ;
- `PREPARATION_CATALOGUE_MODIFIABLE.md`.

**Priorité 2** :
- `SUIVI_MOTEUR_PLANS_2D.md` ;
- `PREPARATION_INTEGRATION_METIER.md` ;
- `PREPARATION_AVANCEMENT_TRAVAUX.md` ;
- `PREPARATION_VALIDATION_VARIANTES.md` ;
- `PREPARATION_ETAPES_DEPENSES_INTERNES.md`.

**Règles et conception** :
- `DECISIONS.yaml` ;
- `BUSINESS_RULES.csv` ;
- `PERMISSIONS.csv` ;
- `ACCEPTANCE_CRITERIA.csv` ;
- `DATABASE_TABLES.csv` ;
- `STATE_MACHINES.yaml`.

**Maquettes présentes** : `CHANTIERLIVE_MAQUETTES_4C.html`, `.pdf` et
`_APERCU.png`, seulement les écrans de connexion, d'invitation et
d'accueil. Les huit maquettes ESPACES du 2026-10-03 sont **absentes**.

---

## 11. Message d'ouverture suggéré pour la première session Claude Chat

> Tu es le chef de projet de ChantierLive ; je suis le décideur. Lis
> `PASSATION_CLAUDE_CHAT.md` (et les documents joints). Résume-moi en
> dix lignes l'état du projet, les risques et les décisions qui
> m'attendent, puis rédige la **boucle 1** (§8) au format du §3.2, prête
> à transmettre à l'agent d'exécution. Ne suppose rien qui ne soit pas
> écrit : en cas de doute, la boucle commence par vérifier l'état réel.
