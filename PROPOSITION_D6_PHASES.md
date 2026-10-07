# Proposition D6 — Phases (B019/B020) et étapes d'avancement (M033)

**Statut : proposition, aucune décision prise.** Rédigée le 2026-10-07
(boucle 17b) pour que le fondateur tranche D6 : « B019 (phases) suspendue
alors que M033 (avancement) existe ». Aucun code, aucune migration, aucune
donnée modifiés.

**Cadre déjà décidé (D177, 2026-10-07)** : deux mesures distinctes, jamais
fusionnées ni confondues à l'écran :

- « **Avancement déclaré par l'entreprise** » : M033, pondéré, déclaré, déjà
  livré, dans le MVP sous ce seul libellé ;
- « **Avancement validé** » : BR034, phases validées / phases publiées
  applicables, à livrer avec la validation des phases. BR034, AC050 et
  EC020 restent valables pour cette mesure.

Les décisions du 2026-10-03 appliquées par M033 sont consignées en D178.

## 1. Ce que disent les règles

### 1.1 Backlog

| Tâche | Libellé | Dépend de | done_when |
|---|---|---|---|
| B019 | Créer modèles simples et phases | B014 | « modèle copié dans le chantier » |
| B020 | Publier corriger et valider une phase | B019 | « versions antérieures visibles » |
| B044 | Créer tableaux de bord par rôle | B020 ; B031 | « fraîcheur et droits affichés » |

### 1.2 Exigences et règles liées

- **Modèles et brouillon**
  - FR042 et AC042 : créer les phases depuis un modèle simple ; les copies
    sont créées en brouillon.
  - FR043 : ajouter, renommer, réordonner ou retirer une phase en brouillon.
  - BR030 : phases librement éditables avant publication ; le modèle est
    copié dans le chantier.
- **Publication et contenu**
  - FR044 et AC044 : consulter phases, statuts, dates et progression.
  - FR045 : publier le planning initial.
  - BR031 : une phase publiée possède statut, ordre, dates et historique.
- **Correction d'une phase publiée**
  - FR046 et AC046 : l'entreprise demande une modification, versionnée, sans
    écraser l'actuelle.
  - FR047 et AC047 : le propriétaire principal approuve, refuse ou demande
    une correction ; décision horodatée.
  - BR032 : modifier une phase publiée passe par une demande ou une nouvelle
    version selon son impact.
  - EC021 : corriger une phase validée crée une demande ou une nouvelle
    version et conserve la validation antérieure.
- **Validation**
  - FR048 et AC048 : l'entreprise déclare une phase prête (statut
    « attente de validation » et demande associée).
  - FR049 et AC049 : le propriétaire valide ou refuse la fin d'une phase ;
    statut et motif conservés.
  - BR033 : terminer une phase et la valider par le propriétaire sont deux
    actions distinctes.
- **Progression**
  - FR050, AC050 et BR034 : progression = phases validées / phases publiées
    applicables, V/N, sans estimation technique implicite ; c'est
    l'« Avancement validé » de D177.
  - EC020 : si toutes les phases sont non applicables, progression non
    calculable, jamais 100 %.
  - EC022 : jamais de suppression physique d'une phase liée à des données ;
    archiver ou rendre non applicable.
- **Droits (PERMISSIONS.csv)**
  - PHASE_VIEW : A pour les quatre rôles.
  - PHASE_CREATE : propriétaire principal C (« propose »), entreprise A.
  - PHASE_EDIT_DRAFT : entreprise A, chef de chantier C (délégation),
    propriétaires N (D082).
  - PHASE_PUBLISH : propriétaire principal C, entreprise A.
  - PHASE_VALIDATE : propriétaire principal A, copropriétaire C (permission
    explicite).
  - PHASE_UPDATE_PROGRESS (ajouté le 2026-10-04 pour M033) : entreprise A,
    chef de chantier C (délégation).
