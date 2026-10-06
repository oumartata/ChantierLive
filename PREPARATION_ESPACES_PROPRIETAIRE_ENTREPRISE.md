# Préparation — espaces propriétaire et entreprise distincts (maquettes fondateur 2026-10-03)

Analyse et proposition de lots uniquement. Aucun code, aucune migration,
aucun changement de droits ce tour. Base des huit maquettes fournies (quatre
« espace propriétaire », quatre « espace entreprise ») comparées à l'état
réel du code (`src/app/(app)/...`, `supabase/migrations/*.sql`).

## 1. Constat vérifié

### 1.1 Aujourd'hui, les deux espaces partagent la MÊME navigation

`chantiers/[id]/layout.tsx` construit un seul menu, par chantier, dont la
forme pour OWNER/PRIMARY est **identique** à celle de CONTRACTOR
(`canInvite`/`canSeeFinancials` vrais pour les deux) :
Chantier, Inviter, Invitations, Équipe, Photos, Plans, Devis, Avenants,
Acomptes, Synthèse. C'est exactement ce que la consigne demande de ne plus
faire (« ne reproduis pas le menu entreprise dans l'espace propriétaire »).
CO_OWNER a la même liste sans Inviter/Invitations ; SITE_MANAGER n'a que
Chantier/Équipe/Photos/Plans.

### 1.2 Espace propriétaire visé (4 maquettes) — comparaison

| Écran maquette | Nav actuelle correspondante | État |
|---|---|---|
| Mon chantier (fiche + avancement global + étape actuelle + résumé financier) | `chantiers/[id]` (fiche) + `finances` (résumé) | Partiel — fiche et résumé financier existent séparément ; « étape actuelle » n'existe pas |
| Versements (prix convenu / avance / solde / historique / déclarer) | `chantiers/[id]/acomptes` + `finances` | **Déjà construit** côté RPC (`list_advance_payments`, `get_project_financial_summary`), présentation à regrouper |
| Photos et vidéos partagées (onglets Tout/Photos/Vidéos/Partagé entreprise) | `chantiers/[id]/photos` | **Déjà construit** (`list_project_media`, statut `PUBLIE`), onglets à ajouter en UI seulement |
| Avancement des travaux (jauge % + étapes nommées + historique) | **Aucun équivalent** | Absent — nécessite une fonctionnalité neuve (§3.1) |

### 1.3 Espace entreprise visé (4 maquettes) — comparaison

| Écran maquette | Nav/page actuelle correspondante | État |
|---|---|---|
| Tableau de bord (mes chantiers, compteurs, activité récente) | **Aucune page organisation n'existe** (`organisations/[id]/` ne contient que `catalogue/` et `ingenieurs/`) ; le plus proche est `tableau-de-bord` (liste personnelle sans compteurs ni barres de progression) | Absent — nécessite une coquille (« shell ») organisation neuve (§3.2) |
| Photos, vidéos et avancement (partage média + mise à jour d'étape) | `chantiers/[id]/photos` pour le média (déjà construit) ; la mise à jour d'étape dépend de §3.1 | Partiel |
| Dépenses internes (journal, justificatifs, réservé entreprise) | **N'existe nulle part** (conception seule, `DATABASE_TABLES.csv` T024-T027, jamais migré) | Absent — fonctionnalité neuve complète (§3.3) |
| Versements clients (mêmes données, vue entreprise) | `chantiers/[id]/acomptes` | **Déjà construit** côté RPC, présentation entreprise à ajouter |

Précision sur la dernière maquette entreprise : la version substituant
« Générateur de plans » (maquette antérieure) est bien celle analysée ici
(« Versements clients ») — `/prototype-plans` reste, comme aujourd'hui, une
action contextuelle depuis l'onglet Plans d'un chantier (`chantiers/[id]/plans`),
jamais un lien de nav persistant, ce que confirme le code actuel et qui n'est
contredit par aucune des huit maquettes (aucune ne montre « Générateur de
plans » comme item de menu).

### 1.4 Chef de chantier (SITE_MANAGER)

Aucune maquette fournie pour ce rôle. Son menu actuel (Chantier/Équipe/
Photos/Plans) n'est pas traité ici — non modifié par cette analyse.

## 2. Tableau de correspondance (synthèse, 8 écrans)

| # | Écran | Espace | RPC/table déjà existants réutilisables | Manque concret |
|---|---|---|---|---|
| 1 | Mon chantier | Propriétaire | fiche projet, `get_project_financial_summary` | « Étape actuelle » (§3.1) |
| 2 | Versements | Propriétaire | `list_advance_payments`, `get_project_financial_summary`, `advance_requirement_versions` | Aucun — présentation seule |
| 3 | Photos et vidéos partagées | Propriétaire | `list_project_media` | Aucun — présentation seule (onglets) |
| 4 | Avancement des travaux | Propriétaire | — | Fonctionnalité « étapes » entière (§3.1) |
| 5 | Tableau de bord entreprise | Entreprise | `project_memberships` (role=CONTRACTOR), `advances`, `plan_catalog_items` (comptages) | Coquille organisation + agrégation multi-chantiers (§3.2) |
| 6 | Photos, vidéos et avancement | Entreprise | `list_project_media` (publier/brouillon) | Mise à jour d'étape (§3.1), sélecteur de chantier dans la coquille (§3.2) |
| 7 | Dépenses internes | Entreprise | aucun (conception seule) | Fonctionnalité « dépenses » entière (§3.3) |
| 8 | Versements clients | Entreprise | `list_advance_payments`, `advance_events`, `declare_advance_payment` | Aucun — présentation seule |

## 3. Décisions bloquantes nouvelles (à valider avant toute migration)

### 3.1 Étapes de chantier / avancement — fonctionnalité neuve

**Confirmé absent du code** : aucune table `phases`/`project_phases`,
aucune RPC contenant « phase ». `PERMISSIONS.csv` liste des codes
`PHASE_*` jamais implémentés ; `D141` acte explicitement que les étapes
sont différées (B019 suspendue, B027 partielle, AC172 non satisfait par
B068). **Ceci n'est pas une tâche de présentation : c'est une
fonctionnalité neuve**, nécessaire à 3 des 8 écrans (Mon chantier,
Avancement des travaux, Photos/vidéos et avancement entreprise).

Le plan de migration du projet réserve déjà cette place, sans jamais
l'avoir construite : `MIGRATION_ORDER.csv` lignes 8-9, `M007
« phase_templates template_items »` et `M008 « project_phases
phase_versions »` (dépendances `M004;M007`, jalon « version publiée
immuable »). Aucun fichier `supabase/migrations/*m007*` ni `*m008*`
n'existe — vérifié. **Proposition : reprendre ces identifiants déjà
réservés, ne pas en inventer de nouveaux.**

Conception minimale proposée (description seulement, aucune migration
créée) :
- `project_phases` : une ligne par étape nommée du chantier (`label`,
  `position`/ordre, `status` parmi `A_VENIR`/`EN_COURS`/`TERMINEE`),
  rattachée au `project_id`.
- `phase_versions` ou simplement des colonnes d'horodatage
  (`started_at`, `completed_at`) sur `project_phases` — à trancher selon
  le même principe « versions append-only » déjà en usage partout ailleurs
  (M008 prévoit `phase_versions`, donc un historique, pas une simple mise
  à jour en place).
- Écriture réservée à CONTRACTOR (même principe que `authorize_work_start`,
  `set_advance_requirement` : l'entreprise pilote, le propriétaire
  consulte) — aucun droit nouveau pour le propriétaire, cohérent avec
  « aucun élargissement de droits ».
- Lecture : mêmes lecteurs que `get_project_financial_summary`
  (CONTRACTOR, OWNER/PRIMARY, CO_OWNER) — réutilise `D140`.
- « Photo de l'avancement » (maquette 4) : réutilise `list_project_media`
  (la plus récente `PUBLIE`), aucune colonne photo dupliquée sur
  `project_phases`.

**Décision à valider par le fondateur** : liste des étapes fixe (ex.
Fondations/Élévation des murs/Toiture/Finitions, comme la maquette) ou
modèle personnalisable par chantier (plus proche de `phase_templates`
déjà nommé dans M007) ? Ce choix détermine si M007 (modèles réutilisables)
est nécessaire dès ce lot ou seulement M008 (liste directe par chantier).

### 3.2 Coquille (shell) organisation pour l'espace entreprise — restructuration de navigation

Les maquettes entreprise montrent un menu PERSISTANT indépendant d'un
chantier précis (Tableau de bord / Chantiers / Versements clients /
Dépenses internes / Photos et vidéos / Catalogue de plans / Équipe), avec
un sélecteur de chantier DANS le contenu (ex. maquette 6 : « Maison Sanogo
— Bamako ▾ »). **Rien de tel n'existe aujourd'hui** : toute la navigation
entreprise actuelle est scopée par chantier (`chantiers/[id]/layout.tsx`),
il n'y a aucune page `organisations/[id]/page.tsx` ni nav organisation.

C'est une restructuration de navigation, pas seulement de nouveaux écrans :
nécessite un nouveau `organisations/[id]/layout.tsx` (ou équivalent) avec
son propre menu, et que les pages concernées (versements, photos,
dépenses) acceptent un chantier choisi dans leur propre contenu plutôt que
par l'URL `chantiers/[id]/...`. Les pages déjà construites
(`organisations/[id]/catalogue`, `organisations/[id]/ingenieurs`)
s'intègrent sans changement à ce nouveau menu.

**Décision à valider** : les URLs `chantiers/[id]/photos`,
`chantiers/[id]/acomptes` restent-elles la source de vérité (la nouvelle
coquille organisation n'étant qu'une liste de liens vers elles, filtrée
par chantier choisi — changement minimal, aucune donnée dupliquée), ou
l'entreprise obtient-elle de nouvelles routes `organisations/[id]/...`
dédiées (plus proche de la maquette mais plus de code) ? Recommandation :
la première option (liens filtrés), qui ne duplique aucune logique déjà
construite.

### 3.3 Dépenses internes — fonctionnalité neuve, déjà actée en droits

Confirmé absent du code (conception seule). La règle de confidentialité
est déjà tranchée et ne change pas : `D086`/`D090`/`BR098`/`BR099` — privé
par défaut envers le client, CONTRACTOR seul en écriture et lecture par
défaut. Construire cette fonctionnalité est un lot de migration à part
entière (tables `expenses`/`expense_categories`/`receipts`, déjà nommées
dans `DATABASE_TABLES.csv` T024-T027) — **non détaillé dans ce tour**
(hors demande explicite actuelle, qui porte sur la navigation et les
écrans déjà couverts par des règles validées) sauf si le fondateur demande
de le chiffrer maintenant.

### 3.4 Relocalisation Équipe / Invitations / Devis / Avenants côté propriétaire

Les maquettes propriétaire n'ont ni « Équipe » ni « Devis »/« Avenants »
en nav persistante. Ces fonctions restent nécessaires (OWNER/PRIMARY doit
toujours pouvoir inviter un CO_OWNER ou une entreprise, et décider d'un
devis/avenant — `D112`, inchangé) : **rien n'est supprimé, seulement
déplacé hors du menu principal**. Proposition minimale : accessibles
depuis la fiche « Mon chantier » (ex. un bandeau d'action quand une
décision est en attente — devis proposé, avenant proposé — et un accès
« Gérer l'équipe » à côté du bouton « Modifier » déjà existant sur cette
fiche). Aucun droit nouveau, aucune route supprimée — uniquement une
question d'emplacement dans l'interface, à valider par le fondateur avant
toute modification de nav.

## 4. Lots proposés

### Lot ESPACES-1 — nav propriétaire épurée + consultation catalogue (aucune fonctionnalité neuve)

Regroupe en 3 écrans (Mon chantier / Versements / Photos et vidéos) des
données déjà lisibles aujourd'hui (`get_project_financial_summary`,
`list_advance_payments`, `list_project_media`), retire Devis/Avenants/
Acomptes/Synthèse/Inviter/Invitations/Équipe du menu persistant (relocalisés,
§3.4), ajoute l'item « Catalogue » déjà proposé et non implémenté au tour
précédent (`PREPARATION_CATALOGUE_MODIFIABLE.md` §8 — `list_project_catalog_items_for_owner`,
bloqué par la même décision de résolution organisation↔chantier). Aucune
migration pour ce lot seul (présentation + relocalisation) hormis celle déjà
décrite au §8 du document catalogue.

### Lot ESPACES-2 — étapes de chantier / avancement (M007/M008, fonctionnalité neuve)

Construit la fonctionnalité décrite en §3.1 : tables, RPC de lecture
(propriétaire + entreprise) et RPC d'écriture (entreprise). Alimente
l'écran « Avancement des travaux » (propriétaire), la section « Étape
actuelle » de « Mon chantier », et la mise à jour d'étape de « Photos,
vidéos et avancement » (entreprise). **Dépend de la décision §3.1** (liste
fixe ou modèle personnalisable) avant toute migration.

### Lot ESPACES-3 — coquille organisation + nav entreprise (restructuration)

Construit la coquille décrite en §3.2, migre les écrans déjà existants
(photos, versements/acomptes, catalogue, ingénieurs) dans ce nouveau menu
avec sélecteur de chantier, ajoute le tableau de bord organisation
(compteurs, activité récente — agrégations en lecture seule sur des
données déjà existantes, aucune nouvelle table nécessaire pour les
compteurs eux-mêmes). **Dépend de la décision §3.2** (liens filtrés vs
routes dédiées).

**Avancement du 2026-10-06 (sans migration, option « liens filtrés »)** :
nouvelle page `/entreprise/chantiers/[id]` (chantier sélectionné).
- **Accès** : adhésion CONTRACTOR **active** sur ce chantier, vérifiée
  côté serveur avant toute lecture. Un chantier non autorisé affiche
  « Chantier non accessible », sans son nom ; l'appartenance à une
  organisation n'ouvre rien.
- **Sélecteur** : liste des chantiers autorisés, affichée dès qu'il y en
  a plusieurs.
- **Contenu, en lecture seule, par les fonctions existantes** :
  - avancement déclaré (M033) ;
  - récapitulatif du prix convenu, des montants reconnus et en attente, du
    reste dû (M028), **pour ce seul chantier** ;
  - versements avec leur statut (M014).
- **Actions** : uniquement par des liens vers les pages existantes
  (avancement, versements, photos et vidéos, plans, fiche du chantier).
- **États distingués** : lecture impossible, information absente (plan
  des étapes non publié, prix non établi) et zéro.
- **Tableau de bord** : lien « Avancement et versements » ajouté, le lien
  existant est conservé.

**Reste à faire** :
- compteurs et activité récente du tableau de bord ;
- migration des pages « Équipe » et « Photos » vers le sélecteur unique.

Les maquettes fondateur du 2026-10-03 ne sont pas dans le dépôt : la
fidélité visuelle n'est pas vérifiée. Seule `CHANTIERLIVE_MAQUETTES_4C`
(« Accueil entrepreneur ») est présente ; le style existant est conservé.

### Lot ESPACES-4 — dépenses internes (fonctionnalité neuve, hors chiffrage de ce tour)

Construit l'écran « Dépenses internes » (§3.3). Migrations et permissions
à détailler dans un tour dédié si le fondateur valide sa priorité
maintenant — les règles de confidentialité sont déjà actées (`D086`/`D090`),
seule la table n'existe pas.

### Lot ESPACES-5 — versements clients (entreprise), présentation seule

Réutilise intégralement `list_advance_payments`/`advance_events`/
`declare_advance_payment` (M014, inchangés) pour l'écran « Versements
clients ». Aucune migration. Peut être livré indépendamment des autres
lots, y compris avant ESPACES-3 (en restant temporairement sous
`chantiers/[id]/acomptes`, avec une présentation entreprise dédiée).

**Avancement du 2026-10-06** : `/entreprise/chantiers/[id]` présente, en
lecture seule, les versements du client et leurs statuts, ainsi que le
récapitulatif financier **du chantier sélectionné**. Aucun total entre
chantiers. Déclarer, confirmer, contester et joindre un justificatif
restent sur `chantiers/[id]/acomptes` (lien) : aucun second circuit.

Preuves :
- `scripts/test-entreprise-chantier-summary.mjs` : 13/13, dans
  `npm test` ;
- parcours navigateur sur ordinateur et à 390 px.

Limite de la démonstration : le chantier de démonstration n'a aucun
versement. Une déclaration exige un devis accepté par un propriétaire, et
aucun compte propriétaire supplémentaire n'a été créé. Le navigateur montre
donc l'état « aucun versement » et le prix « non établi ». Les statuts
sont couverts par le test unitaire.

**Preuve métier complète du 2026-10-06** (aucun code modifié) :

*Données.* Couple de démonstration EXISTANT (entreprise et propriétaire
principal) du chantier « DÉMO AVANCEMENT — validation navigateur »
(`scripts/seed-demo-avancement.mjs`), plus l'ingénieur de démonstration
existant (`scripts/demo_seed_chantierlive.mjs`). Aucun compte créé,
aucun mot de passe réinitialisé ou affiché : connexion par un serveur local
à usage unique. Sauvegarde vérifiée avant écriture :
`.local_backups/pre_versements_demo_*_20261006_054910`.

*Parcours, circuits normaux, dans le navigateur.* Les règles existantes
ont été rencontrées puis respectées, sans être contournées : un plan
retenu est exigé pour estimer, un plan publié et validé pour proposer.
1. L'entreprise dépose un plan et le partage ; le propriétaire le
   retient.
2. L'entreprise désigne l'ingénieur et lui soumet le plan ; l'ingénieur
   valide ; l'entreprise publie le plan.
3. L'entreprise estime puis propose le devis (1 × 10 000 000 FCFA) ; le
   propriétaire l'accepte.
4. L'entreprise fixe l'avance exigée : 3 000 000 FCFA.
5. Le propriétaire déclare un versement de 2 500 000 FCFA (Orange Money,
   05/10/2026).
6. L'entreprise confirme la réception.

*Résultats attendus et observés* (identiques entre la synthèse
`/entreprise/chantiers/[id]`, la page Versements de l'entreprise et celle
du propriétaire) :

| État | Prix convenu | Reconnu | En attente | Reste dû |
|---|---|---|---|---|
| Après déclaration | 10 000 000 | 0 (0) | 2 500 000 (1) | 10 000 000 : un montant en attente n'est pas déduit |
| Après confirmation | 10 000 000 | 2 500 000 (1) | 0 (0) | 7 500 000 |

Valeurs identiques après rechargement. Statuts réellement prévus :
« Déclaré, en attente de confirmation », puis « Confirmé par les deux
parties ».

*Actions selon les droits existants.*
- Propriétaire auteur de la déclaration : « Contester », « Annuler ma
  déclaration » et « Joindre le justificatif » ; jamais « Confirmer ».
- Entreprise : « Confirmer la réception » et « Contester ».

*Séparation entreprise / propriétaire.*
- Le propriétaire est refusé sur `/entreprise/chantiers/[id]` (« Chantier
  non accessible ») ; son tableau de bord entreprise est vide.
- Aucune dépense, aucun achat, aucun justificatif d'entreprise sur ses
  pages Chantier, Versements, Synthèse, Photos, Plans, Devis et
  Avancement. Le seul justificatif visible est celui de **son** propre
  versement.
- Sur ordinateur et à 390 px : aucun débordement horizontal.

*Données de démonstration ajoutées (local)*, sur ce chantier :
- 1 plan déposé, partagé, retenu, validé et publié ;
- 1 désignation d'ingénieur dans l'organisation « Espace professionnel »
  (entreprise de démonstration) ;
- 1 devis accepté (10 000 000 FCFA) ;
- l'avance exigée (3 000 000 FCFA) ;
- 1 versement reconnu (2 500 000 FCFA).

Preuves, hors Git : `exports/preuves/versements-2026-10-06/`.

**Confrontation aux critères écrits d'ESPACES-5** :
- satisfait : réutilisation de `list_advance_payments` et de
  `declare_advance_payment` (déclaration par la page existante), sans
  migration ;
- satisfait : présentation entreprise dédiée, avec statuts, prouvée de
  bout en bout ;
- **reste à faire, ESPACES-5 demeure partiel** :
  1. le menu « Versements clients » (`/entreprise/versements`) mène encore
     à la page générique `chantiers/[id]/acomptes`, pas à la présentation
     entreprise ;
  2. l'historique (`advance_events`) n'est consultable que sur la page
     générique, pas dans la présentation entreprise ;
  3. la fidélité à la maquette « Versements clients » n'est pas vérifiée :
     les huit maquettes du 2026-10-03 ne sont pas dans le dépôt, et aucune
     référence de substitution n'a été fabriquée.

## 5. Permissions concernées

Aucune permission existante n'est élargie. Nouvelles lignes nécessaires
(description seulement, non ajoutées à `PERMISSIONS.csv` ce tour) :
- `PHASE_VIEW`/`PHASE_UPDATE` (déjà présentes dans `PERMISSIONS.csv` à
  l'état de conception, §3.1 les rendrait réelles — CONTRACTOR écrit,
  OWNER/PRIMARY et CO_OWNER lisent, SITE_MANAGER à trancher).
- `CATALOG_PUBLISHED_VIEW` (déjà proposée, `PREPARATION_CATALOGUE_MODIFIABLE.md` §8.3).
- Permissions « dépenses » (`EXPENSE_*`) déjà présentes dans
  `PERMISSIONS.csv` à l'état de conception — inchangées par ce tour
  (Lot ESPACES-4 seulement, non chiffré ici).

## 6. Hors périmètre de cette analyse

Chef de chantier (aucune maquette fournie, menu actuel inchangé) ;
`/prototype-plans` (reste une action contextuelle, jamais un lien de nav
persistant) ; copie catalogue vers un chantier (Lot B du document
catalogue, inchangé) ; toute migration ou changement de droits — aucun
n'est créé ni appliqué par cette analyse.

## 7. Suivi de vérification — complété après le commit `d679a36`

Au moment du commit, `npm run build` et `npm run lint` (complets, tout le
dépôt) avaient échoué sur ce poste, consignés comme non concluants plutôt
que comme une absence d'erreur. Erreurs exactes observées, conservées
telles quelles :

- `npm run lint` (complet) : `FATAL ERROR: Zone Allocation failed -
  process out of memory` (V8), code de sortie 134.
- `npm run build` : `memory allocation of 540688 bytes failed` (allocateur
  natif de Turbopack/Rust), processus interrompu sans sortie de build.
- Mémoire libre mesurée au même moment : **2,15 Go sur 15,69 Go** —
  consommée par des processus hors de mon périmètre (VM Docker/WSL du
  Supabase local, applications de l'utilisateur, autres sessions Claude),
  aucun n'étant le serveur orphelin du port 3000 (`C:\ChantierLive`,
  jamais arrêté) ni un processus que j'ai le droit d'arrêter.

**Reproduit ensuite avec succès**, sans désactiver aucun contrôle :
- `npx eslint "src/**/*.{ts,tsx}"` (tout le code applicatif livré,
  mêmes règles, même configuration) : **0 erreur, 1 avertissement
  préexistant** (`src/lib/supabase/server.ts:28`, `_headers` inutilisé —
  non lié à ce lot).
- `npm run lint` (complet, tout le dépôt y compris `scripts/*.mjs`),
  rejoué après l'arrêt de mon propre serveur de vérification (port 3002,
  jamais le 3000) : **0 erreur, 2 avertissements préexistants** (le même
  plus un dans `scripts/test-catalog-items.mjs:476`, variable
  `latePrep` inutilisée — fichier de test non touché par ce lot).
