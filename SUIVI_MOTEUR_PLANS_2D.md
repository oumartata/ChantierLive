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
(aucune fonctionnalité ajoutée ici). **7/7 jalons terminés.** Un jalon
partiel ne compte jamais comme terminé — M7 ne passe à "Terminé" que
parce que son critère exact (entrée réellement raccordée sur les 4
façades, pour chaque famille EN GÉNÉRATION) est désormais mesuré vrai
pour toutes les familles, corridor partagé compris (lot `37fea69` et
suivant). Le critère de M7 ne porte PAS sur la régénération — ce point
reste une limite ouverte, consignée explicitement sous le tableau,
jamais dissimulée par la clôture de ce jalon.

| # | Jalon | Statut | Critère de clôture | Preuve disponible |
|---|---|---|---|---|
| M1 | Génération initiale multi-familles (double-chargé, salon central/cour, circulation en L, empaquetage libre, corridor partagé) | **Terminé** | `generateVariants` produit ≥1 disposition admissible (0 erreur `independentVerify`) pour chaque cas "connu" de la batterie fixe | Batterie 11 cas (`scripts/test-plans-battery.mjs`) + 253 tests `scripts/test-plans-geometry.mjs` |
| M2 | Vérification géométrique indépendante (chevauchement, accessibilité réelle, ouvertures réellement extérieures) | **Terminé** | `independentVerify`/`computeReachableRooms` recalculent depuis la géométrie brute, jamais depuis un champ enregistré | Sections dédiées de `test-plans-geometry.mjs` (ex. recalcul d'union indépendant des surfaces) |
| M3 | Verrouillage + régénération partielle (préserve exactement position/dimensions/portes/fenêtres verrouillées) | **Terminé** | `regenerateUnlocked` ne modifie jamais une pièce verrouillée ; propose ≥1 disposition nouvelle quand une existe géométriquement | Fixtures `plans-c8-resolu`/`plans-c2-resolu`/`plans-scenario*-post-regen`, scénario C9 salon verrouillé (commit `bdd22fd`), accès arrière (ce lot) |
| M4 | Export/réimport du fichier de projet (.json), round-trip fidèle | **Terminé** | `validateProjectFile` accepte le fichier exporté ; réimport reproduit la disposition exacte | Fixtures `scripts/fixtures/plans-*.projet.json`, vérifié en navigateur (export → réimport, verrou conservé) |
| M5 | Exports visuels SVG/PNG lisibles (légendes, cotes, aucune troncature) | **Terminé** | Inspection visuelle directe du SVG/PNG réellement exporté, aucun chevauchement ni texte coupé | Exports `c2_resolu`/`c9_regenere`/`acces_droite`/`acces_arriere_*` (SVG+PNG/JSON) envoyés et inspectés |
| M6 | Batterie fixe de cas représentatifs, catégorisés et mesurés en continu | **Terminé** | 11 cas couvrant proportions de terrain, programmes 2–3 chambres, 4 façades d'accès, dont un cas volontairement incompatible et un hors périmètre ; chaque cas catégorisé (connu/inconnu/incompatible démontré/hors périmètre), jamais un pass/fail | `scripts/test-plans-battery.mjs`, rejoué à chaque lot, nombres protégés inchangés |
| M7 | Les 4 façades d'accès réellement raccordées, pour CHAQUE famille de disposition, EN GÉNÉRATION | **Terminé** | Entrée réellement raccordée (pas seulement déplacée) sur avant/arrière/gauche/droite, pour toutes les familles | Double-chargé : 4/4 façades (tests section 16/17). Corridor partagé : 4/4 façades, 2 terrains dont un non carré à reculs asymétriques (tests section 19, 56 assertions) |

---

## 3. Journal des lots

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

**Tests** : 253/253 (`scripts/test-plans-geometry.mjs`, +102 depuis le lot
précédent : sections 19 et 20). Batterie 11 cas rejouée sans modification
de ses paramètres, tous les nombres protégés inchangés (C1=26,52 m²,
C2=34,62 m², C8 génération=29,74/régénération=[26,17], C9
génération=34,62/régénération=[26,5 / 27,00 / 31,78 / 35,68 / 35,69],
C10=36 dispositions/24,54, C11=18/26,52) ; C3/C10/C11 trouvent
légitimement PLUS de variantes qu'avant (famille corridor partagé
désormais correctement applicable à gauche/droite/arrière) — jamais une
régression, une amélioration mesurée sur les mêmes fixtures protégées.

**Correction de formulation (« limite mathématique prouvée »)** :
l'entrée du lot `bdd22fd` ci-dessous emploie cette expression pour le cas
C2 sans préciser la famille ni les hypothèses concernées — corrigé ici
plutôt que réécrit, pour ne pas effacer l'historique : il s'agit
STRICTEMENT de la famille « corridor partagé entre deux rangées »
(`buildSharedCorridorLayoutStraight`), pour LE programme exact de C2 (2
pièces en rangée avant, 3 en rangée arrière, dont 3 chambres) sur LE
terrain exact de C2 (20×14 m, reculs du cas), prouvée par énumération
EXHAUSTIVE de toutes les bipartitions de types possibles pour cette
configuration précise — jamais une impossibilité architecturale générale,
jamais valable pour un autre programme, terrain, ou famille de
disposition.

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
28/68 (41 %) / 7/7 jalons moteur terminés / 3 cycles effectués (sur 5
autorisés, arrêt anticipé — objectif de génération atteint et vérifié sur
4 façades, régénération étendue avec succès à l'accès arrière) / résultat
utilisateur : corridor partagé désormais disponible sur les 4 façades en
génération initiale (avant/arrière/gauche/droite, terrain carré et non
carré à reculs asymétriques), et en régénération pour avant/arrière avec
verrou strictement préservé / limite principale : régénération à corridor
partagé non étendue à gauche/droite (repère virtuel entier, limite ouverte
documentée, jamais forcée — recherche générale utilisée à la place, sans
résultat invalide) / commit à suivre (voir état Git du compte rendu).
