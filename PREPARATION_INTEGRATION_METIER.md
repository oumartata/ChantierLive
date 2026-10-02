# Préparation — intégration métier du générateur 2D au chantier

Document de préparation (analyse + plan), **aucune migration, aucun code,
aucune donnée écrite**. Complète `SUIVI_MOTEUR_PLANS_2D.md` (clôturé sur ses
7 jalons, prototype 2D isolé — voir ce fichier) et `MVP_BACKLOG.csv`
(compteur global, inchangé : 28/68, 41 %). Ne renumérote pas le backlog ;
toute nouvelle tâche (« demande » métier) nécessiterait un identifiant
attribué par le fondateur, jamais inventé ici.

---

## 1. Réutilisation — ce qui existe déjà (constat, pas une proposition)

Le pipeline dépôt → validation → publication d'un plan de chantier est
**déjà entièrement implémenté**, indépendamment de ce lot :

- **`src/app/(app)/chantiers/[id]/plans/page.tsx`** (465 lignes) et
  **`actions.ts`** (414 lignes) : liste des candidats, dépôt direct
  (`depositProjectPlanAction`), rattachement depuis le catalogue
  (`attachCatalogPlanAction`), choix/rétention (`setRetainedPlanAction`),
  soumission à validation technique (`submitPlanForValidationAction`),
  publication (`publishPlanAction`), partage SITE_MANAGER
  (`grantSiteManagerShareAction`/`revokeSiteManagerShareAction`).
- **`src/app/(app)/validations-plans/`** : boîte de réception de
  l'ingénieur habilité, distincte du catalogue (RPC
  `list_submitted_plan_validations`/`decide_plan_validation`, jamais
  confondue avec `plan_catalog_item_validations` — séparation affirmée par
  commentaire de migration, `m019`/`m023b`).
- **Flux `prepare`/`upload`/`finalize`** : générique
  (`private_object_uploads`, `m026`), déjà étendu à l'`entity_type`
  `project_plan_version` (`m020_project_plans.sql`) — c'est le MÊME
  mécanisme déjà utilisé pour les photos (`media_assets`) et le catalogue
  (`plan_catalog_item_versions`), pas une nouveauté à construire.
- **Tables déjà en place** : `project_plans`, `project_plan_versions`
  (origin `CATALOG`/`DIRECT`), `plan_validations`, `project_plan_publications`,
  `project_plan_shares`. Aucune de ces tables n'est modifiée par ce lot.
- **`src/app/prototype-plans/`** est aujourd'hui **totalement isolé** : le
  seul pont existant est un lien de navigation à sens unique
  (`/prototype-plans?retour={projectId}`, `plans/page.tsx:274-281`), qui ne
  lit ni n'écrit aucune donnée de chantier — confirmé par lecture directe
  (`prototype-plans/page.tsx`, hors groupe de routes `(app)`, aucune
  session ni permission).

**Conséquence directe** : le chaînon manquant n'est PAS le dépôt, la
validation ou la publication (déjà faits) — c'est uniquement (a) le pont
entre une disposition générée/éditée et un dépôt réel, et (b) la notion de
« demande » (paramètres de génération, historique) qui n'existe nulle part
aujourd'hui.

---

## 2. Parcours proposé

```
chantier → demande → génération → édition → choix explicite →
export/dépôt (version réelle) → validation technique → publication
```

| Étape | Mécanisme | Statut |
|---|---|---|
| chantier | `projects` / `project_memberships` | existant |
| demande | **nouveau concept, absent aujourd'hui** | à concevoir (§3) |
| génération | `buildFreePackedLayout` et les 4 autres familles, `src/app/prototype-plans/geometry.ts` | existant, clôturé (7/7 jalons) |
| édition | `PlanEditor.tsx` — brouillon LOCAL (`localStorage`, « reste dans ce navigateur, sur cet appareil uniquement », déjà affiché à l'utilisateur) | existant, jamais côté serveur |
| choix explicite | déjà un acte distinct pour le dépôt direct (`setRetainedPlanAction`) | existant pour la partie chantier ; absent pour choisir ENTRE PLUSIEURS variantes générées |
| export/dépôt | `renderSvg`/export SVG-PNG (prototype) + `depositProjectPlanAction` (chantier) — **pas encore reliés** | pont à construire (Lot 1, §4) |
| validation technique | `submitPlanForValidationAction` → `plan_validations` | existant, inchangé |
| publication | `publishPlanAction` → `project_plan_publications` | existant, inchangé |

**Brouillon d'édition ≠ demande métier** (distinction demandée explicitement
conservée) :
- Le **brouillon** (`PlanEditor`, déplacement/redimensionnement de pièces,
  annuler/rétablir) reste exactement ce qu'il est aujourd'hui : un état de
  travail local au navigateur, jamais synchronisé, jamais une preuve
  d'historique métier.