- **Conception technique**
  - Tables : T011 `phase_templates`, T012 `phase_template_items`,
    T013 `project_phases`, T014 `phase_versions` (insertion seule).
  - API022–API028 : `phase.list`, `copy_template`, `create_draft`,
    `update_draft`, `publish`, `mark_complete`, `validate`.
  - Écrans : SCR021 `/phases`, SCR024 `/phases/preparer`,
    SCR028 `/phases/:id/decision`, SCR029 `/phases/:id`.
  - Cas d'usage UC007 à UC009.
- **Liens attendus avec les autres modules**
  - FR052 : journal rattaché à une phase (différé par D149, J6).
  - FR101 : incident avec phase (différé par D166, L8).
  - FR065 et FR066 : photo rattachée à une phase, filtre par phase.
  - FR072 et FR081 : dépense avec phase.
  - FR136 : le rapport inclut les phases.
- **Tableaux de bord**
  - FR113 et AC113 : le propriétaire voit la progression.
  - FR114 et FR115 : retards et tâches.
  - BR068 : chaque indicateur est dérivé de données autorisées et affiche
    sa fraîcheur.

## 2. Ce que M033 fait réellement

Source : `supabase/migrations/20261003050000_m033_project_phases.sql` et
`PREPARATION_AVANCEMENT_TRAVAUX.md`. Migration appliquée en local
uniquement ; aucun numéro de backlog n'y est rattaché.

- **Tables** (RLS activée, tous privilèges révoqués) :
  - `project_phase_plans` : un plan par chantier, `BROUILLON` ou `PUBLIE`,
    avec révision ;
  - `project_phases` : libellé, position, poids de 0 à 100, progression de
    0 à 100, archivage ;
  - `project_phase_events` : historique en insertion seule, de type
    `PLAN_PUBLISHED`, `PROGRESSION_UPDATED` ou `STRUCTURE_CHANGED`, avec
    valeur précédente et nouvelle, auteur, rôle, motif et avancement figé.
- **Fonctions** :
  - `get_project_phase_plan`, `list_project_phases`, `list_phase_events`
    (lecture, toute adhésion active) ;
  - `upsert_phase_plan_draft` et `publish_phase_plan` (entreprise seule ;
    somme des poids exactement 100) ;
  - `update_phase_progress` (entreprise, ou chef de chantier avec délégation
    PHASE_UPDATE_PROGRESS) ;
  - `restructure_phase_plan` (entreprise seule, motif obligatoire,
    historique inchangé).
- **Modèle** : six étapes proposées par l'interface, à poids vides, sans
  table de modèles. Les tables T011 et T012 ne sont pas créées (accepté par
  le fondateur le 2026-10-04).
- **Écrans** :
  - `/chantiers/[id]/avancement` : composition, publication, progression,
    restructuration et historique côté entreprise ; lecture seule côté
    propriétaire ;
  - carte « Avancement » de la fiche chantier, avec la pastille « Déclaré
    par l'entreprise » ;
  - délégation PHASE_UPDATE_PROGRESS accordée depuis `/equipe`.
- **Absent** :
  - statut par phase (en cours, prête, validée, refusée, non applicable) ;
  - dates ;
  - validation par le propriétaire (PHASE_VALIDATE) ;
  - demande de modification soumise au propriétaire ;
  - avancement V/N ;
  - lien avec le journal, les incidents, les photos ou les dépenses.
- **Tests** : `scripts/test-project-phases.mjs` 37/37 et
  `scripts/test-phase-plan-actions.mjs` 17/17. Parcours navigateur fait le
  2026-10-04 ; le chef de chantier délégué n'y a pas été parcouru.

## 3. Critère par critère

