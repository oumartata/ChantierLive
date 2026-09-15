# Projet de suivi de chantier à distance

Base compacte de continuité après les Phases 0 et 1.

ChantierLive est une seule PWA responsive. Les mentions mobile et ordinateur désignent deux affichages de la même application et de la même base de code.

## Fichiers

- `PROJECT_STATE.yaml` : source officielle de l'état du projet.
- `DECISIONS.yaml` : décisions validées et questions ouvertes.
- `REQUIREMENTS_SCOPE.yaml` : objectifs et périmètre du lot 2A.
- `GLOSSARY.csv` : vocabulaire métier.
- `ROLES.csv` : quatre rôles techniques du MVP.
- `PERMISSIONS.csv` : matrice d'autorisation initiale.
- `FUNCTIONAL_REQUIREMENTS.csv` : 160 exigences fonctionnelles du MVP.
- `BUSINESS_RULES.csv` : 90 règles métier.
- `NON_FUNCTIONAL_REQUIREMENTS.csv` : 40 exigences de qualité et sécurité.
- `ACCEPTANCE_CRITERIA.csv` : 160 critères Given/When/Then reliés aux FR.
- `USE_CASES.csv` : 30 cas d'utilisation reliés aux FR.
- `USER_JOURNEYS.yaml` : 7 parcours principaux.
- `STATE_MACHINES.yaml` : états et transitions des objets sensibles.
- `EDGE_CASES.csv` : 65 cas limites et réponses attendues.
- `FLOW_*.mmd` : parcours Mermaid invitation, synchronisation, finance et licence.
- `INFORMATION_ARCHITECTURE.yaml` : structure UX par rôle, sections et règles responsive.
- `SCREENS.csv` : inventaire des 64 écrans du MVP avec routes, accès et références.
- `NAVIGATION_RULES.csv` : gardes et redirections de navigation.
- `FLOW_NAVIGATION.mmd` : vue synthétique de la navigation métier.
- `WIREFRAMES.yaml` : 18 gabarits basse fidélité et parcours prototypés.
- `SCREEN_TEMPLATE_MAP.csv` : correspondance entre les 64 écrans et leurs gabarits.
- `UI_COMPONENTS.csv` : bibliothèque de 36 composants UX réutilisables.
- `UX_STATES.csv` : 28 états standard et réponses attendues.
- `CRITICAL_SCREEN_SPECS.yaml` : comportement détaillé des 25 écrans les plus risqués.
- `FORM_SCHEMAS.yaml` : champs, validations et règles de 15 formulaires clés.
- `UX_COPY.csv` : 90 textes d'interface en français simple.
- `CONTENT_RULES.yaml` : règles rédactionnelles, juridiques et d'accessibilité.
- `NAMING_SHORTLIST.csv` : candidats, exclusions et niveau de vérification des noms.
- `BRAND_DIRECTIONS.yaml` : direction visuelle de travail retenue pour ChantierLive.
- `DESIGN_TOKENS.csv` : couleurs, typographie, espacements et formes de l'interface.
- `BRAND_PREVIEW.svg` : aperçu visuel de l'identité de travail ChantierLive.
- `PRODUCT_EXTENSIONS.yaml` : cadrage de la planothèque et de la vitrine des entrepreneurs.
- `UI_KIT_SPEC.yaml` : apparence et comportement des composants haute fidélité.
- `COMPONENT_STYLE_MAP.csv` : correspondance compacte entre composants UX et styles.
- `RESPONSIVE_RULES.yaml` : adaptations mobile, tablette et ordinateur.
- `UI_KIT_PREVIEW.svg/.png` : planche visuelle des composants ChantierLive.
- `HIGH_FIDELITY_SCREENS.yaml` : inventaire et objectifs des 12 maquettes finales.
- `CHANTIERLIVE_MAQUETTES_4C.html` : source visuelle des écrans mobile et ordinateur.
- `CHANTIERLIVE_MAQUETTES_4C.pdf` : dossier consultable des 12 maquettes.
- `CHANTIERLIVE_PROTOTYPE_4D.html` : prototype cliquable responsive des parcours prioritaires.
- `PROTOTYPE_TEST_PLAN.yaml` : protocole et seuils des tests de compréhension.
- `USABILITY_TESTS.csv` : scénarios de test et résultats à renseigner.
- `TECH_ARCHITECTURE.yaml` : architecture technique générale proposée pour la PWA.
- `ARCHITECTURE_DECISIONS.csv` : choix, risques et mesures de réduction du lot 5A.
- `ARCHITECTURE_SOURCES.csv` : documentation officielle vérifiée pour les choix techniques.
- `ARCHITECTURE_OVERVIEW.mmd` : vue synthétique des composants techniques.
- `DATA_MODEL.yaml` : conventions, domaines, versionnement et transactions critiques du modèle 5B.
- `DATABASE_TABLES.csv` : dictionnaire compact des 43 tables prévues.
- `RLS_POLICY_MATRIX.csv` : règles de lecture, écriture et tests d'isolation par ressource.
- `RLS_HELPERS.yaml` : fonctions de sécurité serveur et identités de test requises.
- `ERD_CORE.mmd` : relations principales du modèle de données.
- `API_CONTRACTS.csv` : 63 contrats de lecture, commande, authentification et synchronisation.
- `SYNC_PROTOCOL.yaml` : enveloppe, file locale, idempotence, conflits, reprise et médias.
- `SERVER_OPERATIONS.csv` : 18 transactions serveur critiques et leurs garanties.
- `API_ERRORS.csv` : codes d'erreur stables et réponses attendues de la PWA.
- `SEQUENCE_SYNC.mmd` : séquence de synchronisation et conflit de révision.
- `SEQUENCE_INVITATION.mmd` : séquence d'invitation bidirectionnelle sécurisée.
- `IMPLEMENTATION_PLAN.yaml` : lots, conditions de démarrage et estimations en jours effectifs.
- `MVP_BACKLOG.csv` : 60 tâches de développement ordonnées avec dépendances.
- `MIGRATION_ORDER.csv` : ordre non destructif des 18 migrations Supabase.
- `DELIVERY_GATES.csv` : 11 preuves obligatoires avant passage au lot suivant.
- `IMPLEMENTATION_FLOW.mmd` : séquence générale de construction du MVP.
- `TEST_STRATEGY.yaml` : niveaux, environnements, appareils et blocages qualité.
- `TEST_CATALOG.csv` : 72 tests prévus, tous non exécutés à ce stade.
- `SECURITY_RELEASE_CHECKLIST.csv` : 40 contrôles de sécurité et conformité.
- `OPERATIONS_RUNBOOK.yaml` : incidents, sauvegardes, restauration et supervision.
- `PILOT_LAUNCH_PLAN.yaml` : Alpha, Bêta et mesures terrain.
- `LAUNCH_GATES.csv` : 25 conditions avant code, Alpha, Bêta et commercialisation.
- `RISK_REGISTER.csv` : 20 risques suivis avec déclencheurs et responsables.
- `QUALITY_FLOW.mmd` : séquence de validation jusqu'au lancement.
- `PROJECT_HANDOFF.yaml` : point d'entrée officiel pour reprendre le projet sans perte de contexte.

## Convention de permissions

- `A` : autorisé.
- `C` : conditionnel selon profil, délégation, état ou vérification.
- `N` : interdit.
- `B` : accès exceptionnel temporaire et audité.

## État

- Phase 2A validée.
- Phase 2B validée.
- Phase 2C validée.
- Phase 3A validée.
- Phase 3B validée.
- Phase 3C validée.
- Nom de travail retenu : ChantierLive, sous réserve des vérifications officielles.
- Phase 4A validée par le fondateur.
- Phase 4B validée par le fondateur.
- Phase 4C validée par le fondateur.
- Phase 4D validée par le fondateur.
- Phase 5A validée par le fondateur.
- Phase 5B validée par le fondateur.
- Phase 5C validée par le fondateur.
- Phase 6A validée par le fondateur.
- Phase 6B validée par le fondateur le 15 septembre 2026.
- Dossier de conception et préparation terminé à 100 %.
- Développement logiciel non commencé : 0 %.
- Projet mis en attente jusqu'à la fin de FuturePro et ArchivaPro.
- Reprise future : lire `PROJECT_HANDOFF.yaml`, puis commencer L00/B001 dans un dépôt séparé.
