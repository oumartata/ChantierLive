# Suivi — Moteur de plans 2D (prototype T0, `src/app/prototype-plans/`)

Ce fichier complète `MVP_BACKLOG.csv` (suivi officiel global, 68 tâches) —
il ne le remplace ni ne le concurrence. Le moteur de plans 2D est un
prototype exploratoire, antérieur à son entrée éventuelle dans ce backlog
("catalogue modifiable seulement après stabilisation du moteur 2D", règle
constante de ce chantier) : ses jalons propres sont suivis ici, le
compteur global reste exclusivement celui de `MVP_BACKLOG.csv`.

**Convention de clôture de boucle** (demandée explicitement, à reconduire
à chaque bilan futur) — terminer chaque compte rendu de lot par une ligne :
`compteur global / jalons moteur / cycles effectués / résultat utilisateur / limite principale / commit`.

**Suite (après la clôture des 7/7 jalons)** : la préparation de
l'intégration métier (parcours chantier → demande → génération → édition →
dépôt → validation → publication, réutilisation de l'existant, schéma
minimal proposé, découpage en lots) est documentée séparément dans
[`PREPARATION_INTEGRATION_METIER.md`](./PREPARATION_INTEGRATION_METIER.md)
— ce fichier-ci reste centré sur le moteur 2D lui-même, pas sur son
intégration applicative.

---

## 1. ChantierLive — compteur global

**29/69 tâches, 40 restantes, 42 %.**

Source : `MVP_BACKLOG.csv` (69 lignes de tâches, critère `done_when` par
tâche). Ce compteur n'est incrémenté QUE lorsqu'une tâche de ce fichier
est réellement terminée selon son propre critère — jamais pour un commit,
un test, ou un lot du moteur 2D ci-dessous. Valeur inchangée par ce
document et par tous les lots plans-generator jusqu'à `B069` inclus :
« Créer et gérer des demandes de plan avec variantes versionnées avant
dépôt » (autorisée comme terminée par le fondateur le 2026-10-03, preuves
dans `PREPARATION_INTEGRATION_METIER.md`) — la PREMIÈRE tâche B0xx qui
recoupe le travail de ce fichier (l'intégration métier du générateur 2D,
pas le moteur lui-même, qui reste 7/7 et hors de ce compteur).

---

## 2. Moteur 2D — jalons de livraison

Liste finie, établie depuis le périmètre déjà convenu au fil des lots
(aucune fonctionnalité ajoutée ici). **7/7 jalons terminés.** Un jalon
partiel ne compte jamais comme terminé.

**Correction de portée (M7, lots précédents)** : un lot antérieur avait
marqué M7 "Terminé" sur la seule preuve de deux familles (double-chargé,
corridor partagé) — remis à "Partiel" une fois la portée réelle de
« CHAQUE famille » vérifiée ; un lot suivant a étendu guidée et circulation
en L aux 4 façades (4/5 familles à 4/4), laissant empaquetage libre bloqué
sur l'accès avant comme seule limite restante, précisément identifiée et
documentée (jamais masquée).

**Ce lot** : corrige cette dernière limite. Diagnostic confirmé avant toute
modification (6 terrains signalés, reproduits avec leurs paramètres
exacts) : `backtrackPackNeedsIntoFreeSpace` pose, pour TOUTE rangée et
indépendamment de l'accès demandé, ses pièces près du bord de plus petit Y
et son propre segment de circulation près du bord de plus grand Y — une
convention interne qui correspond nativement à un accès "back". Pour
"front", la rangée masque alors exactement l'emprise en x de sa propre
circulation : aucune position d'entrée sur le mur haut ne peut la
rejoindre en ligne droite (prouvé géométriquement, pas seulement supposé —
une recherche élargie de positions candidates dans les espaces entre
pièces a été explicitement testée et ne change rien, confirmant un biais
structurel plutôt qu'une lacune de couverture). Corrigé en réutilisant le
même principe miroir déjà appliqué ailleurs dans ce fichier
(`buildSharedCorridorLayoutStraight`, `buildGuidedLayoutStraight`) :
pour `accessSide === "front"` uniquement, la composition retenue par le
remplissage natif est reflétée autour du centre vertical de l'emprise
AVANT la recherche de porte d'accès — aucune règle spéciale aux 6 terrains,
aucun changement de programme/dimensions/reculs, aucun contrôle relâché
(`connectGroupsToNetwork` et la validation des fenêtres s'appliquent sans
changement sur la géométrie reflétée). Voir le journal pour le détail du
diagnostic et de la vérification.

**Matrice famille × façade (génération)** — mise à jour ce lot :

| Famille | Avant | Arrière | Gauche | Droite | Limite restante |
|---|---|---|---|---|---|
| Double-chargé | ✅ | ✅ | ✅ | ✅ | Aucune (déjà 4/4, lots antérieurs) |
| Corridor partagé | ✅ | ✅ | ✅ | ✅ | Aucune en génération (régénération dédiée aussi 4/4, voir M3) |
| Guidée (salon central / cour) | ✅ | ✅ | ✅ | ✅ | Aucune en génération ; **régénération non dédiée reste une limite ouverte** (recherche générale uniquement, non testée spécifiquement — non traitée ce lot, hors périmètre explicite) |
| Circulation en L | ✅ | ✅ | ✅ (natif) | ✅ | Aucune en génération (défaut colonne droite/bord réel corrigé, lot précédent) ; **régénération non dédiée reste une limite ouverte** (idem, non traitée ce lot) |
| Empaquetage libre | ✅ **(corrigé ce lot)** | ✅ | ✅ | ✅ | Aucune en génération, sur les 6 terrains signalés (reflet en Y pour l'accès avant, voir journal). Gauche/droite non admissibles sur 2 des 6 terrains signalés (15×20, 16×18) — **préexistant, symétrique (gauche et droite échouent identiquement), jamais introduit par ce lot** : limite de couverture de la recherche par retour-arrière pour ce programme précis, pas un biais directionnel. |

**M7 est désormais clôturé selon son critère existant** : les 5 familles
listées en M1 raccordent réellement leur entrée sur les 4 façades
physiques, EN GÉNÉRATION — le seul périmètre couvert par ce jalon. La
régénération dédiée (guidée, en L) reste une limite ouverte, distincte de
M7, documentée ci-dessus et jamais présentée comme résolue.

| # | Jalon | Statut | Critère de clôture | Preuve disponible |
|---|---|---|---|---|
| M1 | Génération initiale multi-familles (double-chargé, salon central/cour, circulation en L, empaquetage libre, corridor partagé) | **Terminé** | `generateVariants` produit ≥1 disposition admissible (0 erreur `independentVerify`) pour chaque cas "connu" de la batterie fixe | Batterie 11 cas (`scripts/test-plans-battery.mjs`) + 602 tests `scripts/test-plans-geometry.mjs` |
| M2 | Vérification géométrique indépendante (chevauchement, accessibilité réelle, ouvertures réellement extérieures) | **Terminé** | `independentVerify`/`computeReachableRooms` recalculent depuis la géométrie brute, jamais depuis un champ enregistré | Sections dédiées de `test-plans-geometry.mjs` (ex. recalcul d'union indépendant des surfaces) |
| M3 | Verrouillage + régénération partielle (préserve exactement position/dimensions/portes/fenêtres verrouillées) | **Terminé** | `regenerateUnlocked` ne modifie jamais une pièce verrouillée NI une pièce non verrouillée sous sa dimension cible (un placement qui l'exigerait est rejeté, jamais proposé réduit) ; propose ≥1 disposition nouvelle quand une existe géométriquement | Fixtures `plans-c8-resolu`/`plans-c2-resolu`/`plans-scenario*-post-regen`, scénario C9 salon verrouillé, accès avant/arrière/gauche/droite (sections 20/22, `scripts/test-plans-geometry.mjs`) — stratégie dédiée corridor partagé désormais réutilisée sur les 4 façades, voir journal |
| M4 | Export/réimport du fichier de projet (.json), round-trip fidèle | **Terminé** | `validateProjectFile` accepte le fichier exporté ; réimport reproduit la disposition exacte (dimensions, verrou, bilan de surfaces) | Fixtures `scripts/fixtures/plans-*.projet.json` ; section 21 (`serializeProject`→écriture→`validateProjectFile`, round-trip vérifié y compris le bilan de surfaces) ; vérifié en navigateur pour avant/arrière/gauche/droite (guidée, corridor partagé) |
| M5 | Exports visuels SVG/PNG lisibles (légendes, cotes, aucune troncature) | **Terminé** | Inspection visuelle directe du SVG/PNG réellement exporté, aucun chevauchement ni texte coupé | Exports `c2_resolu`/`c9_regenere`/`acces_droite`/`acces_arriere_*`/`guidee_arriere_*`/`acces_gauche_*` (SVG+PNG/JSON+fichiers de projet réels) envoyés et inspectés |
| M6 | Batterie fixe de cas représentatifs, catégorisés et mesurés en continu | **Terminé** | 11 cas couvrant proportions de terrain, programmes 2–3 chambres, 4 façades d'accès, dont un cas volontairement incompatible et un hors périmètre ; chaque cas catégorisé (connu/inconnu/incompatible démontré/hors périmètre), jamais un pass/fail | `scripts/test-plans-battery.mjs`, rejoué à chaque lot, tous les nombres inchangés |
| M7 | Les 4 façades d'accès réellement raccordées, pour CHAQUE famille de disposition, EN GÉNÉRATION | **Terminé** | Entrée réellement raccordée (pas seulement déplacée) sur avant/arrière/gauche/droite, pour TOUTES les familles listées en M1 | Voir la matrice famille × façade ci-dessus : 5/5 familles à 4/4 en génération ; empaquetage libre accès avant corrigé ce lot (diagnostic + reflet en Y, 755 tests `scripts/test-plans-geometry.mjs` dont section 25 dédiée) |

**Note de portée (ne modifie aucune règle de ce chantier, consignée pour
validation explicite du fondateur)** : la règle constante "catalogue
modifiable seulement après stabilisation du moteur 2D" (section 1
ci-dessus) fait référence à CE jalon M7 comme dernier jalon de génération
du moteur 2D. Les 7/7 jalons sont désormais terminés selon leurs critères
respectifs — ce document ne décide PAS que le catalogue est débloqué,
cette décision reste exclusivement celle du fondateur.

### Clôture du prototype 2D — périmètre exact et limites

Les 7 jalons moteur (M1 à M7) sont terminés selon leurs critères propres
(section ci-dessus). Ceci clôture le **prototype géométrique 2D isolé**
(`src/app/prototype-plans/`) tel que ce document le suit — PAS l'ensemble
de ChantierLive, dont le compteur global (section 1) est à 29/69 tâches
(42 %, `B069` inclus depuis le 2026-10-03) — la clôture du prototype ne le
modifie pas davantage ; voir `PREPARATION_INTEGRATION_METIER.md` pour
l'intégration métier distincte (Lots 1/2/3, 3/3).

**Ce qui est couvert, avec preuve** :
- 5 familles de génération (double-chargé, corridor partagé, guidée
  salon central/cour, circulation en L, empaquetage libre), chacune
  raccordant réellement son entrée sur les 4 façades physiques
  (avant/arrière/gauche/droite), vérifié par 755 tests
  (`scripts/test-plans-geometry.mjs`) et une batterie fixe de 11 cas
  catégorisés (`scripts/test-plans-battery.mjs`).
- Vérification géométrique indépendante (chevauchements, accessibilité
  réelle, ouvertures réellement extérieures, accès véhicule) recalculée
  depuis la géométrie brute, jamais depuis un champ enregistré.
- Verrouillage + régénération partielle fonctionnels pour TOUTES les
  familles via la recherche générale ; stratégie dédiée (réutilise la
  géométrie native) pour corridor partagé sur les 4 façades spécifiquement.
- Export/réimport du fichier de projet (.json) fidèle, exports visuels
  SVG/PNG lisibles, vérifiés en navigateur à plusieurs reprises depuis un
  serveur confirmé lancé sur E:.

**Limites explicitement hors de ce périmètre, non résolues par cette
clôture** (jamais présentées comme résolues) :
- **Régénération dédiée non étendue à guidée (salon central/cour) ni à
  circulation en L** : ces deux familles utilisent la recherche générale
  de `regenerateUnlocked`, jamais testée spécifiquement pour elles ;
  seule la famille corridor partagé a une stratégie dédiée vérifiée sur
  les 4 façades (M3).
- **Empaquetage libre, accès gauche/droite** : 2 des 6 terrains signalés
  pour l'accès avant (15×20, 16×18) restent sans disposition admissible
  pour gauche ET droite identiquement — préexistant, symétrique, jamais
  un biais directionnel comme celui corrigé ce lot pour l'avant ; limite
  de couverture de la recherche par retour-arrière pour ce programme
  précis, consignée ici, jamais masquée.
- **3D, R+1, catalogue de matériaux/coûts** : différés, hors périmètre de
  ce prototype par construction (règle constante de ce chantier).
- Les préréglages de pièces (dimensions cibles/minimales) restent des
  hypothèses de conception modifiables par l'utilisateur, jamais des
  normes réglementaires certifiées (rappelé explicitement dans l'interface
  elle-même).

### Diagnostic d'usage — protocole (préparé le 2026-10-04)

Problème rapporté par le fondateur : **les modifications sont difficiles et
le comportement est perçu comme instable.** Le diagnostic n'attend pas de
vidéo : il rejoue lui-même le parcours suivant, en navigateur, sur un
projet généré.

Parcours : générer → sélectionner une pièce → saisir ses dimensions →
déplacer une ouverture (si l'outil le permet) → verrouiller → régénérer →
annuler / rétablir → sauvegarder → recharger.

Chaque constat est classé dans une seule catégorie :

| Catégorie | Définition | Preuve exigée |
|---|---|---|
| Défaut reproduit | Comportement contraire à ce que l'interface annonce, reproduit au moins deux fois | Étapes exactes, état avant/après, capture ou état exporté |
| Commande difficile à comprendre | La fonction existe et marche, mais l'utilisateur ne la trouve pas ou ne comprend pas son effet | Où elle se trouve, ce qui manque (libellé, retour, ordre) |
| Fonction absente | Le parcours demande une action que l'outil ne propose pas | Étape du parcours concernée, sans conception ni développement à ce stade |

Isolation, obligatoire :
- le brouillon du générateur vit dans le `localStorage` du navigateur
  (clé `chantierlive:prototype-plans:draft:v1`), par origine ;
- tout import de fixture (`scripts/fixtures/*.projet.json`, exports
  conservés dans `C:\Restauration-E`) se fait dans un espace de test isolé,
  par exemple une origine distincte (`http://127.0.0.1:3001`) ou un onglet
  dont on a vérifié au préalable qu'il n'a **aucun brouillon** ;
- jamais par-dessus un brouillon existant. L'import remplace le brouillon
  ouvert et son historique Annuler/Rétablir.

Rappel : le brouillon navigateur d'origine n'est pas récupéré à ce stade
(voir `PROJECT_STATE.yaml`, `restoration_2026_10_04`).

### Diagnostic d'usage — exécuté le 2026-10-04 (aucun code modifié)

**Conditions.** `next dev` lancé depuis `C:\Projets\ChantierLive` sur le
port 3001. Origine de test `http://localhost:3001`, vide avant le test
(aucune clé `localStorage`, aucun brouillon). Les origines du port 3000
n'ont pas été touchées. Cas : valeurs par défaut (terrain 15×20, accès
avant, 3 chambres, 1 salon, 1 cuisine, 2 sanitaires). Vue 1024×768, puis
390×844. Aucun import de fixture : l'import passe par le sélecteur de
fichier natif et une confirmation, que le navigateur de test ne pilote pas.
L'aller-retour export/import reste couvert par M4. Captures hors Git :
`exports/preuves/generateur-2026-10-04/`.

**Ce qui fonctionne (constaté) :**
- génération (variantes, vérification indépendante sans problème) ;
- ouverture de l'éditeur, avec brouillon enregistré à ce moment ;
- sélection d'une pièce au clic ;
- réduction de dimension acceptée et refus d'un chevauchement ;
- Annuler / Rétablir / Annuler, avec restauration exacte du plan et des
  anomalies ;
- verrouillage et déverrouillage ;
- fermeture des propositions sans modifier le brouillon ;
- rechargement puis « Reprendre ce brouillon » : plan identique au
  stockage, verrou conservé ;
- confirmations avant d'écraser un brouillon par une nouvelle génération
  ou un import (vérifiées dans le code, non cliquées).

#### Défauts reproduits

| # | Gestes exacts | Attendu | Obtenu |
|---|---|---|---|
| B1 — **corrigé** (voir « Correctif B1/B2 ») | Éditeur → « Redimensionner » → Chambre 1 → Largeur `3,50` → Tab (refusé : chevauche Chambre 2) → Profondeur `3,20` → Tab | Après le refus, le champ revient à la largeur réelle (3,03) | Le champ garde `3.50` ; la pièce reste à 3,03. Après la modification suivante, le message de refus disparaît et le champ affiche toujours 3,50 : **valeur affichée ≠ plan, sans signal**. Cause : `defaultValue` avec une clé `w-${selected}-${room.w}` inchangée en cas de refus (`PlanEditor.tsx:774-781`) |
| B2 — **corrigé** (voir « Correctif B1/B2 ») | Éditeur → « Redimensionner » → Chambre 1 → Profondeur `3,50` → `3,20` → Tab. Reproduit à l'identique sur Chambre 2 | Soit la pièce garde le mur qui porte sa porte vers la circulation, soit le geste est refusé ou signalé aussitôt | Acceptée. La pièce raccourcit du côté de sa porte et se détache de la circulation : « n'est reliée au dégagement par aucune ouverture réelle », « n'est pas réellement accessible depuis l'entrée ». Ces anomalies s'affichent seulement sous le tableau des surfaces, hors de vue. Le mur est alors « gris » : impossible d'y remettre une porte. Cause : saisie numérique toujours ancrée au coin haut-gauche (`PlanEditor.tsx:563-573`), et `resizeRoom` (`geometry.ts:2740`) ne contrôle pas la perte d'accès |
| B3 — *reclassé : limite de recherche* ; **analysé le 2026-10-05** (voir « B3 — diagnostic ») ; **Chambre 2 résolu le 2026-10-05** (voir « B3 — correctif en deux sous-lots ») ; **Salon 1 résolu le 2026-10-05** (voir « B3 — Salon 1 verrouillé ») | Cas par défaut → verrouiller Chambre 2 → « Proposer de nouvelles dispositions… » ; puis la même chose avec Salon 1 verrouillé | Au moins une disposition nouvelle | 2/2 : « aucune disposition NOUVELLE » (75 puis 50 explorations écartées, toutes « cette recherche bornée n'a pas trouvé de place »). Limite connue de la régénération générale, hors corridor partagé (§2), constatée ici sur le cas le plus courant. **Reclassement (2026-10-04)** : ce n'est pas un défaut de comportement reproduit, mais une limite de couverture de la recherche bornée ; sa cause n'est pas encore analysée |
| B4 — **corrigé** (voir « Correctif B4/B5 ») | Vue 390×844, page du générateur | Page à la largeur de l'écran | Mise en page élargie à 485 px par le tableau « Besoins (pièces) » (6 colonnes de champs `w-20`) : toute la page, plan compris, est dézoomée sur téléphone |
| B5 — **corrigé** (voir « Correctif B4/B5 ») | Éditeur à 100 % | Libellés lisibles | Libellés des deux sanitaires superposés (« SanitaireSanitaire 2 », cotes tronquées). L'export, lui, numérote les petites pièces |

#### Difficultés d'utilisation (la fonction existe)

| # | Constat |
|---|---|
| U1 | Les champs Largeur/Profondeur n'existent qu'en mode « Redimensionner ». En mode « Sélectionner », une pièce sélectionnée n'offre aucun moyen visible de saisir ses dimensions |
| U2 | Message de refus générique (« minimum, emprise ou chevauchement ») qui ne nomme ni la cause ni la pièce gênante (ici Chambre 2) |
| U3 | La régénération n'apparaît qu'après le verrouillage d'une pièce. Quand rien n'est trouvé, l'écran propose quand même « Choisir cette disposition » pour la disposition actuelle |
| U4 | Murs cliquables de l'outil porte signalés par de fins pointillés colorés, peu visibles à 100 %. Le mur portant la porte actuelle n'est pas cliquable |
| U5 | La page saute verticalement quand la barre d'outils change de hauteur (changement d'outil ou de sélection) |
| U6 | Après rechargement, le bandeau « Reprendre ce brouillon » est en haut de page alors que le navigateur rétablit le défilement plus bas : il peut passer inaperçu |
| U7 | Textes d'introduction obsolètes : « aucune persistance » (alors qu'il existe un brouillon local et un fichier de projet) et « le déplacement libre des pièces à la souris n'est pas encore proposé » (alors que l'outil « Déplacer » existe) |
| U8 | Variantes numérotées « 3, 4, 5 » sans 1 ni 2 (les numéros écartés sont masqués) |
| U9 | Annuler fait perdre la sélection en cours |

#### Fonctions absentes

| # | Constat |
|---|---|
| F1 | Aucun outil pour déplacer, ajouter ou supprimer une **fenêtre** : seules les portes sont éditables (aucune commande, confirmé dans `PlanEditor.tsx`) |
| F2 | Aucune régénération qui accepte de **redimensionner** les pièces non verrouillées autour d'un verrou. **Lien avec B3 réfuté pour le cas Chambre 2** (2026-10-05) : une disposition nouvelle existe sans redimensionnement (Variante 5). Non démontré pour le cas Salon 1. **Toujours absent** après le correctif B3, qui ne redimensionne rien |

#### Premier correctif proposé (non développé)

**Rendre fiable la saisie des dimensions d'une pièce (B2 + B1, et U2
pour ce geste)**, sans toucher au moteur de génération :
1. dans `handleResizeField`, garder fixe le mur qui porte la porte de la
   pièce vers la circulation, au lieu du seul coin haut-gauche ;