| Critère | M033 | Commentaire |
|---|---|---|
| B019 done_when « modèle copié dans le chantier » ; AC042 | **Couvert** | Le modèle de six étapes est copié en brouillon, modifiable, sans table de modèles (accepté le 2026-10-04). |
| FR042 « depuis un modèle simple » (choix parmi des modèles) | Partiellement | Un seul modèle, défini côté application. |
| FR043 et BR030 : éditer librement le brouillon | **Couvert** | Liste complète enregistrée par `upsert_phase_plan_draft`. |
| FR045 : publier le planning initial | Partiellement | La publication existe, mais il n'y a pas de dates : ce n'est pas un « planning ». |
| FR044, AC044 et BR031 : statut, ordre, dates, historique | Partiellement | Ordre, historique et progression ; ni statut ni dates. |
| FR046, AC046 et BR032 : modifier une phase publiée par demande ou nouvelle version | Partiellement | La restructuration est directe, motivée et historisée, sans demande au propriétaire. |
| FR047 et AC047 : le propriétaire décide d'une modification | Non couvert | — |
| FR048 et AC048 : phase déclarée prête | Non couvert | — |
| FR049, AC049 et BR033 : validation distincte de la fin | Non couvert | PHASE_VALIDATE est hors périmètre (D178). |
| FR050, AC050 et BR034 : avancement V/N (« Avancement validé ») | Non couvert | M033 fournit l'autre mesure (D177). |
| EC020 : tout non applicable, pas de 100 % | Non couvert | Aucune notion de « non applicable ». |
| EC021 : correction d'une phase validée conserve la validation | Non couvert | Aucune validation. |
| EC022 : jamais de suppression physique | **Couvert** | Étape archivée après publication. |
| B020 done_when « versions antérieures visibles » | Partiellement | L'historique des événements montre valeurs précédentes et nouvelles, mais il n'existe pas de table `phase_versions` par phase. |
| PHASE_VIEW | **Couvert** | — |
| PHASE_UPDATE_PROGRESS | **Couvert** | Entreprise, et chef de chantier délégué. |
| PHASE_CREATE et PHASE_PUBLISH, « C » du propriétaire principal | Non couvert | Écart ouvert depuis le 2026-10-04 (§4). |
| PHASE_EDIT_DRAFT, « C » du chef de chantier | Non couvert | Écart ouvert depuis le 2026-10-04 (§4). |
| PHASE_VALIDATE | Non couvert | — |
| SCR021 et SCR024 | Partiellement | Couverts par `/avancement`, sous une autre adresse. |
| SCR028 et SCR029 | Non couvert | — |
| T011 et T012 | Non créées | Accepté le 2026-10-04. |
| T013 | **Couvert** | Même nom, autre forme. |
| T014 | Non créée | Remplacée par l'historique d'événements. |

## 4. Écarts de droits « C » ouverts depuis le 2026-10-04

Source : `PREPARATION_AVANCEMENT_TRAVAUX.md` §3.1 et §8. Le fondateur a
décidé le 2026-10-04 de « conserver la restriction actuelle à
l'entreprise dans ce lot ». L'écart reste à trancher.

| Code | Conception | M033 | Pistes |
|---|---|---|---|
| PHASE_CREATE | Propriétaire principal C (« propose ») | Entreprise seule | (i) aligner la conception : N pour le propriétaire ; (ii) ajouter une proposition du propriétaire soumise à l'entreprise |
| PHASE_PUBLISH | Propriétaire principal C | Entreprise seule | (i) aligner : N ; (ii) publication à deux, plus lourde |
| PHASE_EDIT_DRAFT | Chef de chantier C (délégation) | Entreprise seule | (i) aligner : N ; (ii) ouvrir sur délégation, mécanisme existant (`has_project_permission`, comme PHASE_UPDATE_PROGRESS) |

## 5. Options

### Option A — M033 devient la base de B019/B020, avec compléments

Une seule notion d'« étape », celle de M033. B020 y ajoute la validation.

- **B019** : son done_when est déjà atteint par M033. Validation possible
  sur preuve existante, éventuellement après l'ajout d'un choix de modèle
  si FR042 est jugé exigé.
- **B020**, migration probable **M040** :
  - statut par étape : en cours, prête, validée, refusée, non applicable ;
  - dates prévues facultatives ;
  - déclaration « prête » par l'entreprise ;
  - validation ou refus motivé par le propriétaire principal (copropriétaire
    sur délégation PHASE_VALIDATE) ;
  - événements de validation en insertion seule ; une correction après
    validation conserve la validation antérieure (EC021) ;
  - « Avancement validé » = V/N, non calculable si tout est non applicable
    (EC020) ;
  - à trancher : modification d'une étape publiée directe et motivée, comme
    aujourd'hui, ou soumise au propriétaire (BR032, FR047).
