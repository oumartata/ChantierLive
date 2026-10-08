# Proposition B046 — rapport PDF simple

Boucle 37, étape 2 (2026-10-08). Aucun code B046, aucune migration, aucune
bibliothèque installée. Le cadre du rapport existe :
- instantané autorisé et identifié ;
- date de génération et période ;
- mention « pas une expertise » ;
- respect des permissions du générateur.

En revanche, plusieurs règles manquent ou se contredisent :
- le **contenu pour l'entreprise et pour le chef de chantier** ;
- les **sections exactes** ;
- le **stockage** ;
- la **trace de génération** au regard de D186 ;
- les **photos** ;
- le choix d'une **bibliothèque**.

Décisions R1 à R10 attendues du fondateur.

## 1. Sources citées

- **B046** (MVP_BACKLOG, L07, P0, dépend de B028 et B031) : « Générer
  rapport PDF simple ». done_when : « instantané identifié et autorisé ».
- **B047** (anticipation, L07, P1) : partage manuel vers WhatsApp ;
  done_when : « lien expirant ou fichier partagé ».
- **Exigences**
  - FR135 / AC135 : rapport d'un chantier et d'une **période**, par
    `Owner|Contractor` ; « erreur relançable » en cas d'échec.
  - FR136 / AC136 : « résumé ; phases ; journaux ; **dépenses
    autorisées** ; incidents et **décisions** » ; seules les données
    autorisées.
  - FR137 / AC137 : date de génération et période en en-tête ou pied.
  - FR138 / AC138 : télécharger (le partage relève de B047).
  - FR139 / AC139 : permissions du générateur, aucune donnée hors
    périmètre.
  - FR140 / AC140 : avertissement « pas une expertise technique ».
- **Règles**
  - BR079 : PDF généré depuis un **instantané autorisé** avec un
    **identifiant** ; une régénération peut différer si les données ont
    changé.
  - BR080 : outil de suivi, ni expertise, ni certification, ni garantie
    de conformité.
  - BR057 / AC090 : tout rapport d'acompte rappelle le caractère
    déclaratif.
  - **BR098** : jamais de rapport ni d'export dérivé des finances
    internes pour le client.
- **Décisions**
  - D034 (**PROPOSED**) : avertissements obligatoires pour preuves,
    acomptes, rapports.
  - D183, D185, D187 : finances internes.
  - D186 : audit du chantier lisible par l'entreprise seule.
  - D169 / D172 : visibilité des documents.
  - D191 : commentaires retirés ou modérés.
  - D199 : liste blanche des notifications ; une génération de rapport
    n'en produit pas.
- **Permissions**
  - REPORT_GENERATE : propriétaire principal A, copropriétaire A,
    entreprise A, chef de chantier **C** (« selon données visibles ») ;
    PROJECT_EXPORT : chef de chantier C, « limité aux rapports
    autorisés ».
  - REPORT_SHARE (B047).
- **Écrans et textes**
  - SCR046 `/chantiers/:id/rapports` ; SCR047 aperçu
    (`/rapports/:reportId`) ; disclaimer REPORT_TRACE_NOT_CERTIFICATION.
  - TXT060 « Générer le rapport ».
  - TXT061 « Rapport généré le {date} à partir des données synchronisées
    disponibles. »
- **Principes de la boucle**
  - le rapport ne contient que ce que le rôle voit, recalculé à la
    génération ;
  - jamais de finance interne, budget, reçu, document « Entreprise
    seulement », brouillon ou commentaire masqué dans un rapport
    propriétaire ;
  - aucun chiffre inventé (R13) ;
  - « Avancement déclaré » et « Avancement validé » jamais fusionnés ;
  - nom de fichier sans donnée sensible.
- **Existant** : aucune bibliothèque PDF ; toutes les lectures par rôle
  existent déjà sous forme de fonctions contrôlées en base (journaux
  publiés, incidents, photos, documents, étapes, versements, devis,
  avenants).

## 2. Ce qui est établi

- Le rapport est généré **côté serveur, à la demande**, avec la session de
  la personne. Les données sont lues par les **mêmes fonctions** que les
  écrans de l'application : le rapport ne peut contenir que ce que le rôle
  voit, recalculé à l'instant. Ex-membre et non-membre sont refusés par
  ces fonctions.
- Mentions en tête et en pied de chaque page :
  - date et heure de génération ;
  - période ;
  - identifiant du rapport ;
  - « Rapport généré le {date} à partir des données synchronisées
    disponibles » (TXT061) ;
  - « Outil de suivi : ni expertise, ni certification, ni garantie de
    conformité » (BR080) ;
  - « Aucune preuve n'est garantie authentique par ChantierLive » ;
  - section versements : « Déclarations entre les parties ; ChantierLive
    n'encaisse rien » (BR057).
