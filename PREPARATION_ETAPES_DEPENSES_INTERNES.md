# Préparation séparée — étapes de chantier et dépenses internes

Proposition uniquement, demandée séparément de la séparation de navigation
(commit `d679a36`). Aucune migration créée, aucun droit modifié. Couvre :
modèle de données, permissions, règle de calcul (étapes) et migrations
nécessaires (description seulement).

## 1. Étapes de chantier / avancement

**Remplacé par un document dédié** : `PREPARATION_AVANCEMENT_TRAVAUX.md`,
qui reprend les décisions validées par le fondateur (poids = 100 %,
progression 0-100 % par étape, calcul `Σ(poids × progression)/100`,
affichage « déclaré par l'entreprise », historique attribué,
non-réutilisation automatique de M007/M008 — vérifiée sur l'historique
réel des migrations). Cette section n'est volontairement plus détaillée
ici pour éviter deux versions divergentes de la même analyse.

## 2. Dépenses internes

### 2.1 Signification ACTUELLE de `EXPENSE_VIEW` dans les documents (avant toute décision)

Demandé explicitement avant toute implémentation : voici ce que les
documents disent AUJOURD'HUI, sans aucune transformation.

**`EXPENSE_VIEW` est une ligne de `PERMISSIONS.csv`** (fichier de
conception, jamais encore codée en SQL), colonnes exactes :

```
EXPENSE_VIEW,finance,C,N,A,A,B,"Privé par défaut envers le client (BR098); propriétaire selon seuil ou activation explicite du chantier (BR050), jamais un droit natif inconditionnel."
```

Soit, par colonne (`owner_primary, owner_co, contractor, site_manager, platform_admin`) :
**PRIMARY = C** (conditionnel), **CO_OWNER = N** (jamais, sans aucune
condition mentionnée), **CONTRACTOR = A** (natif), **SITE_MANAGER = A**
(natif), **platform_admin = B** (bris de glace/audit).

