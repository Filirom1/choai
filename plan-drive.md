# Plan d'Architecture & Implémentation : Support Google Drive & Refactoring Remote Sync

Ce document sert de feuille de route complète et rigoureuse pour l'agent suivant. Il définit la stratégie pour intégrer **Google Drive** comme fournisseur de synchronisation distant sans entremêler le code existant de GitHub, en refactorant vers une architecture modulaire et découplée.

---

## 1. Principes & Objectif de Conception

### Le constat
Le code actuel lie directement la notion de `Remote` (`owner`, `repo`, `branch`, `path`) et la route `/git` à l'implémentation spécifique de GitHub. Tenter d'y insérer des gardes de types (`if (isGitHubRemote) ... else ...`) dans tous les fichiers (`kept-in-view.ts`, `GitExplorer.tsx`, `where.ts`, `sync.ts`) dégrade la lisibilité, viole le principe ouvert/fermé (OCP) et crée un couplage fort entre deux services tiers qui n'ont rien en commun.

### L'objectif
1. **Isoler chaque fournisseur distant** dans son propre module (`core/github/` et `core/google-drive/`).
2. **Introduire un contrat d'abstraction `RemoteProvider`** (ou registre fonctionnel) pour les opérations génériques (push, pull, statut, liens vers les pièces jointes).
3. **Respecter scrupuleusement les règles du projet** (`CLAUDE.md`) :
   - 100% PWA côté client, sans serveur intermédiaire.
   - Fonctions pures, immuabilité, composition, typage strict via `Result<T, E>`.
   - Pas de `throw`, pas de mutations sauvages, `undefined` par défaut.
   - Les messages d'erreurs restent typés (les vues décident du texte).
   - Invariants de frontières stricts vérifiés par `tests/boundary.test.ts`.

---

## 2. Décisions Métier & Techniques Validées

