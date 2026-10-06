# Préparation — catalogue modifiable (prochain chantier)

> **Mise à jour du 2026-10-06** : premier sous-lot du Lot B réalisé sans
> migration, et proposition de migration pour la suite : voir §9. La
> traçabilité de l'origine (M035, Supabase local) est réalisée : voir §10.
> Les sections 1 à 9 sont conservées telles quelles (historique).

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

### Lot A — modèle de catalogue avec fichier de projet modifiable (**terminé, local uniquement**)

**Statut : terminé.** Autorisation fondateur explicite reçue (2026-10-03)
pour créer et appliquer les migrations UNIQUEMENT sur Supabase local.
Migrations : `20260930150000_m032_catalog_item_modifiable_layout.sql`
(colonne `layout jsonb` additive + contrainte de taille) et
**`20260930160000_m032b_correction_validation_layout.sql`** — correction
d'une frontière de confiance contournable sur M032, détectée par appel RPC
direct le 2026-10-03 (ci-dessous) et corrigée en nouveau fichier, cible
locale et sauvegarde reconfirmées avant application, aucune migration déjà
appliquée modifiée rétroactivement.

**Frontière de validation — contournement confirmé puis corrigé (M032b)** :
un appel RPC direct à `finalize_catalog_item_upload(uuid, jsonb)` (signature
M032), par un propriétaire d'organisation légitime mais SANS passer par
l'action serveur Next (donc sans jamais appeler `validateProjectFile`),
avec un ProjectFile respectant l'enveloppe SQL superficielle (objet,
version connue, clés `orientation`/`layout` présentes) mais structurellement
invalide (porte référençant une pièce inexistante), était **accepté** :
version créée, layout stocké tel quel. Confirmé empiriquement avant toute
correction. **Corrigé** en reprenant le même principe déjà utilisé pour le
contenu du fichier plat (`attest_storage_verified`, M010/M026) — jamais une
duplication de `validateLayout` en SQL : le layout ne transite plus par un
paramètre de `finalize_catalog_item_upload` (qui redevient à un seul
paramètre, signature originale) mais par une nouvelle fonction
`attest_catalog_item_layout`, accessible **UNIQUEMENT au rôle `service_role`**
(aucun grant à `authenticated`, exactement comme `attest_storage_verified`).
Seule l'action serveur Next — qui détient la clé service_role et appelle
TOUJOURS `validateProjectFile` juste avant — peut donc faire parvenir un
layout jusqu'à une version. Reconfirmé après correction : le même appel
direct échoue désormais (`finalize_catalog_item_upload` ne reconnaît plus
l'argument ; `attest_catalog_item_layout` renvoie `permission denied` pour
tout appelant authentifié), zéro version créée.

**Rattachement de l'attestation au bon téléversement et à son propriétaire —
vérifié (relecture, aucun changement)** : `attest_catalog_item_layout`
rattache strictement au bon téléversement par `operation_uuid` (clé unique
de `private_object_uploads`) mais, recevant `service_role`, ne peut pas
relire `auth.uid()` pour vérifier elle-même le propriétaire. Ce n'est pas une
faille : la propriété est garantie EN AMONT, par du code déjà existant et
inchangé — `get_upload_status` (M019) refuse tout appelant qui n'est pas
`created_by_profile_id` sur cet `operation_uuid`, et `prepare_catalog_item_upload`
(M019, bloc `unique_violation`) refuse explicitement de réutiliser un
`operation_uuid` déjà posé par un autre profil, une autre organisation ou un
autre contenu (`operation_uuid_conflict`) — un `operation_uuid` ne peut donc
jamais être détourné vers un autre propriétaire AVANT d'atteindre l'attestation.
Et EN AVAL, `finalize_catalog_item_upload` revérifie lui-même, indépendamment,
`created_by_profile_id <> v_uid` et `organizations.owner_profile_id <> v_uid`
avant de lire `pending_layout`. La chaîne complète est donc déjà couverte par
le comportement existant, non modifié par M032b, et par les preuves déjà
réunies (33/33, dont le contournement confirmé puis fermé) : **aucun test
supplémentaire n'est nécessaire** pour ce point précis.

