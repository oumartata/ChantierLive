# Avancement des travaux — préparation et réalisation (M033)

**Statut : réalisé**, commit `bf05e20` (2026-10-03), migration
`supabase/migrations/20261003050000_m033_project_phases.sql`, **appliquée
en local uniquement** (aucune migration distante). Ce document a d'abord
été une préparation (commit `b9d7903`, « aucune migration créée ») ; il est
désormais aligné sur ce qui a réellement été livré. Les écarts entre la
préparation et la réalisation sont listés au §8, sans les masquer.

Aucun identifiant de backlog n'est attaché à ce lot (même convention que
M031/M032) : le compteur global reste **29/69**.

## 0. Identifiant de migration

La séquence réelle M001 → M032b ne présente aucun trou (M030 existe et est
appliqué, `20260930110000`). Le lot porte donc le prochain numéro réel,
**M033**, horodaté au jour du dépôt (`20261003050000`). Les identifiants
M007/M008 de `MIGRATION_ORDER.csv` (lignes 8-9 : `phase_templates
template_items`, `project_phases phase_versions`) restent une **référence
de conception** citée en commentaire de la migration ; ils ne sont pas
réutilisés comme nom de fichier.

## 1. Périmètre livré

**Inclus** :
- étapes nommées par chantier, avec un poids (somme exactement 100 à la
  publication) et une progression de 0 à 100 % chacune ;
- un modèle initial de six étapes proposé par l'interface, à poids vides,
  entièrement modifiable par l'entreprise avant publication (§2.4) ;
- l'avancement global calculé, consultable par toute adhésion active ;
- l'historique attribué et append-only de chaque événement ;
- la restructuration après publication, avec motif obligatoire ;
- la fiche chantier propriétaire (`chantiers/[id]/page.tsx`), qui affiche
  le pourcentage réel au lieu du message « indisponible » ;
- la délégation `PHASE_UPDATE_PROGRESS` accordable depuis
  `chantiers/[id]/equipe`, en réutilisant le composant de délégation
  existant.

**Exclu** :
- toute validation automatique par photo ou géolocalisation ;
- `PHASE_VALIDATE` (approbation propriétaire) : **hors périmètre**, rien
  n'est créé (§3.2) ;
- les dépenses internes (lot séparé, `PREPARATION_ETAPES_DEPENSES_INTERNES.md`) ;
- le catalogue de plans.

## 2. Modèle de données réalisé

Trois tables, avec RLS activée **et** tous les privilèges de table
révoqués : l'accès passe uniquement par les fonctions `SECURITY DEFINER`
du §4 (même durcissement que `advance_ledgers`, M014).

### 2.1 `project_phase_plans` (une ligne par chantier)
`id`, `project_id` (unique), `status` (`BROUILLON` | `PUBLIE`), `revision`
(concurrence optimiste), `last_event_seq`, `published_at_server`,
`published_by_profile_id`, `created_at_server`. Une contrainte impose la
cohérence entre le statut et les champs de publication. Des déclencheurs
interdisent de dépublier un plan ou de modifier ses champs immuables.

### 2.2 `project_phases` (étapes d'un chantier)
`id`, `project_id`, `plan_id`, `position` (> 0, unique parmi les étapes
actives), `label` (1 à 200 caractères), `weight` (0 à 100), `progression`
(0 à 100, défaut 0), `archived_at`, `created_at_server`.

Après publication, une étape retirée est **archivée**, jamais supprimée.
La somme des poids n'est pas contrainte ligne à ligne : elle est vérifiée
par `publish_phase_plan` et `restructure_phase_plan`.

### 2.3 `project_phase_events` (historique append-only)
`event_seq` (unique par plan), `event_type` (`PLAN_PUBLISHED` |
`PROGRESSION_UPDATED` | `STRUCTURE_CHANGED`), `previous_value`,
`new_value`, `actor_profile_id`, `actor_role` (`CONTRACTOR` |
`SITE_MANAGER`), `reason` (obligatoire pour `STRUCTURE_CHANGED`),
`computed_global_progress` (0 à 100), `created_at_server`.

Toute modification ou suppression d'un événement est refusée par
déclencheur. `computed_global_progress` est **figé** au moment de
l'événement, avec les poids alors en vigueur : une restructuration
ultérieure ne réécrit jamais l'historique déjà affiché.

### 2.4 Modèle initial : six étapes, côté application
Le modèle par défaut **n'est pas semé en SQL**. Il est défini dans
`src/app/(app)/chantiers/[id]/avancement/PhasePlanForms.tsx`
(`DEFAULT_ROWS`) : Préparation du chantier, Fondations, Gros œuvre,
Toiture / étanchéité, Second œuvre, Finitions. Les **poids sont vides** :
l'entreprise les saisit elle-même, la publication exige une somme de 100.

