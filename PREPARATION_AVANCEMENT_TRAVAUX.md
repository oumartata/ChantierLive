# Préparation — lot d'implémentation « Avancement des travaux »

Analyse et proposition uniquement. **Aucune migration créée ni appliquée.**
Reprend les décisions validées par le fondateur (2026-10-03, ce tour) pour
border précisément le périmètre avant tout code.

## 0. Vérification de l'historique des migrations (demandée explicitement)

Nouvelle vérification, plus poussée que le tour précédent — `ls
supabase/migrations/` montre que **M030 existe déjà** et est appliqué
(`20260930110000_m030_invitation_preview_already_member.sql`), entre M029
et M031. Il n'y a donc PAS de trou dans la séquence réelle comme je
l'avais supposé à tort : la chaîne complète est M001→M030, puis M031
(+b/c/d), puis M032(+b) — tous appliqués, aucun identifiant numérique
disponible entre eux.

**Conséquence directe** : le prochain identifiant réel, selon la
convention confirmée (nom `Mxxx` = repère de planification, fichier
horodaté à la date réelle de dépôt, jamais inséré avant une migration déjà
appliquée), est **M033** — pas M007, pas M008. Conformément à votre
consigne, M007/M008 ne sont PAS réutilisés comme identifiants de fichier ;
ils restent cités en commentaire comme référence de conception
(`phase_templates`/`template_items` pour M007, `project_phases`/
`phase_versions` pour M008, telles que nommées dans `MIGRATION_ORDER.csv`
lignes 8-9), sans qu'aucune migration déjà appliquée ne soit modifiée.

Fichier proposé (non créé) : `202610DDHHMMSS_m033_project_phases.sql`,
horodaté au jour réel du dépôt, après `20260930160000`.

## 1. Périmètre de ce lot

**Inclus** :
- Étapes nommées par chantier, avec poids (somme = 100 %) et progression
  (0-100 % chacune), personnalisables par l'entreprise à partir d'un
  modèle par défaut.
- Calcul de l'avancement global, lecture par le propriétaire et
  l'entreprise, historique attribué de chaque changement.
- Affichage propriétaire déjà construit ce tour
  (`chantiers/[id]/avancement`, actuellement « indisponible ») : ce lot le
  rend réel.

**Exclu explicitement** (hors périmètre, aucune ambiguïté) :
- Toute validation automatique par photo ou géolocalisation (consigne
  fondateur).
