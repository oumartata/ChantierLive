# Proposition B044 — tableaux de bord par rôle

Boucle 26, étape 1 (2026-10-07). Décisions du fondateur (boucle 26b, D189) :
J1 à J7 renommées T1 à T7, toutes en option A ; réalisé sans migration
(src/lib/dashboard/dashboard.ts, /tableau-de-bord, scripts/test-dashboard.mjs).

## 1. Sources citées

- **B044** (MVP_BACKLOG, lot L07, P0, dépend de B020 et B031) : « Créer
  tableaux de bord par rôle » ; done_when : « fraîcheur et droits affichés ».
- **FR113** (propriétaire) : « Voir progression; dernière activité; budget
  indicatif partagé (D143, jamais le budget interne ; D183); alertes et
  approbations. » — AC113 : progression, budget indicatif partagé, activité,
  alertes et demandes autorisées ; aucune donnée financière interne.
- **FR114** (entreprise) : « Voir ses chantiers; activités; retards;
  incidents et demandes. » — AC114 : résumé filtrable de ses chantiers.
- **FR115** (chef de chantier) : « Voir tâches de saisie; incidents et
  éléments non synchronisés. » — AC115 : actions utiles et éléments non
  synchronisés visibles.
- **FR116** : ouvrir le détail depuis chaque indicateur (SHOULD).
- **FR117 / BR069** : date de dernière synchronisation, fournie par le
  serveur. **FR118 / BR070** : état vide qui distingue absence de données,
  absence de droit, chargement et erreur. **BR068** : chaque indicateur
  dérive de données autorisées et affiche sa fraîcheur.
- **FR172** : montant contractuel, paiements reconnus, reste dû, étapes et
  photos, sans le détail des dépenses internes.
- **D143** : `projects.budget` = enveloppe indicative partagée, ni montant
  contractuel, ni budget interne ; exclue de tout calcul.
- **D177** : « Avancement déclaré par l'entreprise » et « Avancement
  validé » : deux mesures, jamais fusionnées ni confondues à l'écran.
- **D183** : le propriétaire (principal et copropriétaire) n'accède jamais
  aux dépenses, budget interne, justificatifs, ni à aucun total, compteur ou
  tableau de bord qui en dérive.
- **SCREENS / CRITICAL_SCREEN_SPECS / INFORMATION_ARCHITECTURE** :
  - SCR010 « Tableau de bord propriétaire » (`/accueil`, OWNER) : sélecteur
    de chantier, alertes, progression, budget, décisions en attente,
    mises à jour récentes ; fraîcheur serveur.
  - SCR011 « Portefeuille entrepreneur » (`/accueil`, CONTRACTOR) :
    indicateurs du portefeuille, filtres, cartes de chantier, alertes ;
    « surveiller plusieurs chantiers sans fuite entre projets ».
  - SCR009 « Aujourd'hui terrain » (`/aujourdhui`, SITE_MANAGER) :
    connexion, chantier, journal du jour, actions rapides, brouillons
    locaux, file d'envoi ; hors connexion complet.
  - role_homes : accueil par rôle (OWNER → SCR010, CONTRACTOR → SCR011,
    SITE_MANAGER → SCR009).
- **État actuel** : `/tableau-de-bord` liste « Mes chantiers » sans aucun
  indicateur ; `/entreprise` liste les chantiers de l'entreprise et dit
  explicitement ne montrer aucun compteur faute de source fiable.

## 2. Contenu par rôle et source de chaque chiffre

Toutes les sources sont des fonctions existantes qui revérifient déjà le
droit de l'appelant ; aucune ne lit une donnée interne pour le
propriétaire (tests B029, B030–B032).

### Propriétaire principal (par chantier où il est OWNER/PRIMARY)

| Indicateur | Source |
|---|---|
| Avancement déclaré par l'entreprise (%) | `get_project_phase_plan` (M033, pondéré déclaré) |
| Avancement validé (x / y étapes) | `get_project_validated_progress` (M040, BR034) — bloc séparé |
| Enveloppe indicative du projet | `projects.budget` (D143), libellé « indicative », jamais additionnée |
| Montant contractuel, payé, reste dû | `get_project_financial_summary` (M028, FR172) |
| Décisions en attente | devis proposé (`get_quote_state`), avenant proposé (`list_change_orders`), étape à valider (`list_project_phase_details`, D179 : principal) |
| Alertes | incidents ouverts (`list_project_incidents`), dont gravité haute |
| Dernière activité | date la plus récente parmi journaux publiés, photos publiées, événements d'étape, incidents, documents visibles |

### Copropriétaire

Même contenu, en lecture ; les décisions réservées au principal sont
affichées « décision du propriétaire principal » (droits affichés, B044).