**Garantie PNG/JSON — précisée** : la correspondance visuelle entre le PNG
déposé et le ProjectFile stocké, observée lors du parcours navigateur normal,
est une propriété du CODE CLIENT (`UploadModifiableVersionForm.tsx` rend
toujours le PNG depuis le MÊME objet déjà validé avant tout envoi) — **ce
n'est pas une garantie imposée côté serveur** : aucune contrainte en base ne
lie le contenu visuel du PNG au contenu du `layout`, les deux étant déposés
par deux appels RPC distincts (upload du fichier via le flux
prepare/claim/écriture/attest générique ; layout via `attest_catalog_item_layout`).
Ce que le serveur impose réellement : (1) le PNG stocké est bien celui dont
le contrôle d'intégrité (somme de contrôle) a été vérifié sur les octets
RÉELLEMENT relus dans Storage (inchangé, M010/M026) ; (2) AUCUN appelant
authentifié ordinaire ne peut faire parvenir un layout jusqu'à une version
sans passer par l'action serveur (donc par `validateProjectFile`), qu'il
corresponde ou non au PNG déposé dans le même dépôt — la correspondance
elle-même reste une propriété de bonne conduite du code client, jamais
vérifiée par une contrainte serveur indépendante.

**Transaction et téléversements non finalisés — précisé** : SEULE la
création de la ligne `plan_catalog_item_versions` (référence au fichier +
`layout`) est atomique — les deux sont écrits dans la MÊME instruction
`insert`, à l'intérieur de `finalize_catalog_item_upload` (une fonction
PL/pgSQL s'exécute dans une seule transaction) : aucune version avec l'un
sans l'autre n'est observable. Cette transaction est en revanche DISTINCTE
des étapes précédentes (upload du PNG, `attest_catalog_item_layout`) : si le
processus est interrompu entre l'upload du fichier et la finalisation
(réseau coupé, onglet fermé), AUCUNE ligne `plan_catalog_item_versions`
n'existe encore — l'upload reste dans un état intermédiaire résumable
(`private_object_uploads.status = 'FINALIZING'`, `pending_layout` déjà posé
ou non selon où l'interruption a eu lieu) ; rejouer `attest_catalog_item_layout`
(idempotent, écrase la même valeur) puis `finalize_catalog_item_upload`
(idempotent, revalide tout) termine le dépôt sans jamais créer de version
incomplète ni de doublon — vérifié (§ preuves ci-dessous).

- **Fichiers concernés** : `supabase/migrations/20260930150000_m032_*.sql`,
  `20260930160000_m032b_*.sql` ; `organisations/[id]/catalogue/actions.ts`
  (étapes prepare/claim/écriture/attest extraites dans
  `ensureReadyToFinalizeCatalog`, réutilisées par `depositCatalogItemVersionAction`
  INCHANGÉE et `depositModifiableCatalogItemVersionAction`, qui appelle
  désormais `attest_catalog_item_layout` via le client service_role avant
  `finalize_catalog_item_upload` ; nouvelle `getCatalogItemVersionFileAction`) ;
  composants `UploadModifiableVersionForm.tsx` (lit UN fichier .json, le
  valide côté client pour un retour immédiat, rend le PNG depuis CE MÊME
  layout via `renderSvg`/`renderSvgToPngBlob`) et `CatalogVersionFileLinks.tsx`
  (aperçu signé + téléchargement du JSON, droits existants) ; `render.ts`
  gagne `renderSvgToPngBlob` (extrait de `PlanEditor.renderExportPng`,
  réutilisé, jamais un second moteur de rendu).
- **Preuves** : `scripts/test-catalog-item-layout.mjs`, **33/33** — dépôt
  modifiable réussi, compatibilité ascendante (appel sans layout), 6 rejets
  (format/version/structure/taille) sans version partielle créée, rôle non
  autorisé refusé, **contournement RPC direct confirmé puis fermé** (2
  tentatives distinctes : paramètre supprimé de `finalize_catalog_item_upload`,
  `attest_catalog_item_layout` inaccessible à `authenticated` — zéro version
  créée dans les deux cas), échec réel après téléversement mais avant toute
  attestation/finalisation puis reprise sans doublon ni version incomplète,
  réimport fidèle après un appel indépendant (« rechargement »), ancienne
  version intacte après une nouvelle (immuabilité), `get_catalog_item_version_file` :
  propriétaire lit tout, ancien modèle renvoie `layout=null` sans erreur,
  outsider refusé. Non-régression : `scripts/test-catalog-items.mjs` 44/44,
  `scripts/test-plan-requests.mjs` 30/30, `scripts/test-project-plans.mjs`
  49/49, `scripts/test-plans-geometry.mjs` 755/755. Parcours navigateur réel
  (compte `demo-entreprise`, organisation « Espace professionnel ») rejoué
  après la correction M032b : dépôt modifiable réussi (v3), aucune erreur
  console/réseau.
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
    p_catalog_item_id, p_generation_params)` : revérifie la **double
    condition D107** (CONTRACTOR/OWNER-PRIMARY du chantier ET propriétaire
    de l'organisation — même lecture que `attach_catalog_plan_to_project`,
    jamais un droit nouveau) ; exige `plan_catalog_items.published_version_id`
    non nul ET `plan_catalog_item_versions.layout` non nul (sinon
    `catalog_item_not_editable`, message explicite renvoyant vers le
    rattachement direct existant).
- **Correction documentaire (précision founder, 2026-10-03) — les
  paramètres source sont une RÉFÉRENCE DISTINCTE, jamais les paramètres de
  la nouvelle demande** : `p_generation_params` est un paramètre **obligatoire
  de l'appel**, exactement comme pour `create_plan_request` (génération à
  partir de rien) — terrain, reculs, façade d'accès et programme du
  **chantier destinataire**, renseignés ou confirmés EXPLICITEMENT par
  l'utilisateur avant la création de la demande, jamais déduits ni
  pré-remplis automatiquement depuis le modèle. `generation_params` de la
  `project_plan_requests` créée est TOUJOURS ce paramètre destinataire,
  jamais une copie des paramètres d'origine du modèle. Les paramètres
  D'ORIGINE du modèle restent accessibles séparément, en lecture seule,
  uniquement via `source_catalog_item_version_id` (jamais fusionnés dans
  `generation_params`, jamais une seconde source de vérité pour le terrain
  réel) — l'UI afficherait ces deux jeux de paramètres côte à côte,
  explicitement distingués, jamais l'un à la place de l'autre. La première
  `project_plan_request_variants` créée (variant_number=1, `layout` = COPIE
  EN VALEUR du layout du modèle, jamais une référence vivante vers
  `plan_catalog_item_versions`) reste la disposition du modèle telle quelle
  — une copie destinée à être ADAPTÉE, jamais présumée déjà conforme au
  terrain destinataire.
- **Contrôles portant sur les paramètres DESTINATAIRES, jamais un simple
  avertissement (précision founder, 2026-10-03)** : les mêmes contrôles de
  dépôt que toute variante (Lot 1, `independentVerify`, programme complet,
  aucune pièce mise de côté) s'appliquent à la copie en comparant la
  géométrie RÉELLEMENT dessinée aux paramètres DESTINATAIRES
  (`generation_params` de CETTE demande — terrain/reculs/accès/programme du
  chantier réel), jamais aux paramètres d'origine du modèle. Si la copie ne
  correspond pas au terrain destinataire (débordement hors emprise, accès
  incompatible, programme incomplet), le dépôt reste refusé EXACTEMENT comme
  pour toute variante non conforme — **aucun redimensionnement silencieux,
  aucun ajustement automatique du terrain, des reculs ou des dimensions des
  pièces pour la faire rentrer** : l'utilisateur doit éditer réellement la
  disposition (déplacer/redimensionner les pièces, reconfigurer l'accès) et
  ne peut la sauvegarder comme variante déposable qu'une fois les contrôles
  réellement satisfaits pour CE terrain précis.
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

1. **Format du fichier de projet dans le catalogue** — **tranchée et
   implémentée (Lot A, 2026-10-03)** : colonne `layout jsonb` nullable
   directement sur `plan_catalog_item_versions` (M032), conformément à la
   recommandation.
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

## 6. Clôture de ce lot

**29/69 (42 %)** global, inchangé par ce lot (aucune tâche `MVP_BACKLOG.csv`
concernée). Prototype 7/7, intégration 3/3, chacun dans
son périmètre, inchangés. **Catalogue modifiable — Lot A terminé**
(§3 ci-dessus, migration M032 créée et appliquée en local, 27/27 + 44/44 +
30/30 + 49/49 + 755/755, parcours navigateur réel). **Lots B et C non
entamés** — seule leur documentation a été corrigée ce lot (§3, précision
sur la distinction paramètres source/destinataire). **Le catalogue
modifiable n'est PAS complet** : aucun parcours de copie vers un chantier
n'existe encore (Lot B), donc rien n'est déposable de bout en bout depuis
un modèle de catalogue à ce stade — seul le dépôt ET la consultation d'un
modèle modifiable AU CATALOGUE fonctionnent réellement.

**Clôture formelle (référence commit `924d82c`)** : Lot A est clos à cet
état exact. Limite documentée et non négociable : la validation
STRUCTURELLE du fichier de projet est garantie côté serveur (frontière
`service_role`, contournement confirmé puis fermé — ci-dessus) ; la
concordance VISUELLE entre le PNG déposé et ce fichier n'est garantie QUE
par le parcours normal (code client), jamais par une contrainte serveur
indépendante. Toute évolution future qui voudrait une garantie serveur sur
la concordance visuelle est un chantier distinct, non commencé, non promis
par ce lot.

## 7. Règles métier confirmées par le fondateur (2026-10-03) — analyse

Analyse uniquement — aucun changement de droits ni migration appliquée ce
tour.

| Règle demandée | Comportement actuel | Changement nécessaire |
|---|---|---|
| Propriétaire consulte l'avancement | **Absent** : aucune table/RPC « étapes »/« phases » n'existe (`PHASE_*` dans PERMISSIONS.csv = conception seule). `D141` le confirme explicitement : étapes différées (B019 suspendue, B027 partielle), AC172 seulement partiellement satisfait par B068. | Hors périmètre de ce tour — fonctionnalité non construite, dépend d'un backlog distinct non rouvert ici. |
| Propriétaire consulte ses versements | **Déjà fait** : `list_advance_payments`/`list_advance_events` (M014) — lecteurs CONTRACTOR, OWNER/PRIMARY, CO_OWNER. | Aucun. |
| Propriétaire consulte le solde | **Déjà fait** : `get_project_financial_summary` (M028) — `balance_fcfa`/`remaining_due_fcfa`, mêmes lecteurs, aucune donnée de dépense ni de budget (`D140`/`D142`/`BR112`). | Aucun. |
| Propriétaire consulte photos/vidéos partagées | **Déjà fait** : `list_project_media` (M010) — médias `PUBLIE` lisibles par OWNER (PRIMARY et CO_OWNER), CONTRACTOR, SITE_MANAGER ; brouillons jamais visibles au propriétaire. | Aucun. |
| Entreprise propose le prix et l'avance de démarrage | **Déjà fait** : devis proposé par CONTRACTOR et décidé par OWNER/PRIMARY (`propose_quote_version`/`decide_quote_version`, M021) ; avance exigée fixée par CONTRACTOR, plafonnée au montant contractuel (`set_advance_requirement`, M014). | Aucun. |
| Le solde est versé à la fin | **Déjà satisfait, par construction** : « solde » est un montant CALCULÉ (contrat − versements reconnus, `D142`), pas une étape de workflow distincte ; tout versement (premier ou dernier) passe par le même mécanisme (`declare_advance_payment`). | Aucun — ne pas créer un type de versement « final » distinct : ce serait un circuit nouveau, hors périmètre autorisé. |
| Dépenses/coûts internes/justificatifs privés à l'entreprise | **Règle déjà actée** (`D086`, `D090`, `BR098`, `BR099`) mais la fonctionnalité « dépenses » elle-même n'existe pas encore en base (conception seule : `SCREENS.csv`, `DATABASE_TABLES.csv`) — rien à « réintroduire », rien n'a jamais été codé. | Aucun aujourd'hui — au jour de la construction de cette fonctionnalité, appliquer `D086`/`D090` dès la première version (pas de lecture propriétaire sauf seuil `BR098`, jamais pour le budget `BR099`). |
| Propriétaire consulte le catalogue | **Absent** : la page catalogue est réservée en totalité au propriétaire D'ORGANISATION (`organization.owner_profile_id === user.id`) ; aucun accès pour le propriétaire de chantier. | Nouvelle consultation minimale — voir §8. |

## 8. Catalogue — consultation par le propriétaire du chantier (proposition, non implémentée)

Changement minimal proposé, distinct de la gestion du catalogue (page
existante, inchangée) et du Lot B ci-dessus (copie vers un chantier,
inchangé). Analyse et proposition uniquement — aucune migration créée ni
appliquée ce tour.

### 8.1 Décision bloquante préalable (nouvelle, non résolue par le code existant)

« L'organisation liée à ce chantier » suppose un lien déterministe
chantier → organisation. Vérifié : ce lien **n'existe pas** dans le cas le
plus courant. `projects.organization_id` n'est écrit qu'une fois, à la
création (`create_draft_project`, M004b) : toujours `NULL` quand le
créateur est OWNER (B009/`D`-sourcé), jamais mis à jour ensuite —
`accept_invitation` (M006a), qui fait rejoindre un CONTRACTOR à un chantier
déjà créé par son propriétaire, n'écrit que `project_memberships`, jamais
`projects.organization_id`. Par ailleurs, profil → organisation n'est pas
1:1 (`organizations.owner_profile_id` sans contrainte d'unicité ;
`organization_memberships` sans colonne `role`, adhésion M:N, D078) — un
CONTRACTOR peut posséder ou appartenir à plusieurs organisations, exactement
la même ambiguïté que `create_draft_project` résout déjà par un choix
explicite (`organization_choice_required`) quand il crée lui-même un
chantier.

**Conséquence** : pour un chantier créé par son propriétaire puis rejoint
par une entreprise invitée (le cas visiblement le plus courant), il n'existe
aujourd'hui AUCUNE colonne permettant de déterminer quelle organisation lui
est liée. Avant toute consultation catalogue par le propriétaire, ce lien
doit être rendu explicite — au moment où un CONTRACTOR rejoint un chantier,
pas en l'inventant à la lecture.

**Proposition minimale (réutilise le mécanisme déjà validé de
`create_draft_project`, aucun circuit nouveau)** :
- Ajouter une colonne nullable `project_memberships.organization_id`
  (référence `organizations(id)`), renseignée uniquement pour les lignes
  `role = 'CONTRACTOR'`.
- `create_draft_project` (CONTRACTOR crée son propre chantier) : reporter le
  même `v_org_id` déjà résolu sur la ligne `project_memberships` du créateur
  — aucune nouvelle résolution, valeur déjà calculée.
- `accept_invitation` (CONTRACTOR rejoint un chantier existant, rôle
  CONTRACTOR) : exiger la MÊME résolution que `create_draft_project`
  (auto-sélection si une seule organisation possédée, sinon
  `organization_choice_required` avec un paramètre explicite déjà du même
  nom) avant d'insérer la ligne `project_memberships`.
- Si aucune organisation n'est résolue (cas impossible par construction une
  fois ce qui précède en place) : `project_memberships.organization_id`
  reste `NULL`, la consultation catalogue renvoie alors une liste vide,
  jamais une erreur.

Cette décision doit être validée par le fondateur avant toute migration —
elle touche `project_memberships` (table déjà utilisée par les droits
d'accès de tout le reste de l'application) et le flux d'acceptation
d'invitation existant.

### 8.2 Lecture catalogue — RPC proposée (description seulement)

`list_project_catalog_items_for_owner(p_project_id uuid)` — nouvelle
fonction, `security definer stable`, grant `authenticated` (lecture
ordinaire, pas une écriture : pas de frontière `service_role` nécessaire
ici, à la différence de l'attestation de layout).

- Vérifie l'appelant : `project_memberships` actif, `project_id = p_project_id`,
  `role = 'OWNER'` (PRIMARY ou CO_OWNER — même lecteur que `D140`), sinon
  `not_authorized`.
- Résout l'organisation via la ligne `project_memberships` active
  `role = 'CONTRACTOR'` du même chantier (§8.1) ; si absente, renvoie un
  ensemble vide (aucune erreur — un chantier sans entreprise rattachée n'a
  simplement rien à montrer).
- Sélectionne UNIQUEMENT les modèles PUBLIÉS de cette organisation :
  `plan_catalog_items i join plan_catalog_item_versions v on v.id = i.published_version_id`
  (jamais la dernière version comme `list_organization_catalog_items` —
  explicitement la version PUBLIÉE), `where i.organization_id = v_org_id and i.archived_at is null`.
- Colonnes renvoyées, volontairement restreintes : `catalog_item_id`,
  `label`, `version_number`, `published_at_server`, et une référence au
  fichier plat (PDF/PNG) pour générer une URL signée d'aperçu via le
  mécanisme existant — **`layout` jamais sélectionné** (absent de la
  requête, pas seulement masqué côté client) : aucune lecture du JSON
  modifiable par ce chemin, par construction.
- Aucun brouillon, aucune version non publiée, aucune autre organisation :
  garanti par les deux filtres (`published_version_id` et
  `organization_id = v_org_id` résolu en §8.1).

### 8.3 Permissions

Nouvelle ligne `PERMISSIONS.csv` (domaine catalogue), proposée pour
validation :

```
CATALOG_PUBLISHED_VIEW,catalogue,A,A,N,N,A,"Propriétaire de chantier (principal ou copropriétaire) : modèles PUBLIÉS de l'organisation liée au chantier uniquement, aucun JSON, aucun brouillon. Distinct de CATALOG_ITEM_* (gestion, propriétaire d'organisation)."
```

(Colonnes dans l'ordre déjà en usage dans le fichier : OWNER/PRIMARY,
CO_OWNER, CONTRACTOR, SITE_MANAGER, et la dernière colonne = commentaire —
`CONTRACTOR`/`SITE_MANAGER` restent `N` ici car ils ont déjà leurs propres
droits de gestion catalogue, sans rapport avec cette consultation
chantier.)

### 8.4 Page (description seulement)

Nouvelle page `src/app/(app)/chantiers/[id]/catalogue/page.tsx`, lecture
seule, appelant uniquement `list_project_catalog_items_for_owner` —
jamais `list_organization_catalog_items` (réservée à la gestion,
inchangée). Aperçu signé réutilise le mécanisme déjà existant
(`CatalogVersionFileLinks.tsx`/URL signée), sans dupliquer de logique de
génération de lien.

### 8.5 Hors périmètre de cette proposition

Copie d'un modèle vers un chantier (reste le Lot B existant, §« Lot B —
démarrer une demande… », inchangé par cette proposition) ; gestion du
catalogue (page existante, inchangée) ; accès aux brouillons, versions non
publiées, ou catalogues d'autres organisations (toujours refusés).

## 9. Lot B — copie vers un chantier : premier sous-lot sans migration (2026-10-06, local)

### 9.1 Fonctions réellement disponibles (vérifiées depuis M034)

- Lecture du modèle : `list_organization_catalog_items` et
  `get_catalog_item_version_file` (M019/M032), réservées au **propriétaire
  de l'organisation**.
- Chantier : `create_plan_request` (M031b), CONTRACTOR ou OWNER/PRIMARY du
  chantier.
- Première variante : circuit M034 (attestation `service_role` liée au
  profil de session, puis `save_plan_request_variant`).
- Rattachement chantier → organisation : `projects.organization_id`, comme
  pour `attach_catalog_plan_to_project` (D107).

Ces fonctions suffisent pour un parcours complet **sans migration ni droit
nouveau**. Seule manque la traçabilité de la version source (§9.4).

### 9.2 Réellement utilisable

Parcours : catalogue → « Copier la version publiée vers un chantier »
(`/organisations/[id]/catalogue/[itemId]/copier`) → choix du chantier →
paramètres du chantier → vérification → création → ouverture dans
l'éditeur.

- **Source** : uniquement la version **publiée**, munie d'un fichier
  structuré. Un modèle plat n'a pas de lien de copie ; son accès direct
  explique qu'il n'est pas éditable.
- **Destination** : chantiers où l'utilisateur a une adhésion **active**
  (CONTRACTOR ou OWNER/PRIMARY) **et** qui sont rattachés à l'organisation
  du modèle. Posséder l'organisation ne donne accès à aucun chantier.
- **Paramètres du chantier** : saisis, ou repris de la dernière demande de
  plan de **ce chantier** (présentés comme tels, à confirmer). Jamais
  pré-remplis depuis le modèle. Une case de confirmation est exigée et se
  décoche à chaque modification. Les paramètres du modèle sont affichés à
  part, en lecture seule.
- **Vérification sans écriture** (`catalogueCopy.ts`) :
  - **bloquant**, la copie n'est pas créée : façade d'accès différente,
    programme différent, pièce sous les minima du chantier, élément non
    déplaçable (couloir, raccord, circulation) hors emprise, cheminement
    extérieur hors terrain, modèle avec cour d'entrée (limite de ce lot) ;
  - **à adapter dans l'éditeur** : pièces hors emprise et anomalies de
    `independentVerify`, que l'éditeur contrôle au dépôt ;
  - aucun verdict d'admissibilité : le texte rappelle que la copie n'est
    ni déposée ni admissible.
- **Copie** : clone profond, posée sur le terrain et l'emprise du chantier,
  pièces aux mêmes positions et dimensions, autorisations F2 retirées,
  orientation du chantier. Elle est revalidée (v4, sans avis) puis
  enregistrée comme **variante 1** d'une nouvelle demande, dont les
  `generation_params` sont ceux du **chantier**.
- **Reprise sans doublon** : même opération et même date de préparation
  donnent le même fichier. Si la réponse est perdue, la demande est
  retrouvée par l'attestation de l'opération.
- **Brouillon** : préparer ou vérifier ne touche aucun brouillon. Dans
  l'éditeur, la copie est seulement **proposée**. Si un brouillon local
  existe, le bandeau prévient du remplacement et propose de le télécharger
  (réimportable). L'ouverture d'une variante par la liste existante demande
  désormais confirmation quand un brouillon local existe.
- **Contrôles côté serveur** : toutes les vérifications passent par les
  actions serveur avec la session réelle
  (`src/lib/plans/catalogueCopySource.ts`). La demande et la variante sont
  revérifiées par `create_plan_request` et le circuit M034.

### 9.3 Garanties vérifiées

- Modèle et version d'origine inchangés : ligne identique avant et après.
- Aucune autorisation F2 héritée.
- Aucun redimensionnement.
- Aucune validation héritée : pas de version de chantier, pas de
  validation de chantier, validations du catalogue inchangées.
- Aucun dépôt automatique.

Preuves :
- `scripts/test-plans-catalogue-copy.mjs` : 35/35, branché dans
  `npm test` ;
- `scripts/test-catalogue-copy-source.mjs` : 29/29, local, vraies
  sessions ;
- parcours navigateur sur les données de démonstration (§9.6).

### 9.4 Préparé, non implémenté — migration proposée (non créée, non appliquée)

**Besoin** : conserver, sur la demande créée, la version source du modèle
(« issu de “Modèle X” v1 »), immuable, et faire porter la double
condition D107 par la base plutôt que par l'action serveur seule.

**Opérations (M035, prochain identifiant libre)** :
1. `alter table project_plan_requests add column
   source_catalog_item_version_id uuid null references
   plan_catalog_item_versions(id) on delete restrict` : additive, nulle
   pour toutes les demandes existantes.
2. Déclencheur d'immuabilité des demandes (M031) étendu à cette colonne :
   fixée à l'insertion, jamais modifiée.
3. `create_plan_request_from_catalog_item(p_project_id,
   p_catalog_item_id, p_generation_params)`, en `security definer`,
   accordée à `authenticated` :
   - mêmes contrôles que `create_plan_request` (adhésion active
     CONTRACTOR ou OWNER/PRIMARY, compte non provisoire) ;
   - propriétaire de l'organisation du modèle ;
   - `projects.organization_id = plan_catalog_items.organization_id` ;
   - modèle non archivé ;
   - version publiée avec `layout` non nul, sinon
     `catalog_item_not_editable` ;
   - insertion avec `source_catalog_item_version_id`.
4. La variante 1 reste créée par le circuit M034 (validation et
   préparation de la copie côté serveur) : aucun plan en argument.

**Rôles concernés** : exactement ceux de `attach_catalog_plan_to_project`.
Aucun droit nouveau, aucun accès du propriétaire de chantier au catalogue
(§8 inchangé).

**Impact** :
- colonne additive ;
- l'action de copie appelle la nouvelle fonction au lieu de
  `create_plan_request` ;
- affichage en lecture seule de la source sur la demande ;
- aucune lecture du catalogue par ce chemin pour d'autres rôles.

**Critères de réussite** :
- la source s'affiche et ne peut être ni modifiée ni supprimée ;
- un appel direct est refusé pour un chantier d'une autre organisation, un
  chantier sans adhésion, un copropriétaire, un modèle non publié ou
  plat ;
- aucune clé étrangère vers une table de validation ;
- deux chantiers obtiennent deux demandes indépendantes ;
- les tests du §9.3 restent verts.

### 9.5 Bloqué sur une décision

1. **Appliquer la migration du §9.4** : décision du fondateur, après
   relecture.
2. **Consultation du catalogue par le propriétaire du chantier** (§8.1) :
   inchangé, toujours bloqué. Le lien chantier → organisation n'existe pas
   pour un chantier créé par son propriétaire. Ce lot n'élargit aucun accès.
3. **Copie des seules versions publiées** : règle du Lot B appliquée telle
   quelle. Autoriser la copie d'une version non publiée serait une décision
   distincte.
4. **Hors de ce sous-lot, sans décision de droits** :
   - réorientation d'un modèle vers une autre façade d'accès ;
   - copie d'un modèle avec cour d'entrée ;
   - adaptation du programme (ajout ou retrait de pièces).

   Ce sont des évolutions du moteur, à cadrer séparément.

### 9.6 Données de démonstration (Supabase local)

- **Publication de la version 1 du « Modèle démo F2 v5 (2026-10-06) »**,
  par le circuit réel : désignation d'un ingénieur de démonstration (compte
  local `demo-ingenieur-catalogue@example.test`, mot de passe aléatoire non
  conservé), soumission, décision `VALIDATED`, publication par le
  propriétaire.
- **Sur le « Chantier démo F2 v5 »** : une demande `41b42a13…` (paramètres
  du chantier, 15 × 20 m, accès avant) et sa variante 1, la copie. Ni
  déposée, ni validée.
- **Données jetables** créées par les scripts de test.

## 10. Traçabilité de l'origine — M035 (2026-10-06, Supabase local)

**Migration** : `20261006150000_m035_plan_request_catalog_source.sql`,
appliquée **en local uniquement**, après une sauvegarde vérifiée (schéma +
données complètes, `.local_backups/pre_m035_*_20261006_050921`). Aucune
réinitialisation, aucune purge. Les 40 demandes existantes gardent une
origine nulle : aucune n'est réécrite, aucune origine n'est déduite.

### 10.1 Ce qui est enregistré

- `project_plan_requests.source_catalog_item_version_id` : clé étrangère
  vers la **version exacte** (`on delete restrict`), jamais vers le modèle
  ni vers « sa version publiée actuelle ». Les versions de catalogue sont
  déjà immuables : publier une version suivante ne change ni l'origine ni
  la copie.
- `project_plan_requests.catalog_copy_operation_uuid` : opération de
  création, unique.
- Les deux colonnes sont posées ensemble ou pas du tout (contrainte), puis
  figées par le déclencheur d'immuabilité des demandes, y compris pour
  `service_role`. Aucune origine ne peut être ajoutée, changée ou effacée
  après coup.

### 10.2 Seule voie : `create_plan_request_from_catalog_item`

Elle applique en base les règles déjà en place :
- adhésion active CONTRACTOR ou OWNER/PRIMARY sur le chantier, compte non
  provisoire (comme `create_plan_request`) ;
- lecture de la source réservée au propriétaire de l'organisation (comme
  `get_catalog_item_version_file`) ;
- chantier rattaché à l'organisation de la version
  (`catalog_organization_mismatch`, D107) ;
- à la création : modèle et organisation non archivés, version **publiée
  au moment de l'écriture** (`catalog_version_not_published`) et
  structurée (`catalog_item_not_editable`).

Elle est idempotente par opération : même opération, même auteur,
chantier, version et paramètres renvoient la même demande, sans rien
écrire. Toute autre combinaison est refusée
(`catalog_copy_operation_conflict`). Les droits sur le chantier et sur la
source sont revérifiés à chaque appel, y compris en reprise.

`create_plan_request` est inchangée et ne peut poser aucune origine. La
table reste fermée à `authenticated` et `anon`.

### 10.3 Écritures atomiques et reprise

| Étape | Transaction | Reprise |
|---|---|---|
| A. `create_plan_request_from_catalog_item` | une : contrôles + insertion de la demande **avec** son origine | idempotente par opération |
| B. `attest_plan_request_variant_layout` (M034) | une : attestation du fichier validé | idempotente pour le même fichier |
| C. `save_plan_request_variant` (M034) | une : contrôles + consommation de l'attestation + insertion de la variante 1 | idempotente par opération |

A, B et C sont trois appels distincts, jamais une transaction commune. Une
même opération porte la même date de préparation, donc le même fichier.
La rejouer reprend après l'étape déjà faite, sans doublon :
- après une réponse perdue ;
- après un échec entre A et C ;
- lors d'appels simultanés.

Si une autre version a été publiée entre-temps, la reprise reste possible
et termine avec la version d'origine. Une **nouvelle** opération exige, en
revanche, la version publiée actuelle.

Limite : si l'utilisateur abandonne la page après A, sans jamais rejouer
la même opération, la demande reste ouverte avec son origine et sans
variante. Elle reste reprenable depuis la page Plans comme toute demande,
mais sans la copie : il suffit de relancer la copie, qui crée alors une
nouvelle opération.

### 10.4 Affichage

`list_plan_request_origins(p_project_id)` a les mêmes lecteurs que
`list_plan_requests`.
- **Propriétaire de l'organisation** (seul à lire déjà le catalogue) : il
  reçoit le libellé du modèle et le numéro de version.
- **Autres lecteurs** : ils apprennent seulement que l'origine est un
  modèle du catalogue.
- **Rien d'autre n'est exposé** : ni identifiant de modèle ou de version,
  ni fichier, ni plan.

La page Plans du chantier affiche, pour chaque demande :
- « Origine : modèle « … », version n (catalogue) » ;
- « Origine : un modèle du catalogue de l'entreprise » ;
- ou « Origine non renseignée ».

La page de copie copie la version **affichée**. Si une autre version a été
publiée depuis, elle refuse et demande de recharger.

### 10.5 Preuves

- `scripts/test-catalogue-copy-source.mjs` : **59/59**, local, vraies
  sessions. Il couvre :
  - version exacte enregistrée ;
  - publication ultérieure sans effet sur l'origine ni sur la copie ;
  - copie depuis une version qui n'est plus publiée refusée ;
  - reprise après publication terminée avec la version d'origine ;
  - 8 appels directs refusés : sans session, sans propriété de
    l'organisation, autre organisation, copropriétaire, version non
    publiée, version plate, modèle d'une autre organisation, version
    inexistante ;
  - origine non attribuable par l'ancienne fonction ni par insertion
    directe ;
  - origine immuable, non effaçable, non ajoutable après coup ;
  - reprise après réponse perdue, après échec réel, et appels simultanés :
    une demande, une variante ;
  - même opération avec d'autres paramètres refusée ;
  - affichage selon les permissions ;
  - droits revérifiés après retrait d'accès, y compris en reprise.
- Non-régression : `test-plan-requests.mjs` 30/30,
  `test-plan-request-variant-attestation.mjs` 39/39.
- Navigateur : voir §10.6.

### 10.6 Données de démonstration ajoutées

Sur le « Chantier démo F2 v5 », une demande `db1bbf33…` créée depuis la
version 1 du « Modèle démo F2 v5 (2026-10-06) », avec sa variante 1 (la
copie), ni déposée ni validée.

La page Plans affiche son origine. Les demandes antérieures, dont la copie
`41b42a13…` du lot précédent, affichent « Origine non renseignée ».

