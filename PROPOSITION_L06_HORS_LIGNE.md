# Proposition L06 — hors ligne (B036 à B043)

Boucle 39 (2026-10-09). Document de décision, **sans code, sans migration,
sans base**. Il cite ce qui est déjà décidé, décrit l'existant, propose une
architecture, traite la **sécurité de l'appareil** et liste les décisions
H1 à H14 attendues du fondateur, avec un découpage en boucles.

Aucune règle écrite ne rend impossible la confidentialité sur l'appareil.
Une **limite technique** doit cependant être dite clairement : un navigateur
ne protège pas les données locales contre une personne qui utilise le
téléphone déverrouillé, avec la session ouverte. La protection repose donc
surtout sur trois leviers :
- garder **peu de données** sur l'appareil ;
- les **effacer** au bon moment ;
- ne **jamais** y stocker les finances internes d'autrui ni les documents.

Voir §5 et H5.

## 1. Tâches et done_when (MVP_BACKLOG, lot L06, P0)

| Tâche | Intitulé | Dépend de | done_when |
|---|---|---|---|
| B036 | Créer base IndexedDB locale | B021 ; B031 | « brouillons persistent après fermeture » |
| B037 | Créer file UUID et dépendances | B036 | « une opération active par entité » |
| B038 | Implémenter sync push idempotent | B037 | « retry ne duplique aucune donnée » |
| B039 | Implémenter pull par curseur serveur | B038 | « changements paginés sans horloge client » |
| B040 | Créer écran de file et états réseau | B037 | « attente erreur conflit visibles » |
| B041 | Créer résolution de conflits brouillons | B038 | « choix utilisateur enregistré » |
| B042 | Créer correction liée pour conflit financier | B035 ; B041 | « écrasement forcé impossible » |
| B043 | Gérer reprise des médias | B026 ; B037 | « upload reprend sans doublon » |

IMPLEMENTATION_PLAN : L06 « IndexedDB, file hors ligne, synchronisation et
conflits », de 14 à 22 jours. L09 en dépend, dont B054 (Android modeste et
faible réseau ; D201 y ajoute le test du vrai menu de partage).

## 2. Règles et décisions déjà prises

- **SYNC_PROTOCOL.yaml** (VALIDATED, contrat 1)
  - Créables hors ligne : `journal_draft`, `expense_draft`, `media_draft`,
    `receipt_draft`, `incident_draft`.
  - **En ligne seulement** : publication, approbation, refus, validation
    d'étape, transfert de rôle, retrait du principal, activation de
    licence, reconnaissance d'acompte.
  - Enveloppe d'opération : `operation_uuid`, `device_id`, `project_id`,
    `entity_type`, `entity_id`, `action`, `base_revision`,
    `client_created_at`, `payload`, `payload_hash`, dépendance éventuelle.
    L'acteur, le rôle et les permissions viennent du **jeton, jamais du
    contenu envoyé**.
  - File : IndexedDB, ordre FIFO par chantier et par entité, au plus 2
    entités en parallèle, **une seule opération active par entité**, lots
    de 25 au plus, médias séparés et repris fichier par fichier.
  - Résultats : APPLIED, DUPLICATE, CONFLICT, REJECTED, RETRY_LATER,
    BLOCKED_DEPENDENCY. Un doublon rend le résultat initial sans répéter
    l'effet.
  - Côté serveur : acteur pris dans le jeton ; contrôle de l'adhésion, du
    rôle, de la délégation et de la licence ; réservation de l'UUID ;
    comparaison de `base_revision` ; transaction ; audit ; curseur ; heure
    serveur seule. **Aucun last-write-wins financier.**
  - Réception : **séquence serveur monotone par chantier**, jamais l'heure
    du téléphone ; pagination `has_more` ; suppressions représentées
    (statut ou marqueur), jamais une disparition silencieuse.
  - Conflits : brouillons → KEEP_SERVER / CREATE_NEW_REVISION /
    DISCARD_LOCAL ; finances → KEEP_SERVER / CREATE_LINKED_CORRECTION /
    CANCEL_LOCAL. Interdits : FORCE_OVERWRITE_FINANCE, SILENT_MERGE,
    CLIENT_CLOCK_WINS.
  - Nouvelles tentatives : 2, 5, 15, 30 puis 60 s avec aléa, puis FAILED
    visible avec « Réessayer ». Erreurs définitives : FORBIDDEN,
    INVALID_STATE, LICENSE_READ_ONLY, IDENTITY_NOT_VERIFIED.
  - Médias : LOCAL_PENDING → … → FINALIZED, avec contrôles de type, de
    taille, d'empreinte SHA-256 et de chemin. La synchronisation en
    arrière-plan du service worker reste facultative.