2. avant d'appliquer, refuser un redimensionnement qui ferait perdre à la
   pièce son accès réel (même vérification que celle déjà calculée pour
   les anomalies), avec un message qui nomme la cause ;
3. après un refus, remettre le champ à la valeur réellement appliquée.

Raison de la priorité : c'est le geste de base demandé (« saisir ses
dimensions ») et il produit aujourd'hui, en un seul Tab, un plan
silencieusement cassé ou un champ qui ment. Ce sont les deux symptômes
les plus proches de « instable ». Portée : `PlanEditor.tsx` (un
gestionnaire, deux champs) et un contrôle dans `geometry.ts`, réutilisant
la vérification existante. Tests : cas ajoutés à
`scripts/test-plans-geometry.mjs` (porte en bas → réduction de profondeur
→ porte toujours raccordée ; réduction qui couperait l'accès → refusée),
puis parcours navigateur B1/B2 rejoué. B4 (tableau mobile) est le
candidat suivant : correction de présentation isolée. B3/F2 relèvent du
moteur et demandent un lot dédié.

### Correctif B1/B2 — redimensionnement fiable (réalisé le 2026-10-04)

Autorisé par le fondateur le 2026-10-04. Point de départ : HEAD `8396683`,
arbre propre. Brouillon de test isolé : profil Playwright vierge sur
`http://localhost:3001`, aucune clé de stockage avant le test. Aucun
brouillon existant n'a été touché. Le navigateur intégré a été abandonné
pour ce parcours : panneau masqué de 279 px, captures expirées (« Screenshot
timed out after 5s: the page did not finish rendering in time ») et clics
décalés sous émulation.

**Règle appliquée** : une modification de dimensions est acceptée en
entier (une seule entrée Annuler/Rétablir), ou refusée sans toucher au plan
(aucune entrée d'historique), avec un motif persistant qui nomme la cause
et l'élément concerné.

**Fichiers touchés et raison :**
- `geometry.ts` : c'est le seul module qui connaît portes, chevauchements
  et vérification indépendante. Ajouts : `resizeRoomDimension` (choix du mur
  fixe), `checkRoomResize` (contrôle complet sur copie candidate),
  `newVerificationIssues`. `resizeRoom` est inchangée.
- `PlanEditor.tsx` : branchement des champs ET des poignées sur ces
  contrôles, avis persistants par champ, champ remonté sur la valeur réelle
  après un refus.
- `scripts/test-plans-geometry.mjs` : section 26, 24 tests.

**Comportement :**
- Le mur fixe est déduit des **coordonnées réelles** des portes qui
  desservent la pièce : ses portes, celles d'autres pièces qui y
  débouchent, l'entrée, la porte véhicule. Une porte compte sur un bord
  seulement si sa ligne coïncide avec ce bord et si toute sa largeur y tient.
- Portes sur les deux bords de l'axe modifié : refus « plutôt que de choisir
  arbitrairement ».
- Aucune porte sur l'axe : bord haut/gauche fixe d'abord, sinon le bord
  opposé. Le bord conservé est annoncé dans le message.
- Sur la copie candidate :
  - aucune porte (de la pièce ou véhicule) ne bouge ni ne rétrécit ;
  - une fenêtre peut suivre son propre mur, mais ne glisse pas le long de
    ce mur et ne rétrécit pas ;
  - aucune anomalie **nouvelle** sur l'ensemble du plan (accès depuis
    l'entrée, portes des autres pièces, fenêtres extérieures,
    chevauchements, emprise) ; les anomalies préexistantes ne bloquent pas.
- Les autres pièces ne sont jamais modifiées. Les pièces verrouillées sont
  inchangées, et une pièce verrouillée ne se redimensionne pas.

**Preuves :**

| Preuve | Résultat |
|---|---|
| `test-plans-geometry.mjs` | **779/779** (755 antérieurs + 24 nouveaux) |
| Reproduction de B2 | L'ancien ancrage coupe l'accès de Chambre 1 ; le nouveau refuse explicitement, état intact ; même refus par les poignées |
| Reproduction de B1 | Refus nommant « Chambre 2 », largeur réelle intacte ; ressaisir la valeur affichée ne compte pas comme un changement |
| Balayage : 4 façades × 7 pièces × 2 dimensions × 3 écarts = **168 essais au total** (42 par façade, le facteur 4 est inclus) | 32 acceptés, 136 refusés, 0 « inchangé » (32 + 136 = 168). Chaque acceptation conserve accès, portes et autres pièces, et applique la valeur exacte ; aucun refus ne modifie l'état reçu |
| Portes sur les 4 murs | Acceptations sur des pièces dont la porte est en haut, en bas, à gauche et à droite |
| Pièce verrouillée | Refusée pour elle-même ; inchangée quand une autre pièce est modifiée |
| Autre pièce affectée | Refus nommant « Cuisine 1 » |
| Fenêtre décalée le long du mur | Refusée ; par le champ, le bord opposé est essayé et annoncé, fenêtre intacte |
| Ancrage ambigu | Refus motivé |
| Aller-retour (modification puis modification inverse) | Géométrie identique |

**Navigateur** (captures dans
`exports/preuves/generateur-correctif-2026-10-04/`, hors Git) :
- Chambre 1, largeur `3.50` → Tab : avis « Largeur — refusé, plan inchangé :
  « Chambre 1 » chevaucherait « Chambre 2 » » ; champ revenu à 3,03 ;
  « Annuler » désactivé.
- Puis profondeur `3.20` → Tab : second avis (« Mur bas de « Chambre 1 »
  gardé fixe (la porte vers la circulation). Refusé, ce changement créerait
  une anomalie : … ») ; champs à 3,03 / 3,50 ; le premier avis reste
  affiché, y compris 3 s plus tard ; aucune anomalie dans le brouillon.
- Salon 1, largeur 4,38 → 4,08 : « appliqué, mur gauche conservé ». Un seul
  Annuler revient à 4,38 et désactive Annuler. Rétablir réapplique 4,08. Le
  brouillon stocké suit chaque étape.

**Limite mise en évidence, non traitée (hors périmètre)** : dans un plan en
rangées, une variation de profondeur d'une pièce de façade est presque
toujours refusée. Le vérificateur existant ne juge un mur extérieur que
s'il touche le **rectangle englobant** du bâti (`hasExteriorTouch`,
`openingLeadsOutside`). Une pièce en retrait, ou les voisines d'une pièce
agrandie, perdent alors leur « ouverture extérieure ». Le refus est
cohérent avec les contrôles existants, comme demandé, mais cette règle
prudente devient le principal frein à l'édition des dimensions. À analyser
dans un lot dédié ; aucune règle de vérification n'a été modifiée ici.
L'aperçu des poignées reste un contrôle rapide : un rectangle affiché comme
possible peut encore être refusé au relâchement, avec motif.