Ce choix est **accepté par le fondateur** (2026-10-04). Les tables
`phase_templates`/`template_items` prévues par la préparation **ne sont
pas créées**, faute de besoin fonctionnel démontré. Elles ne le seront que
si un besoin réel apparaît, par exemple des modèles propres à une
organisation.

## 3. Droits réalisés

| Action | Fonction | Permission | PRIMARY | CO_OWNER | CONTRACTOR | SITE_MANAGER |
|---|---|---|---|---|---|---|
| Lire le plan, les étapes, l'historique et le pourcentage | `get_project_phase_plan`, `list_project_phases`, `list_phase_events` | `PHASE_VIEW` | A | A | A | A |
| Composer et modifier le brouillon | `upsert_phase_plan_draft` | `PHASE_CREATE` / `PHASE_EDIT_DRAFT` | N | N | A | N |
| Publier (somme des poids = 100) | `publish_phase_plan` | `PHASE_PUBLISH` | N | N | A | N |
| Déclarer la progression d'une étape publiée | `update_phase_progress` | **`PHASE_UPDATE_PROGRESS`** | N | N | A | C (délégation active sur CE chantier) |
| Restructurer après publication (motif obligatoire) | `restructure_phase_plan` | `PHASE_EDIT_DRAFT` + `PHASE_PUBLISH` | N | N | A | N |

A = autorisé nativement ; C = sous condition ; N = refusé. Toute écriture
exige un compte vérifié (`is_account_provisional() = false`) et la révision
attendue (`revision_conflict` sinon). « Lire » signifie : toute adhésion
active du chantier.

### 3.1 `PHASE_UPDATE_PROGRESS`
Ce code est **ajouté à `PERMISSIONS.csv`** (2026-10-04) et décrit
exactement le droit implémenté, sans l'élargir :
- l'entrepreneur actif du chantier l'a nativement ;
- le chef de chantier l'a seulement avec une délégation active, accordée
  par l'entrepreneur et limitée à ce chantier ;
- le propriétaire (principal ou copropriétaire) et la plateforme sont
  toujours refusés.

Techniquement, M033 étend la contrainte `membership_permissions`,
`has_project_permission` et `delegation_couple` (même couple
CONTRACTOR → SITE_MANAGER que `PHASE_EDIT_DRAFT`).

**Écart ouvert entre la conception et la réalisation (non résolu)** :
- dans `PERMISSIONS.csv`, `PHASE_CREATE` et `PHASE_PUBLISH` donnent au
  propriétaire principal un droit conditionnel (C, « proposer ») ;
- `PHASE_EDIT_DRAFT` donne au chef de chantier un droit sur délégation ;
- M033 réserve ces trois actions au seul CONTRACTOR.

Décision du fondateur (2026-10-04) : **conserver la restriction actuelle à
l'entreprise dans ce lot**, sans modifier les permissions. Les lignes de
`PERMISSIONS.csv` concernées ne sont ni réécrites ni implémentées.
L'écart reste ouvert : il faudra le trancher explicitement, soit en
alignant la conception sur la restriction, soit en implémentant les droits
conditionnels dans un lot dédié.

### 3.2 `PHASE_VALIDATE` : hors périmètre
`PHASE_VALIDATE` reste dans la conception, n'est pas implémenté et n'est
pas supprimé. **Aucune approbation propriétaire n'est créée.**
L'avancement est affiché comme « déclaré par l'entreprise ».

## 4. Calcul réalisé

```
avancement_global = Σ(weight_i × progression_i) / 100
```

Le calcul porte sur les étapes actives (`archived_at is null`) d'un plan
`PUBLIE`. Comme la somme des poids vaut 100, le résultat est borné entre 0
et 100. Tant que le plan est en `BROUILLON`, `global_progress` vaut
`NULL` : aucun pourcentage n'est affiché.

La valeur courante est recalculée à la lecture. La valeur historique est
celle figée dans `project_phase_events.computed_global_progress`.

Affichage propriétaire : « Avancement déclaré par l'entreprise »,
pourcentage, date du dernier événement. Il n'existe aucune commande
d'écriture.

## 5. Migration (réalisée)

`20261003050000_m033_project_phases.sql` (830 lignes) :
- §1 extension de la délégation ;
- §2 tables ;
- §3 déclencheurs d'invariants ;
- §4 types de retour ;
- §5 lecture ;
- §6 brouillon et publication ;
- §7 progression ;
- §8 restructuration.

