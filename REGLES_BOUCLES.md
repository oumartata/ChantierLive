# Règles des boucles — ChantierLive

Référence unique pour toutes les boucles à partir du 2026-10-06. Reprend,
condensées, les règles permanentes de `PASSATION_CLAUDE_CHAT.md` §4, avec les
précisions décidées depuis par le fondateur. En cas de doute, le fondateur
tranche ; l'agent s'arrête et signale.

---

## 1. Règles permanentes

### Git, publication, supports
- **R1** Aucun push par l'agent : le fondateur pousse lui-même. Aucune
  fusion ni déploiement sans décision explicite du fondateur pour ce cas
  précis.
- **R2** Commits locaux seulement, identifiables, en français
  (`feat(...)`, `docs(...)`…), terminés par la ligne d'attribution de
  l'agent.
- **R3** Préserver le travail présent : jamais de `git stash`, aucun
  nettoyage automatique ; écart d'état au départ = arrêt.
- **R4** Lecteurs `D:` et `E:` interdits (aucune lecture, écriture ni
  opération). `F:` autorisé pour les sauvegardes seulement. Projet
  `FuturePro` interdit.

### Base de données
- **R5** Aucune base distante, aucune donnée réelle : tout se fait sur
  Supabase **local**.
- **R6** Migrations : uniquement avec l'accord explicite du fondateur, en
  local seulement ; avant application, cible locale confirmée et
  sauvegarde schéma + données **vérifiée** dans `.local_backups/` (non
  versionné) ; jamais de réinitialisation ni de purge ; jamais de
  modification d'une migration appliquée (nouveau fichier, nouvel
  identifiant). Prochain identifiant libre au 2026-10-06 : **M036** (à
  revérifier dans `supabase/migrations/`).

### Secrets et comptes
- **R7** Ne jamais afficher de mot de passe ni de clé. Ne pas lire ni
  afficher les fichiers d'identifiants (`scripts/.demo-credentials*.json`,
  `exports/preuves/f2-demandes-2026-10-06/.compte-demo.json`). Connexion de
  démonstration par un serveur local à usage unique qui sert les
  identifiants au navigateur sans les afficher. Ne réinitialiser aucun mot
  de passe existant.
- **R8** Comptes : n'en créer que si nécessaire et autorisé ; réutiliser
  d'abord les comptes de démonstration existants.

### Écriture et données utilisateur
- **R9** Documents écrits sans laisser le shell interpréter accents graves
  ni substitutions (outils d'édition, ou heredoc entre guillemets
  simples).
- **R10** Brouillons : jamais remplacés sans confirmation explicite ;
  possibilités de récupération préservées.

### Métier, sécurité, interface
- **R11** Séparation métier : le propriétaire voit prix convenu,
  versements, avancement et médias partagés ; dépenses internes, achats et
  justificatifs de l'entreprise ne lui sont **jamais** exposés ; être
  propriétaire ou membre d'une organisation ne donne accès à aucun
  chantier — seule l'adhésion active au chantier compte.
- **R12** Accès toujours vérifiés côté serveur, jamais déduits d'un
  paramètre envoyé par le navigateur.
- **R13** Interface : composants existants (`src/components/ui`), aucun
  compteur ni pourcentage inventé, aucun total financier entre chantiers
  sans signification établie.

---

## 2. Vérifications proportionnées

- **V1** Tests ciblés : **toujours**, pour ce qui change.
- **V2** `npm run verify` (lint, typecheck, tests, build) : **seulement avant
  un commit de code**, sur la version finale ; relancé si le code change
  après lui ; jamais pour un commit de documents seuls.
- **V3** Navigateur : **seulement si l'interface change**, sur ordinateur et
  à 390 px de large ; preuves rangées hors Git dans
  `exports/preuves/<sujet>-<date>/`, sans secret.
- **V4** Tests dépendant de la charge machine : aucun test connu (« B3
  Chambre 2 » et n° 28 corrigés en boucles 6 et 6b). Tout échec est
  rapporté tel quel.

---

## 3. Format de consigne

```
OBJECTIF : <un seul résultat>
Départ : C:\Projets\ChantierLive, branche <branche>, HEAD <hash>. Vérifie l'état ; arrête-toi en cas d'écart.
FINI QUAND : <critères mesurables>
HORS PÉRIMÈTRE : <liste>
ARRÊT SI : <conditions d'arrêt, dont toute décision non écrite>
Cycles max : <N>. Bilan au format court.
```

---

## 4. Format de bilan court (20 lignes maximum)

```
Résultat : fait | partiel | bloqué — <une ligne>
Critères :
- <critère> : prouvé | absent — <preuve chiffrée>
- ...
Écarts et décisions attendues :
- <écart ou décision, ou « aucun »>
Commit : <hash ou « aucun »> — statut Git : <propre / détail>
<compteur> / <cycles> / <résultat> / <commit>
```

Règles du bilan : distinguer prouvé, affirmé sans preuve et absent ;
zéro, information absente et lecture impossible ne se confondent pas ;
aucune garantie absolue ; une tâche du backlog n'est terminée que sur
validation du fondateur (compteur inchangé sinon).
