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

---

## 1. ChantierLive — compteur global

**28/68 tâches, 40 restantes, 41 %.**

Source : `MVP_BACKLOG.csv` (68 lignes de tâches, critère `done_when` par
tâche). Ce compteur n'est incrémenté QUE lorsqu'une tâche de ce fichier
est réellement terminée selon son propre critère — jamais pour un commit,
un test, ou un lot du moteur 2D ci-dessous (aucune des tâches B0xx
actuellement listées ne correspond au travail du moteur de plans). Valeur
non modifiée par ce document ni par aucun lot plans-generator à ce jour.

---

## 2. Moteur 2D — jalons de livraison

Liste finie, établie depuis le périmètre déjà convenu au fil des lots
(aucune fonctionnalité ajoutée ici). **6/7 jalons terminés.** Un jalon
partiel ne compte jamais comme terminé.

**Correction de portée (M7, ce lot)** : le lot précédent avait marqué M7
"Terminé" sur la seule preuve de deux familles (double-chargé, corridor
partagé). Vérification demandée explicitement sur la portée réelle de
« CHAQUE famille » : **FAUX** — `buildLShapedLayout` (circulation en L)
refuse explicitement tout `accessSide` autre que `"left"`
(`geometry.ts:979`, message "non prise en charge... autre que gauche"),
et `buildGuidedLayout` (salon central / cour d'entrée) refuse explicitement
tout `accessSide` autre que `"front"` (`geometry.ts:791`, "non pris en
charge... autre qu'avant"). Ce sont des refus EXPLICITES et documentés
(jamais un résultat silencieusement incorrect), mais ils signifient que
M7 n'est PAS satisfait pour l'ensemble des familles — remis à **Partiel**,
jamais reformulé pour conserver artificiellement 7/7.

| # | Jalon | Statut | Critère de clôture | Preuve disponible |
|---|---|---|---|---|
| M1 | Génération initiale multi-familles (double-chargé, salon central/cour, circulation en L, empaquetage libre, corridor partagé) | **Terminé** | `generateVariants` produit ≥1 disposition admissible (0 erreur `independentVerify`) pour chaque cas "connu" de la batterie fixe | Batterie 11 cas (`scripts/test-plans-battery.mjs`) + 380 tests `scripts/test-plans-geometry.mjs` |
| M2 | Vérification géométrique indépendante (chevauchement, accessibilité réelle, ouvertures réellement extérieures) | **Terminé** | `independentVerify`/`computeReachableRooms` recalculent depuis la géométrie brute, jamais depuis un champ enregistré | Sections dédiées de `test-plans-geometry.mjs` (ex. recalcul d'union indépendant des surfaces) |
| M3 | Verrouillage + régénération partielle (préserve exactement position/dimensions/portes/fenêtres verrouillées) | **Terminé** | `regenerateUnlocked` ne modifie jamais une pièce verrouillée NI une pièce non verrouillée sous sa dimension cible (un placement qui l'exigerait est rejeté, jamais proposé réduit) ; propose ≥1 disposition nouvelle quand une existe géométriquement | Fixtures `plans-c8-resolu`/`plans-c2-resolu`/`plans-scenario*-post-regen`, scénario C9 salon verrouillé, accès avant/arrière/gauche/droite (sections 20/22, `scripts/test-plans-geometry.mjs`) — stratégie dédiée corridor partagé désormais réutilisée sur les 4 façades, voir journal |
| M4 | Export/réimport du fichier de projet (.json), round-trip fidèle | **Terminé** | `validateProjectFile` accepte le fichier exporté ; réimport reproduit la disposition exacte (dimensions, verrou, bilan de surfaces) | Fixtures `scripts/fixtures/plans-*.projet.json` ; section 21 (`serializeProject`→écriture→`validateProjectFile`, round-trip vérifié y compris le bilan de surfaces) ; vérifié en navigateur |
| M5 | Exports visuels SVG/PNG lisibles (légendes, cotes, aucune troncature) | **Terminé** | Inspection visuelle directe du SVG/PNG réellement exporté, aucun chevauchement ni texte coupé | Exports `c2_resolu`/`c9_regenere`/`acces_droite`/`acces_arriere_*` (SVG+PNG/JSON+fichiers de projet réels) envoyés et inspectés |
| M6 | Batterie fixe de cas représentatifs, catégorisés et mesurés en continu | **Terminé** | 11 cas couvrant proportions de terrain, programmes 2–3 chambres, 4 façades d'accès, dont un cas volontairement incompatible et un hors périmètre ; chaque cas catégorisé (connu/inconnu/incompatible démontré/hors périmètre), jamais un pass/fail | `scripts/test-plans-battery.mjs`, rejoué à chaque lot — C8/C9 régénération CORRIGÉS ce lot (voir journal) |
| M7 | Les 4 façades d'accès réellement raccordées, pour CHAQUE famille de disposition, EN GÉNÉRATION | **Partiel** | Entrée réellement raccordée (pas seulement déplacée) sur avant/arrière/gauche/droite, pour TOUTES les familles listées en M1 | Double-chargé : 4/4 (tests section 16/17). Corridor partagé : 4/4, 2 terrains dont un asymétrique (section 19). Empaquetage libre : `accessSide` géré nativement pour les 4 côtés dans le code (`geometry.ts:1562`), **non couvert par une preuve dédiée** dans ce lot. Salon central/cour (guidée) : **1/4 (avant seulement)**, refus explicite et documenté pour les 3 autres. Circulation en L : **1/4 (gauche seulement)**, refus explicite et documenté pour les 3 autres. |

---

## 3. Journal des lots

### Lot (en cours, après `33d0a11`) — régénération corridor partagé étendue à gauche/droite

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

**Vérifié** : accès gauche et droite, terrain carré symétrique (15×20) et
terrain non carré à reculs asymétriques (14×24), verrou côté entrée
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
- Vérifié : 4 façades × 2 terrains (carré symétrique, non carré à reculs
  asymétriques) × construction directe de la famille, 0 erreur
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
arrière/gauche/droite, terrain carré et non carré à reculs asymétriques),
et en régénération pour avant/arrière avec verrou strictement préservé /
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