- Dépenses internes (lot séparé, `PREPARATION_ETAPES_DEPENSES_INTERNES.md`).
- `PHASE_VALIDATE` (confirmation de l'étape par le propriétaire) : voir
  §3.4 — écart avec la conception existante, signalé plutôt que supposé.
- Catalogue de plans, copie vers un chantier : sans rapport.

## 2. Modèle de données proposé

### `project_phase_plans` (un par chantier, jamais recréé — une seule ligne vivante)
- `id`, `project_id` (unique), `status` (`BROUILLON` | `PUBLIE`), `published_at_server`, `published_by_profile_id`.
- Tant que `BROUILLON` : l'entreprise compose librement sa liste d'étapes
  (voir `project_phases` ci-dessous) à partir du modèle par défaut.
- Passage à `PUBLIE` (« démarrage ») : verrouille la liste et les poids —
  **exige serveur-side que `sum(project_phases.weight) = 100`**, sinon
  rejet explicite (jamais un arrondi silencieux).

### `phase_templates` / `template_items` (référence de conception M007, fichier réel M033)
- Modèle par défaut, fourni au niveau plateforme (un seul jeu de
  référence : Fondations/Élévation des murs/Toiture/Finitions, comme la
  maquette) : `id`, `label`, `position`, `default_weight` (ex. 20/40/25/15,
  total 100 — **à confirmer avec vous**, valeurs d'exemple seulement).
- **Décision à valider** : un seul modèle plateforme partagé, ou un
  modèle par organisation (copiable/modifiable) ? Votre consigne dit
  « personnalisable par l'entreprise » — je recommande : modèle
  plateforme en lecture seule comme point de départ, copié dans
  `project_phases` dès la création du plan du chantier (jamais modifié
  en place), toute personnalisation se fait ensuite sur la copie.

### `project_phases` (étapes réelles d'UN chantier)
- `id`, `project_id`, `label`, `position`, `weight` (numeric, 0-100),
  `progression` (numeric, 0-100, défaut 0), `archived_at` (retrait
  logique, jamais de suppression physique une fois le plan publié).
- Contrainte : `weight between 0 and 100`, `progression between 0 and 100`.
- La somme des `weight` n'est PAS contrainte ligne à ligne (impossible en
  SQL pur) : vérifiée par les RPC d'écriture (voir §3), jamais seulement
  côté client.

### `project_phase_events` (historique append-only, jamais réécrit)
Une ligne par changement, jamais une mise à jour en place — répond
directement à « toute modification doit être attribuée et historisée » et
« jamais recalculée silencieusement » :
- `id`, `project_id`, `phase_id` (nullable pour un événement global comme
  la publication du plan), `event_type` (`PLAN_PUBLISHED` |
  `PROGRESSION_UPDATED` | `STRUCTURE_CHANGED`), `previous_value jsonb`,
  `new_value jsonb`, `actor_profile_id`, `reason` (texte, **obligatoire**
  pour `STRUCTURE_CHANGED` après publication — jamais un changement de
  poids silencieux), `computed_global_progress` (numeric, **snapshot** du
  pourcentage global AU MOMENT de cet événement, calculé avec les poids
  EN VIGUEUR à cet instant précis — jamais recalculé rétroactivement si
  les poids changent plus tard).
- C'est cette colonne `computed_global_progress`, gelée à chaque
  événement, qui garantit qu'une restructuration des poids après
  démarrage ne modifie jamais silencieusement l'historique déjà affiché.

## 3. Droits proposés

Reprend `PERMISSIONS.csv` (`PHASE_VIEW`/`PHASE_CREATE`/`PHASE_EDIT_DRAFT`/
`PHASE_PUBLISH`, déjà conçues) et ajoute UNE permission nouvelle, absente
du fichier actuel, pour l'action qu'aucun code existant ne couvre
(mettre à jour la progression d'une étape déjà publiée) :

| Action | Permission | PRIMARY | CO_OWNER | CONTRACTOR | SITE_MANAGER |
|---|---|---|---|---|---|
| Lire les étapes et l'avancement global | `PHASE_VIEW` (existante) | A | A | A | A |
| Composer/réordonner les étapes (brouillon) | `PHASE_CREATE`/`PHASE_EDIT_DRAFT` (existantes) | C (propose) | N | A | C (délégation) |
| Publier le plan (démarrage, poids figés) | `PHASE_PUBLISH` (existante) | C | N | A | N |
| **Mettre à jour la progression (0-100 %) d'une étape publiée** | **`PHASE_UPDATE_PROGRESS` (nouvelle, proposée)** | N | N | A | C (délégation) |
| Restructurer étapes/poids après publication (explicite, historisé) | `PHASE_EDIT_DRAFT` + `PHASE_PUBLISH` rejoués, avec `reason` obligatoire | C | N | A | N |

`PHASE_UPDATE_PROGRESS` est **proposée, pas supposée** : aucune ligne de
`PERMISSIONS.csv` ne couvre aujourd'hui le fait de déclarer un
pourcentage d'avancement sur une étape déjà publiée (les codes existants
parlent de création/édition de brouillon, de publication ou de
validation — jamais de ce cas précis). Même répartition de rôles que
`PHASE_EDIT_DRAFT` (entrepreneur natif, chef avec délégation active,
propriétaire toujours refusé par cohérence avec D082), par analogie
explicite, pas par réutilisation silencieuse d'un code existant.

### 3.4 Écart signalé : `PHASE_VALIDATE` hors périmètre de ce lot

`PERMISSIONS.csv` prévoit déjà `PHASE_VALIDATE` (OWNER/PRIMARY natif,
CO_OWNER conditionnel) — une confirmation de l'étape PAR le propriétaire.
Votre consigne de ce tour décrit un avancement **entièrement déclaré par
l'entreprise**, affiché comme tel (« Avancement déclaré par l'entreprise »),
sans étape de confirmation propriétaire, et exclut toute validation
automatique. Je ne transforme donc PAS `PHASE_VALIDATE` pour l'y faire
entrer : je le laisse **hors périmètre de ce lot**, ni implémenté ni
supprimé de la conception — à vous de confirmer s'il doit un jour exister
comme fonctionnalité séparée (ex. un futur « accord du propriétaire » sur
une étape), ou rester sans objet.