- `npm run build` : **compilation réussie** (« Compiled successfully »,
  TypeScript et 22 pages statiques générés sans erreur), toutes les
  nouvelles routes (`/entreprise/*`, `/chantiers/[id]/avancement`,
  `/chantiers/[id]/catalogue`) présentes dans la sortie.
- `npm run verify` (lint + typecheck + test + build, pipeline complet) :
  **toutes les étapes réussies**.

**Conclusion** : l'échec initial était une contrainte de mémoire du poste
au moment précis de l'exécution (confirmé par la mesure de mémoire libre
et par la réussite immédiate une fois cette pression retombée), jamais
une erreur de code — ni conclu à tort comme une absence d'erreur avant
cette confirmation complète, ni masqué par une exécution partielle.

**Exécution adaptée proposée pour la suite**, sans désactiver aucun
contrôle :
1. Lint ciblé sur `src/**/*.{ts,tsx}` à chaque lot (déjà la pratique
   suivie ce tour-ci) — rapide, fiable même sous pression mémoire,
   mêmes règles exactes que le lint complet.
2. `npm run verify` (complet) relancé avant tout commit significatif,
   mais seulement après avoir arrêté les serveurs de vérification que
   j'ai moi-même démarrés (jamais le port 3000/C:) — déjà fait ce tour.
3. Si l'échec par manque de mémoire se reproduit malgré cela : le
   signaler explicitement comme non concluant (jamais l'interpréter
   comme une réussite), et proposer de le rejouer sur l'intégration
   continue GitHub déjà existante pour ce dépôt plutôt que de réduire la
   portée des règles localement.