- **TECH_ARCHITECTURE.yaml**
  - Synchronisation « local_first_limité » ; états visibles : hors ligne,
    en attente, envoi, synchronisé, conflit, erreur.
  - Médias : compression avant mise en file, quota local visible,
    suppression locale après confirmation.
- **Règles** : BR006 (actions sensibles en ligne avec identité vérifiée),
  **BR036** (seuls les brouillons de journal, média, dépense, reçu et
  incident sont créables hors ligne), BR037 (le brouillon appartient à son
  auteur), BR074 à BR078 (état visible et persistant, reprise idempotente,
  UUID créé avant le stockage local, révision serveur, avertissement avant
  effacement, « aucune promesse de conservation illimitée »).
- **Exigences** : FR125 à FR134 ; NFR005, NFR006, NFR033.
- **Décisions** : D008 et D050 (UUID, révision serveur, IndexedDB).
- **Cas limites**
  - EC015 : participant retiré avec des brouillons locaux.
  - EC017 : chantier archivé.
  - EC024 : publication après retrait.
  - EC034 : budget modifié pendant une dépense hors ligne.
  - EC044 : incident urgent hors ligne, « l'alerte n'est pas envoyée avant
    synchronisation ».
  - EC049 : fraîcheur des données en cache.
  - EC052 : stockage plein.
  - EC053 : stockage effacé par le navigateur.
  - EC054 : horloge fausse.
  - EC055 : deux appareils.
- **Tests prévus** : TST041 à TST050 (mode avion, fermeture et
  réouverture, retour du réseau, UUID rejoué, dépendances, accès retiré,
  conflit, conflit financier, approbation hors ligne, heure fausse) ;
  TST062 (mise à jour du service worker sans perte de la file).
- **Décisions métier qui dépendent du hors ligne**
  - **Journal** : brouillon serveur de son auteur seul (BR037, M036) ;
    publication en ligne seulement.
  - **Incidents** : **D161**, en ligne l'incident est créé directement
    OUVERT, sans brouillon serveur ; « le brouillon d'incident est reporté
    avec le hors-ligne ».
  - **Dépenses** : **D184 F9**, « hors connexion reporté avec le
    hors-ligne » ; D187 H1 (brouillon visible de son auteur seul) ; D188
    (reçus).
  - **Photos** : D100 / BR107 (brouillon visible de son auteur seul) ;
    compression côté client déjà testée.
  - **Notifications** : D199, créées à l'application de l'action sur le
    serveur, donc **à la synchronisation** ; un incident urgent hors ligne
    n'alerte personne avant (EC044).
  - **Licence** : en lecture seule, toute écriture est refusée
    (LICENSE_READ_ONLY, erreur définitive).

## 3. Ce qui existe déjà

- **`sync_operations`** (M005, T040) : enveloppe complète du contrat, UUID
  unique par (opération, chantier, acteur), dépendance au sein d'un même
  chantier et d'un même acteur, statut, révision, curseur et résultat
  canonique. Écriture réservée au serveur. **Aucune fonction ne l'utilise
  encore (0 ligne).**
- **Idempotence par UUID dans les envois de fichiers** :
  `private_object_uploads.operation_uuid` avec prepare → claim → attest →
  finalize. Rejouer le même UUID rend le même résultat ; `recover_*` et
  `get_upload_status` permettent la reprise ; la purge suit une rétention
  de 7 jours (D190).
- **Révisions serveur et refus de conflit** (`revision_conflict`) sur les
  brouillons de journal, les dépenses, les documents, les étapes, etc.
- **Compression des photos** côté client (test-photo-compression).
- **Service worker** (`public/sw.js`, v5) : coquille et ressources
  statiques seulement, **jamais** de route dynamique ni de donnée de
  session, page `/offline`. Aucune donnée de chantier n'est en cache
  aujourd'hui.
- **Manque** : base locale, file, application des lots côté serveur, flux
  de changements par curseur, écran de file, conflits, brouillon d'incident
  et de dépense hors ligne.

## 4. Architecture proposée