- **Journal, incidents, photos, dépenses** : un seul identifiant d'étape
  (`project_phases.id`) à rattacher plus tard. Il suffit d'ajouter un lien
  facultatif dans une migration séparée et de revoir ensemble J6 (D149) et
  L8 (D166).
- **B044** : les deux mesures de D177 viennent des mêmes étapes et
  s'affichent côte à côte, chacune avec son libellé et sa date de
  fraîcheur (BR068).
- **Coût** : une migration principale, sans nouvelle table d'identité.
  Écrans : décision propriétaire, statut par étape et seconde mesure.

### Option B — Deux notions distinctes

Les « étapes d'avancement » de M033 et les « phases » de B019/B020 (modèles
T011/T012, versions T014, validation) coexistent.

- **Migrations probables** : M040 (modèles et phases, sous un autre nom que
  `project_phases`, déjà pris), M041 (versions et validation).
- **Journal, incidents, photos, dépenses** : il faut choisir à quoi
  rattacher chaque élément (étape ou phase). La décision commune de J6 et L8
  devient plus difficile.
- **B044** : deux sources de progression et deux listes à expliquer ; fort
  risque de confusion pour le propriétaire, contraire à l'esprit de D177
  (« jamais confondues »).
- **Coût** : environ deux fois plus de tables, de droits et d'écrans ;
  double saisie pour l'entreprise.

### Option C — Validation des phases hors MVP

On garde M033 seul dans le MVP ; B020 et l'« Avancement validé » passent en
V1.

- **Justification possible** : réduire le MVP. L'avancement déclaré est déjà
  livré et visible par le propriétaire.
- **Contre** : FR048, FR049 et FR050 sont MUST et BR033 est explicite ; il
  faudrait réviser le backlog (B020, puis B044 qui en dépend) et retirer du
  MVP l'« Avancement validé » de D177. Le propriétaire n'aurait aucun moyen
  de contester ou de valider la fin d'une étape.
- **Migrations** : aucune dans l'immédiat.
- **Journal et incidents** : liens vers les étapes de M033 possibles
  plus tard, comme en A.
- **B044** : une seule mesure, déclarée.

## 6. Recommandation

**Option A.**

1. Elle respecte D177 sans dupliquer : les deux mesures sont calculées sur
   les mêmes étapes, ce qui garde l'écran simple pour le propriétaire.
2. M033 couvre déjà le done_when de B019 et la moitié de B020 :
   publication, historique, archivage, droits de lecture.
3. Une seule identité d'étape rend possible une décision commune pour J6
   (journal), L8 (incidents), les photos et les dépenses, sans choisir
   entre deux référentiels.
4. Le coût est d'une migration (M040), contre deux en option B.

Pour les écarts « C » (§4), je recommande :

- d'aligner la conception sur la restriction pour PHASE_CREATE et
  PHASE_PUBLISH (N pour le propriétaire principal) : son rôle passe par la
  validation (PHASE_VALIDATE A), pas par la composition du planning ;
- d'ouvrir PHASE_EDIT_DRAFT au chef de chantier délégué dans M040, avec le
  mécanisme de délégation existant.

Je recommande aussi, avec l'arrivée de l'« Avancement validé », que la carte
de la fiche chantier, aujourd'hui titrée « Avancement » avec une pastille,
porte le libellé complet « Avancement déclaré par l'entreprise », pour
respecter D177.

## 7. Décisions attendues du fondateur

- **P1** : option A, B ou C.
- **P2** (si A) : statuts d'une étape (en cours, prête, validée, refusée,
  non applicable) ; dates prévues facultatives ou non.
- **P3** (si A) : modification d'une étape publiée directe et motivée (état
  actuel), ou soumise au propriétaire (BR032, FR047).
- **P4** : validation par le propriétaire principal seul, ou aussi par le
  copropriétaire sur délégation.
- **P5** : écarts « C » (§4), à aligner ou à implémenter, code par code.
- **P6** : B019 validée sur la preuve M033, ou après ajout d'un choix de
  modèle (FR042).
- **P7** : moment où revoir ensemble J6 et L8 (liens journal, incidents,
  photos, dépenses vers les étapes).
