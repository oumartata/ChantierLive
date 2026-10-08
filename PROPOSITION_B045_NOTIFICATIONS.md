# Proposition B045 — notifications internes et e-mail

Boucle 36, étape 2 (2026-10-08). Aucun code B045, aucune migration. Le
cadre existe : notification interne minimisée, lue par son seul
destinataire, jamais d'e-mail vers une adresse non vérifiée. En revanche,
plusieurs règles manquent ou se contredisent :
- **quels événements** notifier ;
- **quel e-mail** sans service d'envoi ;
- **quelles échéances** sans planificateur ;
- **ce que voit un membre qui a perdu ses droits**.

Décisions N1 à N12 attendues du fondateur.

## 1. Sources citées

- **B045** (MVP_BACKLOG, L07, P0, dépend de B016 et B034) : « Créer
  notifications internes et e-mail ». done_when : « aucun e-mail non
  vérifié ».
- **Exigences**
  - FR119 / AC119 : notification interne pour les « événements
    configurés », **unique** par événement réussi.
  - FR120 / AC120 : marquer lu, ouvrir l'objet « autorisé ».
  - FR121 : configurer les notifications non critiques (SHOULD).
  - FR122 : e-mail seulement vers un e-mail vérifié.
  - FR124 / AC124 : « aucun secret ni détail financier inutile ».
  - FR100 / AC100 : demandes et décisions notifiées aux parties
    concernées.
  - AC093 / AC094 : décision figée et notifiée.
  - FR104 / **AC104** : affectation d'un incident « enregistrée et
    notifiée ».
  - FR106 : incident urgent, alerte aux « rôles concernés ».
  - FR144 / AC144 : notifier avant l'expiration de la licence.
  - FR156 / AC156 : suspension notifiée (reportée, D195 E1).
  - FR160 / AC160 : accès support notifié (D197 S9 : avec B045).
- **Règles**
  - BR061 : événements critiques → notification interne ; canaux
    externes selon préférences et vérification.
  - **BR062** : 4 gravités ; une urgence déclenche une alerte, pas un
    service de secours.
  - BR071 : une préférence ne peut pas désactiver une alerte de sécurité
    obligatoire ; aucun e-mail non vérifié.
  - BR073 : écran verrouillé et e-mail minimisent montants, adresses et
    détails sensibles.
  - BR084 : expiration de licence notifiée.
- **Décisions**
  - D034 (**PROPOSED**) : avertissements obligatoires pour preuves,
    acomptes, rapports, paiement de licence. Ce sont des avertissements
    d'écran, pas des notifications ; je la cite sans la trancher.
  - D183, D185, D187 : finances internes jamais vers le propriétaire.
  - D186 : audit.
  - D197 et **D198** : accès support et bandeau visible de tous les
    membres sans détail.
- **Modèle**
  - T036 `notifications` (« append-only + lecture ») ; T037
    `notification_preferences`.
  - R020 : « destinataire uniquement », marquer lu seulement.
- **Cas limites**
  - EC050 : ni e-mail vérifié ni push → la notification interne est
    conservée.
  - EC051 : lien vers un objet non autorisé → écran sûr, sans fuite.
- **Écran et canaux**
  - SCR012 `/notifications`.
  - Canaux prévus (TECH_ARCHITECTURE) : interne, e-mail vérifié,
    WhatsApp manuel.
- **Principes de la boucle**
  - rien ne révèle ce que le destinataire n'a pas le droit de voir, ni
    par le texte ni par l'existence de la notification ;
  - destinataires recalculés à l'envoi ;
  - ni secret ni donnée de paiement ;
  - aucun service payant sans décision.