### 4.1 Sur l'appareil (IndexedDB, une base par compte)

Base `chantierlive-<profil>`, jamais partagée entre deux comptes. Magasins :
- `queue` : les opérations, avec UUID créé **avant** l'écriture locale
  (BR076), état, nombre de tentatives, dernière erreur et dépendance.
- `drafts` : brouillons locaux de l'auteur (journal, incident, dépense,
  reçu, photo), avec la `base_revision` connue.
- `blobs` : fichiers en attente (photos compressées, reçus), supprimés dès
  la confirmation FINALIZED.
- `reference` : le minimum pour créer un brouillon hors ligne. Il s'agit
  des chantiers où le compte est membre (identifiant, nom, rôle) et des
  étapes publiées (identifiant, libellé) pour les rattachements ; les
  catégories de dépense font partie de l'application. **Ni contenu
  publié, ni document, ni finance, ni identité d'autrui** (H1).
- `meta` : identifiant d'appareil (aléatoire, par installation), compte,
  curseurs par chantier, dernière synchronisation.

### 4.2 Actions hors ligne par rôle (BR036, droits actuels)

| Rôle | Créables hors ligne (brouillons) | Jamais hors ligne |
|---|---|---|
| Entreprise | journal, incident, photo, dépense, reçu | publier, décider, valider, devis, avenants, versements, budget, invitations |
| Chef de chantier | journal, incident, photo, dépense, reçu | idem |
| Propriétaire principal | incident | idem, plus toute décision |
| Copropriétaire | incident | idem |

La publication, la soumission, l'approbation ou la décision exigent
**toujours** la connexion (BR006, SYNC_PROTOCOL `online_only`).

### 4.3 Envoi (push, B037 et B038)

- File par chantier et par entité ; **une seule opération active par
  entité** ; une opération dépendante (photo d'un journal, reçu d'une
  dépense) attend son parent.
- Fonction serveur unique d'application d'un lot (25 au plus). Pour chaque
  opération :
  1. réservation de l'UUID dans `sync_operations` ;
  2. appel de la **fonction métier existante** (brouillon de journal,
     incident, brouillon de dépense…), qui garde tous ses contrôles ;
  3. mémorisation du résultat canonique.

  Un rejeu rend le même résultat (DUPLICATE) sans effet.
- Le serveur lit l'acteur dans le jeton et ignore le rôle ou l'acteur
  envoyés.

### 4.4 Réception (pull par curseur, B039)

- Table de changements alimentée côté serveur, avec une **séquence bigint
  monotone par chantier**, jamais l'heure du téléphone. Le client demande
  « depuis le curseur N », par pages, tant que `has_more` vaut vrai.
- Contenu limité à ce dont l'appareil a besoin (H1) : l'état de **ses**
  opérations et brouillons, les étapes publiées, le statut de son adhésion
  et de la licence. Une adhésion retirée ou un accès perdu y figure, ce
  qui déclenche l'effacement (§5).

### 4.5 Conflits (B041, B042)

- **Brouillon** (révision obsolète, deux appareils, EC055) : écran avec la
  valeur locale, la valeur serveur, qui a changé et quand (heure serveur).
  Choix : garder la version serveur, créer une nouvelle révision à partir
  de la locale, ou abandonner la locale. Le choix est enregistré.
- **Finance** (dépense, reçu ; budget modifié entre-temps, EC034) :
  - garder la version serveur ;
  - **créer une correction liée** (B035, contre-écriture motivée) ;
  - annuler la locale.

  **Aucun écrasement forcé** : l'option n'existe pas dans l'interface, et
  le serveur la refuse.
- Accès retiré ou licence en lecture seule : refus définitif. Le brouillon
  local devient « non envoyable » (H7).

### 4.6 Médias (B043)

Photo compressée et mise en file avec son UUID. Envoi par le flux existant
(prepare, claim, téléversement, attest, finalize) ; reprise par
`recover`/`get_upload_status` après coupure ; **même UUID, donc jamais de
doublon**. Le fichier local est effacé après FINALIZED.

## 5. Sécurité de l'appareil

- **Ce qui n'est jamais sur l'appareil** : les finances internes
  d'autrui ; le budget ; les documents (aucun, y compris « Entreprise
  seulement ») ; les journaux, incidents et photos publiés par d'autres ;
  les commentaires ; les identités, e-mails et téléphones ; les rapports
  PDF ; les jetons autres que la session.
