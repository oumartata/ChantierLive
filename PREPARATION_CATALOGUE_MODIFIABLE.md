# Préparation — catalogue modifiable (prochain chantier)

Document d'analyse et de plan uniquement. **Aucun code, aucune migration
créée ou appliquée.** Complète `PREPARATION_INTEGRATION_METIER.md` (Lots
1/2/3 terminés, 3/3) sans le modifier. Condition déjà remplie pour ouvrir ce
chantier : moteur 2D 7/7 (`SUIVI_MOTEUR_PLANS_2D.md`) — la règle constante
« catalogue modifiable seulement après stabilisation du moteur 2D » est
satisfaite ; l'ouverture de CE chantier reste une décision du fondateur,
pas actée par ce document.

---

## 1. Constat vérifié (lecture directe du code, rien supposé)

- **`plan_catalog_item_versions` (M019) n'a AUCUNE colonne structurée** —
  seul `private_object_upload_id` référence un fichier plat (PDF/JPEG/PNG,
  bucket `organization-catalog`, mêmes contraintes que `project-plans`).
  Aucun « fichier de projet modifiable », aucun aperçu distinct du fichier
  lui-même n'existe aujourd'hui pour un modèle de catalogue.
- **`attach_catalog_plan_to_project` (M020) ne copie jamais le contenu** :
  il insère une ligne `project_plan_versions` `origin='CATALOG'` qui
  RÉFÉRENCE `catalog_item_version_id` (jamais dupliqué dans `project-plans`),
  ligne immuable comme toute version, sans aucun chemin d'édition existant.
  Aucun concept de « copie »/« fork » n'existe nulle part dans le code.
- **Gouvernance actuelle, à deux niveaux distincts, vérifiés dans le code** :
  - Création/dépôt/publication/soumission d'un modèle de catalogue :
    `organizations.owner_profile_id` **seul** (vérifié inline dans chaque
    RPC M019) — jamais un simple membre d'organisation.
  - Rattachement d'un modèle publié à UN chantier
    (`attach_catalog_plan_to_project`) : **double condition déjà en place**
    (D107) — CONTRACTOR ou OWNER/PRIMARY du chantier **ET** propriétaire de
    l'organisation à laquelle le chantier est rattaché. Un OWNER/PRIMARY
    habilité sur le chantier mais pas propriétaire de l'organisation est
    refusé (`not_authorized`, confirmé par test réel lors du lot précédent).
- **Validation déjà séparée, sans aucune FK commune** :
  `plan_catalog_item_validations` (catalogue) et `plan_validations`
  (chantier, M023b) ne se référencent jamais l'une l'autre ; `publish_catalog_item_version`
  ne touche jamais `project_plans`/`project_plan_versions`/`plan_validations`.
  Seul point de partage réel : `plan_engineer_designations` (habilitation,
  jamais une décision commune).
- **Le générateur 2D (`src/app/prototype-plans/`) et le catalogue sont
  aujourd'hui totalement étrangers l'un à l'autre** — aucun code ne relie
  un `Layout`/`ProjectFile` (format déjà versionné et validé,
  `projectFile.ts`) à un modèle de catalogue.
- **M031 (Lots 1-3) fournit déjà** tout le pipeline demande → variante
  (format `ProjectFile` jsonb, append-only) → dépôt réel (PNG,
  `finalize_plan_request_variant_deposit`) → validation/publication
  chantier inchangées — c'est CE pipeline qu'il faut réutiliser, jamais un
  second mécanisme.

## 2. Objectif reformulé à partir de ce constat

Le besoin (« conserver un plan avec aperçu ET fichier de projet modifiable »,
« repartir de ce modèle dans un chantier », « copie indépendante »,
« éditer sans modifier le modèle », « réutiliser dépôt/validation/
publication ») correspond EXACTEMENT au pipeline M031 déjà construit, à UNE
différence près : **aujourd'hui une demande démarre toujours d'une
génération vierge ; il manque un second point de départ — un modèle de
catalogue muni d'un fichier de projet — qui amorce une demande avec une
PREMIÈRE variante déjà posée (copie, jamais une référence).**

## 3. Découpage en lots bornés

### Lot A — modèle de catalogue avec fichier de projet modifiable (migration décrite, non créée)