- **Existant** : aucune table, aucun planificateur de tâches, aucun
  service d'envoi. Supabase local fournit un récepteur de courrier de
  développement (gratuit, local, jamais d'envoi réel).

## 2. Ce qui est établi

- La notification est créée **dans la même transaction** que l'action :
  si l'action échoue, aucune notification. Elle est unique par événement
  et par destinataire (AC119).
- Les destinataires sont calculés à cet instant d'après les droits réels
  (adhésion active, partie, visibilité). **Jamais l'auteur de l'action.**
- **Jamais** une dépense, un budget, un reçu, un document « Entreprise
  seulement » ou une finance interne vers un propriétaire ou un
  copropriétaire. Le chef de chantier n'est jamais destinataire du
  budget.
- Le texte est minimal : type d'événement, nom du chantier pour la
  notification interne, rôle de l'auteur (jamais son nom ni son
  identifiant). Aucun montant, aucune adresse, aucun motif libre, aucune
  référence de paiement.
- Seul le destinataire lit la notification et la marque lue. L'ouverture
  revérifie le droit sur l'objet ; sinon, écran sûr (EC051).
- Un non-membre et un ex-membre ne reçoivent rien de nouveau.

## 3. Événements candidats (destinataires selon les droits, texte, canal)

« Membres » = adhésion active au moment de l'envoi, auteur exclu.
Canal : **I** = interne ; **E** = e-mail si décision N1.

| Événement | Destinataires | Texte proposé | Canal |
|---|---|---|---|
| Journal publié | tous les membres | « Nouveau journal publié — {chantier} » | I |
| Incident signalé | tous les membres | « Incident signalé ({gravité}) — {chantier} » | I |
| Incident **urgent** (BR062) | tous les membres ; alerte obligatoire (N2) | « Incident URGENT signalé — {chantier} » | I + E |
| Incident affecté (AC104) | le responsable désigné | « Un incident vous est affecté — {chantier} » | I |
| Incident résolu ou clos | déclarant et responsable | « Incident {résolu/clos} — {chantier} » | I |
| Commentaire ajouté | voir N6 | « Nouveau commentaire sur un {journal/incident} — {chantier} » | I |
| Document publié | membres pour qui le document est lisible (TOUS, PRINCIPAUX, ENTREPRISE) | « Nouveau document — {chantier} » (sans titre) | I |
| Photo publiée | voir N7 | « Nouvelles photos — {chantier} » | I |
| Étape déclarée terminée | parties qui valident (propriétaire principal, copropriétaire selon les droits existants) | « Étape à valider — {chantier} » | I |
| Étape validée ou refusée | entreprise, chef de chantier | « Étape {validée/refusée} — {chantier} » | I |
| Devis ou avenant proposé | propriétaire principal, copropriétaire (lecteurs actuels) | « Devis/avenant à examiner — {chantier} » (sans montant) | I + E |
| Devis ou avenant décidé | entreprise | « Devis/avenant {accepté/refusé} — {chantier} » | I + E |
| Acompte déclaré | l'autre partie principale | « Versement déclaré à confirmer — {chantier} » (sans montant) | I + E |
| Acompte confirmé ou contesté | le déclarant | « Versement {confirmé/contesté} — {chantier} » | I |
| Dépense soumise | entreprise (qui décide) | « Dépense à examiner — {chantier} » | I |
| Dépense décidée | auteur (entreprise ou chef de chantier) | « Dépense {approuvée/refusée/contestée} — {chantier} » | I |
| Budget interne | aucun (l'entreprise est seule actrice) | — | — |
| Licence activée ou rejetée | le déclarant | « Licence {activée/déclaration rejetée} — {chantier} » | I + E |
| Licence bientôt expirée, en grâce, en lecture seule (N3) | tous les membres (LICENSE_VIEW) | « Licence : {état} — {chantier} » | I (+ E N2) |
| Accès support ouvert, arrêté, expiré | les deux parties principales (D197 S8) ; les autres membres voient seulement le bandeau (D198) | « Accès support {ouvert/arrêté/terminé} — {chantier} » | I + E |
| Demande d'aide prise en charge | la partie qui a demandé | « Votre demande d'aide est prise en charge — {chantier} » | I |
| Transfert de rôle demandé ou confirmé | les personnes concernées | « Transfert de rôle {à confirmer/confirmé} — {chantier} » | I + E |
| Retrait d'un participant | **personne** : la règle « l'ex-membre ne reçoit rien » s'applique (N10) | — | — |
| Admin : déclaration de licence, demande d'aide | administrateurs de plateforme (métadonnées : identifiant court) | « Déclaration de licence à vérifier » / « Nouvelle demande d'aide » | I |

## 4. Règles manquantes ou contradictoires

1. **E-mail** : le done_when exige un canal e-mail (« aucun e-mail non
   vérifié »), mais aucun service d'envoi ne peut être branché sans
   décision, et le « branchement d'un service d'envoi réel » est hors
   périmètre.
2. **Événements « configurés »** (FR119) : aucune liste n'existe (§3
   proposée), et rien ne dit quelles alertes sont « de sécurité
   obligatoires » (BR071).