**Précision sur le balayage (2026-10-04, sans nouvelle exécution)** : les
boucles réellement exécutées par `scripts/test-plans-geometry.mjs` (section
26) sont `for side of [front, back, left, right]` → `rooms.forEach` (7
pièces) → `for field of [w, d]` → `for delta of [-0.3, +0.3, +0.6]`, soit
4 × 7 × 2 × 3 = **168 appels au total** (42 par façade). Résultat
consigné par l'exécution du commit `37de14f` : 32 acceptés + 136 refusés =
168, aucun « inchangé ».

### Correctif B4/B5 — éditeur sur mobile et libellés lisibles (réalisé le 2026-10-04)

Point de départ : HEAD `37de14f` (corrections B1/B2 et leurs contrôles
conservés, intacts). **Aucune géométrie modifiée** : seules la mise en page
et l'affichage changent.

**Mode de vérification** : Playwright (navigateur Chromium sans interface,
profil vierge, origine `http://localhost:3001`). Le navigateur intégré
n'était pas utilisable : panneau masqué, captures expirées. Les mesures
sont prises par script dans le DOM, le même script avant et après le
correctif, aux largeurs 1280, 390 et 375 px. Captures et scripts :
`exports/preuves/generateur-b4-b5-2026-10-04/` et
`exports/preuves/*.js`, hors Git.

**Fichiers touchés et raison :**
- `PrototypeClient.tsx` (B4) : le tableau « Besoins (pièces) » est placé
  dans un conteneur à défilement horizontal propre. Ce conteneur est une
  région nommée et focalisable, une indication « ↔ » s'affiche sous 640 px,
  et la colonne « Pièce » reste figée pendant le défilement. Aucune colonne
  masquée, aucune réduction générale.
- `PlanEditor.tsx` (B5) :
  - même critère de renvoi numéroté que l'export (`isSmallRoom` ou
    `!roomTextFits`, à l'échelle du dessin) ;
  - numéros **uniques** 1..n, et une légende cliquable sous le plan
    (nom, dimensions, surface ; un clic sélectionne la pièce) ;
  - la ligne « Sélection » affiche nom, dimensions et surface ;
  - textes, portes, fenêtres et poignées inchangés.
- `render.ts` : `roomTextFits` est seulement exportée, pour être
  réutilisée sans copie. Le rendu exporté reste identique.

**Mesures (le même script avant et après) :**

| Largeur | Avant : largeur de document | Après | Éléments hors écran après | Tableau après | Libellés après |
|---|---|---|---|---|---|
| 375 px | **485** | 360 (barre verticale de 15 px) | 0 | défile dans son conteneur (279 → 704 px), région nommée | 0 débordement, 0 chevauchement |
| 390 px | **485** | 375 | 0 | idem (293 → 704 px) | idem |
| 1280 px | 1265 | 1265 | 0 | 687 → 704 px, défilement local | idem |

Avant le correctif, à toutes les largeurs : « Sanitaire 1/2 » et leurs cotes
débordaient de la pièce et se chevauchaient. Après : légende « 1 — Cuisine
1 : 2,69 × 3,00 m (8,1 m²) », « 2 — Sanitaire 1 … », « 3 — Sanitaire 2 … ».
Plus petite hauteur de texte mesurée sur le plan : 10,7 px, identique avant
et après (aucune réduction).

**Contrôles fonctionnels (375, 390, 1280 px)**, tous réussis :
- clic sur « Sanitaire 1 » dans la légende : « Sélection : Sanitaire 1 —
  1,61 × 2,00 m (3,2 m²) », pastille surlignée, 4 poignées visibles ;
- sélection du Salon sur le plan, largeur 4,08 → 4,38 par le champ :
  « appliqué, mur gauche conservé », puis un Annuler ramène à 4,08 ;
- zoom « + » : la page ne s'élargit pas (le plan défile dans son cadre) ;
- `touch-action: none` conservé sur le plan, 7 tracés de portes et
  ouvertures présents ;
- brouillon (`layout`) **identique** avant et après chaque changement de
  largeur et en fin de parcours.

Non-régression : `npm run verify` (voir commit).

**Observation, non corrigée (hors périmètre)** : l'**export** SVG/PNG
numérote ses pastilles avec `r.number`. « Cuisine 1 » et « Sanitaire 1 »
y portent donc toutes deux le numéro « 1 ». L'éditeur utilise désormais
des numéros uniques. Les numéros de l'éditeur et de l'export peuvent donc
différer ; une harmonisation de l'export est à décider.

### Lot à préparer — preuve de façade extérieure (non développé)

**Constat** : `hasExteriorTouch` et `openingLeadsOutside` considèrent un mur
comme extérieur seulement s'il touche le **rectangle englobant** du bâti.
C'est la cause principale des refus de redimensionnement en façade (lot
`37de14f`) : une pièce en retrait, ou les voisines d'une pièce agrandie,
perdent leur « ouverture extérieure ».

**Objectif** : remplacer ce critère unique par une preuve géométrique, sans
le relâcher. Un mur n'est extérieur que si l'espace situé de l'autre côté
est démontré extérieur.

**Exigences du futur modèle :**
- classer l'espace qui borde chaque segment de mur en **extérieur**,
  **cour** ou **vide intérieur**, et jamais « extérieur » par défaut ;
- une zone vide ne devient pas extérieure du seul fait qu'elle n'est pas
  bâtie : il faut démontrer qu'elle communique avec l'extérieur de
  l'emprise (par exemple, une propagation depuis le bord de l'emprise sur
  la grille des rectangles bâtis), avec une largeur minimale à préciser ;
- un vide **enclos** (entouré de pièces ou de circulations) reste intérieur ;
  une cour reste une cour (règles existantes conservées) ;
- les fenêtres sont vérifiées segment par segment, sur leur propre portion
  de mur.

**Preuves attendues :**
- cas de référence où le résultat ne doit PAS changer (toutes les
  dispositions actuellement générées : 755+ tests et batterie de 11 cas
  inchangés) ;
- cas de retrait ouvert sur l'extérieur (accepté) ;
- cas de vide enclos (refusé) ;
- cas de cour ;
- rejeu du balayage de la section 26 pour mesurer l'effet sur les refus.

**Hors de ce lot** : aucune modification de la règle actuelle n'est faite
ici. Risque à suivre : un critère plus fin peut changer les dispositions
retenues par la génération, ce qui demande une comparaison avant/après
complète.

### Façades extérieures — diagnostic et preuve isolée (réalisé le 2026-10-04)

Point de départ : HEAD `e13e4b4`, arbre propre. B1/B2 et B4/B5 n'ont pas
été touchés. **Le vérificateur, la génération, la régénération, les
surfaces, les exports et le format de projet sont inchangés.** La preuve est
un module autonome, branché nulle part.

#### 1. Refus actuel reproduit, figé avant toute modification

- Fixture : `scripts/fixtures/plans-facade-retrait-refus.json`. Elle
  contient la disposition par défaut (15×20, accès avant, 3 chambres) telle
  que générée, l'entrée de génération, le geste et le motif observé.
- Geste : « Redimensionner » → Chambre 1 → profondeur 3,50 → 3,20.
- Motif : « Mur bas de « Chambre 1 » gardé fixe (la porte vers la
  circulation). Refusé, ce changement créerait une anomalie : « Chambre 1 »
  n'a aucune ouverture extérieure possible (pièce entièrement intérieure).
  (et 1 autre(s) anomalie(s) nouvelle(s)) ».
- Cause isolée par le test : les **seules** anomalies nouvelles sont
  « aucune ouverture extérieure possible » et « une fenêtre ne débouche plus
  sur un mur extérieur réel ». Les deux proviennent de `wallTouchesExterior`
  (le mur doit toucher le rectangle englobant élargi de `WALL_EXT`). Aucun
  accès, chevauchement ni porte n'est en cause.

#### 2. Ce que le modèle représente réellement

| Élément | Représentation | Utilisable pour une enveloppe ? |
|---|---|---|
| Pièces | Rectangles **intérieurs** (dimensions habitables) | Oui, comme masse bâtie |
| Corridor, raccords, circulations | Rectangles | Oui, comme masse bâtie (ils sont dans le contour actuel) |
| Murs | **Implicites** : constantes `WALL_EXT` = 0,20 m (autour du contour) et `WALL_INT` = 0,10 m (interstice entre éléments voisins) ; aucun objet mur | Seulement par déduction : épaissir la masse bâtie de `WALL_EXT` |
| Contour (`footprint`) | **Toujours** le rectangle englobant (limite assumée et commentée dans `Layout.footprint`) | Non : c'est justement la cause du refus |
| Cour | Rectangle explicite (`courtyard`) | Oui, comme classe distincte |
| Trajets extérieurs (`exteriorPaths`) | Rectangles reliant l'entrée ; **convention**, pas preuve d'air libre (commentaire du modèle) | Traités comme non bâtis, sans être une preuve |
| Espaces extérieurs (`exteriorSpaces`) | Bandes rectangulaires dérivées du seul rectangle englobant | Non : ils ignorent tout vide intérieur au rectangle |
| Résiduel non affecté (`surfaces.nonAffectee`) | Simple surface (nombre), pas de géométrie | Non |
| Reculs (terrain hors emprise) | Non bâtis par définition de l'emprise | Oui : air libre sur la parcelle |
| Au-delà du terrain, couverture d'un vide, hauteur | **Non représentés** | Non : incertitude à laisser explicite |

**Conclusion** : il n'existe pas d'enveloppe explicite. L'union des pièces
et des circulations n'en est **pas** une : elle contient les interstices de
cloison (0,10 m) et ne dit rien des murs extérieurs. Une enveloppe peut
toutefois être **déduite prudemment**, en épaississant chaque élément bâti
de `WALL_EXT`. Cet épaississement ferme tout interstice inférieur à 0,40 m.
L'exposition d'un vide se démontre ensuite par un chemin libre continu
jusqu'à la limite du terrain.

#### 3. Évolution minimale proposée et preuve isolée

Module `src/app/prototype-plans/exteriorExposure.ts`, non branché.
Paramètres fixés **avant** les cas, sans aucun ajustement ensuite :
- pas de grille de 0,05 m ;
- une cellule est bâtie dès qu'elle chevauche un élément épaissi (règle
  prudente) ;
- dégagement exigé devant l'ouverture = `MIN_WINDOW_WIDTH` (0,60 m),
  au-delà de l'épaisseur du mur ;
- contact direct = même distance que `wallAdjacency`.

Classes de résultat :
- **extérieur** : dégagement entièrement libre et relié à la limite du
  terrain ;
- **cour** : dégagement dans la cour identifiée ;
- **séparation** : autre pièce ou circulation à moins d'une cloison ;
- **obstruée** : élément bâti dans le dégagement ;
- **vide intérieur** : libre mais enclos ;
- **non classé** : sortie du terrain ou classes mêlées.

Un vide n'est **jamais** extérieur par défaut, et aucune incertitude n'est
convertie en acceptation.

La preuve porte sur la **portion de l'ouverture**, pas sur le mur entier.
Les extrémités d'un mur en retrait bordent l'épaisseur des pièces voisines ;
l'ouverture, elle, doit être dégagée sur toute sa largeur.

Script : `scripts/test-plans-exterior-exposure.mjs`, désormais dans
`npm test` : **17/17**.

| Cas | Attendu | Obtenu | Règle actuelle | Raison géométrique |
|---|---|---|---|---|
| Rectangle simple, fenêtre de Chambre 1 | extérieur | extérieur | extérieur | 360/360 cellules libres reliées au bord du terrain |
| **Retrait exposé** : fenêtre de Chambre 1 après 3,50 → 3,20 | extérieur | extérieur | **refusé** | retrait de 0,30 m ouvert vers le recul avant |
| Retrait, mur entier | obstruée | obstruée | refusé | extrémités contre l'épaisseur des voisines (la preuve vise l'ouverture) |
| **Bâtiment en L** (Chambre 3 retirée), portion centrale du mur droit de Chambre 2 | extérieur | extérieur | **refusé** | angle rentrant ouvert, 420/420 cellules |
| Cour identifiée (15×25, entrée par cour), mur haut de Chambre 1 | cour | cour | extérieur | contact direct avec le rectangle de cour |
| Vide intérieur fermé (anneau de 4 pièces) | vide intérieur | vide intérieur | refusé | aucun chemin libre jusqu'au bord |
| Même vide, ouvert d'un côté | extérieur | extérieur | refusé | communication avec l'extérieur sur 2,9 m |
| Mur mitoyen d'une pièce | séparation | séparation | refusé | interstice de cloison |
| Mur mitoyen de la circulation | séparation | séparation | refusé | idem |
| Pièce voisine à 0,50 m | obstruée | obstruée | refusé | dégagement < 0,20 + 0,60 m |
| Interstice de 0,10 m / 0,30 m | séparation | séparation | refusé | à moins d'une cloison |
| Interstice de 0,38 m | obstruée | obstruée | refusé | fermé par l'épaississement (720 cellules bâties) |
| Pièce contre la limite du terrain (recul nul) | non classé | non classé | **extérieur** | au-delà du terrain : non représenté |