- La **demande** est le niveau au-dessus : un jeu de paramètres de
  génération (terrain, façade d'accès, programme de pièces) rattaché au
  chantier. **Modifier les paramètres crée une NOUVELLE demande** — jamais
  un écrasement de la précédente ; l'historique des demandes passées reste
  consultable même après qu'une variante a été déposée et publiée.
- Le dépôt réel (`project_plan_versions`) reste la seule chose qui compte
  pour la validation technique et la publication — une demande ou un
  brouillon qui n'a jamais été déposé n'entre jamais dans ce pipeline.

---

## 3. Données et droits (schéma minimal proposé — **non créé, non appliqué**)

### Schéma minimal proposé

```
project_plan_requests          -- la "demande"
  id, project_id (FK projects, requis),
  created_by_profile_id, created_as_role (OWNER_PRIMARY | CONTRACTOR),
  generation_params jsonb       -- GenerationInput sérialisé (terrain, accès, besoins…)
  status (OPEN | DEPOSITED | CANCELLED),
  created_at

project_plan_request_variants  -- chaque disposition générée/éditée pour une demande
  id, request_id (FK project_plan_requests),
  layout jsonb                  -- Layout sérialisé (même format que le fichier de projet .json)
  chosen boolean default false, -- "choix explicite" parmi les variantes
  project_plan_version_id       -- NULL tant que non déposée ; FK une fois déposée (lien vers le pipeline existant)
  created_at
```

Strictement rattaché au projet (`project_id` non nul, pas de colonne
organisation) et **hors catalogue** : aucune FK vers `plan_catalog_items`/
`plan_catalog_item_versions`, même séparation que `project_plan_versions`
aujourd'hui vis-à-vis du catalogue (§1).

### Règles d'accès (décisions conservées, pas réinventées)

- **Création/proposition d'une demande** : CONTRACTOR ou OWNER/PRIMARY
  uniquement — **confirmé identique au comportement RÉEL du code existant**
  (`plans/page.tsx:146-162` : CO_OWNER et SITE_MANAGER sont redirigés vers
  la vue réduite AVANT tout accès aux candidats/brouillons ; seuls
  `isOwnerPrimary`/`isContractor` atteignent le formulaire de dépôt). Note :
  `PERMISSIONS.csv` ligne `PLAN_DEPOSIT` marque `owner_co` comme
  conditionnel (`C`) — nuance préexistante, non résolue ici, sans effet sur
  cette décision puisque le code réel n'ouvre aujourd'hui aucun accès
  candidat à CO_OWNER.
- **Aucune extension à l'ingénieur seul** : confirmé qu'aucun rôle
  « ingénieur » n'existe comme rôle de chantier — c'est une désignation par
  organisation (`plan_engineer_designations`), dont la migration (`m023`)
  affirme explicitement qu'elle « ne confère par elle-même aucun droit de
  chantier ». La demande reste donc hors de portée de l'ingénieur seul par
  construction, pas par une règle ajoutée ici.
- **Consultation** : les mêmes lecteurs que les plans candidats
  aujourd'hui — OWNER_PRIMARY et CONTRACTOR uniquement (même
  redirection que ci-dessus) ; CO_OWNER/SITE_MANAGER ne verraient ni
  demandes ni variantes, seulement le plan publié (`PublishedPlanCard`,
  inchangé).
- **Validation technique sur une version réellement déposée** : une
  variante non déposée (`project_plan_version_id` NULL) ne peut jamais
  entrer dans `submitPlanForValidationAction` — ce champ est la seule
  passerelle vers le pipeline existant, jamais un raccourci.