- « Avancement déclaré » (étapes déclarées terminées) et « Avancement
  validé » (étapes validées par le propriétaire principal) sont deux
  colonnes ou sections **distinctes**.
- Chiffres : seulement des valeurs stockées ou des comptes de lignes
  affichés (R13) ; aucun pourcentage recalculé autrement que l'écran
  Avancement.
- Format : A4 portrait, texte d'au moins 10 points, une colonne. C'est
  lisible sur téléphone sans défilement horizontal.

## 3. Règles manquantes ou contradictoires

1. **Entreprise** : FR136 cite « dépenses autorisées », mais les principes
   et BR098 interdisent toute finance interne dans un rapport client. Rien
   ne dit si le rapport de l'entreprise peut, lui, contenir ses dépenses
   et son budget.
2. **Chef de chantier** : REPORT_GENERATE vaut « C » (conditionnel), mais
   la condition n'est écrite nulle part ; FR135 ne cite que
   `Owner|Contractor`.
3. **Sections** : FR136 (« phases ; journaux ; dépenses ; incidents et
   décisions ») et la liste de la boucle (« avancement déclaré et validé,
   journaux, incidents, photos, documents partagés, versements ») ne
   coïncident pas. Les décisions (devis, avenants) et les commentaires ne
   sont pas tranchés.
4. **Photos** : images intégrées (poids du fichier sur téléphone,
   formats) ou simple liste ? Non défini.
5. **Période** : bornes, durée maximale et valeur par défaut non définies.
6. **Instantané et stockage** (BR079) : rien ne dit si le PDF est
   **conservé** (compartiment privé, durée) ou **régénéré** à la demande
   avec une empreinte. SCR047 prévoit un aperçu par `reportId`, ce qui
   laisse penser à un rapport conservé.
7. **Trace de génération** : l'audit du chantier n'est lisible que par
   l'entreprise (D186). Y inscrire qu'un propriétaire a généré un rapport
   révélerait son activité à l'entreprise. Aucune règle ne le tranche.
8. **D034** est encore PROPOSED : la mention « aucune preuve garantie
   authentique » vient de la boucle, non d'une décision écrite.
9. **Caractères** : les polices PDF standard ne couvrent que le jeu
   latin. Un texte saisi avec d'autres caractères (émoji, autre écriture)
   ne s'affiche pas sans police intégrée.
10. **Bibliothèque** : nouvelle dépendance à justifier (§5, R10).

## 4. Décisions attendues (A = recommandation)

- **R1. Rapport de l'entreprise.**
  - **A** : au MVP, **un seul modèle de « rapport de suivi »** pour tous
    les rôles, sans aucune finance interne (ni dépense, ni budget, ni
    reçu), même pour l'entreprise. FR136 « dépenses autorisées » est
    précisée : « aucune dépense interne dans le rapport de suivi au
    MVP ».
  - **B** : l'entreprise peut ajouter une section « Finances internes »
    à son propre rapport, marquée « Document interne, ne pas transmettre
    au client ».
  - *Recommandation A* : un rapport est fait pour circuler (B047) ; un
    rapport interne viendra plus tard s'il est demandé.
- **R2. Chef de chantier.**
  - **A** : autorisé, avec les sections qu'il voit dans l'application :
    pas de versements, ni de devis ou d'avenants, et documents selon leur
    visibilité. REPORT_GENERATE précisé.
  - **B** : non autorisé au MVP.
  - *Recommandation A.*
