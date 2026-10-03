# Préparation séparée — étapes de chantier et dépenses internes

Proposition uniquement, demandée séparément de la séparation de navigation
(commit `d679a36`). Aucune migration créée, aucun droit modifié. Couvre :
modèle de données, permissions, règle de calcul (étapes) et migrations
nécessaires (description seulement).

## 1. Étapes de chantier / avancement

### 1.1 Vérification des identifiants M007/M008 (demandée explicitement)

- **Réservation** : `MIGRATION_ORDER.csv` lignes 8-9 réserve `M007
  « phase_templates template_items »` (dépend de M001) et `M008
  « project_phases phase_versions »` (dépend de M004;M007), jalon
  « version publiée immuable ».
- **Historique appliqué** : aucun fichier `supabase/migrations/*m007*` ni
  `*m008*` n'existe (vérifié par liste de répertoire). Les deux
  identifiants qui EN DÉPENDENT dans le même plan (`M009 daily_logs`,
  `M015 approvals`) n'ont eux non plus jamais été construits — aucune
  chaîne de dépendance cassée, aucun conflit.
- **Convention du dépôt** : confirmée sur M031/M032 (créés en 2026-09-30,
  bien après leur « place » conceptuelle dans le plan d'origine) — le
  nom `Mxxx` est un repère de planification, le fichier physique est
  TOUJOURS déposé avec l'horodatage réel du jour de création, après la
  dernière migration déjà appliquée (`20260930160000`, M032b), jamais
  inséré rétroactivement avant des migrations déjà en place.
- **Conclusion** : rien n'empêche de reprendre `M007`/`M008` comme noms —
  ce n'est ni automatique ni risqué, seulement vérifié comme demandé.
  Fichiers proposés (si validés) : `202610DDHHMMSS_m007_phase_templates.sql`
  et `202610DDHHMMSS_m008_project_phases.sql`, horodatés au jour réel du
  dépôt.

### 1.2 Permissions déjà conçues — à reprendre telles quelles

`PERMISSIONS.csv` (colonnes : `owner_primary, owner_co, contractor,
site_manager, platform_admin`) contient déjà, à l'état de conception,
une règle plus riche que « l'entreprise écrit, le propriétaire lit » :

| Permission | PRIMARY | CO_OWNER | CONTRACTOR | SITE_MANAGER | Condition |
|---|---|---|---|---|---|
| `PHASE_VIEW` | A | A | A | A | Adhésion active |
| `PHASE_CREATE` | C | N | A | N | « Propriétaire peut proposer ; entrepreneur publie » |
| `PHASE_EDIT_DRAFT` | N | N | A | C | Chef exige délégation active ; propriétaire toujours refusé (D082) |
| `PHASE_PUBLISH` | C | N | A | N | Historique créé |
| `PHASE_VALIDATE` | **A** | C | N | N | Copropriétaire seulement si permission explicite |

Point important, à ne pas simplifier à tort : `PHASE_VALIDATE` donne à
OWNER/PRIMARY un droit **natif** (A, pas seulement lecture) — cohérent
avec le principe déjà en usage pour les acomptes (déclaration par une
partie, confirmation par l'autre, M014). L'étape n'est donc pas qu'une
information poussée par l'entreprise : le propriétaire confirme qu'une
étape déclarée terminée l'est réellement, avant qu'elle compte dans un
pourcentage. Aucune permission nouvelle à créer : ces 5 lignes existent
déjà dans `PERMISSIONS.csv`, seulement jamais implémentées en SQL.

### 1.3 Modèle de données proposé

**`phase_templates`** (M007) — modèles réutilisables, par organisation :
- `id`, `organization_id`, `label`, `archived_at`.
- **`template_items`** : `id`, `template_id`, `position` (ordre), `label`,
  `default_weight` (poids par défaut pour le calcul, voir §1.4).
- Un modèle « par défaut » (ex. Fondations/Élévation des murs/Toiture/
  Finitions, comme la maquette) est fourni au niveau plateforme ou copié
  à la création de l'organisation — **décision à valider** : seed unique
  partagé, ou copie par organisation dès la première utilisation ?

**`project_phases`** (M008) — étapes réellement instanciées sur UN
chantier (jamais directement sur le modèle) :
- `id`, `project_id`, `position`, `label`, `weight` (copié du modèle,
  modifiable ensuite — « personnalisable par l'entreprise »), `status`
  (`BROUILLON`/`PUBLIEE`/`VALIDEE`), `started_at`, `completed_at`.
- **`phase_versions`** : historique append-only de chaque changement de
  statut (jamais une correction en place) — même principe que
  `advance_events`/`plan_catalog_item_versions` : une ligne par
  transition, jamais réécrite.
- Création/réorganisation des étapes : `PHASE_CREATE`/`PHASE_EDIT_DRAFT`
  (entrepreneur natif, propriétaire conditionnel en proposition).
- Passage `PUBLIEE` : `PHASE_PUBLISH` (entrepreneur).
- Passage `VALIDEE` : `PHASE_VALIDATE` (propriétaire/PRIMARY natif,
  CO_OWNER conditionnel) — AUCUNE étape ne doit compter dans
  l'avancement avant cette confirmation (voir §1.4).
- Photo d'avancement (maquette « Avancement des travaux ») : réutilise
  `list_project_media` (M010, inchangée) — pas de colonne photo
  dupliquée sur `project_phases`.

### 1.4 Règle de calcul du pourcentage — À VALIDER SÉPARÉMENT (demande explicite)

Deux options, aucune tranchée ici :

- **Option A — simple** : `% = (nombre d'étapes VALIDEES) / (nombre total d'étapes) × 100`.
  Facile à expliquer, mais traite « Fondations » et « Finitions » comme
  équivalentes alors qu'elles ne prennent pas le même temps.
- **Option B — pondérée (recommandée)** : `% = (somme des weight des étapes VALIDEES) / (somme totale des weight) × 100`,
  où `weight` vient du modèle par défaut (`template_items.default_weight`)
  et reste modifiable par chantier (`project_phases.weight`) — cohérent
  avec « étapes proposées par défaut, personnalisables par l'entreprise ».

**Dans les deux options** : seules les étapes **VALIDEES** (confirmées
par le propriétaire, `PHASE_VALIDATE`) comptent — jamais une étape
seulement `PUBLIEE` par l'entreprise et non confirmée. Sans cela,
l'entreprise pourrait afficher un pourcentage qu'aucune partie adverse
n'a confirmé, à l'inverse du principe déjà appliqué aux versements
(M014). **Ce choix (A ou B, et la restriction aux étapes validées) doit
être confirmé par le fondateur avant toute migration.**

### 1.5 Migrations nécessaires (description seulement)

1. `M007` — `phase_templates`, `template_items` (+ triggers d'immuabilité
   sur les lignes déjà publiées, même principe que partout ailleurs).
2. `M008` — `project_phases`, `phase_versions`, RPC : `list_project_phases`
   (lecture, `PHASE_VIEW`), `propose_phase`/`create_phase`
   (`PHASE_CREATE`), `publish_phase` (`PHASE_PUBLISH`), `validate_phase`
   (`PHASE_VALIDATE`), `get_project_progress` (calcul du pourcentage,
   option A ou B une fois tranchée).

## 2. Dépenses internes

### 2.1 Permissions déjà conçues — à reprendre telles quelles

| Permission | PRIMARY | CO_OWNER | CONTRACTOR | SITE_MANAGER | Condition |
|---|---|---|---|---|---|
| `EXPENSE_CREATE_DRAFT` | C | N | A | A | Hors ligne autorisé ; UUID unique |
| `EXPENSE_PUBLISH` | N | N | A | C | Chef exige délégation + synchro ; propriétaire toujours refusé (D082) |
| `EXPENSE_CORRECT_VALIDATED` | C | N | A | N | Contre-écriture, motif, audit |
| `EXPENSE_VIEW` | **C** | N | A | A | Privé par défaut (BR098) ; propriétaire **selon seuil ou activation explicite du chantier (BR050)**, jamais un droit natif inconditionnel |

Précision déjà actée (`BR050`) : « Le propriétaire décide selon seuil
configurable ; en l'absence de seuil, toute dépense publiée reste
consultable sans être réputée approuvée. » — ce n'est donc PAS un
« jamais » absolu comme une lecture rapide de D086/D090 pourrait le
laisser penser : c'est privé PAR DÉFAUT, avec une exception déjà prévue
et nommée (seuil, ou activation explicite du chantier), jamais un droit
inconditionnel. Le budget prévisionnel interne (`BUDGET_VIEW`, BR099)
reste lui strictement privé, sans aucune exception — distinct des
dépenses.

### 2.2 Modèle de données proposé

Reprend les noms déjà réservés dans `DATABASE_TABLES.csv` (T024-T027),
jamais migrés :
- **`expense_categories`** : `id`, `organization_id`, `label`,
  `archived_at`.
- **`expenses`** : `id`, `project_id`, `category_id`, `label`,
  `amount_fcfa`, `expense_date`, `created_by_profile_id`, `status`
  (`DRAFT`/`PUBLISHED`), `operation_uuid` (idempotence hors ligne, même
  principe que `advances`/`private_object_uploads`).
- **`expense_versions`** : historique append-only des contre-écritures
  (`EXPENSE_CORRECT_VALIDATED` — jamais une correction en place, motif
  obligatoire, audit).
- **`receipts`** (justificatifs) : **aucune nouvelle table de stockage**
  — réutilise `private_object_uploads` (M026) avec un nouvel
  `entity_type = 'expense_receipt'`, exactement comme
  `advance_receipt`/`media_asset`/`plan_catalog_item_version` ; un
  `attest_storage_verified` déjà existant couvre l'intégrité du fichier,
  aucune fonction d'attestation supplémentaire nécessaire.
- Seuil `EXPENSE_VIEW` (`BR050`) : `project_expense_visibility_threshold`
  (nullable, sur `projects` ou une table dédiée à trancher) — **décision
  à valider** : seuil par montant unitaire de dépense, ou cumul
  périodique ? Rien dans `BUSINESS_RULES.csv` ne tranche ce point
  aujourd'hui.

### 2.3 Migrations nécessaires (description seulement)

Nouvel identifiant à réserver (aucun `Mxxx` existant ne couvre les
dépenses dans `MIGRATION_ORDER.csv` au-delà du nom des tables) — **à
demander explicitement au fondateur avant tout dépôt**, jamais inventé
ici : `expense_categories`, `expenses`, `expense_versions`, RPC
(`create_expense_draft`, `publish_expense`, `correct_expense`,
`list_expenses` avec filtrage `EXPENSE_VIEW`/seuil), extension
`private_object_uploads` (`entity_type` déjà extensible, aucune
migration de structure requise pour cette partie).

## 3. Hors périmètre de cette proposition

Aucune migration n'est créée par ce document. Les deux décisions
ouvertes (§1.4 règle de calcul, §2.2 nature du seuil `EXPENSE_VIEW`)
doivent être tranchées par le fondateur avant toute implémentation.