Non-régression mesurée : **1400 fenêtres** générées sur 64 configurations
(4 façades × 4 terrains × 2 modes d'entrée × salon central oui/non) sont
toutes démontrées extérieures ou sur cour.

Coût mesuré : environ **13 ms** par grille (15×20, 120 000 cellules),
contre 0,12 ms pour `independentVerify`. La cause est le test de chaque
cellule contre chaque rectangle.

#### 4. Impact (analysé, rien n'est appliqué)

| Domaine | Effet si la preuve était branchée | Précaution |
|---|---|---|
| Redimensionnement | Le cas de la fixture deviendrait acceptable : sa fenêtre est démontrée exposée. La règle « pièce avec au moins une ouverture extérieure possible » (`hasExteriorTouch`) devrait devenir « au moins une portion de la taille d'une fenêtre démontrée exposée » | `checkRoomResize` inchangé : il lit le vérificateur |
| Fenêtres de pièces verrouillées | Aucune fenêtre n'est déplacée. La vérification seule change | La non-régression couvre les fenêtres générées |
| Génération | `chooseExteriorWindow` resterait sur la règle actuelle. La faire évoluer changerait le choix des murs et donc des dispositions | Hors du premier lot ; comparaison complète avant/après exigée |
| Régénération | Utilise vérificateur et `chooseExteriorWindow` : même remarque | Idem |
| Surfaces | `nonAffectee` et `exteriorSpaces` restent dérivés du rectangle englobant. Un retrait exposé reste compté comme « résiduel » | Inchangé dans le premier lot ; une reclassification est un lot à part |
| Exports | Mêmes messages et même dessin | Inchangé |
| Projets sauvegardés | Aucun champ stocké ne dépend de cette règle. Un projet relu n'est jamais réécrit. Deux écarts de verdict existent : (a) fenêtre sur **cour**, aujourd'hui « extérieure », (b) pièce **contre la limite du terrain**, aujourd'hui « extérieure », ici « non classée » | Ne jamais rendre plus sévère un projet existant : (a) et (b) gardent le verdict actuel |

#### 5. Recommandation

**Déductible sûrement du modèle actuel** :
- masse bâtie et murs implicites ;
- exposition d'une ouverture vers les reculs ou vers un vide relié au bord
  du terrain ;
- contact avec la cour identifiée ;
- vide enclos ;
- séparation et obstruction.

**Exige une information supplémentaire** :
- ce qui est au-delà de la limite du terrain (voisins, mitoyenneté) ;
- la couverture d'un vide (auvent, débord de toit) ;
- une exigence de dégagement réglementaire, qui n'est jamais une norme
  certifiée dans ce prototype ;
- une enveloppe explicite, si des bâtiments non rectangulaires deviennent
  générés.

**Lot d'implémentation minimal proposé** :
1. Dans `independentVerify` seulement : une fenêtre est valide si la règle
   actuelle l'accepte **OU** si la preuve la classe « extérieur » sur sa
   propre portion. Le contrôle « ouverture extérieure possible » de la
   pièce suit la même règle, avec une portion de la taille d'une fenêtre.
   C'est une union stricte : aucun cas accepté aujourd'hui ne devient
   refusé. Cour et limite du terrain gardent leur verdict actuel.
2. Inchangés : `chooseExteriorWindow` (génération, régénération), surfaces,
   `exteriorSpaces`, exports, format de projet.
3. Rasterisation par plages d'indices de chaque rectangle au lieu du test
   cellule par cellule ; une grille par vérification au plus.

**Critères de réussite** :
- 779 tests de géométrie et batterie de 11 cas inchangés ;
- les 17 cas de la preuve inchangés ;
- le geste de la fixture devient accepté, avec la porte toujours raccordée ;
- vide enclos, interstices, obstruction et limite du terrain restent
  refusés, ou gardent le verdict actuel ;
- balayage de la section 26 rejoué, avec le nombre de nouvelles
  acceptations justifiées une à une ;
- coût de la vérification inférieur ou égal à 5 ms sur 15×20, mesuré.

### Façades extérieures — branchement dans la vérification (réalisé le 2026-10-04/05)

Point de départ : HEAD `1148026`, arbre propre. Le diagnostic livré n'est
pas refait.

**Ce qui change**, dans `independentVerify` seulement, et pour deux
contrôles :
- « une fenêtre ne débouche plus sur un mur extérieur réel » ;
- « aucune ouverture extérieure possible ».

Chacun garde la règle historique (contact avec le rectangle englobant) et
accepte **en plus** une fenêtre dont la propre portion de mur est classée
« extérieur » par `exteriorExposure.ts` (`windowProvenExterior`). La preuve
n'ajoute que des acceptations ; elle ne court-circuite aucun autre contrôle
(chevauchement, emprise, portes, accès depuis l'entrée, battants, verrou,
contrôles de `checkRoomResize`).

Inchangés :
- `chooseExteriorWindow` ;
- les règles de génération et de régénération qui appellent directement
  `hasExteriorTouch` (lignes ≈ 3809, 4443, 5069) ;
- les surfaces, `exteriorSpaces`, les exports et le format de projet.

Aucun projet n'est réécrit.

**Cours et limite du terrain** : leur verdict **historique** est conservé
(la règle historique les accepte toujours). Ce n'est **pas** une preuve
d'exposition. La preuve classe une fenêtre sur cour « cour », et une pièce
contre la limite du terrain « non classé » ; ces classes ne sont jamais
comptées comme exposition prouvée.

**Fichiers touchés et raison :**
- `exteriorExposure.ts` :
  - constantes lues au moment de l'appel (import circulaire avec
    `geometry.ts`) ;
  - tracé par plages d'indices et cellules en octets (performance) ;
  - cache d'une grille par état géométrique (WeakMap : les dispositions
    sont immuables) ;
  - passage minimal (ouverture morphologique) ;
  - `windowProvenExterior`, qui exige que la baie repose réellement sur
    la ligne de son mur.
- `geometry.ts` : import et deux conditions du vérificateur.
- `scripts/test-plans-geometry.mjs` :
  - le test B2 encodait le refus historique et vérifie maintenant
    l'acceptation ;
  - le cas négatif « autre pièce » porte désormais sur une vraie
    obstruction ;
  - l'ancien montage « contour stocké raccourci » est remplacé par une
    vraie obstruction (élément bâti devant la fenêtre, contour recalculé),
    et documenté à part.
- `scripts/test-plans-exterior-exposure.mjs` : fixture rejouée, risques de
  grille, justification des acceptations.
- `scripts/snapshot-plans-verifier-effects.mjs` (nouveau) : instantané et
  comparaison avant/après de la génération, de la régénération et du
  redimensionnement.

#### Passage minimal annoncé (0,60 m) et bascule observée (1,20 m)

Les trois grandeurs sont distinctes. Chacune n'est comptée qu'**une fois**.

1. **Écartement brut g** entre les deux rectangles de pièces (bords
   intérieurs, sans mur).
2. **Largeur restante après épaississement des murs** : chaque élément bâti
   est épaissi de `WALL_EXT` = 0,20 m, une seule fois. Il reste donc
   g − 0,40 m. Aucun autre épaississement géométrique n'est appliqué.
3. **Effet de la grille** (pas de 0,05 m), en deux parties :
   - *marquage prudent* : une cellule qui touche un élément épaissi, même
     par un seul bord, est bâtie. On perd jusqu'à une cellule de chaque
     côté, selon la position des bords par rapport à la grille ;
   - *arrondi du passage* : le paramètre de 0,60 m devient P = ⌈0,30 / 0,05⌉
     = 6 cellules de dégagement de chaque côté. Une cellule n'est
     traversable qu'avec une course libre de 2P + 1 = **13 cellules
     (0,65 m)**.

Ce n'est pas un double comptage. Les murs sont retirés à l'étape 2 ;
l'étape 3 ne traite que la discrétisation de la largeur restante.

**Résultat du seul cas testé** (test 4c : fente droite entre deux
rectangles parallèles), mesuré en faisant varier l'alignement sur la
grille :

| Écartement brut g | Libre après murs | Résultat |
|---|---|---|
| < 1,055 m | < 0,655 m | toujours fermé |
| 1,055 à 1,105 m | 0,655 à 0,705 m | fermé **ou** ouvert selon l'alignement |
| ≥ 1,105 m | ≥ 0,705 m | toujours ouvert |

Le test (grille alignée) donne 1,10 m fermé et 1,20 m ouvert, ce qui est
cohérent avec ce tableau. Ces seuils **ne se généralisent pas** à toutes
les géométries : un passage oblique, coudé ou au bord d'une cour peut avoir
un autre seuil. L'incertitude d'alignement, de l'ordre d'une cellule, reste
explicite.

L'exigence effective est donc plus stricte que le paramètre annoncé. C'est
voulu, par prudence. Retrouver exactement 0,60 m serait un relâchement à
décider explicitement ; je ne l'ai pas fait.

**Hypothèses retenues** :
- murs implicites d'épaisseur constante (`WALL_EXT` = 0,20 m) ;
- grille de 0,05 m ;
- dégagement devant la baie de 0,60 m (`MIN_WINDOW_WIDTH`) ;
- reculs non bâtis ;
- rien n'est supposé au-delà de la limite du terrain ;
- trajets extérieurs non bâtis (convention du modèle) ;
- aucune couverture de vide représentée.

#### Résultats

| Contrôle | Résultat |
|---|---|
| Fixture (Chambre 1, 3,50 → 3,20 m) | **Acceptée**, avec le message « mur bas conservé (la porte vers la circulation) ». Valeur exacte appliquée ; porte intacte et raccordée ; fenêtre conservée (même mur, même position le long du mur, même largeur) ; autres pièces identiques ; 0 anomalie. La règle historique refuse toujours cette fenêtre ; c'est la preuve qui l'accepte |
| 168 essais de redimensionnement (4 façades × 7 pièces × 2 dimensions × 3 écarts) | Avant : 32 acceptés et 136 refusés. Après : **76 acceptés** et 92 refusés. Les **44** nouvelles acceptations étaient toutes refusées pour la seule règle d'exposition ; aucun cas n'est passé d'« accepté » à « refusé ». Chacune est justifiée automatiquement (test 5) : toutes les fenêtres que la règle historique refuse sont démontrées « extérieur », et il reste 0 anomalie |
| Cas négatifs conservés | Obstruction réelle par élargissement d'une pièce voisine : refus qui nomme « A 1 ». Vide fermé, fentes de 0,50 à 1,10 m, élément à 1,10 m ou moins devant la fenêtre : jamais « extérieur ». Vraie obstruction (Consolidation d) détectée |
| Risques de grille (tests 4a à 4c) | Passage par un seul coin (δ = 0 à 0,30 m) : vide intérieur. Décalages de grille de 0,013, 0,027 et 0,049 m : classification identique. Seuils : voir ci-dessus |
| Génération (80 configurations) | **0 différence structurelle** (variantes, formes, ordre, rejets, anomalies). Seul le compteur d'échecs, borné par le budget de temps (`maxMillis`), varie : 8 configurations entre avant et après, contre 3 (avant contre avant) et 6 (après contre après) entre deux exécutions identiques. C'est du bruit de même ordre |
| Régénération (70 cas, une pièce verrouillée à chaque fois) | 0 différence |
| Batterie de 11 cas (avant sur une copie de `1148026` hors dépôt, puis après) | Identique, hors durées et compteurs d'échecs. Une variation du compteur « autre » de 8 à 9 sur un cas, sans autre écart ; durées de 2 à 17 ms (mesure unique) |
| Performance (12 configurations fixes, 15×20 et autres) | Grille : 3,29 à 4,34 ms (moyenne 3,61) sur les mesures annoncées, **mais 5,56 ms au premier calcul à froid** (mesure unique) : **la cible de 5 ms n'est donc pas systématiquement tenue**. Vérification sans recours à la preuve : 0,010 à 0,083 ms. Appels suivants, grille en cache : 0,077 ms. Un geste complet sur la fixture : 4,42 ms |
| Glissé de poignée | Aucun calcul de grille : l'aperçu n'utilise que `resizeRoom` / `tryMoveRoom` ; la vérification complète n'a lieu qu'au relâchement |
| Navigateur (Playwright, profil isolé, `localhost:3001`) | Fixture rejouée dans l'interface : 3,50 → 3,20 appliqué, mur bas inchangé (6,70 m), portes identiques, fenêtre conservée, autres pièces identiques, aucune anomalie. Annuler : état d'origine exact, puis bouton désactivé. Rétablir : état accepté exact. Rechargement et « Reprendre ce brouillon » : état identique, étiquette « 3.03 × 3.20 m ». Valeur du profil de test restaurée ; console sans erreur. Captures `nav_01` à `nav_03` dans `exports/preuves/facade-branchement-2026-10-04/` |
| `npm run verify` | Vert : lint 0 erreur (3 avertissements préexistants), typecheck, 781/781 et 30/30, build. Après ce lancement, `exteriorExposure.ts` n'a reçu que des **commentaires** ; lint, typecheck et les deux suites ont été rejoués sur la version finale |

**Limites :**
- les seuils de passage ne valent que pour le cas testé ;
- l'exigence effective (0,65 à 0,705 m) est plus stricte que le paramètre
  annoncé (0,60 m) ;
- la cour et la limite du terrain restent sur leur verdict historique, qui
  n'est pas une preuve ;
- la génération (`chooseExteriorWindow`, `hasExteriorTouch` direct) ne
  profite pas de la preuve ;
- le premier calcul de grille d'un état coûte environ 4 à 6 ms ;
- la comparaison de génération reste soumise au bruit du budget de temps.

Captures, instantanés et scripts de mesure : `exports/preuves/facade-branchement-2026-10-04/` (hors Git).

### B3 — diagnostic de la régénération après verrouillage (réalisé le 2026-10-05, aucun code applicatif modifié)

Point de départ : HEAD `d72012e`, arbre propre, aucun stash.

**Conditions d'origine** :
- *conservés* : le geste (verrou sur Chambre 2, puis sur Salon 1, puis
  « Proposer de nouvelles dispositions ») et les comptes (75 puis 50
  explorations écartées) ;
- *non conservé* : le brouillon du diagnostic du 2026-10-04. Le stockage du
  navigateur intégré à `localhost:3001` est vide à la lecture ; rien n'a
  été supprimé par ce lot.

**Reproduction**, clairement identifiée comme telle :
`scripts/fixtures/plans-b3-regeneration-reproduction.json`. Elle part des
paramètres par défaut de l'écran et de la première variante affichée
(« Variante 3 », non modifiée). Le verrou est appliqué au moment de la
trace. Elle redonne **exactement** 75 et 50 explorations écartées.

Trace : `node scripts/trace-b3-regeneration.mjs`. Elle est en lecture
seule et n'utilise que l'API publique. Des détails internes ont été
obtenus sur une **copie instrumentée hors dépôt** du moteur (patch et
scripts dans `exports/preuves/b3-2026-10-05/`, hors Git) :
- erreurs de finalisation du retour arrière, aujourd'hui jetées sans
  trace ;