- **Existant réutilisé** : `plan_catalog_item_versions` (table, trigger
  d'immuabilité déjà strict — une colonne nouvelle n'y change rien pour les
  lignes déjà posées) ; `finalize_catalog_item_upload` (RPC, M019) ;
  `ProjectFile`/`serializeProject`/`validateProjectFile` (`projectFile.ts`,
  inchangés) ; `renderSvg` (`render.ts`, inchangé, pour régénérer un aperçu
  à la demande depuis le layout stocké — jamais un second moteur de rendu).
- **Modification nécessaire (migration, description seulement)** :
  - `alter table plan_catalog_item_versions add column layout jsonb null`
    — additive, compatible par construction avec toutes les versions
    existantes (NULL, jamais une valeur forcée).
  - `finalize_catalog_item_upload` : paramètre additionnel optionnel
    `p_layout jsonb default null`, écrit tel quel dans la nouvelle colonne,
    aucune autre logique changée (mêmes vérifications de droits, même
    fichier plat obligatoire en parallèle — le PDF/PNG reste la pièce
    jointe de référence, le layout est un AJOUT, jamais un remplacement).
  - Le dépôt d'une nouvelle version de catalogue (formulaire
    `UploadVersionForm.tsx`, propriétaire d'organisation uniquement, rôle
    inchangé) obtiendrait un champ optionnel : joindre le fichier de projet
    déjà exporté depuis `/prototype-plans` (bouton « Exporter le fichier de
    projet (.json) », inchangé) en plus du PDF/PNG habituel.
- **Compatibilité des anciens éléments** : tout modèle déposé avant ce lot a
  `layout = NULL` — reste utilisable EXACTEMENT comme aujourd'hui (référence
  plate via `attach_catalog_plan_to_project`, inchangé), simplement absent
  de la nouvelle liste « partir d'un modèle modifiable » (Lot B), jamais une
  erreur ni une dégradation visible.
- **Critères d'acceptation** : un modèle déposé avec `layout` non nul expose
  un aperçu régénéré depuis CE layout (`renderSvg`, pas le PDF/PNG) ; un
  modèle sans `layout` reste identique en tout point à son comportement
  actuel ; le fichier plat (aperçu légal/PDF) reste obligatoire dans tous
  les cas, jamais remplacé par le seul layout.

### Lot B — démarrer une demande depuis un modèle de catalogue (migration décrite, non créée ; dépend du Lot A)