### Entreprise (portefeuille, SCR011)

| Indicateur | Source |
|---|---|
| Nombre de chantiers par statut | `project_memberships` + `projects` (RLS) |
| Par chantier : incidents ouverts | `list_project_incidents` |
| Par chantier : demandes à traiter | dépenses soumises (`list_project_expenses`, interne), versements à confirmer (`list_advance_payments`), étapes « terminée » en attente de validation (`list_project_phase_details`, statut TERMINEE) |
| Par chantier : « retards » | **règle manquante (J2)** |
| Par chantier : avancement déclaré / validé | comme ci-dessus, deux mesures séparées |
| Dernière activité | comme ci-dessus |

Aucun total financier entre chantiers (FINI QUAND de la boucle) ; aucun
montant sur les cartes du portefeuille (le détail est sur la fiche).

### Chef de chantier (SCR009)

| Indicateur | Source |
|---|---|
| Journal du jour : brouillon en cours / publié / absent | `list_my_daily_log_drafts`, `list_published_daily_logs` |
| Incidents ouverts | `list_project_incidents` |
| Mes dépenses en attente / brouillons | `list_project_expenses` (jamais budget ni alerte, D187 H3) |
| Éléments non synchronisés | **hors ligne hors périmètre (J5)** |

## 3. Décisions attendues (A = recommandation)

- **J1. Utilisateur à plusieurs rôles** (propriétaire d'un chantier,
  entreprise d'un autre).
  - **A** : une seule page d'accueil (`/tableau-de-bord`) avec un bloc par
    rôle détenu, chaque bloc limité aux chantiers de ce rôle.
  - **B** : sélecteur d'espace (un accueil par rôle, `/accueil`,
    `/entreprise`, `/aujourdhui`).
  - **C** : accueil du rôle « principal » seulement.
  - *Recommandation A* : aucune donnée d'un rôle ne se mélange à l'autre, et
    rien n'est caché.
- **J2. « Retards » (FR114)** : aucune règle ne les définit.
  - **A** : étapes actives d'un plan publié, non validées, dont la fin
    prévue (`project_phases.planned_end`) est dépassée ; libellé factuel
    « fin prévue dépassée », jamais « retard » d'un tiers.
  - **B** : incidents de type « retard » (D160) seulement.
  - **C** : reporter jusqu'à une règle de planning.
  - *Recommandation A*, avec B affiché à part dans les incidents.
- **J3. Fraîcheur (FR117, BR069) sans synchronisation hors ligne.**
  - **A** : « Données lues sur le serveur le … (UTC) » (heure du serveur
    au moment de la lecture) + date de la donnée la plus récente par
    indicateur.
  - **B** : attendre le hors ligne.
  - *Recommandation A*.
- **J4. « Alertes et approbations » du propriétaire.**
  - **A** : décisions qui l'attendent (devis proposé, avenant proposé,
    étape à valider — principal seulement) + incidents ouverts (gravité
    haute mise en avant).
  - **B** : décisions seulement.
  - *Recommandation A*.
- **J5. Chef de chantier, « éléments non synchronisés »** : la file hors
  ligne n'existe pas (hors périmètre).
  - **A** : ne pas afficher le bloc ; FR115 partielle, complétée avec le
    hors ligne.
  - **B** : bloc avec la mention « envoi hors connexion pas encore
    disponible ».
  - *Recommandation A* (R13 : aucun compteur inventé).
- **J6. Demandes internes de l'entreprise sur le portefeuille** (dépenses
  soumises par le chef de chantier).
  - **A** : nombre par chantier, entreprise seule.
  - **B** : non affichées sur le tableau de bord.
  - *Recommandation A* (FR114 « demandes ») ; jamais de montant.
- **J7. Mise en œuvre.**
  - **A** : sans migration, en composant les fonctions existantes (chacune
    revérifie le droit, tests de confidentialité déjà en place) ; coût : un
    appel par source et par chantier.
  - **B** : M047, une fonction d'agrégat par rôle (moins d'appels, mais une
    nouvelle surface à prouver contre toute fuite D183).
  - *Recommandation A*, B plus tard si le nombre de chantiers l'exige.

## 4. Preuves prévues

- Test : pour le propriétaire et le copropriétaire, aucune réponse utilisée
  par le tableau de bord ne contient de dépense, budget interne, reçu ou
  compteur interne (D183) ; navigation sans lien interne.
- Test : les deux mesures d'avancement sont rendues dans deux blocs
  distincts, jamais une moyenne ni un seul pourcentage.
- Aucun total financier entre chantiers ; aucun compteur sans source.
- Navigateur ordinateur et 390 px pour les 4 rôles.