1. **Authentification Google Drive :**
   - Client OAuth SPA officiel Google Identity Services (`google.accounts.oauth2.initTokenClient`).
   - Scope restreint : `https://www.googleapis.com/auth/drive.file` (accès uniquement aux fichiers/dossiers ouverts ou créés par l'application).
   - Durée de vie du token : 1h. En cas d'expiration ou de 401, on réinvite l'utilisateur à cliquer pour rouvrir la pop-up OAuth.
   - Saisie du Google Client ID dans l'UI (avec mémorisation dans IndexedDB et valeur par défaut issue du projet de test : `869320600994-2l2ahavcrd0tcm50qh3kummla72baiqp.apps.googleusercontent.com`).

2. **Sélection & Organisation des Fichiers sur Drive :**
   - Choix du dossier via le **Google Drive Picker** (`google.picker.PickerBuilder` avec vue FOLDERS).
   - Alternative/fallback : listing direct des dossiers via l'API Drive ou saisie manuelle de l'identifiant / URL du dossier Drive.
   - Recherche des fichiers d'un livre au sein du dossier parent : `'${folderId}' in parents and trashed = false`.
   - Résolution des `include` et des compagnons (`.jsonl`) par nom relatif dans ce dossier.

3. **Gestion des Conflits :**
   - **Blocage strict en cas de conflit** : aucune fusion automatique pour Google Drive.
   - Détection par en-tête `If-Match: etag` / `md5Checksum`. Si l'API Drive répond `412 Precondition Failed` ou si le etag distant ne correspond plus à l'accord local (`agreed`), l'écriture est arrêtée et l'erreur de conflit est remontée à l'UI.

4. **Intégration UI :**
   - **Écran d'accueil (`Welcome.tsx`)** : bouton "Prendre depuis Google Drive" au même niveau que "Prendre depuis GitHub".
   - **Route d'ajout (`/add`)** : fragment `#gdrive` affichant `GoogleDrivePanel`.
   - **Panneau distant (synchronisation)** : affichage du panneau adapté selon le provider configuré pour le livre ouvert.

---

## 3. Architecture Cible & Refactoring

### Étape 1 : Modèle de données & Abstraction (`src/core/journal/remote.ts`)

Créer un module dédié à l'abstraction distante plutôt que de figer GitHub dans `kept.ts` :

```ts
// src/core/journal/remote.ts

export interface GitHubRemote {
  readonly provider: "github"
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly path: string
}

export interface GoogleDriveRemote {
  readonly provider: "google-drive"
  readonly folderId: string
  readonly folderName: string
  readonly path: string
}

export type Remote = GitHubRemote | GoogleDriveRemote

/** Contrat commun que chaque fournisseur implémente */
export interface RemoteProvider<R extends Remote> {
  readonly id: R["provider"]
  readonly name: string
  readonly isConnected: (remote: R) => boolean
  readonly labelOf: (remote: R) => string
  readonly evidenceUrl?: (remote: R, relativePath: string) => string | undefined
  readonly pull: (remote: R, bookId: string) => Promise<Result<PullOutcome, RemoteSnag>>
  readonly push: (remote: R, bookId: string, message?: string) => Promise<Result<PushOutcome, RemoteSnag>>
  readonly behind: (remote: R, bookId: string) => Promise<Result<readonly string[], RemoteSnag>>
  readonly unsent: (remote: R, bookId: string) => Promise<Result<readonly UnsentFile[], RemoteSnag>>
}
```

*Note sur la rétrocompatibilité des données stockées dans IndexedDB* : les anciens livres enregistrés avec `{ owner, repo, branch, path }` sans champ `provider` doivent être automatiquement normalisés en `provider: "github"`.

---

### Étape 2 : Implémentation du module `src/core/google-drive/`

Créer le package fonctionnel `apps/web/src/core/google-drive/` :

```
src/core/google-drive/
├── api.ts       # Appels REST purs vers googleapis.com/drive/v3 (fetch, typage des réponses)
├── auth.ts      # Chargement GIS (accounts.google.com/gsi/client), initTokenClient, gestion de session
├── picker.ts    # Chargement Picker (apis.google.com/js/api.js) et dialogue de sélection de dossier
├── kept.ts      # Stockage IndexedDB des tokens, client_id, etags et accords (agreed)
├── sync.ts      # Implémentation du RemoteProvider : pull, push avec If-Match, détection de conflit
└── index.ts     # Point d'entrée exportant le provider et ses types
```

#### Détail des fonctions clés dans `api.ts` :
- `whoami(token: string)`: `GET /drive/v3/about?fields=user`
- `listFilesInFolder(token: string, folderId: string)`: `GET /drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,etag,md5Checksum,modifiedTime,size)`
- `getFileContent(token: string, fileId: string)`: `GET /drive/v3/files/${fileId}?alt=media`
- `createFile(token: string, folderId: string, name: string, content: string)`: upload multipart vers `/upload/drive/v3/files?uploadType=multipart`
- `updateFile(token: string, fileId: string, content: string, etag?: string)`: `PATCH /upload/drive/v3/files/${fileId}?uploadType=media` avec `If-Match: etag`.

#### Détail du sync dans `sync.ts` :
- `pull` : lit `main.journal` et ses `include`s via `openBringingMissing`, enregistre les `etag`s dans `agree`.
- `push` : vérifie pour chaque fichier local modifié si l'etag sur Drive correspond à l'accord. Si non, ou si l'API renvoie 412, échec immédiat `{ at: "conflict", path }`.

---

### Étape 3 : Composants UI Découplés

Ne pas modifier `GitHubPanel` ni encombrer `GitExplorer` de conditions GitHub vs Drive. Créer des composants spécialisés et un conteneur propre :

1. **`src/core/components/take-from-google-drive.tsx`** :
   Bouton symétrique à `TakeFromGitHub`, redirigeant vers `/add#gdrive`.

2. **`src/core/components/google-drive-panel.tsx`** :
   Composant SolidJS dédié avec :
   - Saisie du Google Client ID (pré-rempli ou modifiable).
   - Bouton "Se connecter avec Google".
   - Bouton "Choisir un dossier" (Drive Picker) ou sélection d'un dossier existant.
   - Actions : "Prendre depuis Google Drive" (si nouveau livre) ou "Synchroniser".
   - Messages d'états clairs et affichage des conflits (sans écrasement).

3. **Intégration dans `apps/web/src/core/routes/add.tsx`** :
   Le routeur d'ajout dispatche proprement :
   - `#github` -> `FromGitHub` (`<GitHubPanel />`)
   - `#gdrive` -> `FromGoogleDrive` (`<GoogleDrivePanel />`)
   - défaut -> `<Welcome adding />`

4. **Intégration dans l'écran d'accueil (`Welcome.tsx`)** :
   Ajouter `<TakeFromGoogleDrive />` aux côtés de `<TakeFromGitHub />`.

5. **Panneau distant pour le livre ouvert (`SourceControl` / `/git`)** :
   - Si le livre ouvert est lié à GitHub -> afficher la vue GitHub.
   - Si le livre ouvert est lié à Google Drive -> afficher la vue Google Drive (`GoogleDrivePanel` / statut de synchronisation Drive).

---

### Étape 4 : Traduction (i18n) & Localisation

Ajouter le vocabulaire `gdrive` dans `apps/web/src/core/i18n/` :
- `en.ts` : référence maîtresse.
- `fr.ts` : traduction française.
- `ja.ts` : traduction japonaise.

Clés recommandées :
- `books.fromGoogleDrive`
- `gdrive.title`, `gdrive.clientId`, `gdrive.connect`, `gdrive.connectedAs`, `gdrive.pickFolder`, `gdrive.folder`, `gdrive.pull`, `gdrive.push`, `gdrive.conflict`, `gdrive.working`, `gdrive.unauthorised`, `gdrive.offline`.

---

### Étape 5 : Frontières & Tests (`tests/boundary.test.ts`)

1. **Règle d'écriture (`writers`)** :
   Dans `apps/web/tests/boundary.test.ts`, ajouter `"core/google-drive/sync.ts"` à la liste autorisée des modules écrivant dans le journal :
   ```ts
   // apps/web/tests/boundary.test.ts
   "core/google-drive/sync.ts",
   ```
2. **Tests unitaires** :
   Créer `tests/google-drive.test.ts` testant les fonctions pures :
   - Construction des requêtes multipart.
   - Détection des conflits à partir des etags.
   - Normalisation des chemins et gestion des erreurs.
3. **Vérification finale** :
   - `cd apps/web && bunx tsc -b` -> 0 erreurs.
   - `cd apps/web && bun test tests/` -> tous les tests passent.

---

## 4. Checklist d'exécution pour l'agent

- [ ] 1. Créer `src/core/journal/remote.ts` pour déclarer l'union `Remote = GitHubRemote | GoogleDriveRemote` et normaliser l'existant.
- [ ] 2. Créer `src/core/google-drive/api.ts` (requêtes REST Google Drive v3 pures, typage des résultats).
- [ ] 3. Créer `src/core/google-drive/auth.ts` (GIS OAuth SPA, stockage du token).
- [ ] 4. Créer `src/core/google-drive/picker.ts` (Google Picker pour sélection du dossier).
- [ ] 5. Créer `src/core/google-drive/kept.ts` (mémorisation IndexedDB des etags convenus).
- [ ] 6. Créer `src/core/google-drive/sync.ts` (sync pull/push avec blocage sur 412/conflit et enregistrement dans `writers` de boundary.test.ts).
- [ ] 7. Créer `src/core/components/google-drive-panel.tsx` et `take-from-google-drive.tsx`.
- [ ] 8. Mettre à jour `Welcome.tsx` et `add.tsx` pour intégrer `#gdrive`.
- [ ] 9. Adapter la vue distante (`/git` ou explorateur) pour afficher le panneau Google Drive lorsque le livre actif est sur Drive.
- [ ] 10. Compléter `en.ts`, `fr.ts`, `ja.ts`.
- [ ] 11. Valider avec `bunx tsc -b` et `bun test tests/`.