- **Choix, validation, publication : trois actes distincts**, confirmé
  inchangé — `chosen` (choix d'une variante au sein d'une demande) ≠
  `setRetainedPlanAction` (rétention d'un candidat au niveau chantier,
  déjà existant) ≠ `decide_plan_validation` (validation) ≠
  `publishPlanAction` (publication). Aucun de ces actes n'est fusionné.

### Transitions autorisées (demande)

`OPEN` (création, variantes ajoutées librement par génération/édition) →
`DEPOSITED` (dès qu'une variante choisie a réellement un
`project_plan_version_id`, irréversible) ; `OPEN` → `CANCELLED` (abandon
explicite, n'efface pas l'historique). Jamais de retour `DEPOSITED` →
`OPEN`.

---

## 4. Découpage en lots autonomes

### Lot 1 — Pont génération → dépôt réel (réalisable **sans migration**)

- **Fichiers concernés** : `src/app/prototype-plans/PrototypeClient.tsx`,
  `PlanEditor.tsx`, `page.tsx` (lecture seule du rôle de l'appelant pour le
  `projectId` reçu via `retour`) ; aucun fichier de
  `chantiers/[id]/plans/` modifié — `depositProjectPlanAction` est
  **appelé tel quel**, jamais dupliqué ni réécrit.
- **Résultat utilisateur** : depuis `/prototype-plans?retour={id}`, un
  CONTRACTOR ou OWNER/PRIMARY du chantier peut déposer la disposition
  générée/éditée comme nouveau candidat — export automatique au format
  déjà accepté (`project-plans` : pdf/jpeg/png), reste du pipeline
  (validation, publication, partage) strictement inchangé.
- **Critères de réussite** : bouton de dépôt visible uniquement pour
  CONTRACTOR/OWNER_PRIMARY du chantier ciblé ; dépôt crée une ligne
  `project_plan_versions` réelle via le RPC existant, sans modification de
  celui-ci ; aucune régression du dépôt manuel existant.
- **Tests nécessaires** : vérifier (manuel ou script) qu'un appel avec un
  rôle non autorisé (ou sans session) est rejeté par le RPC
  SECURITY DEFINER existant, même si l'UI venait à mal filtrer ; non-
  régression de la suite 755 tests du moteur 2D (aucun changement attendu).
- **Autorisation encore requise** : aucune migration ; nécessite la
  confirmation du fondateur que le pont (code uniquement) peut être
  implémenté — pas de nouvelle dépendance, pas de nouvelle permission.

### Lot 2 — Schéma « demande » (nécessite une migration — **non créée**)

- **Fichiers concernés** : une nouvelle migration SQL (non écrite ce lot)
  pour `project_plan_requests`/`project_plan_request_variants` (§3) + RLS
  en lecture seule pour OWNER_PRIMARY/CONTRACTOR du projet, écriture
  réservée au créateur et aux SECURITY DEFINER functions, même schéma de
  revérification inline que l'existant (`has_project_role`,
  `is_primary_owner`).
- **Résultat utilisateur (une fois implémenté)** : l'historique des
  demandes et leurs variantes devient réellement consultable, jamais
  écrasé par une modification de paramètres.
- **Critères de réussite / tests nécessaires (futurs)** : round-trip
  demande → variante → dépôt (Lot 1) → validation → publication ; RLS
  testée (lecteur non autorisé rejeté) à l'image des tests existants sur
  `plan_validations`.
- **Autorisation encore requise** : **autorisation explicite du fondateur
  pour la migration** (règle constante de ce chantier) avant toute
  écriture de fichier `supabase/migrations/*.sql` — bloquant, non levé par
  ce document.

### Lot 3 — UI « demande » (dépend du Lot 2)

- **Fichiers concernés** : soit une nouvelle section dans
  `chantiers/[id]/plans/page.tsx` (recommandé, §5), soit une nouvelle
  route `chantiers/[id]/demandes/` (alternative, fragmente la navigation
  déjà complète de `plans/`).
