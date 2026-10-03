# Préparation — intégration métier du générateur 2D au chantier

Document de préparation et de suivi des Lots 1/2/3 (tous terminés — voir §12).
Complète `SUIVI_MOTEUR_PLANS_2D.md` (clôturé sur ses 7 jalons, prototype 2D
isolé) et `MVP_BACKLOG.csv` (compteur global : **29/69, 42 %**, depuis
l'ajout validé de `B069` le 2026-10-03, §11). Aucun identifiant de backlog
n'a été inventé ici : `B069` a été vérifié disponible dans le fichier réel
avant insertion, jamais présumé.

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

## 3. Données et droits (schéma — **créé et appliqué en local, voir §8**)

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

## 8. Migrations exécutées ce lot (détail exact, aucun secret)

Cible confirmée strictement locale AVANT toute opération : `npx supabase
projects list` montrait les trois projets distants existants tous
`"linked": false` ; aucun fichier `supabase/.temp/project-ref` ; toutes les
commandes ci-dessous passaient explicitement `--local`. Sauvegarde
`pg_dump` (schéma + données) écrite dans `.local_backups/` avant la
première opération (fichier ignoré par git, jamais commité, jamais cité ici
par son contenu).

**Écart préexistant découvert en examinant les migrations en attente**
(`supabase migration list --local`, avant toute opération) : deux
migrations déjà commitées dans le dépôt, `20260930100000_m029_*.sql` et
`20260930110000_m030_*.sql`, avaient `remote: ""` (jamais appliquées sur
CETTE instance locale) — ni l'une ni l'autre ne concerne ce lot (B014 et
B015/B016 respectivement, antérieures et sans rapport avec M031). Pas une
migration "étrangère" au sens d'un contenu inconnu ou non commité (`git log`
confirmait les deux déjà committées, `git status` les montrait propres) :
un simple retard d'application locale.

- `supabase migration up --local` → a tenté `20260930100000_m029_*.sql` en
  premier (ordre chronologique) → a échoué : `constraint
  "projects_latitude_range" ... already exists`. Lecture directe de l'état
  réel (`pg_get_functiondef` sur `update_draft_project`) : les 3 contraintes
  CHECK existaient déjà sur `projects` (posées hors suivi de migration,
  avant ce lot) MAIS le corps de `update_draft_project` ne portait PAS
  encore les gardes applicatives M029 — un état partiel, jamais un doublon
  simple.
- `supabase migration repair --status applied 20260930100000 --local` (un
  premier essai, trop hâtif) puis **`--status reverted`** (annulé dès la
  vérification de `update_draft_project` ci-dessus — jamais laissé en l'état
  incorrect).
- Création de `20260930105000_m029_correction_idempotence.sql` (NOUVEAU
  fichier, le seul moyen sanctionné de corriger M029 sans le réécrire) :
  bloc `DO` avec `ADD CONSTRAINT` conditionnelle (no-op ici, les 3
  contraintes existaient déjà) + `CREATE OR REPLACE FUNCTION
  update_draft_project` (corps identique à celui déjà publié dans
  `20260930100000_m029_*.sql`, jamais modifié).
- `supabase migration repair --status applied 20260930100000 --local`
  (cette fois correcte : le fichier ORIGINAL M029 n'est jamais exécuté une
  seconde fois, seul l'historique est corrigé pour refléter que son contenu
  logique est désormais réellement présent via 105000).
- `supabase migration up --local` → applique `20260930105000_*.sql` (la
  correction) puis tente `20260930110000_m030_*.sql` → échoue :
  `column "already_member" ... already exists`. Lecture directe
  (`pg_get_functiondef` sur `get_invitation_preview`) : cette fois le corps
  de la fonction portait DÉJÀ la logique `already_member` complète — M030
  était réellement et entièrement appliquée en substance, seul l'historique
  manquait.
- `supabase migration repair --status applied 20260930110000 --local` —
  aucune correction nécessaire, aucun fichier ajouté pour M030.
- `supabase migration up --local` → applique `20260930120000_m031_*.sql`
  (tables `project_plan_requests`/`project_plan_request_variants`,
  triggers d'immuabilité) puis `20260930130000_m031b_*.sql` (6 fonctions
  RPC) — les deux réussissent sans erreur.
- Parcours navigateur réel (chantier de démo local) révèle `list_plan_requests`
  en échec → `max(uuid) does not exist` reproduit directement via `psql`
  (rôle `authenticated` simulé par `set_config('request.jwt.claims', ...)`,
  jamais via le service role, pour reproduire EXACTEMENT le chemin RLS réel)
  → `20260930140000_m031d_correction_max_uuid.sql` (NOUVEAU fichier,
  `CREATE OR REPLACE FUNCTION list_plan_requests`, `array_agg(...)[1]` au
  lieu de `max(uuid)`) → `supabase migration up --local` appliqué.