- **R3. Sections** (ordre), chacune limitée à la période sauf l'état
  courant :
  - **A** :
    1. résumé (nom du chantier, période, statut, état de la licence,
       nombre d'éléments par section) ;
    2. avancement déclaré ;
    3. avancement validé (étapes, dates, sans pourcentage inventé) ;
    4. journaux publiés (texte de la version en vigueur) ;
    5. incidents (signalés dans la période, et ceux encore ouverts) ;
    6. photos (voir R4) ;
    7. documents partagés (titre, type, date ; jamais « Entreprise
       seulement » pour un autre rôle que l'entreprise) ;
    8. versements (déclarés, confirmés ou contestés, montants
       déclaratifs ; rôles qui les voient) ;
    9. décisions (devis et avenants acceptés ou refusés dans la période,
       montants contractuels ; rôles qui les voient).
    Commentaires exclus au MVP.
  - **B** : A plus les commentaires visibles (jamais les retirés ni les
    modérés).
  - *Recommandation A.*
- **R4. Photos.**
  - **A** : au MVP, liste seulement (nombre, dates, légendes), sans
    image.
  - **B** : jusqu'à 12 miniatures JPEG réduites par rapport.
  - *Recommandation A* : un fichier léger pour le téléphone et WhatsApp.
- **R5. Période.**
  - **A** : choix « 7 derniers jours » (par défaut), « 30 derniers
    jours » ou dates libres. Au plus 92 jours, jamais dans le futur.
  - *Recommandation A.*
- **R6. Instantané et stockage.**
  - **A** : **régénéré à la demande, non conservé**. Chaque génération
    reçoit un identifiant, imprimé sur le PDF, et laisse une trace :
    identifiant, chantier, rôle, période, empreinte SHA-256 du fichier,
    date. Deux générations successives peuvent donc différer (BR079).
    L'aperçu SCR047 devient la page du rapport fraîchement généré.
  - **B** : PDF conservé dans un compartiment privé (durée à fixer),
    réouvrable par son identifiant.
  - *Recommandation A* : rien de privé ne s'accumule. B047 pourra
    choisir le partage du fichier par le téléphone, sans lien.
- **R7. Trace de génération.**
  - **A** : table dédiée `report_generations`, lisible seulement par la
    personne qui a généré (et par le serveur), **jamais** dans l'audit du
    chantier ni le journal de l'entreprise.
  - **B** : dans l'audit du chantier (visible de l'entreprise).
  - *Recommandation A* (D186 : ne pas révéler l'activité d'une partie à
    l'autre).
- **R8. Mentions obligatoires** : valider D034 pour les rapports, avec
  les cinq mentions du §2.
  - *Recommandation : D034 VALIDATED pour les rapports.*
- **R9. Caractères.**
  - **A** : police standard. Un caractère non affichable est remplacé par
    « ? » ; le pied de page l'indique si cela se produit. Aucune police
    intégrée.
  - **B** : police libre intégrée (par exemple Noto Sans, licence OFL,
    environ 500 Ko) pour couvrir plus d'écritures.
  - *Recommandation A* au MVP (français).
- **R10. Bibliothèque** (taille et licence vérifiées sur le registre npm
  le 2026-10-08).

  | Bibliothèque | Licence | Taille décompressée | Dernière version | Atouts / limites |
  |---|---|---|---|---|
  | **pdfkit** 0.20.x | MIT | 10,3 Mo | 2026-08-30 (maintenue) | coupure des lignes et pagination intégrées, serveur Node |
  | pdf-lib 1.17.1 | MIT | 19 Mo | 2021-11 (plus maintenue) | pas de coupure de lignes automatique |
  | jsPDF 4.x | MIT | 29,5 Mo | maintenue | orientée navigateur |
  | @react-pdf/renderer | MIT | petite, mais ajoute pdfkit et une dizaine de paquets | maintenue | modèle React, plus de dépendances |

  - **A** : **pdfkit**, côté serveur seulement, en dépendance de
    l'application. Pour les tests, **pdfjs-dist** (Apache-2.0, 34 Mo)
    sert à **extraire le texte** du PDF et y appliquer le scanner. Il
    reste en dépendance de développement seulement, dans une version
    publiée depuis au moins deux semaines (la 6.4.299 n'a que 5 jours).
  - **B** : pdf-lib (plus de maintenance, coupure des lignes à écrire
    soi-même).
  - *Recommandation A.*

## 5. Réalisation prévue après décision

- **M053** (accord requis), seulement si R7 A : table `report_generations`
  (insertion seule, lecture par son auteur) et fonction
  `record_report_generation`.
- **Génération** :
  - route serveur `/chantiers/:id/rapports/pdf?du=…&au=…` ;
  - lectures par les fonctions existantes avec la session de la
    personne ;
  - PDF pdfkit ;
  - nom de fichier `rapport-chantier-<identifiant court>-<du>_<au>.pdf`,
    sans nom de chantier ni de personne ;
  - trace de génération.
- **Tests**
  - Contenu par rôle (4 rôles) ; ex-membre et non-membre refusés.
  - Le scanner de confidentialité est appliqué au **texte extrait** du PDF
    (pdfjs-dist) pour chaque rôle : finances internes, budget, reçus,
    documents « Entreprise seulement », brouillons, commentaires retirés,
    identités. Contrôle positif capable d'échouer (R15).
  - « Déclaré » et « validé » séparés ; mentions présentes ; nom de
    fichier vérifié.
- **Écrans** : SCR046 « Rapports » (période, bouton « Générer le
  rapport »). Vérification navigateur sur ordinateur et à 390 px pour les
  4 rôles, avec ouverture du PDF.