Le « C » de PRIMARY renvoie à **`BR050`** (`BUSINESS_RULES.csv`, module
finance), citée texto : « Le propriétaire décide selon seuil
configurable ; en l'absence de seuil toute dépense publiée reste
consultable sans être réputée approuvée. » C'est donc, tel que documenté
aujourd'hui :
- une **permission de rôle** (pas un simple affichage) ;
- conditionnée par un **seuil numérique configurable PAR LE PROPRIÉTAIRE**
  lui-même (pas par l'entreprise) ;
- en l'absence de seuil réglé, la condition documentée est en réalité
  **permissive par défaut** (« toute dépense publiée reste consultable ») —
  la consultation n'équivaut cependant jamais à une approbation.
- `D086` (VALIDATED) cite `BR098`/`EXPENSE_VIEW` et dit que le client
  consulte « le montant contractuel, les paiements reconnus, le reste dû,
  les étapes et les photos » — SANS répéter explicitement l'exception de
  seuil de BR050 dans son propre texte, alors que `BR098` (la règle
  source) la mentionne, elle, explicitement. Il y a donc une tension
  documentaire réelle entre `D086` (lecture stricte) et `BR098`/`BR050`
  (exception nommée) — je la signale plutôt que de la trancher moi-même.
- Aucun seuil CHIFFRÉ n'est fixé nulle part dans les documents actuels :
  `BR050` dit « configurable », sans valeur ni mécanisme précisés.

**Donc, avant votre consigne de ce tour, le document ne disait PAS
« jamais » de façon inconditionnelle pour PRIMARY** — il disait
« conditionnel à un réglage qui n'existe pas encore ». C'est une nuance
réelle, pas une supposition de ma part : je la rapporte telle quelle.

### 2.2 Votre décision de ce tour — à appliquer comme override explicite

Vous avez maintenant tranché explicitement : *« Le propriétaire du
chantier ne doit accéder ni aux dépenses internes, ni aux justificatifs
associés, ni aux marges. »* Ceci **remplace** la condition « C » de
`EXPENSE_VIEW` pour PRIMARY par un **N inconditionnel**, pour PRIMARY
ET CO_OWNER (qui était déjà N), sans seuil ni activation de chantier.
« Marges » est un concept qui n'existe NULLE PART dans les documents
actuels (`DATABASE_TABLES.csv`, `PERMISSIONS.csv`, `BUSINESS_RULES.csv`
— aucune occurrence) : c'est une contrainte nouvelle que vous posez pour
le jour où ce concept sera construit (probablement dérivé de dépenses −
montant contractuel), pas une correction d'un droit déjà documenté.

### 2.3 Matrice explicite proposée (rôles réellement présents sur un chantier)

Reprend `EXPENSE_CREATE_DRAFT`/`EXPENSE_PUBLISH`/`EXPENSE_CORRECT_VALIDATED`
telles que déjà conçues (aucun changement demandé dessus), et applique
votre override à `EXPENSE_VIEW` :

| Action | PRIMARY | CO_OWNER | CONTRACTOR | SITE_MANAGER |
|---|---|---|---|---|
| Lire une dépense ou son montant (`EXPENSE_VIEW`) | **N** (était C, override §2.2) | N | A | A |
| Lire un justificatif joint (fichier) | **N** | N | A | A |
| Lire une marge (concept futur, non construit) | **N** | N | A (à confirmer : natif ou restreint) | N (à confirmer) |
| Créer un brouillon de dépense (`EXPENSE_CREATE_DRAFT`) | C (inchangé, hors ligne) | N | A | A |
| Publier une dépense (`EXPENSE_PUBLISH`) | N | N | A | C (délégation + synchro) |
| Corriger une dépense validée (`EXPENSE_CORRECT_VALIDATED`) | C (inchangé) | N | A | N |

Chaque « N » de cette colonne propriétaire doit être un refus **côté
serveur** (RLS + RPC, jamais seulement l'absence d'un lien dans le menu) :
- RPC de lecture (`list_expenses`, `get_expense`) : vérifie le rôle AVANT
  toute sélection, exactement comme `get_project_financial_summary`
  refuse aujourd'hui SITE_MANAGER — jamais un filtrage après coup côté
  client.
- Fichiers (justificatifs) : URL signées générées UNIQUEMENT après le
  même contrôle de rôle que la lecture de la dépense elle-même (même
  principe que `get_advance_receipt_file_key`, M014, déjà en place pour
  les justificatifs de versement) — un propriétaire ne doit jamais
  pouvoir obtenir une URL signée vers un justificatif de dépense, même en
  devinant un identifiant.
- RLS sur les tables `expenses`/`expense_versions`/les lignes
  `private_object_uploads` (`entity_type = 'expense_receipt'`) : exclut
  explicitement le rôle OWNER, pas seulement une absence de politique
  permissive.

### 2.4 Budget interne (`BUDGET_VIEW`, BR099) — rappel, inchangé

Reste strictement privé, sans AUCUNE exception de seuil (contrairement à
ce que documentait `EXPENSE_VIEW` avant votre override) — `BR099`
distingue déjà ce cas comme plus strict que les dépenses. Non concerné
par ce lot, cité seulement pour éviter toute confusion entre les deux.

### 2.5 Modèle de données proposé

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
- Plus de colonne de seuil (`BR050`) à prévoir : votre override (§2.2)
  rend la lecture propriétaire inconditionnellement refusée, donc aucun
  mécanisme de seuil configurable n'est nécessaire pour ce lot. Si une
  activation explicite de chantier devait un jour réintroduire un accès
  conditionnel, ce serait une décision distincte, à reprendre séparément
  plutôt qu'à anticiper ici.

### 2.6 Migrations nécessaires (description seulement)

Nouvel identifiant à réserver **au moment réel du dépôt** (jamais choisi
à l'avance) — même méthode de vérification qu'au §0 du document
« Avancement des travaux » (`PREPARATION_AVANCEMENT_TRAVAUX.md`) :
relire `supabase/migrations/` pour prendre le prochain numéro réellement
libre à cette date, jamais un numéro décidé aujourd'hui pour un dépôt
futur. Contenu proposé : `expense_categories`, `expenses`,
`expense_versions`, RPC (`create_expense_draft`, `publish_expense`,
`correct_expense`, `list_expenses` avec refus serveur strict pour OWNER),
extension `private_object_uploads` (`entity_type` déjà extensible, aucune
migration de structure requise pour cette partie).

## 3. Hors périmètre de cette proposition

Aucune migration n'est créée par ce document. La règle de calcul de
l'avancement est désormais tranchée par le fondateur — voir
`PREPARATION_AVANCEMENT_TRAVAUX.md` (§1, remplace cette section pour les
étapes). Le lot « dépenses internes » proprement dit (migration réelle)
reste un lot séparé, non commencé.