3. **Échéances** (FR144 licence, fin d'accès support) : aucun
   planificateur, aucun seuil défini (combien de jours avant ?).
4. **Droits perdus après l'envoi** : rien ne dit si une notification déjà
   reçue reste visible après le retrait de l'adhésion. Or le principe
   « ex-membre ne reçoit rien » vise aussi l'existence de l'information.
5. **Préférences** (FR121, SHOULD) : portée non définie (par événement ?
   par canal ?).
6. **Commentaires** : destinataires non définis.
7. **Photos** : une notification par photo produirait une avalanche ;
   aucun regroupement n'est prévu.
8. **Incident urgent** : « rôles concernés » non définis (FR106).
9. **Texte et nom du chantier** : BR073 minimise l'écran verrouillé et
   l'e-mail, mais rien ne dit si le nom du chantier peut figurer dans un
   e-mail.
10. **Retrait d'un participant** : informer la personne retirée
    contredit « l'ex-membre ne reçoit rien ».
11. **Administrateur** : aucune règle sur ses notifications (il n'est
    membre d'aucun chantier).
12. **D198 (bandeau pour tous)** exige de modifier `support_active_access`,
    donc une migration ; elle sera intégrée à M052.

## 5. Décisions attendues (A = recommandation)

- **N1. E-mail.**
  - **A** : file d'envoi en base. Une ligne est créée seulement pour un
    e-mail **vérifié** au moment de l'envoi. Le texte est minimal et
    générique (N9). Rien n'est envoyé : statut « EN_ATTENTE ». Le service
    réel sera branché plus tard, sur décision, sans changer la règle.
    Les tests prouvent qu'aucune adresse non vérifiée n'entre jamais dans
    la file.
  - **B** : A, plus une remise au récepteur de courrier local de
    développement (Supabase local), jamais ailleurs.
  - **C** : e-mail retiré de B045 (nouvelle tâche).
  - *Recommandation A* : le done_when est prouvé sans service d'envoi
    branché.
- **N2. Alertes obligatoires** (non désactivables, BR071).
  - **A** : incident urgent ; accès support ouvert ou arrêté ; transfert
    de rôle ; licence passée en grâce ou en lecture seule. Tout le reste
    est désactivable.
  - **B** : A, plus les demandes de décision (devis, avenant, versement,
    étape).
  - *Recommandation A.*
- **N3. Échéances sans planificateur.**
  - **A** : notifications d'échéance **calculées à la lecture** : quand
    un membre ouvre l'application, une fonction crée au besoin, sans
    doublon (clé unique par licence, état et seuil), les notifications
    d'échéance dues. Seuils de licence : J-30, J-7, entrée en grâce,
    passage en lecture seule. Fin d'accès support : notifiée à la
    révocation ; l'expiration est notifiée à la lecture suivante.
  - **B** : planificateur en base (extension pg_cron).
  - *Recommandation A* : rien à exploiter en plus ; pg_cron plus tard si
    besoin.
- **N4. Droits perdus après l'envoi.**
  - **A** : la liste n'affiche que les notifications des chantiers où le
    destinataire est **encore** membre actif, et revérifie le droit sur
    l'objet (document, finance interne) à l'affichage. Une notification
    devenue illisible disparaît de la liste ; rien n'est supprimé.
  - **B** : tout reste visible, seul le lien est revérifié.
  - *Recommandation A* : un ex-membre ne voit plus rien du chantier.
- **N5. Préférences.**
  - **A** : au MVP, préférences **par canal e-mail seulement** (activé ou
    non, par grande famille : chantier, finances, décisions). Le canal
    interne reçoit tout. Les alertes obligatoires (N2) ignorent les
    préférences.
  - **B** : préférences par événement et par canal.
  - *Recommandation A.*
- **N6. Commentaires.**
  - **A** : l'auteur de l'élément commenté et les autres personnes ayant
    commenté le même élément, chacun revérifié.
  - **B** : tous les membres.
  - *Recommandation A.*
- **N7. Photos.**
  - **A** : une seule notification par auteur, par chantier et par jour
    (« Nouvelles photos »), mise à jour, non répétée.
  - **B** : aucune notification de photo au MVP.
  - *Recommandation A.*
- **N8. Incident urgent.**
  - **A** : tous les membres actifs (les incidents sont lisibles de
    tous). Alerte obligatoire.
  - *Recommandation A.*
- **N9. Texte.**
  - **A** : en interne, type d'événement, nom du chantier et rôle de
    l'auteur. Dans l'e-mail : **sans** nom de chantier ni contenu
    (« Nouvelle activité sur l'un de vos chantiers : {type} »), avec un
    lien vers l'application qui revérifie les droits.
  - **B** : nom du chantier aussi dans l'e-mail.
  - *Recommandation A* (BR073).
- **N10. Retrait d'un participant.**
  - **A** : aucune notification à la personne retirée (la règle
    « ex-membre ne reçoit rien » prévaut). Les parties principales sont
    informées.
  - **B** : un message unique et générique, sans nom de chantier.
  - *Recommandation A.*
- **N11. Administrateur.**
  - **A** : notifications internes pour une déclaration de licence et une
    demande d'aide, en métadonnées seulement (identifiant court), vers
    tous les administrateurs.
  - **B** : aucune (l'administrateur consulte ses listes).
  - *Recommandation A.*
- **N12. Bandeau D198 dans M052** : `support_active_access` est ouverte à
  tout membre actif. Les parties principales gardent la réponse complète ;
  les autres membres reçoivent seulement « accès en cours jusqu'à HH:MM »,
  sans module ni dossier. Le test et la vérification navigateur couvrent
  le copropriétaire et le chef de chantier (bandeau oui, journal non).

## 6. Réalisation prévue après décision

- **M052** (accord requis) :
  - tables `notifications` (insertion seule, plus lecture),
    `notification_preferences`, `email_outbox` ;
  - fonction interne `notify(...)` appelée dans les transactions des
    événements retenus (fonctions existantes recréées à partir de leur
    dernière définition) ;
  - lecture filtrée (N4), marquer lu, tout marquer lu, échéances
    calculées (N3) ;
  - `support_active_access` élargie (N12).
- **Tests**
  - destinataires par événement et par rôle ;
  - auteur jamais destinataire ;
  - ex-membre et non-membre : rien ;
  - jamais de finance interne ni de document « Entreprise seulement »
    vers un propriétaire ;
  - file d'e-mail limitée aux adresses vérifiées ;
  - scanner de confidentialité étendu aux notifications et à la file
    d'e-mail, avec un contrôle positif capable d'échouer (R15).
- **Écrans** : `/notifications` (SCR012) avec compteur de non-lues dans la
  navigation, préférences, bandeau pour tous (D198). Vérification
  navigateur sur ordinateur et à 390 px pour les 4 rôles.