- **Résultat utilisateur** : créer une demande pré-remplit
  `/prototype-plans` avec ses paramètres (même mécanisme que `retour`,
  étendu) ; lister les demandes passées et leurs variantes ; choisir une
  variante puis la déposer (réutilise le Lot 1).
- **Dépend strictement du Lot 2** — ne peut pas commencer avant que la
  migration soit autorisée et appliquée.

---

## 5. Décisions encore ouvertes (recommandation, pas un arbitrage imposé)

1. **Emplacement de l'UI « demande »** (Lot 3) : section dans
   `plans/page.tsx` existant, ou route séparée `demandes/`. **Recommandation** :
   section dans `plans/page.tsx` — cette page gère déjà tout le cycle de
   vie d'un plan (candidats, validation, publication, partage) ; une route
   séparée fragmenterait un parcours qui est aujourd'hui cohérent en un
   seul endroit. Décision finale au fondateur.
2. **Format du dépôt généré** : image/PDF plat (comme un dépôt manuel
   aujourd'hui, perd la ré-éditabilité) vs. conserver le fichier de projet
   `.json` en plus (seul format « réellement modifiable », déjà affirmé
   dans l'interface du prototype). Le schéma §3 n'empêche pas cette
   évolution (`layout jsonb` dans `project_plan_request_variants` la
   conserve déjà côté demande, indépendamment du format déposé) — mais le
   DÉPÔT lui-même (`project_plan_versions`) ne stocke aujourd'hui qu'un
   fichier Storage plat. Décision à prendre avant le Lot 2 : simple (pas de
   changement du format de dépôt) ou plus ambitieux (nouveau type de
   pièce jointe modifiable). **Recommandation** : rester sur le format
   plat pour ce premier lot — la ré-édition après dépôt n'est demandée par
   aucune preuve d'usage à ce jour, et l'historique des variantes (jsonb,
   §3) préserve déjà la génération d'origine sans y toucher.
3. **Backlog** : aucune tâche `MVP_BACKLOG.csv` ne couvre la « demande »
   (B063/B064 couvrent déjà rattachement + validation/publication, déjà
   implémentés). Une nouvelle tâche serait nécessaire pour un suivi global
   cohérent — identifiant et priorité à attribuer par le fondateur, jamais
   improvisé ici.

---

## 6. Preuves déjà produites — famille guidée avec cour (réutilisables telles quelles)

Aucun nouveau test nécessaire ; références existantes :

- **Tests** : `scripts/test-plans-geometry.mjs`, section 23 (ligne 1551,
  « FAMILLE GUIDÉE (salon central / cour d'entrée) — QUATRE FAÇADES »),
  scénario « cour d'entrée seule » (ligne 1572, `entryMode: "courtyard"`),
  protection de la cour vérifiée explicitement (ligne 1608 : « cour
  d'entrée présente et protégée »). Partie des 755/755 tests actuellement
  verts (`node scripts/test-plans-geometry.mjs`).
- **Suivi** : `SUIVI_MOTEUR_PLANS_2D.md`, journal du lot « familles guidée
  et en L sur 4 façades » (commit `4684e95`) — round-trip
  génération→export→réimport vérifié en navigateur pour la famille guidée,
  accès arrière.
- **Livrables réels** : `guidee_arriere_REEL.projet.json` (fichier de
  projet réel) et `guidee_arriere_REEL.svg` (rendu correspondant),
  déjà produits et déjà transmis — à rejoindre sans refaire leur
  développement si une nouvelle transmission est utile.

---

## 7. Clôture de ce lot

28/68 (41 %) global, inchangé — aucune tâche `MVP_BACKLOG.csv` modifiée par
ce document. **7/7 jalons du prototype 2D**, dans leur périmètre exact
(génération uniquement, voir `SUIVI_MOTEUR_PLANS_2D.md`). **État de
préparation de l'intégration métier** : analyse ciblée terminée, parcours
et schéma minimal proposés, découpage en 3 lots autonomes (1 réalisable
sans migration, 2 et 3 bloqués sur une autorisation de migration non
demandée ni accordée ce lot), aucune décision déjà prise réinventée,
3 décisions ouvertes consignées avec recommandation. Aucune modification du
moteur, des permissions, des données ou du schéma. Aucun push, fusion,
déploiement ou nouvelle dépendance.
