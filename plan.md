# Plan — paramètres et rapports propres à chaque livre

## Objectif

Conserver avec chaque livre les rapports personnalisés et les paramètres de justificatifs, afin qu’ils restent disponibles quand on change de livre et qu’ils puissent suivre celui-ci sur un autre appareil via Drive ou GitHub.

## Répartition des paramètres

- **Propres à chaque livre** : rapports personnalisés (nom et commande hledger), tag des justificatifs et dossier où ils sont rangés.
- **Propres à l’application / à l’appareil** : langue, thème et informations de connexion. Ils ne sont pas partagés avec le livre.

## Stockage envisagé

- Regrouper les données propres au livre dans un fichier de configuration compagnon du journal.
- Déclarer ce fichier dans le journal avec le mécanisme existant `choai-file`, afin qu’il voyage avec les autres fichiers du livre et reste ignoré par hledger.
- Le garder dans la copie locale du livre ; le mécanisme de synchronisation existant l’enverra vers Drive ou GitHub selon la destination du livre.
- Inclure le fichier dans les transferts locaux du livre (dossier ou archive), lorsque ces chemins de transfert prennent en charge les fichiers compagnons.
- Si le fichier de configuration est absent ou invalide, utiliser les valeurs par défaut et présenter une erreur récupérable pour les données invalides plutôt que de les interpréter silencieusement.

## Étapes

1. Définir le type et le format du fichier de configuration, avec seulement les rapports et paramètres de justificatifs.
2. Ajouter une lecture et une écriture rattachées au livre ouvert. Enregistrer la création du fichier et sa déclaration compagnon comme une seule écriture cohérente.
3. Remplacer le stockage global des rapports personnalisés par ce stockage par livre.
4. Remplacer le stockage global des paramètres de justificatifs par ce stockage par livre ; utiliser les paramètres du livre actif pour nommer et classer les justificatifs.
5. Revoir l’écran Paramètres pour distinguer explicitement les préférences de l’application des paramètres du livre actif.
6. Vérifier que les changements du fichier sont pris en charge par les synchronisations GitHub et Drive, ainsi que par les transferts locaux ; ajouter les tests nécessaires.

## Comportement attendu

- Chaque livre dispose de ses propres rapports, tag et dossier de justificatifs.
- Ouvrir un autre livre charge sa configuration, sans reprendre celle du livre précédent.
- Un livre sans configuration commence avec les valeurs par défaut.
- Les changements suivent le cycle normal de synchronisation du livre ; les conflits restent soumis aux règles de synchronisation déjà en place.
- Les préférences d’application et les secrets ne sont jamais écrits dans le fichier partagé.

## Hors périmètre

- Migrer ou préserver les rapports et paramètres actuellement conservés dans `localStorage` : le projet est en développement et aucune compatibilité ascendante n’est requise.
- Partager la langue, le thème ou les jetons d’accès.
- Ajouter un tableau de bord distinct : le besoin retenu concerne les rapports personnalisés déjà existants.