- candidats admis puis absorbés comme doublons ;
- emprise effective de recherche ;
- journal du placement pas à pas.

#### Classification

| | Chambre 2 verrouillée | Salon 1 verrouillé |
|---|---|---|
| Disposition actuelle admissible | oui | oui |
| Propositions nouvelles | 0 | 0 |
| Emprise de recherche | complète (11 × 15 m) | **réduite à 11 × 9,80 m** : le mur extérieur bas du salon verrouillé fixe la limite du bâti (règle existante, légitime ; sinon ce mur deviendrait intérieur) |
| Échecs de placement (ordre fixe) | 59 / 75 (surtout « Salon 1 » sans place) | 50 / 50 (surtout « Chambre 2 », « Chambre 3 » sans place) |
| Rejets d'accès ou de réseau (ordre fixe) | 16 : 13 « segment de circulation coupé », 3 « trajet d'entrée » | 0 |
| Retour arrière | 15 recherches, **24 dispositions complètes**, toutes rejetées en finalisation **sans trace** : 10 trajet d'entrée, 8 circulation coupée, 6 fenêtre du salon | 10 recherches, 0 disposition complète |
| Budget de recherche atteint | 0 / 15 | 0 / 10 (recherche épuisée dans son budget) |
| Rejets de contrôle final (`independentVerify`) | 0 | 0 |
| Doublons | 0 | **1** : la branche « corridor partagé, rangée arrière verrouillée » reconstruit exactement la disposition actuelle |
| Branche « corridor partagé » | entrée, **0 candidat construit, sans trace** | 1 candidat, identique à l'actuel |

#### Causes dominantes (démontrées par la trace)

1. **Placement général** (`packNeedsIntoFreeSpace`) : chaque passage pose
   **une rangée**, le long d'un bord de l'emprise, avec **son propre
   nouveau couloir** (0,20 + 1,20 + 0,10 + 0,20 = 1,70 m réservés en
   travers). *Précision (2026-10-05, sous-lot A)* : depuis `36a0a7f`, la
   part non consommée d'un espace libre est réinjectée, un même espace
   peut donc recevoir plusieurs rangées. Mais chaque rangée paie son
   propre couloir : la formule « une seule rangée par espace libre » était
   inexacte, la conclusion (pas de couloir partagé entre deux rangées)
   reste valable. Les rectangles qui ne touchent aucun bord sont
   refusés. Une pièce verrouillée au milieu d'une rangée, ou une emprise
   réduite, fragmente l'espace en morceaux trop étroits. La disposition
   d'origine utilise **un seul** couloir partagé entre deux rangées ; ce
   placement ne sait pas la reproduire.
2. **Branche « corridor partagé » de la régénération** :
   - rangée avant (Chambre 2) : les pièces non verrouillées de la même
     rangée ne peuvent aller **qu'à droite** du verrou, et seulement par
     **type entier**. Les deux chambres non verrouillées doivent pourtant
     se répartir de part et d'autre (Chambre 1 à gauche) ; aucune
     combinaison ne tient, aucun candidat n'est construit ;
   - rangée arrière (Salon 1) : la rangée de jonction suit un **ordre de
     types figé** (cuisine puis sanitaires). Elle redonne donc la
     disposition actuelle, et aucune permutation n'est explorée.
3. **Observabilité** : les rejets de finalisation du retour arrière et
   l'absence de candidat de la branche partagée ne laissent aucune trace.
   L'écran affiche « 75 explorations écartées » sans montrer que 24
   dispositions complètes ont été trouvées puis rejetées.

#### Preuve constructive à paramètres constants

- **Chambre 2 : obtenue.** Avec la **même entrée**, le générateur produit
  « Variante 5 » :
  - rangée avant identique, Chambre 2 identique (position, dimensions,
    porte, fenêtre) ;
  - rangée arrière réordonnée : Sanitaire 1, Sanitaire 2, Cuisine 1,
    Salon 1 ;
  - 0 anomalie, et la règle « fenêtre de chambre ou salon » est respectée ;
  - ce n'est pas une simple permutation de pièces identiques.
  
  Une disposition nouvelle existe donc **sans aucun redimensionnement** :
  **le lien supposé entre B3 et F2 (absence de redimensionnement
  automatique) est réfuté pour ce cas**.
- **Salon 1 : non obtenue.** Aucune variante du générateur ne conserve
  Salon 1 à l'identique. Les outils de l'éditeur (mettre de côté, replacer,
  porte) ne permettent pas de réordonner la rangée arrière : les raccords
  de circulation restent fixes, et une cuisine plus profonde les
  chevaucherait. C'est une **limite de recherche**, et non une impossibilité.
  Une rangée de jonction réordonnée (Sanitaire 1, Sanitaire 2, Cuisine 1)
  tiendrait dimensionnellement (6,11 m pour 6,12 m disponibles), mais
  cette piste **n'est pas démontrée**.

#### Plus petit correctif proposé (non développé dans ce lot)

1. **Observabilité, sans changement de comportement** : consigner dans
   `failureReasons` ou `searchStats` :
   - les erreurs de finalisation du retour arrière ;
   - les combinaisons refusées de la branche « corridor partagé » ;
   - les doublons de la disposition actuelle.
   
   Critères :
   - les mêmes variantes avant et après (instantané
     `snapshot-plans-verifier-effects.mjs` : 0 différence structurelle) ;
   - la trace montre, pour la fixture Chambre 2, les 24 rejets de
     finalisation et leur motif.
2. **Correctif ciblé de la branche « corridor partagé, rangée avant »** :
   permettre de placer les pièces non verrouillées de la rangée
   verrouillée **des deux côtés** du verrou (segment gauche entre le foyer
   et le verrou, segment droit), avec les mêmes contrôles
   (`finalizeCandidate`, `admitIfValid`). Pas de redimensionnement ni de
   nouvelle stratégie.
   
   Critères :
   - fixture Chambre 2 verrouillée : au moins une proposition nouvelle
     admissible (celle de Variante 5 ou équivalente), Chambre 2 strictement
     inchangée ;
   - génération : 0 différence ; régénération : seulement des ajouts de
     variantes admissibles, jamais une perte ;
   - batterie de 11 cas et tests existants verts.

   L'exploration de l'ordre des types dans la rangée de jonction (cas
   Salon 1) ne vient qu'**après** une preuve constructive dédiée.

### B3 — correctif en deux sous-lots (réalisé le 2026-10-05)

#### Sous-lot A — rejets visibles et comptés (`174a575`)

Aucune proposition n'est modifiée.

- `regenerateUnlocked` renvoie une synthèse `diagnostics`
  (`RegenerationDiagnostics`). Chaque événement y est compté **une seule
  fois** :
  - essais à ordre fixe : sans place, ou rejet à la finalisation ;
  - recherches avec retour arrière : plans complets, rejets à la
    finalisation, budget atteint ;
  - combinaisons « corridor partagé » : écartées avant construction (avec
    leur motif), rejetées à la finalisation, ou non tentées (et pourquoi) ;
  - candidats contrôlés ;
  - doublons de la disposition actuelle et doublons entre propositions ;
  - propositions nouvelles.
- L'écran affiche un « Bilan de la recherche » d'une phrase.
- Fixture Chambre 2 : les **24 plans complets rejetés** sont retrouvés
  (10 trajet d'entrée, 8 circulation coupée, 6 fenêtre).
- Références fixes : génération et redimensionnement, 0 différence ;
  régénération, 0 différence structurelle (seuls des compteurs d'échecs
  augmentent).
- Durée médiane inchangée.

#### Sous-lot B — « corridor partagé » des deux côtés du verrou

Ce qui change : quand la rangée verrouillée longe le couloir partagé, les
pièces non verrouillées de cette rangée peuvent désormais se placer **à
gauche comme à droite** du verrou.

- **Segments libres** : ils sont calculés entre le bord de l'emprise, les
  pièces verrouillées et la bande du foyer d'entrée.
- **Répartition** : une seule répartition est retenue par signature, celle
  qui déplace le moins les pièces (les pièces identiques ne sont jamais
  échangées sans raison).
- **Rangée fraîche** : elle est essayée dans son ordre, puis **en miroir**.
- **Doublons** : les géométries déjà vues sont écartées par type
  (`sharedEquivalentSkipped`).
- **Contrôles** : mêmes contrôles qu'avant (`finalizeCandidate`,
  `admitIfValid`). Aucun redimensionnement, aucun assouplissement, aucune
  règle propre à Chambre 2 ou à un terrain.
- **Inchangé** : les chemins existants et la déduplication.

**Correction du diagnostic** : placer les pièces du côté gauche ne
suffisait pas. Seul, ce placement reconstruit la disposition actuelle
(doublon). Le **miroir de la rangée fraîche** est aussi nécessaire pour
obtenir la disposition de Variante 5.

**Résultats** :

