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

**Statut : terminé**, implémenté et vérifié (branche `claude/plans-generator`,
voir le commit de ce lot). Preuves : typecheck/lint 0 erreur ; 755/755
tests moteur 2D inchangés (aucun fichier du moteur touché) ; 49/49 tests
`scripts/test-project-plans.mjs` (B063, inchangé) rejoués — dépôt
CONTRACTOR/OWNER_PRIMARY toujours admis, CO_OWNER toujours refusé,
dépôt manuel (`DepositPlanForm`) non régressé ; nouveau
`scripts/test-prototype-plans-bridge.mjs` (3/3) — refus serveur confirmés
sans session (`permission denied`) et pour un chantier où l'appelant
authentifié n'a aucune adhésion active (`not_authorized`) ; parcours réel
en navigateur (serveur E:, port 3002, chantier de démo local dédié) —
génération → édition → dépôt confirmé avec aperçu → candidat réel
(« Plan 2 ») visible après rechargement complet, fichier PNG réellement
signé/téléchargeable (légendes et mention d'avant-projet gravées dedans),
aucune retenue/validation/publication automatique, candidat et historique
préexistants (« Plan 1 », retenu/publié/validé) inchangés ; brouillon local
(localStorage) intact après le dépôt réussi, confirmé après navigation et
rechargement.

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

### Lot 2 — Schéma « demande » (migration — **créée et appliquée, local uniquement**)

**Statut : terminé.** Autorisation fondateur explicite reçue (2026-10-03) pour
créer et appliquer les migrations UNIQUEMENT sur Supabase local. Migrations :
`20260930120000_m031_project_plan_requests.sql` (tables + triggers d'immuabilité),
`20260930130000_m031b_project_plan_requests_functions.sql` (RPC), corrections
ciblées `20260930135000_m031c` (colonne ambiguë) et `20260930140000_m031d`
(`max(uuid)` inexistant), détectées et corrigées via test ciblé/parcours
navigateur avant la clôture de ce lot — jamais une réécriture de M031/M031b.
Avant application : cible locale confirmée (`supabase projects list` — aucun
projet lié), sauvegarde `pg_dump` schéma+données dans `.local_backups/`
(ignoré par git), migrations en attente examinées (M029/M030 déjà présentes
dans le dépôt, non liées à ce lot — un écart de suivi préexistant découvert
au passage, réconcilié sans toucher aux données, voir le journal). Aucun
reset, aucune suppression de donnée existante.

- **Fichiers concernés** : `supabase/migrations/20260930120000_m031_*.sql`,
  `..._130000_m031b_*.sql`, `..._135000_m031c_*.sql`, `..._140000_m031d_*.sql`.
  `project_plan_requests`/`project_plan_request_variants` : RLS activée,
  AUCUNE policy (même convention que `project_plan_versions`/`plan_validations`
  — accès exclusivement par fonctions SECURITY DEFINER, jamais par lecture
  directe de table). Permissions reprises telles quelles : CONTRACTOR ou
  OWNER/PRIMARY du chantier ciblé uniquement, re-vérifiées inline (`for update`)
  dans chaque fonction — jamais `has_project_role`/`is_primary_owner` seuls
  pour les mutations (même style que `set_retained_project_plan_version`).
- **Résultat utilisateur** : l'historique des demandes et leurs variantes est
  réellement consultable, jamais écrasé par une modification de paramètres
  (nouvelle demande) ni par l'édition d'une variante (nouvelle variante,
  parent_variant_id conservant la filiation).
- **Preuves** : `scripts/test-plan-requests.mjs`, 27/27 — rôles autorisés/
  refusés, sans session, chantier non autorisé, rattachement à une version
  d'un autre chantier refusé (FK composite), immuabilité (UPDATE/DELETE
  directs refusés, y compris en service_role), reprise idempotente d'un
  dépôt (même operation_uuid, pas de doublon), aucune retenue/validation/
  publication automatique. Non-régression : `scripts/test-project-plans.mjs`
  49/49 (RPC M020/M026 inchangées), `scripts/test-plans-geometry.mjs` 755/755
  (moteur 2D non touché).

### Lot 3 — UI « demande » (**terminé**)

**Statut : terminé.** Section ajoutée dans `chantiers/[id]/plans/page.tsx`
(recommandation du lot précédent retenue, pas de nouvelle route) : liste des
demandes, bouton de création. `/prototype-plans` accepte `?demande=new`
(créée au premier "Générer", avec les paramètres réellement utilisés) ou un
identifiant existant (reprise après rechargement). `PlanEditor` ajoute la
sauvegarde/chargement de variantes (même format `ProjectFile` versionné et
validé que l'export/import de fichier, `serializeProject`/`validateProjectFile`
réutilisés tels quels) et le dépôt d'une variante via
`depositPlanRequestVariantAction` (nouvelle action, réutilise
`ensureReadyToFinalize`, extrait de `depositProjectPlanAction` sans le
dupliquer, puis appelle `finalize_plan_request_variant_deposit` — jamais
`finalize_project_plan_upload` directement pour une variante).

- **Fichiers concernés** : `chantiers/[id]/plans/page.tsx`, `actions.ts`
  (nouvelles actions + refactor partagé), `prototype-plans/page.tsx`,
  `PrototypeClient.tsx`, `PlanEditor.tsx`.
- **Résultat utilisateur** : créer une demande pré-remplit `/prototype-plans`
  (même mécanisme que `retour`, étendu) ; lister les demandes et leurs
  variantes ; charger une variante sans écraser silencieusement le brouillon
  local (confirmation explicite) ; choisir une variante puis la déposer
  (réutilise le Lot 1) ; après dépôt, repartir d'une copie modifiable
  (« Déposer encore (après modification) », export JSON toujours disponible)
  sans toucher à l'historique déposé.
- **Preuve** : parcours navigateur réel complet sur le serveur E: (port 3002),
  chantier de démo local dédié — créer une demande → générer → éditer →
  sauvegarder une variante → rechargement complet de la page → variante
  retrouvée → choisir (« Ouvrir ») → déposer → candidat réel confirmé sur la
  page Plans, demande passée à « Déposée », aucune retenue/validation/
  publication automatique, candidats précédents inchangés.

---

## 5. Décisions (2 tranchées au fil des lots, 1 reste ouverte)

1. **Emplacement de l'UI « demande »** (Lot 3) — **tranchée ce lot** : section
   dans `plans/page.tsx` existant (recommandation retenue), jamais de route
   séparée `demandes/`.
2. **Format du dépôt généré** — **tranché par le fondateur (autorisation
   Lots 2/3)** : « le dépôt reste un PNG via le pipeline existant ». Le format
   Storage (`project_plan_versions`) reste un fichier plat, jamais modifiable
   après dépôt — la ré-éditabilité est assurée AUTREMENT : l'état modifiable
   complet (format `ProjectFile` versionné/validé) est conservé côté demande
   (`project_plan_request_variants.layout`), consultable et rechargeable
   indéfiniment, indépendamment du PNG déposé.
3. **Backlog** : aucune tâche `MVP_BACKLOG.csv` ne couvre la « demande »
   (B063/B064 couvrent déjà rattachement + validation/publication, déjà
   implémentés). Une nouvelle tâche serait nécessaire pour un suivi global
   cohérent — identifiant et priorité à attribuer par le fondateur, jamais
   improvisé ici.

---

## 6. Preuves déjà produites — famille guidée (réutilisables telles quelles)

Aucun nouveau test nécessaire ; références existantes. **Correction
apportée ce lot** : les deux preuves ci-dessous couvrent deux scénarios
DIFFÉRENTS de la même famille — le fichier déjà transmis ne prouve PAS à
lui seul le cas avec cour d'entrée, distingués explicitement ici.

- **Cas AVEC cour d'entrée** — preuve = **tests uniquement**, aucun
  fichier exporté n'existe pour ce cas précis : `scripts/test-plans-geometry.mjs`,
  section 23 (ligne 1551, « FAMILLE GUIDÉE (salon central / cour d'entrée) —
  QUATRE FAÇADES »), scénario « cour d'entrée seule » (ligne 1572,
  `entryMode: "courtyard"`), sur les 4 façades × 2 terrains, protection de
  la cour vérifiée explicitement à chaque fois (ligne 1608 : « cour
  d'entrée présente et protégée (aucune pièce ne la chevauche) »). Partie
  des 755/755 tests actuellement verts (`node scripts/test-plans-geometry.mjs`).
- **Cas SANS cour (salon central seul)** — preuve = tests (même section 23,
  scénario « salon central », ligne ~1571) **ET** livrable réel déjà
  transmis : `guidee_arriere_REEL.projet.json` / `.svg` — vérifié par
  relecture directe de ce fichier (`"courtyard": null`) : **ce livrable
  n'illustre PAS le cas avec cour**, seulement le salon central. Round-trip
  génération→export→réimport correspondant vérifié en navigateur, accès
  arrière (`SUIVI_MOTEUR_PLANS_2D.md`, journal du lot « familles guidée et
  en L sur 4 façades », commit `4684e95`).
- **Si un livrable réel du cas AVEC cour est utile** : non produit à ce
  jour — à générer en rejouant simplement la fixture de la section 23
  (`entryMode: "courtyard"`, terrain/reculs déjà choisis par ce test) à
  travers `buildGuidedLayout` + `renderSvg`/`serializeProject`, sans aucun
  nouveau développement (mêmes fonctions, même méthode que tous les
  livrables déjà produits ce chantier) — non fait ici, hors demande de ce
  lot (Lot 1 seul).

---

## 7. Clôture de ce lot

28/68 (41 %) global, inchangé — aucune tâche `MVP_BACKLOG.csv` réellement
clôturée par ces lots (aucun identifiant inventé). **7/7 jalons du prototype
2D**, dans leur périmètre exact (génération uniquement, voir
`SUIVI_MOTEUR_PLANS_2D.md`, inchangé). **Intégration métier — Lots 1, 2 et 3
terminés** : pont génération→dépôt réel (Lot 1), schéma et RPC
demandes/variantes créés et appliqués en local uniquement (Lot 2, M031),
parcours complet dans l'UI (Lot 3) — créer une demande → générer → éditer →
sauvegarder une variante → retrouver après rechargement → choisir → déposer
→ retrouver le candidat réel, vérifié en navigateur sur le serveur E:.
Permissions inchangées (CONTRACTOR/OWNER-PRIMARY du chantier uniquement),
RLS + SECURITY DEFINER partout, aucun contournement de prepare/upload/
finalize ni de validation/publication. Migrations créées et appliquées
UNIQUEMENT sur l'instance Supabase locale (jamais distante), après
sauvegarde locale et vérification des migrations en attente. Aucun push,
fusion, déploiement ou nouvelle dépendance. 1 décision reste ouverte
(identifiant backlog de la « demande », §5).
