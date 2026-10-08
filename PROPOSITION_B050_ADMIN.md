# Proposition B050 — interface d'administration à métadonnées minimales

Boucle 34, étape 1 (2026-10-08). Aucun code, aucune migration : le périmètre
de B050 n'est fixé nulle part, aucun statut de compte n'existe, et gérer des
comptes oblige à les identifier, ce qui touche D194 A9 (§3) ; décisions E1 à
E8 attendues du fondateur.

## 1. Sources citées

- **B050** (MVP_BACKLOG, lot L08, P0, dépend de B010) : « Créer interface
  admin à métadonnées minimales » ; done_when : « contenus privés absents ».
- **B051** (anticipation) : « Créer accès support limité et expirant » ;
  done_when : « motif périmètre et audit obligatoires » (FR154, FR159, FR160,
  BR089, SCR063, SCR064).
- **Exigences de l'administrateur**
  - FR153 / AC153 : consulter les événements techniques de plateforme sans
    ouvrir les contenus privés (« métadonnées visibles sans contenu privé du
    chantier »).
  - FR155 / AC155 : « gérer statuts de comptes ; licences et paramètres
    globaux autorisés » (« changement validé et audité »).
  - FR156 / AC156 : suspendre un compte ou un chantier avec motif et
    **notification** (« nouvelles actions bloquées et notification créée »).
  - FR157 / AC157 : consulter les signalements et demandes de support
    (« liste minimisée »).
  - FR158 / AC158 : révoquer une session compromise.
- **Règles** : BR008 (sessions révocables, identifiées par appareil) ; BR088
  (métadonnées minimales, aucun accès par défaut aux contenus privés) ; BR090
  (suspension : nouvelles actions bloquées, preuves et audit préservés,
  recours support).
- **Décisions** : D019, D057 (aucun accès ordinaire ni contournement) ; D026
  (**PROPOSED**) : interface séparée ; D193 L2 (prix dans un réglage de
  plateforme modifiable sans code) ; D194 (administrateur sans adhésion,
  journal de plateforme ; A9 : ni nom ni adresse de chantier, ni identité des
  membres).
- **Écrans** : SCR060 tableau de bord plateforme (`/admin`, FR155, FR156) ;
  SCR061 comptes et organisations (`/admin/comptes`, FR155, FR158) ; SCR062
  licences (fait en B049) ; SCR063 et SCR064 (support, B051).
- **Existant** : `/admin/licences` (B049) ; `platform_settings` (prix de la
  licence) ; `platform_audit_events`. Aucun statut de compte ni de chantier
  « suspendu », aucune gestion de session, aucune notification (B045 non
  faite), aucune ligne PERMISSIONS pour l'administration des comptes.

## 2. Ce qui est établi

- Aucun contenu de chantier ni finance interne pour l'administrateur ;
  aucune adhésion ; minimum nécessaire à chaque action ; audit de chaque
  action et de chaque lecture sensible ; aucun chiffre inventé (R13).

## 3. Décisions attendues (A = recommandation)

- **E1. Périmètre de B050.**
  - **A** : lecture et réglages seulement : tableau de bord (§E2),
    chantiers et comptes en métadonnées (§E3, §E4), journal de plateforme
    (§E6), prix de la licence (§E7). Suspension (FR156) et révocation de
    session (FR158) reportées : elles exigent un statut bloquant contrôlé
    partout et une notification (B045).
  - **B** : A + suspension et révocation de session dès B050.
  - *Recommandation A* : « métadonnées minimales » est le cœur de B050 ; la
    suspension mérite sa propre tâche avec la notification.
- **E2. Tableau de bord plateforme** (aucun chiffre inventé).
  - **A** : seulement des comptes de lignes à sens établi : comptes créés,
    comptes vérifiés, chantiers par statut, licences par état, déclarations
    à vérifier, administrateurs ; aucun montant cumulé (pas de « chiffre
    d'affaires » : rien n'est encaissé par l'application).
  - **B** : A + somme des montants déclarés des licences activées.
  - *Recommandation A*.
- **E3. Chantiers vus par l'administrateur.**
  - **A** : identifiant court, statut, pays, état de la licence, date de
    création, nombre de membres actifs par rôle ; ni nom, ni adresse, ni
    description, ni identité des membres (A9).
  - **B** : en plus, la commune.
  - *Recommandation A*.
- **E4. Comptes : identifier sans exposer** (contradiction potentielle avec
  A9 « ni identité des membres »).
  - **A** : aucune liste nominative ; l'administrateur **recherche un compte
    par son identifiant exact** (e-mail ou téléphone fourni par la personne,
    par exemple via le support) ; la réponse donne seulement l'identifiant
    court du compte, la date de création, l'état vérifié/provisoire, le
    nombre d'adhésions actives et s'il est administrateur ; chaque recherche
    est auditée (identifiant cherché masqué dans le journal).
  - **B** : liste paginée des comptes avec e-mail ou téléphone masqués
    (a•••@…).
  - *Recommandation A* : pas d'annuaire ; A9 reste vrai pour toutes les
    listes.
- **E5. Organisations.**
  - **A** : nombre d'organisations, et pour une organisation trouvée depuis
    un compte : identifiant court, date, nombre de membres et de chantiers ;
    pas de nom.
  - **B** : avec le nom de l'organisation (nom commercial d'une entreprise).
  - *Recommandation B* : le nom d'entreprise n'est pas un contenu privé de
    chantier et aide le support ; à trancher.
- **E6. Journal de plateforme.**
  - **A** : l'administrateur lit `platform_audit_events` (action, date,
    acteur administrateur « vous / autre administrateur », identifiant court
    du chantier) ; jamais l'audit des chantiers (D186).
  - *Recommandation A*.
- **E7. Prix de la licence** (D193 L2).
  - **A** : l'administrateur modifie le prix et la mention « démonstration »
    depuis l'interface ; chaque modification est auditée avec ancienne et
    nouvelle valeur ; les déclarations déjà faites gardent leur prix figé.
  - **B** : modification par opération serveur seulement.
  - *Recommandation A*.
- **E8. Interface séparée** (D026 PROPOSED).
  - **A** : section `/admin` avec son propre menu (Tableau de bord,
    Licences, Chantiers, Comptes, Journal), jamais le menu des chantiers ;
    D026 validée sous cette forme.
  - **B** : application distincte.
  - *Recommandation A* au MVP.

## 4. Réalisation prévue après décision

- **M050** (accord requis) : fonctions d'administration en lecture
  (`admin_platform_stats`, `admin_list_projects`, `admin_find_account`,
  `admin_get_organization`, `admin_list_platform_audit`) et
  `admin_set_license_offer` ; toutes refusées à tout non-administrateur ;
  lectures sensibles auditées.
- **Test** : appel de chaque fonction d'administration ; chaque réponse
  parcourue à la recherche de tout contenu privé (journaux, photos,
  documents, dépenses, budget, reçus, commentaires, noms et adresses de
  chantiers, identités de membres hors décision) à partir de marqueurs
  semés ; contrôle démontré capable d'échouer (R15) ; refus pour tout
  non-administrateur ; audit.
- **Écrans** : `/admin` (SCR060), `/admin/chantiers`, `/admin/comptes`
  (SCR061), `/admin/journal` ; navigateur ordinateur et 390 px.