- **Finances internes sur l'appareil** : seulement les **brouillons de
  dépense et de reçu de leur auteur** (entreprise, chef de chantier),
  jusqu'à leur envoi. Jamais sur un téléphone de propriétaire, puisque ce
  rôle ne peut pas les créer.
- **Téléphone partagé** : une base par compte. À la connexion d'un autre
  compte, la base du compte précédent est **fermée et illisible** depuis la
  session courante. Elle est effacée si sa file est vide, sinon conservée
  pour son seul titulaire (H12).
- **Déconnexion** :
  - file vide : base du compte **effacée** ;
  - file non vide : choix explicite (FR133, BR078) entre « Envoyer
    maintenant » (si en ligne), « Exporter mes brouillons » ou « Effacer
    définitivement ». On ne se déconnecte jamais en laissant une file sans
    avertissement (H6).
- **Retrait d'un membre ou droits changés pendant l'absence de réseau**
  - Le serveur refuse toute opération (REJECTED, accès retiré) : rien
    n'est appliqué (EC015, EC024, TST046).
  - Au premier contact, la réception signale l'adhésion retirée : les
    données de **référence** du chantier sont effacées aussitôt, et les
    brouillons non envoyés de la personne deviennent « non envoyables »
    (H7).
  - Si le rôle change (par exemple, le chef perd la création de dépense),
    l'opération est refusée par la fonction métier et suit le même
    traitement.
- **Téléphone perdu ou volé** : la protection repose sur le verrouillage
  du téléphone, la durée de la session et la minimisation des données. À
  prévoir : « déconnecter mes autres appareils » (révocation de session,
  FR158 reportée avant le pilote).
- **Chiffrement** (H5) : IndexedDB n'est pas chiffrée par l'application.
  Une clé WebCrypto conservée sur l'appareil ne protège pas contre
  quelqu'un qui utilise le téléphone déverrouillé. Un code personnel (PIN)
  dont on tire une clé protégerait réellement, au prix d'une saisie à
  chaque ouverture.
- **Durée de conservation** (H8) :
  - opération synchronisée : retirée de la file aussitôt ;
  - fichier : effacé après FINALIZED ;
  - brouillon non envoyé : conservé jusqu'à l'envoi ou à l'abandon, avec
    une alerte au-delà de 7 jours ;
  - référence : rafraîchie à chaque connexion.

  Aucune promesse de conservation illimitée (BR078) ; un stockage effacé
  par le navigateur est signalé (EC053).

## 6. Android modeste et faible réseau

- **Quota** : demander le stockage persistant
  (`navigator.storage.persist()`). Afficher l'espace utilisé et estimé
  (`navigator.storage.estimate()`). Plafond applicatif de **150 Mo ou 40
  photos en attente**. Au-delà : refus d'une nouvelle pièce jointe,
  conservation de la file, proposition d'envoyer (EC052).
- **Taille** : photos compressées avant la mise en file (existant), un
  fichier à la fois, lots JSON de 25 au plus, réponses paginées.
- **Batterie et données** : synchronisation à l'ouverture, au retour du
  réseau et à la demande. **Pas de tâche périodique.** La synchronisation
  en arrière-plan (Chrome Android) reste un bonus, jamais une condition
  (SYNC_PROTOCOL).
- **Réseau lent ou coupé** : temps limite par requête, reprise de l'envoi
  de fichier, tentatives 2, 5, 15, 30 puis 60 s avec aléa, état visible
  par opération (FR127).
- **iPhone (Safari)** : le stockage d'une application web peut être effacé
  après quelques jours sans utilisation. Il faut le signaler (EC053) et ne
  jamais présenter un brouillon local comme sauvegardé.
- **Mise à jour du service worker** sans toucher IndexedDB (TST062).

## 7. Décisions attendues (A = recommandation)

