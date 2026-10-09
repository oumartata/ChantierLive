# Proposition L06 — contradiction O12 (téléphone partagé)

Boucle 40, avant tout code (2026-10-09). Les décisions H1 à H14 de
PROPOSITION_L06_HORS_LIGNE.md, renommées O1 à O14, sont acceptées « dans ce
cadre qui prévaut », avec la consigne de s'arrêter si une recommandation le
contredit. Une recommandation le contredit.

## 1. La contradiction

- **O12 A** (recommandé, accepté) : « une base par compte ; à l'arrivée
  d'un autre compte, effacement de la base précédente **si sa file est
  vide, sinon conservée pour son seul titulaire** ».
- **Cadre de la boucle 40** :
  - « effacement à la déconnexion, **à la connexion d'un autre compte**,
    et au retrait d'un membre » ;
  - « une opération refusée est expliquée et conservée localement jusqu'à
    ce que la personne la retire ; **rien n'est perdu ni appliqué en
    silence** ».

Le cas qui pose problème : le compte A a des brouillons non envoyés sur le
téléphone, mais sa session s'est terminée **sans déconnexion volontaire**
(session expirée, navigateur fermé, téléphone prêté). O6 ne s'applique
donc pas, puisqu'il n'y a pas eu de choix « envoyer, exporter ou effacer ».
Le compte B se connecte ensuite sur le même téléphone. Deux voies :
- **effacer** les brouillons de A, comme le veut le cadre, mais A les perd
  sans le savoir, ce qui est contraire à « rien n'est perdu en silence » ;
- **les conserver**, comme le veut O12 A, mais il n'y a pas d'effacement à
  la connexion d'un autre compte.

## 2. Options

- **P1 (recommandée)** : effacement **explicite** à la connexion d'un autre
  compte.
  - Si le compte précédent n'a rien en attente : effacement immédiat et
    silencieux, puisque rien n'est perdu.
  - S'il a des brouillons non envoyés, B voit avant d'entrer : « Ce
    téléphone contient N brouillon(s) non envoyé(s) d'un autre compte.
    Vous ne pouvez pas les lire. Pour continuer avec votre compte, ils
    seront effacés définitivement. » B choisit entre :
    - « Effacer et continuer » ;
    - « Annuler », pour que A puisse se reconnecter et les envoyer ou les
      exporter.
  - Une trace locale minimale, sans aucun contenu, est gardée pour A :
    nombre de brouillons effacés et date. A la voit s'il se reconnecte sur
    ce téléphone.
- **P2** : O12 A tel quel. La base de A est conservée, fermée et
  illisible pour B. Il faut alors **retirer** du cadre « effacement à la
  connexion d'un autre compte » dans ce seul cas.
- **P3** : un seul compte par appareil (O12 B). Tant que la file de A
  n'est pas vide, aucun autre compte ne peut se connecter sur ce téléphone.

*Recommandation P1* : elle respecte l'effacement à la connexion d'un autre
compte, et la perte n'est jamais silencieuse. B décide en connaissance de
cause et A en est informé à son retour. Aucun contenu de A n'est jamais
lisible par B.

## 3. Interprétation à confirmer (sans contradiction bloquante)

**Retrait d'un membre.** Le cadre demande « effacement au retrait d'un
membre (dès la reconnexion) » et « une opération refusée est … conservée
localement jusqu'à ce que la personne la retire ». Lecture proposée :
- dès la reconnexion, toutes les **données du chantier** sont effacées
  (référence : nom, étapes, rôle) ;
- les **brouillons écrits par la personne elle-même** pour ce chantier ne
  sont pas effacés. Ils deviennent « refusés : accès retiré », sont
  expliqués, ne sont jamais envoyés, et restent jusqu'à ce qu'elle les
  retire ou les exporte (O7).

## 4. Ce qui reste prêt

Aucune autre recommandation ne contredit le cadre : O1 à O11, O13 et O14
s'y accordent. Dès que P1, P2 ou P3 est choisie et l'interprétation du §3
confirmée, la première tranche (B036 et B037) peut être réalisée telle
que prévue, **sans migration** :
- base locale par compte ;
- référence minimale ;
- file UUID avec une seule opération active par entité et ses
  dépendances ;
- effacements testés ;
- scanner du stockage local.

M054 reste prévue pour la tranche suivante (B038, application des lots
côté serveur).