- Tests ciblés (`scripts/test-plan-requests.mjs`) révèlent `list_plan_request_variants`
  en échec → `column reference "id" is ambiguous` (paramètre de sortie
  `RETURNS TABLE` nommé `id`, en collision avec la colonne du même nom) →
  `20260930135000_m031c_correction_colonne_ambigue.sql` (NOUVEAU fichier,
  `CREATE OR REPLACE FUNCTION list_plan_request_variants`, référence
  qualifiée `r.id`) → appliqué.

**Aucune migration déjà appliquée n'a été modifiée rétroactivement** : les
fichiers `20260930100000_m029_*.sql`, `20260930120000_m031_*.sql` et
`20260930130000_m031b_*.sql` sont restés tels qu'écrits/committés ; chaque
correction est un NOUVEAU fichier (`105000`, `135000`, `140000`), jamais une
réécriture — seul l'historique de migration (métadonnée `repair`, pas le
contenu SQL) a été corrigé pour M029/M030, et seulement pour refléter un
état déjà réellement présent sur cette instance, jamais pour en falsifier
un autre.

**État final confirmé** (`supabase migration list --local`) : les 40
migrations du dépôt ont `local == remote` — rien en attente, rien en
avance, aucun écart restant.

## 9. Couverture des 30 tests (`scripts/test-plan-requests.mjs`) pour les 5 garanties demandées

Aucun test déjà concluant n'a été refait ; un seul ajouté (dernier point
ci-dessous) après avoir constaté une preuve manquante, pas un défaut.

1. **Accès à un autre chantier refusé** : « Création demande — chantier non
   autorisé refusé » (`not_authorized`, appelant CONTRACTOR actif sur un
   AUTRE chantier, zéro adhésion sur la cible) ; voir aussi « Rattachement
   direct à une version d'un AUTRE chantier refusé » (FK composite, niveau
   base plutôt que RPC).
2. **Variante déposée immuable** : « UPDATE direct sur une variante déposée
   refusé » et « DELETE direct sur une variante refusé » — testés en
   service_role (accès direct table), pas seulement via le RPC applicatif.
3. **Changement de paramètres créant une nouvelle demande** : « Changement
   de paramètres — nouvelle demande distincte, jamais un écrasement » (deux
   `generation_params` différents → deux lignes `id` distinctes).
4. **Reprise après échec sans doublon** — **preuve manquante constatée et
   complétée ce lot** : les tests déjà présents (« Reprise (même opération)
   — idempotente ») ne couvraient qu'un REJEU après un dépôt DÉJÀ réussi
   (réponse perdue), pas un échec réel avant finalisation. Trois nouveaux
   tests ajoutés : upload attesté puis jamais finalisé (état `FINALIZING`
   confirmé, `finalized_at: null` — interruption réelle, pas simulée après
   coup) ; la reprise aboutit et rattache réellement la variante ; une seule
   version créée pour ce chantier (aucun doublon silencieux).