Elle ne contient aucun seed et aucune donnée métier. Elle est **appliquée en
local uniquement**. Une sauvegarde a été prise avant application
(`.local_backups/pre_m033_*_20261003_043126.sql`).

## 6. Critères de validation et preuves

| Critère | Preuve |
|---|---|
| Publication refusée si la somme des poids ≠ 100 (brouillon et publication), sans arrondi | `scripts/test-project-phases.mjs` |
| Progression hors de 0-100 refusée | idem |
| Écriture refusée pour OWNER/PRIMARY, CO_OWNER et tiers, y compris par appel RPC direct | idem |
| SITE_MANAGER refusé sans délégation, autorisé avec délégation active | idem |
| Calcul pondéré exact (vérifié par un calcul indépendant) | idem |
| Restructuration refusée sans motif ; historique antérieur inchangé (comparé ligne à ligne) | idem |
| Modification concurrente détectée (`revision_conflict`) | idem |
| Parcours complet : publication → mise à jour → consultation propriétaire → rechargement (RPC) | idem — **37/37** |
| Non-régression | `npm run verify` complet vert au commit `bf05e20`, puis de nouveau après la restauration du 04/10 (755/755) |
| Parcours navigateur entreprise et propriétaire, ordinateur et mobile 390×844 | **non fait au commit `bf05e20`** (panneau navigateur indisponible). Voir §7 |

## 7. Validation navigateur (2026-10-04)

Données utilisées : préparation dédiée et limitée,
`scripts/seed-demo-avancement.mjs`. Elle crée 2 comptes neufs, un chantier
« DÉMO AVANCEMENT — validation navigateur », un CONTRACTOR et un
OWNER/PRIMARY ajouté par invitation réelle. Elle ne modifie aucun compte
existant. Le script `demo_seed_chantierlive.mjs` a été écarté : il
réinitialise le mot de passe des comptes déjà présents.

Une sauvegarde a été prise avant ces saisies :
`.local_backups/pre_demo_avancement_data_20261004_173218.sql`.

### 7.1 Conditions

- Serveur : `next dev` lancé depuis `C:\Projets\ChantierLive` (processus
  en écoute sur 127.0.0.1:3000 contrôlé). Une première partie du parcours
  a été observée sur un serveur `next start` présent sur le même port (build
  du 04/10 06:25, code de `bf05e20`) ; elle a suffi à reproduire D1, puis le
  serveur de développement l'a remplacé pour vérifier les correctifs.
- Deux sessions, l'une par origine : `localhost:3000` affiche « Espace
  entreprise » (CONTRACTOR), `127.0.0.1:3000` affiche « Espace
  propriétaire » (OWNER/PRIMARY). Les connexions ont été faites par le
  fondateur ; le fichier d'identifiants n'a pas été lu.
- Chantier : « DÉMO AVANCEMENT — validation navigateur »
  (`100c28c0-7ad5-4cc0-8da4-b664ce8713e3`).

### 7.2 Résultats observés

| Contrôle | Résultat |
|---|---|
| Brouillon, modèle de 6 étapes à poids vides | ✅ affiché ; poids saisis 10/20/30/15/15/5, « Somme des poids : 95 % » |
| Enregistrement du brouillon | ✅ en base : `BROUILLON`, révision 1, poids conservés après rechargement |
| Refus d'un total invalide | ✅ « Publier » désactivé à 95 % ; refus serveur `weight_sum_invalid` affiché (« Publication impossible ») |
| Publication valide (100 %) | ✅ `PUBLIE`, poids 10/20/30/15/15/10, entrée n° 1 à 0 % |
| Progression | ✅ Préparation 100 % → 10 % (n° 2) ; Fondations 50 % → 20 % (n° 3) |
| Restructuration | ✅ bouton désactivé sans motif ; impact annoncé 22,5 % ; résultat 22,5 % (n° 4, motif affiché) ; entrées n° 1 à 3 inchangées (0 / 10 / 20 %) |
| Propriétaire | ✅ 22,5 % exact, « Avancement déclaré par l'entreprise », « Dernière mise à jour le 04/10/2026 20:43:01 par l'entreprise », historique complet ; **0 bouton, 0 formulaire, 0 champ** dans le contenu ; fiche « Mon chantier » : « Avancement 22,5 % — Déclaré par l'entreprise » |
| Persistance après rechargement (`navigation.type = reload`, deux sessions) | ✅ identique à la base : 22,5 %, 6 événements, poids 10/25/25/10/15/15, progressions 100/50/0/0/0/0 |
| Mobile 390×844 (deux sessions) | ✅ largeur de document 390, aucun élément hors écran |
| Ordinateur 1024×768 (deux sessions) | ✅ largeur de document 1009 ≤ 1024, aucun élément hors écran ; captures partielles seulement (limite §7.4) |