- **Existant réutilisé** : `project_plan_requests`/`project_plan_request_variants`
  (M031, inchangés) ; `create_plan_request`/`save_plan_request_variant`
  (logique de verrouillage/rôle identique, réutilisée telle quelle) ;
  `/prototype-plans?retour=…&demande=…` (mécanisme de reprise déjà
  construit, Lot 3) ; `validateProjectFile` (déjà utilisé pour charger une
  variante, réutilisé à l'identique pour charger un modèle).
- **Modification nécessaire (migration, description seulement)** :
  - Nouvelle colonne `project_plan_requests.source_catalog_item_version_id
    uuid null references plan_catalog_item_versions (id) on delete
    restrict` — **conserve la version source utilisée**, jamais mutable
    après création (même trigger d'immuabilité M031, étendu à cette
    colonne : apparition au moment de l'insertion seulement, jamais une
    mise à jour).
  - Nouvelle fonction `create_plan_request_from_catalog_item(p_project_id,
    p_catalog_item_id)` : revérifie la **double condition D107** (CONTRACTOR/
    OWNER-PRIMARY du chantier ET propriétaire de l'organisation — même
    lecture que `attach_catalog_plan_to_project`, jamais un droit nouveau) ;
    exige `plan_catalog_items.published_version_id` non nul ET
    `plan_catalog_item_versions.layout` non nul (sinon
    `catalog_item_not_editable`, message explicite renvoyant vers le
    rattachement direct existant) ; crée une `project_plan_requests` (status
    OPEN, `generation_params` = les paramètres de terrain/programme
    D'ORIGINE du modèle, conservés pour référence, **jamais présentés comme
    valides pour le nouveau terrain**) ET une première
    `project_plan_request_variants` (variant_number=1, `layout` = COPIE du
    layout du modèle, `parent_variant_id` null — une copie en valeur, jamais
    une référence vivante vers `plan_catalog_item_versions`).
- **Terrain, reculs, programme et contrôles géométriques — traitement
  explicite (ne suppose jamais qu'un modèle convient à un autre terrain)** :
  à l'ouverture de cette demande dans `/prototype-plans`, le layout copié
  est chargé dans l'éditeur existant (identique au chargement d'une variante
  ordinaire) ; le terrain/reculs/programme D'ORIGINE du modèle sont affichés
  en lecture seule à titre de référence, jamais appliqués automatiquement au
  nouveau chantier. Le dépôt d'une variante reste bloqué, EXACTEMENT comme
  pour toute variante (Lot 1, inchangé), tant que `independentVerify` signale
  une erreur, qu'une pièce reste mise de côté, ou que le programme n'est pas
  complet — **aucun contrôle géométrique n'est relâché pour une copie**,
  l'utilisateur doit adapter réellement la disposition au terrain réel avant
  de pouvoir sauvegarder puis déposer.
- **Critères d'acceptation** : une demande créée depuis un modèle affiche sa
  version source (lecture seule, jamais modifiable) ; les mêmes contrôles de
  dépôt que toute variante s'appliquent sans exception ; le modèle de
  catalogue reste immuable et inchangé après copie (vérifiable : sa ligne
  `plan_catalog_item_versions` et son `layout` ne changent jamais) ;
  rattacher le même modèle à deux chantiers différents produit deux demandes
  et historiques totalement indépendants.

### Lot C — réutilisation du dépôt/validation/publication (aucune migration — déjà construit)

- **Existant réutilisé intégralement, sans aucune modification** :
  `depositPlanRequestVariantAction`/`finalize_plan_request_variant_deposit`
  (Lot 1/2, M031b) pour le dépôt ; `submit_plan_version_for_validation`/
  `decide_plan_validation`/`publish_project_plan_version` (M023b) pour la
  validation et la publication.
- **Distinction validation modèle / validation chantier — garantie par
  construction, pas par une règle ajoutée** : le dépôt d'une variante issue
  d'un modèle produit une `project_plan_versions` `origin='DIRECT'`
  ordinaire, sans aucune colonne ni FK vers `plan_catalog_item_validations`
  (confirmé : aucune table de validation commune n'existe, §1). Sa
  validation technique chantier est donc TOUJOURS une nouvelle soumission,
  jamais héritée de la validation du modèle catalogue — même si ce dernier a
  déjà été validé et publié à son propre niveau.
- **Critère d'acceptation** : un plan chantier issu d'un modèle VALIDÉ au
  catalogue n'apparaît jamais comme « déjà validé » côté chantier tant que
  `submit_plan_version_for_validation` n'a pas été appelée et décidée
  séparément pour CETTE version précise.

## 4. Décisions réellement bloquantes

1. **Format du fichier de projet dans le catalogue (Lot A)** — bloquant
   avant toute migration : ajouter `layout jsonb` à
   `plan_catalog_item_versions` (recommandé — additive, compatible, aucune
   ligne existante affectée) vs. une table d'extension séparée (même effet,
   un join de plus). **Recommandation : colonne nullable directe**, plus
   simple, cohérence déjà démontrée par `project_plan_request_variants.layout`.
2. **Droit de créer un modèle avec fichier modifiable** — le propriétaire
   d'organisation reste-t-il seul habilité (comme pour tout dépôt de
   catalogue aujourd'hui), ou un ingénieur/CONTRACTOR habilité pourrait-il
   aussi en proposer un ? **Recommandation : conserver le droit actuel
   (propriétaire d'organisation seul)** — aucune preuve d'usage ne demande
   une extension, et tout élargissement serait un droit nouveau au sens où
   ce chantier l'interdit explicitement.
3. **Export préalable obligatoire ou génération intégrée** : le propriétaire
   doit-il TOUJOURS passer par `/prototype-plans` pour produire le fichier
   de projet avant de l'attacher à une version de catalogue (recommandé,
   réutilise tout sans rien construire de neuf), ou le formulaire de dépôt
   catalogue devrait-il un jour intégrer le générateur directement (hors
   périmètre, un chantier distinct) ?

Aucune autre décision bloquante identifiée — le reste (double condition
D107, séparation des validations, immuabilité) reprend des décisions déjà
prises et vérifiées dans le code, jamais réinventées ici.

## 5. Hors périmètre, explicitement

Catalogue 3D/R+1, édition multi-utilisateur simultanée d'un modèle,
suppression/dépublication d'un modèle, tarification ou accès commercial
(`catalog_access_grants`/`CATALOG_PREVIEW_VIEW`) — aucun n'est touché par ce
plan.