5. **Correspondance entre état sauvegardé et PNG déposé** — **non
   couverte, et non couvrable, par ces 30 tests RPC** : le rendu PNG
   (SVG→canvas) est une opération exclusivement côté client
   (`render.ts`/`PlanEditor.tsx`), qu'aucun test serveur ne peut observer.
   Preuve apportée autrement, lors du parcours navigateur CONTRACTOR de ce
   lot (§10) : la variante sauvegardée affichait Chambre 1/2/3 (3,03×3,50 m),
   Salon (4,38×4,50 m), Cuisine (2,69×3,00 m), Sanitaire 1/2 (1,61×2,00 m
   chacun) ; le PNG réellement déposé, retéléchargé et inspecté visuellement
   après coup, montre EXACTEMENT ces mêmes pièces et dimensions. Garantie
   structurelle (code, pas seulement observée une fois) : `confirmDeposit`
   (`PlanEditor.tsx`) rend TOUJOURS le PNG depuis `exportSvgMarkup`, dérivé
   de `current` (l'état affiché) — et le dépôt est bloqué tant que `current`
   ne correspond pas EXACTEMENT (`isSavedAsVariant`, comparaison de valeur)
   à la variante choisie, jamais un état divergent.

## 10. Parcours CONTRACTOR réel (ce lot)

Rôle confirmé depuis les données serveur AVANT le parcours (`project_memberships`,
lecture directe, jamais depuis l'UI) : `role='CONTRACTOR'`, `owner_profile`
vide, `revoked_at` NULL sur le chantier de démo local `Démo — Maison Bamako
— repetition` (compte `demo-entreprise@chantierlive.test`, identifiants
connus car déterministes dans `scripts/demo_seed_chantierlive.mjs` — jamais
une donnée réelle). Session `demo-proprietaire` (déjà ouverte avant ce lot)
déconnectée puis reconnectée après coup pour la restaurer exactement.

Parcours complet effectué et vérifié : créer une nouvelle demande (CONTRACTOR
autorisé, confirmé par l'apparition du bouton ET par le rôle serveur) →
générer → ouvrir l'éditeur → sauvegarder une variante → rechargement complet
de la page (nouvelle requête serveur, pas un état client conservé) →
variante retrouvée et rouverte → déposer cette variante → candidat réel
confirmé sur la page Plans (« Plan 5 », marqué « Non partagé » — comportement
CONTRACTOR inchangé, D104) → PNG téléchargé et comparé visuellement à la
variante (§9, point 5) → session restaurée.

---

## 11. Ligne de backlog `B069` — validée et insérée (2026-10-03)

**Validée par le fondateur** : « L'ajout de B069 "Demandes et variantes de
plans" comme terminée est autorisé, avec les preuves et commits associés. »
Disponibilité revérifiée dans le fichier réel avant insertion (`B068` était
la dernière ligne, aucun `B069` existant) — jamais présumée depuis la
proposition du lot précédent. Ligne réellement insérée dans
`MVP_BACKLOG.csv` (69 lignes de tâches désormais, confirmé par comptage du
fichier) :

```
B069,L02c,P1,"Créer et gérer des demandes de plan avec variantes versionnées avant dépôt",B063,"demande créée avec les paramètres de génération réellement utilisés; modifier les paramètres crée une nouvelle demande, jamais un écrasement; modifier une variante sauvegardée en crée une nouvelle, l'ancienne reste intacte; dépôt d'une variante crée une version réelle (B063) sans retenue/validation/publication automatique; droits CONTRACTOR/OWNER-PRIMARY du chantier seuls, revérifiés côté serveur pour chaque opération"
```

Preuves associées (déjà produites, non refaites) : §8 (migrations M031/b/c/d,
réconciliation M029/M030), §9 (30/30 tests `scripts/test-plan-requests.mjs`,
mapping des 5 garanties), §10 (parcours CONTRACTOR réel en navigateur).
Commits : `7b5fcda` (code+migrations), `a08694d` et `098f9f7` (docs).

**Compteur recalculé depuis le fichier réel** (jamais forcé) : total
`MVP_BACKLOG.csv` = 69 lignes (confirmé par comptage, pas supposé) ; comptage
« terminées » = 28 (valeur communiquée, inchangée par tout travail
antérieur à ce lot) + 1 (`B069`, validée ce tour) = **29**. Soit **29/69 =
41,9... % → 42 %** (calcul exact, pas arrondi forcé au préalable).

---

## 12. Clôture de ce lot

28/68 (41 %) au moment de ce lot (B069 pas encore validé — voir la mise à
jour 2026-10-03 ci-dessous, **29/69, 42 %**, désormais la valeur courante).
**7/7 jalons du prototype 2D**, dans leur périmètre exact (génération
uniquement, voir `SUIVI_MOTEUR_PLANS_2D.md`, inchangé). **Intégration
métier — Lots 1, 2 et 3 terminés** : pont génération→dépôt réel (Lot 1),
schéma et RPC
demandes/variantes créés et appliqués en local uniquement (Lot 2, M031),
parcours complet dans l'UI (Lot 3) — créer une demande → générer → éditer →
sauvegarder une variante → retrouver après rechargement → choisir → déposer
→ retrouver le candidat réel, vérifié en navigateur sur le serveur E:.
Permissions inchangées (CONTRACTOR/OWNER-PRIMARY du chantier uniquement),
RLS + SECURITY DEFINER partout, aucun contournement de prepare/upload/
finalize ni de validation/publication. Migrations créées et appliquées
UNIQUEMENT sur l'instance Supabase locale (jamais distante), après
sauvegarde locale et vérification des migrations en attente. Aucun push,
fusion, déploiement ou nouvelle dépendance.

**Lot précédent (098f9f7)** : parcours CONTRACTOR réel vérifié une seule fois
(§10, rôle confirmé depuis les données serveur) ; migrations exécutées ce
lot documentées précisément, y compris la réconciliation M029/M030, sans
aucun secret affiché (§8) ; couverture des 30 tests mappée aux 5 garanties
demandées, une preuve manquante (reprise après échec réel, distincte du
simple rejeu) complétée par 3 tests ciblés, aucun test déjà concluant refait
(§9) ; ligne de backlog B069 proposée, non encore insérée. Aucune nouvelle
migration hors correctifs déjà couverts par l'autorisation du lot précédent.
Aucune donnée réelle touchée, copie C: intacte.

**Ce lot (2026-10-03)** — clôture documentaire uniquement, aucun
développement : commit contenant les 3 tests de reprise confirmé (`098f9f7`,
déjà présent — mon précédent rapport l'avait étiqueté à tort « docs
seulement », corrigé ici). `B069` revérifiée disponible dans le fichier
réel puis insérée dans `MVP_BACKLOG.csv` (§11), suivis actualisés
(`SUIVI_MOTEUR_PLANS_2D.md`). **Compteur recalculé depuis le fichier réel :
29/69, 42 %** (total confirmé par comptage, pas supposé). Prototype 7/7,
intégration 3/3 (Lots 1/2/3), chacun dans son périmètre propre — aucun des
deux ne clôture ChantierLive dans son ensemble.