| | Avant (A, `174a575`) | Après (B) |
|---|---|---|
| Fixture Chambre 2 : propositions nouvelles | 0 | **1** : géométrie exacte de « Variante 5 », 0 anomalie. Chambre 2 strictement identique (position, dimensions, porte, fenêtre). Ce n'est pas une permutation de pièces identiques |
| Fixture Salon 1 : propositions nouvelles | 0 | 0 (**limite maintenue**, hors périmètre : la rangée de jonction n'est pas réordonnée) |
| Durée médiane, fixture Chambre 2 (7 essais, 2 séries côte à côte) | 289–299 ms | 296–301 ms |
| Durée médiane, fixture Salon 1 | 40–43 ms | 41–43 ms |
| Génération initiale (80 cas de référence) | — | 0 différence structurelle (4 compteurs d'échecs ±1 = bruit du budget temporel) |
| Régénération (70 cas de référence) | — | **0 proposition perdue**, 98 ajoutées dans 18 cas, permutations de pièces identiques inchangées (4 avant, 4 après, toutes préexistantes) |
| Redimensionnement (168 cas) | — | 0 différence |
| Batterie 11 cas | — | identique, sauf : C8, 0 → 1 nouvelle (budget atteint dans les deux cas) ; C9, 3 → 7 nouvelles (8 propositions distinctes par géométrie typée, 0 anomalie) ; C2, compteur d'échecs de génération 9 → 8 (bruit) |
| `test-plans-geometry` | 785/785 | 970/970 : 8 tests de la section 28, plus 177 vérifications de sections existantes qui contrôlent chacune des nouvelles propositions |

Parcours navigateur (profil Playwright isolé, `localhost:3001`) :
1. générer avec les paramètres par défaut ;
2. « Modifier ce plan », puis verrouiller Chambre 2 ;
3. « Proposer » : le bilan affiche 24 plans complets rejetés et 1
   proposition nouvelle ;
4. choisir « Régénération 1 » ;
5. recharger, puis « Reprendre ce brouillon » : on retrouve la même
   disposition, Chambre 2 toujours verrouillée.

Le brouillon préexistant du profil de test a été sauvegardé puis restauré
(empreinte identique). Aucun autre brouillon n'a été touché.

**Statut** :
- **B3, cas Chambre 2 : résolu** ;
- **B3, cas Salon 1 : limite ouverte** à la date de ce sous-lot
  (réordonner la rangée de jonction, non traité) ; traité ensuite, voir
  « B3 — Salon 1 verrouillé » ;
- **F2 reste absent**, et n'est **pas nécessaire** pour Chambre 2.

**Limites** :
- **Volume de propositions** : sur certains cas de référence, le nombre de
  propositions grimpe (par exemple accès gauche ou droite 15 × 25,
  Chambre 3 verrouillée : 6 → 37). Elles sont toutes distinctes et admissibles, mais
  aucun plafond ni tri de présentation n'a été ajouté.
- **Doublons préexistants** : les 4 permutations de pièces identiques
  venaient des chemins antérieurs, dont la déduplication se fait par
  identifiant. Elles n'ont pas été traitées.

### B3 — Salon 1 verrouillé (réalisé le 2026-10-05)

Point de départ : HEAD `b726d2e`, arbre propre, aucun stash. Fixture
inchangée (`plans-b3-regeneration-reproduction.json`).

**Preuve constructive** (copie hors dépôt, paramètres et dimensions
constants). La rangée de jonction est construite dans l'ordre inverse :
Sanitaire 1, Sanitaire 2, Cuisine 1, à droite du salon. Elle passe par le
pipeline complet (`finalizeCandidate`, `admitIfValid`).

Résultat :
- 0 erreur `independentVerify`, 0 anomalie, candidat non rejeté ;
- salon identique (position, dimensions, porte, fenêtre).

La piste « 6,11 m pour 6,12 m », non démontrée dans le diagnostic, est
donc **confirmée** : portes, fenêtres, circulation et accès passent le
vérificateur.

**Correctif générique** : dans la jonction des deux côtés
(`exploreTwoSided`), chaque segment libre essaie désormais des **ordres
distincts** de ses pièces.
- **Ordres essayés** : permutations de multi-ensemble. Des pièces
  identiques (même type, mêmes dimensions) gardent leur ordre relatif, ce
  n'est jamais un échange d'identifiants. L'ordre reçu vient en premier.
- **Borne** : au plus `MAX_JOIN_ORDERS` = 6 combinaisons d'ordres par
  répartition. Le plafond est fixe ; quand il est atteint, il est compté
  (`sharedOrdersCapped`) et affiché dans le bilan et les statistiques.
- **Aucun ordre propre à la fixture.**
- **Chemins actuels conservés** : la combinaison historique (ordre reçu,
  segment de droite, rangée fraîche dans son ordre) reste sautée,
  puisqu'elle est déjà couverte.
- **Inchangé** : mêmes contrôles, aucun redimensionnement, aucune
  modification du terrain, du programme ou des règles.
- **Rangée fraîche** : seuls son ordre et son miroir sont essayés
  (inchangé).

**Résultats** :

| | Avant (`b726d2e`) | Après |
|---|---|---|
| Fixture Salon 1 : propositions nouvelles | 0 | **2** : jonction (Sanitaire 1, Sanitaire 2, Cuisine 1) et (Sanitaire 1, Cuisine 1, Sanitaire 2). Salon identique, 0 erreur, géométries typées distinctes entre elles et de l'actuelle |
| Circulation intérieure / cheminement extérieur / total | 29,74 / 0 / 29,74 m² (disposition actuelle) | 25,42 / 4,56 / 29,98 m² (chacune des 2 propositions) |
| Fixture Chambre 2 | 1 proposition nouvelle (Variante 5) | identique |
| Durée médiane Salon 1 (7 essais, 2 séries côte à côte) | 42 ms | 45–46 ms |
| Durée médiane Chambre 2 | 293–294 ms | 292–299 ms |
| Budget de recherche atteint (fixtures) | 0/15 et 0/10 | 0/15 et 0/10 |
| Génération initiale (80 cas de référence) | — | 0 différence structurelle (5 compteurs d'échecs ±1 = bruit du budget temporel) |
| Régénération (70 cas de référence) | — | **0 proposition perdue**, 32 ajoutées dans 10 cas, permutations de pièces identiques inchangées (4) |
| Redimensionnement (168 cas) | — | 0 différence |
| Batterie 11 cas | — | identique, sauf : C9, 7 → 15 nouvelles (16 propositions, toutes distinctes, 0 erreur ; durée 37 → 47 ms) ; compteur d'échecs de génération de C2/C9 8 → 9 (bruit). C8 inchangé (1 nouvelle) |
| `test-plans-geometry` | 970 | 1059 : 8 nouveaux tests (section 29), 1 test retiré (28, « Salon 1 sans proposition », devenu faux), 82 vérifications de sections existantes appliquées aux nouvelles propositions. Le libellé du test 27 Salon est ajusté |

**D'où vient le cheminement extérieur** : de la construction historique
du cas B, inchangée. Aucun foyer intérieur n'y est posé à la main. Le
recours d'entrée rejoint donc le couloir par une bande extérieure de
1,20 × 3,80 m à gauche de Chambre 1. Ce n'est pas introduit par ce lot,
mais c'est une **différence de qualité visible** par rapport à la
disposition actuelle (entrée par une bande extérieure plutôt que par un
dégagement intérieur).

Parcours navigateur (profil Playwright isolé, `localhost:3001`) :
1. générer ;
2. « Modifier ce plan », puis verrouiller Salon 1 ;
3. « Proposer » : 2 propositions nouvelles ;
4. choisir « Régénération 1 » ;
5. recharger, puis « Reprendre ce brouillon » : on retrouve la même
   disposition, Salon 1 toujours verrouillé, sans anomalie.

Le brouillon préexistant du profil a été sauvegardé puis restauré
(empreinte identique).

**Statut** : **B3 résolu** pour les deux cas du diagnostic (Chambre 2 et
Salon 1). F2 reste absent ; il n'était nécessaire pour aucun des deux.

**Limites** :
- **Cheminement extérieur** : il vient du cas B historique, voir
  ci-dessus.
- **Troncature** : le plafond de 6 ordres tronque l'énumération dans
  l'ordre lexicographique, donc sans garantie d'exhaustivité sur des
  rangées de jonction longues (plafond atteint 1 fois sur la fixture
  Salon 1, 8 fois sur Chambre 2).
- **Rangée fraîche** : elle n'est pas réordonnée.
- **Volume de propositions** : il augmente encore sur certains cas de
  référence (ex. 37 → 45), sans tri de présentation.

---

## 3. Journal des lots

### Lot (en cours, après `5c325ae`) — empaquetage libre, accès avant (clôture M7)

**Objectif** : diagnostiquer puis corriger la dernière limite de M7
(empaquetage libre bloqué sur l'accès avant, découverte et documentée hors
périmètre lors du lot précédent), pour clôturer M7 si ses critères sont
atteints.

**Étape 1 — reproduction et classification** : les 6 terrains signalés
(15×20, 16×18, 18×22, 22×18, 20×20, 17×24) reproduits avec leurs paramètres
exacts (chambre+salon+cuisine, reculs 2/2/2/2), résultats figés avant toute
modification : 0/6 admissibles pour l'accès avant, 6/6 pour l'arrière, même
programme. Classification précise du rejet : `backtrackPackNeedsIntoFreeSpace`
trouve bien une répartition complète dans chaque cas (`outcome.complete.length
> 0`) — le rejet n'est ni un placement incomplet, ni une entrée non
raccordée en général, ni une ouverture invalide : c'est précisément
"aucune position d'entrée sur la façade d'accès ne rejoint tous les
groupes posés", systématiquement et uniquement pour le mur "top".

**Étape 2 — comparaison avant/arrière et localisation de la divergence** :
dump direct des groupes natifs (`corridor`+`placements` par groupe) pour le
cas 15×20 montre que CHAQUE rangée pose ses pièces près du bord de plus
petit Y et son propre segment de circulation près du bord de plus grand Y
— une convention interne de `backtrackPackNeedsIntoFreeSpace`, jamais
dépendante de l'accès demandé. Un chemin d'entrée depuis le mur "top" est
alors à la fois bloqué par les pièces (s'il vise leur étendue en x,
identique à celle de leur propre corridor) ET sans recouvrement d'axe
transverse avec le corridor visé (s'il vise en dehors) — `buildExteriorPath`
exige ce recouvrement pour toute cible. Hypothèse d'un biais directionnel
confirmée par la géométrie elle-même, pas simplement supposée ; une
correction plus simple ("essayer aussi les positions dans les espaces entre
pièces") a été explicitement testée sur les chiffres exacts du cas 15×20 et
montrée insuffisante (le corridor visé n'a toujours aucun recouvrement
transverse), écartée avant d'implémenter le correctif retenu.

**Étape 3 — correctif général** : réutilise le même principe miroir déjà
appliqué ailleurs dans ce fichier (`buildSharedCorridorLayoutStraight`,
`buildGuidedLayoutStraight`), mais dans le sens inverse (le remplissage
natif correspond déjà à "back", pas à "front") : pour
`input.accessSide === "front"` uniquement, `buildFreePackedLayout` reflète
`placements`/`corridors`/`corridorFillers`/`groups` autour du centre
vertical de l'emprise AVANT la recherche de porte d'accès — chaque rangée
se retrouve avec sa circulation du côté proche du mur haut, directement
atteignable. Validé par hypothèse testée séparément (reflet manuel des
groupes dumpés, `connectGroupsToNetwork` passe alors à 0 `strandedNeeds`
pour "top") avant toute modification du fichier source. Recherche native de
`backtrackPackNeedsIntoFreeSpace` intégralement conservée (jamais touchée) ;
aucune règle spéciale aux 6 terrains ; aucun changement de programme,
dimensions ou reculs ; aucun contrôle relâché (`connectGroupsToNetwork` et
la validation des fenêtres inchangés, appliqués tels quels sur la
géométrie reflétée).

**Étape 4 — mesure** : 6/6 terrains signalés admissibles pour l'accès avant
après correctif (contre 0/6 avant), avec 0 erreur `independentVerify`
chacun. Non-régression vérifiée : 6/6 toujours admissibles pour l'arrière ;
gauche/droite inchangés (2 terrains sur 6 restent non admissibles pour les
DEUX côtés identiquement — 15×20 et 16×18 — préexistant, symétrique, jamais
une conséquence de ce correctif qui ne touche que la branche
`accessSide === "front"`). Réussite dès le premier cycle (hypothèse
confirmée par test direct avant modification du code source) — boucle
arrêtée par anticipation, objectif atteint et vérifié.

**Tests** : nouvelle section 25 dédiée dans `scripts/test-plans-geometry.mjs`
(même programme que le diagnostic, 6 terrains × 4 façades) — admissibilité
avant/arrière, 0 erreur `independentVerify`, accessibilité réelle depuis
l'entrée, mur d'entrée attendu, terrain/reculs jamais permutés, bilan de
surfaces cohérent (somme = emprise, sans double comptage), chaque pièce
posée avec au moins une porte et une ouverture extérieure. **755/755 tests
réussis** (602 précédents + 153 nouveaux). Typecheck : 0 erreur. Lint : 0
erreur (2 avertissements préexistants, sans rapport avec ce lot). Batterie
11 cas (`scripts/test-plans-battery.mjs`) rejouée, tous les nombres
inchangés.

**Vérifié en navigateur depuis E:** (serveur confirmé par CommandLine du
processus, port 3002, jamais le port 3000 occupé par le processus orphelin
de `C:\ChantierLive`, non arrêté) : génération réelle (terrain 15×20, accès
avant, chambre+salon+cuisine) sans erreur, export réel du fichier de projet
(.json) téléchargé puis réimporté dans l'éditeur — round-trip confirmé,
mêmes pièces et mêmes surfaces après réimport. La disposition affichée par
défaut dans ce parcours UI provient d'une autre famille (plusieurs familles
sont admissibles pour ce programme simple) ; la preuve ciblée du correctif
empaquetage libre/accès avant repose sur l'appel direct de
`buildFreePackedLayout` (diagnostic + section 25), pas sur l'ordre
d'affichage de l'interface.

**Livraison** : fichier de projet réel (.json) et SVG correspondant pour le
nouveau résultat empaquetage libre/accès avant (terrain 15×20) ; bons
exemples déjà produits rejoints sans redéveloppement (guidée accès arrière :
SVG régénéré depuis le fichier de projet déjà livré ; circulation en L
accès avant : paire JSON+SVG produite depuis la fixture déjà validée par la
section 24, terrain 21×24 asymétrique).

### Lot (après `5c54b0a`) — familles guidée et en L sur 4 façades

**Objectif** : compléter M7 selon son critère existant en étendant la
génération des familles guidée (salon central/cour) et circulation en L
aux 4 façades physiques, en réutilisant les transformations déjà éprouvées.

**Correction de doc** : "terrain carré 15×20" (plusieurs mentions dans ce
fichier et dans `test-plans-geometry.mjs`) était géométriquement faux
(15≠20, un rectangle) — corrigé partout en "terrain rectangulaire 15×20
(non carré, reculs gauche/droite égaux)", la propriété RÉELLEMENT testée
par ces scénarios n'ayant jamais été la forme carrée du terrain.

**Famille guidée (salon central / cour d'entrée)** :
- `buildGuidedLayout` devient un point d'entrée public qui RÉUTILISE les
  deux transformations déjà éprouvées : gauche/droite passent par le même
  repère virtuel transposé que `buildDoubleLoadedLayout`/
  `buildSharedCorridorLayout` ; arrière est pris en charge NATIVEMENT par
  `buildGuidedLayoutStraight` via un reflet vertical interne (même
  technique que `buildSharedCorridorLayoutStraight`) — construit toujours
  comme un accès avant (cour/salon réservés près du haut de l'emprise),
  reflété autour du centre vertical de l'emprise réelle (qui ne dépend que
  des reculs avant/arrière, jamais de l'accès) si l'accès réel est arrière.
- Vérifié : 4 façades × 2 scénarios (salon central ; cour d'entrée seule)
  × 2 terrains (rectangulaire, asymétrique), 0 erreur, entrée sur le mur
  attendu, terrain/reculs jamais permutés, cour protégée (jamais
  chevauchée), bilan de surfaces cohérent. Round-trip réel vérifié en
  navigateur (accès arrière, 32×30, génération → export du vrai fichier de
  projet → réimport, surfaces identiques).

**Famille circulation en L** :
- `buildLShapedLayout` devient un point d'entrée public qui réutilise les
  MÊMES deux transformations, mais dans l'ordre INVERSE des autres
  familles : le NATIF est gauche/droite (gauche inchangé, droite via un
  reflet HORIZONTAL interne à `buildLShapedLayoutStraight`, nouveau mais
  symétrique du reflet vertical déjà utilisé ailleurs) ; avant/arrière
  passent par le repère virtuel transposé (`transposeDoubleLoadedResult`,
  la même fonction générique — une transposition diagonale est une
  involution, valable dans les deux sens, jamais réimplémentée).
- **Défaut PRÉEXISTANT trouvé et corrigé** (reproductible avec
  `accessSide: "left"` seul, avant toute transposition — jamais introduit
  par ce lot, seulement révélé par une vérification plus large que son
  unique scénario natif historique) : quand la rangée haute (simple
  charge) est plus large que le segment bas (double-chargé), la colonne
  DROITE du segment bas était ancrée à la géométrie LOCALE du corridor
  bas, jamais au bord RÉEL du contour englobant (élargi par la rangée
  haute) — sa fenêtre ne débouchait alors plus sur un mur extérieur réel,
  et l'écart ainsi créé n'étant comblé par aucun raccord, sa porte ne
  traversait plus aucune circulation réelle (chambre inaccessible).
  Corrigé en ancrant la colonne droite au bord réel du contour englobant
  et en comblant l'écart résiduel par un raccord touchant le corridor
  DIRECTEMENT (jamais +WALL_INT, une convention de porte, pas une
  connectivité géométrique pure — même défaut d'asymétrie déjà rencontré
  et corrigé plusieurs fois ailleurs dans ce fichier).
- Vérifié : 4 façades × 2 terrains (rectangulaire, asymétrique), avec un
  programme choisi pour reproduire EXACTEMENT le défaut ci-dessus (rangée
  haute large, colonne droite à largeur unique) — 0 erreur, entrée sur le
  mur attendu, terrain/reculs jamais permutés, bilan de surfaces cohérent.
  Échec explicite conservé (terrain délibérément trop étroit) : refusé
  pour un motif géométrique réel, jamais masqué.

**Découverte hors périmètre de ce lot (empaquetage libre)** : en
vérifiant par prudence la cinquième famille avant de statuer sur M7,
`buildFreePackedLayout` échoue SYSTÉMATIQUEMENT pour l'accès avant (testé
sur 6 terrains : 15×20, 16×18, 18×22, 22×18, 20×20, 17×24 — 0/6), alors
que arrière/gauche/droite réussissent au moins une fois chacun sur les
mêmes essais. Le calcul du mur d'accès lui-même est déjà générique et
correct (`geometry.ts`, `accessWall`/`fixedCoord`, vérifié par lecture) —
la cause probable est un biais directionnel du remplissage par
retour-arrière (`backtrackPackNeedsIntoFreeSpace`), qui semble placer les
groupes d'une façon qui bloque systématiquement une position d'entrée
praticable sur le mur "top" spécifiquement. **Non corrigé ce lot**
(objectif limité à guidée + L) — limite consignée précisément (façade et
famille nommées, jamais une conclusion d'impossibilité générale) pour un
lot séparé.

**Tests** : 602/602 (`scripts/test-plans-geometry.mjs`, +196 : sections 23
et 24 dédiées). Une assertion existante devenue obsolète par la levée du
refus de principe sur "en L" (le motif d'échec attendu pour le terrain C2
est passé de "non prise en charge" à un motif géométrique réel) a été mise
à jour, jamais supprimée. Typecheck et lint : 0 erreur. Batterie 11 cas
rejouée sans modification de paramètres, tous les nombres inchangés.

**Livraison** : fichiers de projet réels (.json), SVG et PNG pour les
nouveaux résultats (guidée accès arrière ; corridor partagé accès gauche
du lot précédent), stockés durablement dans `exports/plans/` sur E:
(non versionnés — artefacts générés, voir `.gitignore`) ; le PNG déjà
vérifié localement n'a pas été re-livré en cas d'échec de téléversement
pour éviter des relances inutiles.

### Lot `5c54b0a` — régénération corridor partagé étendue à gauche/droite

**Objectif** : la stratégie dédiée corridor partagé de `regenerateUnlocked`
ne réutilisait sa géométrie (Cas A/B) que pour avant/arrière — gauche/droite
retombaient sur la recherche générale, limite documentée explicitement
dans les lots précédents.

**Réutilisation des transformations existantes** : `regenerateUnlocked`
devient un point d'entrée public qui (1) appelle d'abord
`regenerateUnlockedCore` (l'implémentation inchangée, recherche générale
comprise) NATIVEMENT sur le `Layout` reçu — jamais retiré, pour ne perdre
aucune disposition déjà trouvée nativement pour gauche/droite ; (2) PUIS,
transpose ce même `Layout` dans le repère virtuel de la génération
initiale (`buildSharedCorridorLayout`/`buildDoubleLoadedLayout` : gauche →
avant virtuel, droite → arrière virtuel), rappelle
`regenerateUnlockedCore` INCHANGÉE sur ce repère pour que sa stratégie
dédiée (gardée par `entryWallForRegen`, jusqu'ici seulement avant/arrière)
s'applique aussi, puis transpose chaque résultat vers le repère physique
réel ; (3) fusionne les deux ensembles de dispositions avec déduplication
stricte par géométrie physique — jamais la même disposition comptée deux
fois. `transposeDoubleLoadedResult` (déjà utilisé par la génération
initiale) est réutilisé tel quel, sa signature réduite à
`Pick<GenerationInput, "terrainWidth" | "terrainDepth" | "accessSide">`
(les seuls champs qu'elle lisait) pour l'appeler depuis `regenerateUnlocked`
sans construire ni caster un `GenerationInput` fictif.

**Défaut trouvé et corrigé en cours de route** : une première version
remplaçait ENTIÈREMENT l'appel natif par l'appel transposé (au lieu de
fusionner les deux) — un test préexistant (`accessSide: "left"`,
scénario "Régénération fiable") a alors cessé de trouver une variante
qu'il trouvait auparavant (circulation 48,96 m²) : la recherche générale
n'est PAS garantie symétrique sous une réflexion à 90° (son propre
commentaire la décrit comme "bornée et non exhaustive"), transposer tout
l'appel pouvait donc faire manquer, pour cette recherche précise, ce
qu'elle trouvait nativement. Corrigé en FUSIONNANT les deux appels
(natif + transposé) plutôt qu'en remplaçant l'un par l'autre — aucune
disposition déjà trouvable avant ce lot n'est perdue, et les nouvelles
dispositions corridor partagé s'y ajoutent.

**Vérifié** : accès gauche et droite, terrain rectangulaire 15×20 (non
carré — reculs gauche/droite égaux, avant/arrière différents : 3/2/2/2)
et terrain non carré à reculs asymétriques (14×24 : 4/1/2.5/1), verrou côté entrée
(salon) et verrou côté opposé (chambres) — dans chaque cas où une
disposition corridor partagé existe : pièces verrouillées strictement
inchangées, aucune pièce non verrouillée réduite sous sa cible, 0 erreur
`independentVerify`, entrée sur le mur physique attendu, terrain/reculs
jamais permutés par la transposition interne, bilan de surfaces cohérent
(somme = emprise). Round-trip réel vérifié en navigateur (génération →
verrouillage → régénération → choix → export du fichier de projet réel →
réimport) pour accès gauche (salon verrouillé, 14×24 asymétrique :
circulation 31,32 m², chambres 3,50×3,50 m et sanitaires 1,80×2,00 m
inchangés après export/réimport) et accès droite (chambres verrouillées,
même terrain : "corridor partagé... accès arrière, +chambre/sanitaire
côté arrière", chambres 3,50×3,50 m, salon 22,5 m², sanitaires 3,6 m²
chacun — toutes dimensions physiques exactes, seul l'ordre largeur×
profondeur affiché change selon l'orientation du mur, jamais l'aire).

**Repli inchangé distingué** : vérifié dans chaque cas que "Disposition
actuelle (inchangée)" reste une entrée séparée, jamais confondue avec les
nouvelles "Régénération N" (même mécanisme de déduplication par géométrie
physique que pour avant/arrière).

**Hors périmètre, toujours documenté, jamais forcé** : familles guidée
(salon central/cour) et circulation en L restent chacune à 1/4 façade par
refus explicite (non concernées par ce lot, qui ne touche que la
régénération de la famille corridor partagé).

**Tests** : 380/380 (`scripts/test-plans-geometry.mjs`, +131 : section 22
dédiée gauche/droite). Typecheck et lint : 0 erreur. Batterie 11 cas
rejouée sans modification de paramètres, tous les nombres inchangés
(C1=26,52, C2=34,62, C3=36 var./24,54, C8 génération=29,74/
régénération=[] (0, corrigé lot précédent), C9 génération=34,62/
régénération=[27, 31,78, 35,68], C10=36 var./24,54, C11=18/26,52) —
aucune régression avant/arrière ni sur la batterie fixe.

**Infrastructure** : port 3000 toujours occupé par le serveur orphelin de
`C:\ChantierLive` (processus non tué cette fois, conformément à la
consigne) — vérification faite depuis un serveur lancé explicitement
depuis E: sur le port 3002 (`npm run dev -- --port 3002`), bundle
confirmé à jour (présence de `roomsKeyOf`/`regenerateUnlockedCore`).

### Lot `37fea69` et suivant (corridor partagé — quatre façades d'accès)

**Génération initiale — étendue aux 4 façades :**
- Défaut trouvé : `buildSharedCorridorLayoutStraight` ignorait entièrement
  `accessSide` pour sa géométrie (toujours construite "avant") — le refus
  explicite de l'accès arrière dans le dispatcher était la SEULE protection
  contre un résultat silencieusement incorrect ; gauche/droite (déjà
  "acceptés" via le transpose générique partagé avec le double-chargé)
  n'avaient jamais été vérifiés.
- Corrigé par un reflet vertical interne pour l'accès arrière (rects ET
  étiquettes de mur "top"/"bottom" inversées ensemble), et par la
  généralisation de `transposeDoubleLoadedResult` (ne transposait jamais
  `circulations`/`exteriorPaths` — jamais remarqué par le double-chargé,
  qui ne les utilise jamais ; le foyer de cette famille y est rangé et
  restait dans le mauvais repère après transposition pour gauche/droite).
- Vérifié : 4 façades × 2 terrains (15×20 rectangulaire, 14×24 non carré à
  reculs asymétriques) × construction directe de la famille, 0 erreur
  `independentVerify`, entrée sur le mur physique attendu, terrain/emprise
  exacts (reculs attachés aux côtés physiques, jamais réinterprétés).

**Régénération — étendue à l'accès arrière (génération initiale ⇒
régénération « lorsque cette famille est applicable », selon l'objectif de
ce lot) :**
- La stratégie dédiée de `regenerateUnlocked` (Cas A/B, lot `bdd22fd`)
  était gardée par `layout.accessSide === "front"`. Généralisée : ce n'est
  plus "avant"/"arrière" qui décide quelle rangée porte le foyer d'entrée,
  mais laquelle des deux rangées (verrouillée ou fraîche) touche
  RÉELLEMENT le mur d'entrée — valable aussi bien pour l'accès avant que
  pour l'accès arrière, avec exactement la même construction géométrique
  dans les deux cas.
- Vérifié sur les deux sous-cas (rangée verrouillée côté entrée, rangée
  verrouillée côté opposé), accès avant et arrière : dispositions
  nouvelles trouvées, pièces verrouillées strictement inchangées (position/
  dimensions), 0 erreur `independentVerify`, toutes les pièces accessibles,
  entrée sur le mur attendu — mêmes totaux de circulation que la
  disposition miroir déjà validée (26,36 / 26,52 / 27,00 / 36,07 m²,
  symétrie confirmée, pas une coïncidence).
- **Hors périmètre de ce lot, limite ouverte et documentée (jamais
  forcée)** : régénération à corridor partagé pour accès gauche/droite.
  Ces deux façades passent, en génération, par un repère virtuel entier
  (`transposeDoubleLoadedResult`) — la stratégie dédiée de
  `regenerateUnlocked` travaille directement en coordonnées réelles et ne
  s'applique pas à ce repère virtuel sans une réécriture plus large, non
  entreprise faute de temps dans les cycles autorisés. Sur ces deux
  façades, un verrouillage retombe sur la recherche générale (jamais un
  résultat invalide : vérifié que `independentVerify` reste à 0 erreur
  même sans la stratégie dédiée), avec la même limite déjà chiffrée
  ailleurs (pas de corridor partagé entre rangées).
- **Chiffres cités ci-dessus (26,36 / 26,52 / 27,00 / 36,07 m²) corrigés
  par le lot suivant** : certains de ces résultats s'appuyaient sur le
  défaut de rétrécissement silencieux détaillé plus bas — seuls 27,00 m²
  (et les variantes de la batterie non listées ici) survivent à la
  correction ; les autres n'étaient pas des dispositions à dimensions
  pleinement conservées. Voir le lot `8ae91ed` pour les chiffres corrigés.

**Tests** : 253/253 (`scripts/test-plans-geometry.mjs`, +102 depuis le lot
précédent : sections 19 et 20). Batterie 11 cas rejouée sans modification
de ses paramètres ; C3/C10/C11 trouvent légitimement PLUS de variantes
qu'avant (famille corridor partagé désormais correctement applicable à
gauche/droite/arrière) — jamais une régression, une amélioration mesurée
sur les mêmes fixtures protégées. **Chiffres C8/C9 régénération de ce
tableau corrigés par le lot `8ae91ed` ci-dessous** (s'appuyaient en partie
sur le défaut de rétrécissement silencieux qui y est détaillé).

**Correction de formulation (« limite mathématique prouvée »)** :
l'entrée du lot `bdd22fd` plus bas emploie cette expression pour le cas C2
sans préciser la famille ni les hypothèses concernées — corrigé ici plutôt
que réécrit, pour ne pas effacer l'historique : il s'agit STRICTEMENT de
la famille « corridor partagé entre deux rangées »
(`buildSharedCorridorLayoutStraight`), pour LE programme exact de C2 (2
pièces en rangée avant, 3 en rangée arrière, dont 3 chambres) sur LE
terrain exact de C2 (20×14 m, reculs du cas), prouvée par énumération
EXHAUSTIVE de toutes les bipartitions de types possibles pour cette
configuration précise — jamais une impossibilité architecturale générale,
jamais valable pour un autre programme, terrain, ou famille de
disposition.

### Lot `8ae91ed` et suivant (correction : rétrécissement silencieux en
régénération, double comptage du bilan de surfaces, fichiers de projet
réels)

Défauts rapportés avec fichiers à l'appui (`acces_arriere_generation.json`/
`acces_arriere_regeneration.json` du lot précédent) — les deux confirmés et
corrigés à la source, jamais contournés.

**1. Rétrécissement silencieux de pièces NON verrouillées en régénération**
- Mesuré : chambre 3,50 × 3,00 m → 3,452380952 × 3,00 m ; sanitaire
  1,80 × 2,00 m → 1,771428571 × 2,00 m, sans aucune mention de cet écart.
- Cause : la stratégie dédiée corridor partagé de `regenerateUnlocked`
  utilisait un `fitProportional` local qui réduit proportionnellement les
  largeurs vers leur minimum dès que la largeur disponible n'atteint pas
  exactement la somme des cibles — acceptable en GÉNÉRATION (avec
  divulgation explicite cible/obtenu/minimum, règle déjà en vigueur), mais
  jamais acceptable en RÉGÉNÉRATION, où les dimensions individuelles de
  chaque pièce non verrouillée doivent être conservées. Le même défaut
  existait aussi sur la profondeur (`Math.min(n.depth, rowDepth)` avec
  `rowDepth` lui-même parfois réduit sous la cible).
- Corrigé : remplacé par `fitExact` (largeur) — retourne les cibles
  EXACTES si elles tiennent, sinon `null` (candidat rejeté, jamais réduit) —
  et les clamps de profondeur remplacés par un contrôle strict avant
  construction (`n.depth > profondeur disponible` ⇒ candidat rejeté).
  Chaque pièce non verrouillée obtient donc TOUJOURS sa dimension cible
  exacte dans toute disposition proposée, ou cette disposition n'est pas
  proposée du tout.
- Conséquence mesurée sur la batterie fixe (jamais masquée) : C8
  régénération passe de 1 variante (26,17 m², dimensions réduites sans le
  dire) à **0 variante** — ce candidat n'existait que grâce au
  rétrécissement, il est maintenant honnêtement absent. C9 régénération
  passe de 5 variantes [26,5 / 27 / 31,78 / 35,68 / 35,69] à **3 variantes
  [27 / 31,78 / 35,68]** — les deux écartées s'appuyaient sur le même
  défaut. Ce n'est PAS une régression : ces nombres mesuraient un défaut,
  jamais une vraie capacité de régénération.

**2. Double comptage dans le bilan de surfaces**
- Mesuré : union pièces+circulations=94,67 + cheminement=3,96 +
  non affecté=49,33 + extérieur=0 + cour=0 = **147,96 m², alors que
  l'emprise ne fait que 144 m²** — total supérieur à l'emprise, impossible
  géométriquement.
- Cause : `computeSurfaces` soustrayait TOUJOURS `cheminementExterieur` (et
  la cour) de l'espace « extérieur » en supposant qu'ils tombent
  entièrement HORS du rectangle englobant (`footprint`) — vrai pour la
  bande de jardin classique avant/arrière, mais faux quand `entryRescue`
  pose un chemin d'entrée DANS une encoche interne au rectangle englobant
  (ex. le foyer laissé libre par la rangée fraîche de la famille corridor
  partagé). Cette part était alors comptée une fois dans `nonAffectee`
  (résidu du rectangle englobant) ET une fois dans `cheminementExterieur`.
- Corrigé : mesure désormais, rect par rect (`clipRect`), la part RÉELLE de
  chaque chemin/cour à l'intérieur du rectangle englobant plutôt que de la
  supposer nulle — jamais une simple égalité par soustraction. `nonAffectee`
  exclut cette part ; `exterieure` ne retire que la part RÉELLEMENT hors du
  rectangle englobant. Les 5 catégories (bâti, cheminement, résiduel,
  extérieur, cour) somment désormais EXACTEMENT à l'emprise, vérifié
  automatiquement (`Math.abs(somme - emprise) < 1e-6`) sur tous les
  résultats des sections 19/20/21 du test, jamais une seule fois observée
  manuellement. Interface, JSON et fichier de projet lisent tous le même
  objet `surfaces` calculé une seule fois — aucune divergence possible par
  construction (vérifié par le round-trip de la section 21).

**3. Fichiers de projet réels, distincts des fixtures internes**
- Les JSON livrés au lot précédent étaient des `Layout` bruts
  (`JSON.stringify(layout)`) — utiles pour l'inspection technique, mais
  jamais un véritable fichier de projet rechargeable par l'application.
- Livré ce lot : `acces_arriere_generation.projet.json` et
  `acces_arriere_regeneration.projet.json`, produits par
  `serializeProject` (version 4, horodatage, orientation), réécrits sur
  disque puis relus et validés par `validateProjectFile` — round-trip
  vérifié automatiquement (section 21) : verrou et bilan de surfaces
  identiques avant/après réimport. Les `Layout` bruts précédents restent
  des fixtures internes de diagnostic, jamais présentées comme des
  fichiers de projet.

**Tests** : 249/249 (`scripts/test-plans-geometry.mjs`, sections 19-21
enrichies de contrôles ciblés sur les deux défauts — aucune pièce non
verrouillée réduite, bilan de surfaces cohérent, round-trip de fichier de
projet réel). Typecheck et lint : 0 erreur. Batterie 11 cas rejouée sans
modification de ses paramètres (chiffres C8/C9 régénération corrigés,
voir point 1 ci-dessus ; tous les autres nombres inchangés : C1=26,52,
C2=34,62, C3=36 var./24,54, C8 génération=29,74, C9 génération=34,62,
C10=36 var./24,54, C11=18/26,52).

**M7 rouvert** : voir la section 2 ci-dessus — remis à "Partiel", la
portée "CHAQUE famille" n'étant couverte ni par la famille guidée
(salon central/cour, avant seulement) ni par la circulation en L (gauche
seulement), tous deux par refus explicite et documenté, jamais par un
oubli de test.

**Découverte d'infrastructure (hors périmètre du code, signalée pour
information)** : le port 3000, utilisé par `preview_start`/`npm run dev`
pour vérifier ce lot dans le navigateur, était occupé par un serveur de
développement orphelin lancé depuis **`C:\ChantierLive`** (la copie
préservée, jamais modifiée par ce travail) — probablement resté actif
depuis un lot antérieur de cette session. Ce serveur servait un bundle
bien plus ancien (sans `buildSharedCorridorLayout` ni `buildFreePackedLayout`
du tout), ce qui a d'abord fait croire à une régression de génération
("Aucune solution trouvée" pour le scénario exact rapporté). Diagnostiqué
par inspection du contenu réel sous `/_next/static/chunks/...` (chaînes
attendues absentes), puis confirmé via `netstat`/`Get-CimInstance
Win32_Process` (ligne de commande du processus pointant vers `C:\ChantierLive`).
Ce processus a été arrêté (processus uniquement — aucun fichier de
`C:\ChantierLive` lu, modifié ni supprimé), mais un AUTRE processus
identique a aussitôt repris le port (un superviseur externe le relance,
hors du périmètre de cette session) : la vérification finale a donc été
faite sur le port 3001 (`.claude/launch.json` : nouvelle configuration
`dev-3001`), où le bundle servi contient bien le code de ce lot. **À
signaler au porteur du projet** : si un dépannage futur de
`localhost:3000` échoue étrangement, vérifier d'abord quel répertoire sert
réellement ce port.

**Vérification navigateur (port 3001, bundle confirmé à jour)** : scénario
exact rapporté (20×14, accès arrière, salon verrouillé) rejoué de bout en
bout — génération (20 dispositions), verrouillage du salon, régénération
(« corridor partagé... accès arrière », circulation 27,00 m²), choix de la
disposition, export du VRAI fichier de projet (`serializeProject`,
version 4), réimport de ce même fichier (verrou et bilan de surfaces
identiques après réimport), export SVG/PNG. Chambres 3,50×3,00 m,
sanitaires 1,80×2,00 m dans le plan rendu — aucun rétrécissement visible.
Bilan de surfaces affiché : 95,7 + 4,0 + 44,3 + 0,0 + 0,0 = 144,0 m²
(emprise), exactement cohérent — plus d'écart de 3,96 m².

### Lot `bdd22fd` (consolidation C2 + régénération C9)

- **C2** — nouvelle recherche exhaustive par bipartition des types trouve
  des dispositions complètes, **avec adaptation de certaines profondeurs**
  (le programme ne tient pas à cible exacte sur ce terrain, quelle que soit
  la répartition essayée — prouvé par énumération exhaustive, pas supposé).
  **Le respect intégral des cibles initiales (largeur ET profondeur,
  simultanément, pour toutes les pièces) n'est PAS obtenu** — certaines
  dispositions atteignent la largeur cible exacte partout, mais aucune
  n'atteint aussi la profondeur cible partout.
- **C9** — nouvelles dispositions trouvées pour le scénario salon
  verrouillé. Les dimensions du brouillon d'origine sont préservées pour
  les pièces non verrouillées dans au moins une des nouvelles dispositions
  (aucun repli nécessaire pour celle-ci) ; le salon et ses ouvertures
  (portes, fenêtres) verrouillés restent conservés à l'identique dans
  toutes les dispositions proposées, nouvelles ou non.
- **Total annoncé** : circulation intérieure + cheminement extérieur,
  34,62 m² → 30,96 m² (disposition retenue pour la preuve).
- **Clarification 3 vs 5 variantes** — mêmes paramètres, même base
  (terrain 20×14, salon verrouillé sur la disposition à 34,62 m² générée
  en premier) : l'écart ne vient pas d'un scénario différent. La
  vérification initiale dans le navigateur a eu lieu juste après un
  redémarrage du serveur de développement suite à un arrêt inattendu, sur
  une compilation probablement pas encore totalement à jour (Turbopack).
  Une revérification propre (nouvelle navigation, même terrain, même
  verrouillage) reproduit exactement **3 régénérations** — 26,52 / 27,00 /
  36,07 m² — identiques au test Node et au compte rendu écrit. Les « 5 »
  initialement rapportées dans le navigateur étaient donc une mesure prise
  sur un état transitoire du serveur, pas un second scénario : corrigé ici,
  le chiffre exact et reproductible est **3**.

---

**Bilan de ce lot** :
28/68 (41 %) / 6/7 jalons moteur terminés / 2 cycles effectués (sur 5
autorisés, arrêt anticipé — objectif atteint et vérifié) / résultat
utilisateur : C2 proche des cibles sans les atteindre intégralement
(limite mathématique prouvée — voir formulation précisée ci-dessus : famille
corridor partagé, programme et terrain C2 exacts, jamais générale), C9
régénérable avec verrou intact / limite principale : corridor partagé non
raccordé pour accès arrière/gauche/droite / commit `bdd22fd`.

---

**Bilan de ce lot** (`37fea69` et suivant) :
28/68 (41 %) / **7/7 jalons moteur terminés — CORRIGÉ À 6/7 par le lot
suivant** (M7 marqué "Terminé" ici sur la seule preuve de 2 familles sur 5 ;
corrigé une fois la portée réelle de « chaque famille » vérifiée, voir lot
`8ae91ed`) / 3 cycles effectués (sur 5 autorisés, arrêt anticipé — objectif
de génération atteint et vérifié sur 4 façades, régénération étendue avec
succès à l'accès arrière) / résultat utilisateur : corridor partagé
désormais disponible sur les 4 façades en génération initiale (avant/
arrière/gauche/droite, terrain rectangulaire 15×20 et non carré 14×24 à
reculs asymétriques), et en régénération pour avant/arrière avec verrou strictement préservé /
limite principale : régénération à corridor partagé non étendue à gauche/
droite (repère virtuel entier, limite ouverte documentée, jamais forcée —
recherche générale utilisée à la place, sans résultat invalide) / commit
`8ae91ed`.

---

**Bilan de ce lot** (`8ae91ed` et suivant — correction des défauts
rapportés) :
28/68 (41 %) / 6/7 jalons moteur terminés (M7 rouvert à "Partiel", portée
réelle précisée : guidée et L restent à 1/4 façade chacune, par refus
explicite) / 2 cycles effectués (sur 5 autorisés, arrêt anticipé — les deux
défauts rapportés confirmés et corrigés dès le premier cycle, second cycle
consacré aux tests ciblés et à la vérification de portée de M7) / résultat
utilisateur : régénération corridor partagé ne réduit plus jamais
silencieusement une pièce non verrouillée (rejette plutôt que rétrécir) ;
bilan de surfaces des 5 catégories somme désormais exactement à l'emprise
(vérifié automatiquement, plus de double comptage) ; fichiers de projet
réels livrés (serializeProject → écriture → validateProjectFile, round-trip
vérifié) / limite principale : régénération à corridor partagé toujours
non étendue à gauche/droite ; empaquetage libre non couvert par une preuve
dédiée 4 façades ; familles guidée et L restent à 1 façade chacune par
conception (non un défaut de ce lot) / commit `f835ee5`.

---

**Bilan de ce lot** (régénération corridor partagé — gauche/droite) :
28/68 (41 %) / 6/7 jalons moteur terminés (M7 reste "Partiel", critère
inchangé — ce lot ne touche que la régénération, hors de sa portée ;
guidée et L restent à 1/4 façade chacune) / 1 cycle effectué (sur 5
autorisés, arrêt anticipé — réussite vérifiée au premier cycle, un défaut
de symétrie de la recherche générale corrigé en cours de route par
fusion plutôt que remplacement) / résultat utilisateur : régénération
corridor partagé disponible sur les 4 façades (avant/arrière/gauche/
droite), verrou préservé et aucune pièce réduite dans les deux sens
(verrou côté entrée, verrou côté opposé), terrain/reculs physiques jamais
permutés, bilan de surfaces cohérent, round-trip génération→verrouillage→
régénération→choix→export→réimport vérifié en navigateur pour gauche et
droite / limite restante : familles guidée (salon central/cour) et
circulation en L restent chacune à 1/4 façade par conception (hors
périmètre de ce lot) / commit `5c54b0a` / serveur confirmé depuis E: :
http://127.0.0.1:3002 (port 3000 occupé par un processus orphelin de
`C:\ChantierLive`, non arrêté cette fois).

---

**Bilan de ce lot** (familles guidée et en L sur 4 façades) :
28/68 (41 %) / 6/7 jalons moteur terminés (M7 reste "Partiel", critère
inchangé — voir la matrice famille × façade : 4/5 familles désormais à
4/4 en génération) / 2 cycles effectués (sur 5 autorisés, arrêt anticipé —
guidée réussie au premier cycle, en L au second après un défaut
préexistant trouvé et corrigé en cours de route) / résultat utilisateur :
salon central/cour et circulation en L génèrent désormais une disposition
admissible sur les 4 façades (avant/arrière/gauche/droite), terrain/
reculs physiques jamais permutés, cour protégée, bilan de surfaces
cohérent, round-trip génération→export→réimport vérifié en navigateur
(guidée, accès arrière) / limite restante : empaquetage libre échoue
systématiquement pour l'accès avant (limite nouvellement et précisément
identifiée, hors périmètre de ce lot) ; régénération dédiée non étendue à
guidée/L (recherche générale uniquement, non testée spécifiquement) /
commit `4684e95` / serveur confirmé depuis E: : http://127.0.0.1:3002
(port 3000 toujours occupé par le même processus orphelin de
`C:\ChantierLive`, non arrêté).

---

**Bilan de ce lot** (empaquetage libre, accès avant — clôture M7) :
28/68 (41 %) / **7/7 jalons moteur terminés** (M7 clôturé selon son critère
existant de génération — voir la matrice famille × façade : 5/5 familles
désormais à 4/4 ; régénération dédiée guidée/L distinguée et laissée
ouverte, jamais confondue avec M7) / 1 cycle effectué (sur 5 autorisés,
arrêt anticipé — hypothèse du reflet en Y testée et confirmée séparément
avant toute modification du fichier source, correctif validé dès le
premier cycle) / résultat utilisateur : empaquetage libre génère désormais
une disposition admissible pour l'accès avant sur les 6 terrains signalés
(0/6 → 6/6), 0 erreur de vérification indépendante, non-régression
confirmée pour l'arrière (6/6 inchangé) et pour gauche/droite (inchangés,
y compris les 2 terrains sur 6 déjà non admissibles des deux côtés avant ce
lot) ; round-trip génération→export→réimport vérifié en navigateur ;
livraison du nouveau résultat (JSON + SVG) et des bons exemples
guidée/L déjà produits, sans redéveloppement / limite restante :
empaquetage libre gauche/droite non admissible sur 2 des 6 terrains
signalés (15×20, 16×18 — préexistant, symétrique, hors de ce correctif) ;
régénération dédiée guidée/L toujours non étendue (recherche générale
uniquement) / clôture du prototype 2D prononcée avec son périmètre exact
et ses limites (voir section 2 ci-dessus) — ChantierLive dans son ensemble
n'est PAS terminé (28/68, inchangé) / commit `b718dd0` / serveur
confirmé depuis E: : http://127.0.0.1:3002 (port 3000 toujours occupé par
le même processus orphelin de `C:\ChantierLive`, non arrêté).