## 4. Calcul proposé

Formule exacte, conforme à votre consigne :

```
avancement_global = Σ(weight_i × progression_i) / 100
```

sur les `project_phases` actives (`archived_at is null`) du plan `PUBLIE`.
Avec `Σ weight_i = 100` garanti à la publication (§2), le résultat est
borné 0-100 par construction. Calculé par une RPC de lecture
(`get_project_progress`), jamais stocké comme colonne mutable à part le
`computed_global_progress` gelé dans l'historique (§2) — la valeur
« actuelle » affichée est toujours recalculée à la lecture à partir de
l'état vivant de `project_phases`, qui lui-même ne change que par des
événements historisés.

Affichage propriétaire (`chantiers/[id]/avancement`, déjà en place,
actuellement « indisponible ») : « Avancement déclaré par l'entreprise »
+ pourcentage + date du dernier événement (`max(created_at_server)` sur
`project_phase_events` pour ce chantier) — jamais présenté comme confirmé
ou validé par le propriétaire, conformément à votre consigne.

## 5. Migration proposée (description seulement, non créée)

`M033` (`project_phases`, voir §0) :
- Tables : `project_phase_plans`, `phase_templates`, `template_items`,
  `project_phases`, `project_phase_events`.
- Seed : un modèle par défaut (`phase_templates`/`template_items`) —
  **valeurs d'étapes et de poids par défaut à confirmer avec vous avant
  toute création de fichier**, je ne les invente pas ici.
- RPC : `get_project_phase_plan` (lecture, `PHASE_VIEW`), `add_phase`/
  `edit_phase_draft`/`reorder_phases` (brouillon, `PHASE_CREATE`/
  `PHASE_EDIT_DRAFT`), `publish_phase_plan` (`PHASE_PUBLISH`, vérifie
  `sum(weight) = 100` serveur-side, rejette sinon), `update_phase_progress`
  (`PHASE_UPDATE_PROGRESS`, nouvelle), `restructure_phase_plan` (édition
  après publication, `reason` obligatoire, événement `STRUCTURE_CHANGED`),
  `get_project_progress` (calcul, lecture).
- Aucune permission existante élargie ; une seule permission nouvelle
  (`PHASE_UPDATE_PROGRESS`) à ajouter à `PERMISSIONS.csv` avant le code,
  pas en même temps.

## 6. Critères de validation proposés

- Une étape ne peut être publiée que si la somme des poids du plan vaut
  exactement 100 — testé par un appel direct avec une somme ≠ 100 (rejet
  explicite, aucun arrondi).
- Une mise à jour de progression est toujours attribuée
  (`actor_profile_id`) et historisée (`project_phase_events`), jamais une
  écriture silencieuse sur `project_phases` seule.
- Une restructuration après publication exige un `reason` non vide et
  produit un événement `STRUCTURE_CHANGED` ; les événements antérieurs
  (`computed_global_progress` gelé) restent inchangés après la
  restructuration — testé en comparant l'historique avant/après un
  changement de poids.
- `PHASE_UPDATE_PROGRESS` refusée pour OWNER (PRIMARY et CO_OWNER) dans
  tous les cas, y compris par appel RPC direct (pas seulement un menu
  caché) — même exigence que M032b (frontière vérifiée côté serveur, pas
  seulement côté UI).
- `get_project_progress` ne retourne jamais une valeur hors 0-100, et
  jamais de différence entre le calcul en lecture et le dernier
  `computed_global_progress` historisé pour un plan non modifié depuis.
- Non-régression : suites existantes inchangées (755/755
  `scripts/test-plans-geometry.mjs` + `test:sw`), aucune dépendance sur
  ces tables.

## 7. Décisions encore ouvertes (à trancher avant tout code)

1. Modèle par défaut : plateforme unique en lecture seule, ou copiable
   par organisation ? (recommandation §2, à confirmer)
2. Valeurs par défaut du modèle (libellés et poids) — aucune proposée ici
   sans votre confirmation.
3. `PHASE_UPDATE_PROGRESS` : nom et répartition de rôles proposés §3,
   à valider avant ajout à `PERMISSIONS.csv`.
4. Sort de `PHASE_VALIDATE` (§3.4) : hors périmètre confirmé, ou à
   intégrer autrement plus tard ?

Aucune migration n'est créée tant que ces points ne sont pas confirmés.