### 7.3 Défauts reproduits et corrigés (aucune migration)

| # | Défaut reproduit | Correctif | Preuve |
|---|---|---|---|
| D1 | « Publier » publiait le brouillon **enregistré**, pas l'écran : affichage simultané « Somme des poids : 100 % » et « Publication impossible — somme ≠ 100 » ; si le brouillon enregistré totalisait déjà 100, des modifications non enregistrées auraient été ignorées sans avertissement | `publishPlanAction` enregistre d'abord les étapes affichées (`upsert_phase_plan_draft`, révision revérifiée) puis publie la révision obtenue | navigateur : publication directe sans enregistrement → poids publiés = poids affichés ; `scripts/test-phase-plan-actions.mjs` |
| D2 | Aucun retour après « Enregistrer le brouillon » | bandeau « Brouillon enregistré » | navigateur |
| D3 | Après une restructuration réussie, l'éditeur restait ouvert, motif conservé : un second clic a créé l'entrée n° 5, identique à n° 4 | éditeur refermé après succès ; l'action refuse une structure identique à celle en vigueur (« Aucune modification… ») | navigateur : refus affiché, aucune entrée n° 6 ; puis vraie modification acceptée (n° 6) et éditeur refermé ; test ciblé |
| D4 | Pourcentages au format anglais (« 22.5 % ») et « % » renvoyé seul à la ligne sur mobile (« 100 / % ») | `formatPercent` (fr-FR, espace insécable) sur les 5 affichages | captures 04 (avant) et 05 (après) |

L'entrée n° 5 (doublon de D3) **reste dans l'historique du chantier de
démonstration** : l'historique est append-only, et un déclencheur refuse
toute modification ou suppression. Rien n'a été contourné pour l'effacer.

Tests : `scripts/test-phase-plan-actions.mjs` 17/17 (logique pure et
séquence RPC exacte de la publication corrigée) ; non-régression
`scripts/test-project-phases.mjs` 37/37. Limite : les Server Actions Next
ne sont pas appelées par ces scripts ; leur comportement est prouvé par le
parcours navigateur ci-dessus.

### 7.4 Limites de cette validation

- Captures en 1024×768 : le panneau du navigateur intégré était masqué
  (`tabs_context` : « The Browser pane is currently hidden »). Les captures
  sont alors recadrées à environ 800 px CSS, ou expirent (message exact :
  « screenshot failed: Screenshot timed out after 5s: the page did not
  finish rendering in time »). La vue ordinateur est prouvée par les
  mesures DOM et le texte. Pour une capture pleine page, il faut afficher
  et élargir le panneau du navigateur, puis relancer la capture.
- Le chef de chantier avec délégation n'a pas été parcouru en navigateur ;
  ce cas est couvert par `test-project-phases.mjs`.
- Captures conservées hors Git : `exports/preuves/avancement-2026-10-04/`.

## 8. Écarts entre la préparation (`b9d7903`) et la réalisation (`bf05e20`)

| Préparation | Réalisation | Statut |
|---|---|---|
| Tables `phase_templates`/`template_items` avec seed | Non créées ; modèle de six étapes à poids vides côté application | Accepté par le fondateur le 2026-10-04 |
| Valeurs par défaut « à confirmer » | Six libellés, poids vides | Accepté |
| `PHASE_UPDATE_PROGRESS` à ajouter à `PERMISSIONS.csv` **avant** le code | Ajouté après coup, le 2026-10-04, à l'identique du droit implémenté | Corrigé |
| Propriétaire principal « C » sur la publication et la restructuration (proposition) | CONTRACTOR seul | **Écart ouvert, non résolu** ; restriction conservée dans ce lot (fondateur, 2026-10-04) |
| Chef de chantier « C » sur le brouillon via délégation | CONTRACTOR seul | **Écart ouvert, non résolu** ; restriction conservée dans ce lot (fondateur, 2026-10-04) |
| RPC nommées `add_phase`/`edit_phase_draft`/`reorder_phases`/`get_project_progress` | `upsert_phase_plan_draft` (liste complète) ; pourcentage renvoyé par `get_project_phase_plan` | Équivalent fonctionnel |
| Colonne `revision`, `actor_role`, `event_seq` | Ajoutées (concurrence, attribution, ordre) | Complément |