- **H1. Données gardées sur l'appareil.**
  - **A** : minimum, soit la file, ses propres brouillons et la référence
    (chantiers et étapes publiées). Aucune lecture hors ligne des contenus
    publiés.
  - **B** : A plus la lecture hors ligne des journaux et incidents publiés.
  - *Recommandation A* au MVP (la confidentialité d'abord).
- **H2. Actions hors ligne par rôle** : celles du tableau §4.2.
  - **A** : comme proposé.
  - *Recommandation A.*
- **H3. Incident hors ligne** (D161).
  - **A** : brouillon local ; à la synchronisation, l'incident est
    **créé OUVERT** (comme en ligne), avec son heure de survenue
    déclarative et l'heure serveur de création. Un incident urgent hors
    ligne affiche « alerte non envoyée tant que vous êtes hors ligne »
    (EC044).
  - **B** : brouillon serveur, à confirmer en ligne avant ouverture.
  - *Recommandation A.*
- **H4. Dépenses et reçus hors ligne** (F9).
  - **A** : brouillon local, synchronisé en **brouillon serveur** de son
    auteur ; la soumission reste en ligne.
  - **B** : pas de dépense hors ligne au MVP.
  - *Recommandation A.*
- **H5. Chiffrement local.**
  - **A** : pas de chiffrement applicatif annoncé ; protection par la
    minimisation, l'effacement et le verrouillage du téléphone, dits
    clairement à la personne.
  - **B** : clé WebCrypto non extractable (protection faible).
  - **C** : code personnel (PIN) pour ouvrir la file locale.
  - *Recommandation A* au MVP, C à rouvrir après le pilote si les
    téléphones sont souvent partagés.
- **H6. Déconnexion avec une file non vide.**
  - **A** : choix bloquant entre envoyer, exporter ou effacer
    définitivement.
  - *Recommandation A.*
- **H7. Brouillons d'un membre retiré ou devenus interdits.**
  - **A** : « non envoyables », avec export pour son auteur (texte et
    photos dans un fichier local) ou effacement ; jamais envoyés.
  - **B** : effacement immédiat sans export.
  - *Recommandation A* (EC015 « conserver local/export selon politique »).
- **H8. Conservation.**
  - **A** : comme §5 ; alerte à 7 jours, sans effacement automatique d'un
    brouillon non envoyé.
  - **B** : effacement automatique à 30 jours.
  - *Recommandation A.*
- **H9. Quota.**
  - **A** : stockage persistant demandé ; plafond de 150 Mo ou 40 photos.
  - *Recommandation A* (à mesurer en B054).
- **H10. Déclenchement de la synchronisation.**
  - **A** : à l'ouverture, au retour du réseau et à la demande ; pas de
    tâche périodique.
  - *Recommandation A.*
- **H11. Curseur de réception.**
  - **A** : nouvelle table de changements par chantier, avec une séquence
    bigint, alimentée par les fonctions serveur et limitée à H1.
  - **B** : réutiliser l'audit (identifiants UUID non ordonnés, lisible de
    l'entreprise seule : impossible tel quel).
  - *Recommandation A.*
- **H12. Téléphone partagé.**
  - **A** : une base par compte ; à l'arrivée d'un autre compte,
    effacement de la base précédente si sa file est vide, sinon conservée
    pour son seul titulaire.
  - **B** : un seul compte par appareil.
  - *Recommandation A.*
- **H13. Licence en lecture seule ou chantier archivé pendant l'absence
  de réseau** : refus définitif, brouillon « non envoyable » (comme H7).
  - *Recommandation A.*
- **H14. Notifications** : créées seulement à l'application sur le serveur
  (D199) ; jamais de notification locale qui laisserait croire qu'une
  alerte est partie.
  - *Recommandation A.*

## 8. Découpage en boucles et migrations probables

| Boucle | Tâches | Contenu | Migration probable |
|---|---|---|---|
| 40 | B036 | base locale par compte, référence, effacement (déconnexion, autre compte), quota et persistance | aucune |
| 41 | B037 + B038 | file UUID, dépendances, application idempotente des lots (journal, incident, dépense, reçu) | **M054** (application des lots par `sync_operations` ; brouillon d'incident hors ligne selon H3) |
| 42 | B039 | réception par curseur, effacement sur adhésion retirée | **M055** (table de changements et séquence par chantier) |
| 43 | B040 | écran de file, états réseau, export et effacement des brouillons | aucune |
| 44 | B041 | conflits de brouillons, choix enregistré | possible M056 (trace du choix) |
| 45 | B042 | correction liée pour conflit financier, écrasement impossible | aucune ou M056 |
| 46 | B043 | reprise des médias hors ligne sans doublon | aucune (flux existant) |

Tests : TST041 à TST050 et TST062, en mode avion réel dans le navigateur
de test et avec un réseau lent simulé. **Android modeste** et vrai partage
en B054.
