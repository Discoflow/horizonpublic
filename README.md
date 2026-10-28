# Horizon — V1.2 · dernière version préparée

Application web installable pour organiser un univers personnel de 50 actifs, calculer les RSI hebdomadaire et mensuel de période 40, les SMA hebdomadaire/mensuelle configurables et leur distance au cours. La page publique utilise Supabase Auth et synchronise la liste d’actifs, les règles d’alerte et les préférences après connexion. **Aucun prix fictif n’est affiché.** L’envoi push et la planification des cours restent à configurer.

La V1.2 améliore la lisibilité mobile avec du texte, des icônes et des zones tactiles plus grands. Le code est préparé localement; il faut encore le déposer dans les dépôts GitHub pour que la page publiée le prenne en compte.

## Lancer en local

Node.js 20 ou supérieur est requis. Dans le dossier `outputs/investment-v1` :

```sh
node server.mjs
```

Ouvrir `http://localhost:4173`. Les données de suivi sont enregistrées localement dans ce navigateur. Pour effectuer les tests du moteur :

```sh
node --test tests/*.test.mjs
```

## Configuration des services

1. Créer une clé gratuite sur [Alpha Vantage](https://www.alphavantage.co/support/#api-key). Le quota public gratuit est de **25 requêtes par jour**. La configuration applique un plafond opérationnel initial de **20 appels/jour** pour garder cinq appels de marge. Ne passez pas ce plafond à 25 sans vérifier l’usage des autres intégrations/consommateurs de la clé.
2. Créer un projet Supabase. Le plan gratuit comprend notamment deux projets actifs, 500 Mo de base par projet, 5 Go d’egress et 500 000 invocations Edge Function, mais les projets peu actifs peuvent être mis en pause après une semaine. Il n’offre pas de sauvegarde automatique téléchargeable. Aucun service n’a été créé ni déployé par cette livraison.
3. Appliquer les migrations `supabase/migrations/` dans l’ordre. La deuxième migration associe les utilisateurs Auth déjà créés à leurs profils et accorde les droits minimaux du Data API sous RLS.
4. Dans Supabase Auth > URL Configuration, définir le Site URL de production et ajouter l’URL de la page aux Redirect URLs. L’application utilise la connexion par adresse e-mail et mot de passe; le trigger DB refuse les nouvelles adresses hors liste. Les profils existants sont vérifiés par leur ligne `public.profiles`.
5. Dans les secrets Edge Function, définir `ALPHA_VANTAGE_API_KEY`, `CRON_SECRET` (valeur aléatoire forte), et les variables Supabase `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` requises par le runtime. La clé Alpha Vantage et la clé service role restent côté serveur.
6. Déployer `supabase/functions/sync-market-data`, puis planifier un appel quotidien protégé par l’en-tête `x-cron-secret` avec Supabase Cron et `pg_net`. Les détails sont dans [Planification](docs/scheduling.md).

`.env.example` décrit les noms des variables, sans valeurs. Ne jamais préfixer un secret par `VITE_` ou le placer dans le navigateur.

## Fonctionnalités disponibles dans cette V1

- Interface responsive française, PWA avec cache hors ligne, liste de suivi et formulaire d’ajout/suppression.
- Priorités haute/moyenne/basse, tri, recherche, état explicite d’absence de données.
- Moteur indépendant de React et du fournisseur : calcul RSI Wilder, SMA, distance, agrégations clôturées lundi–dimanche et mois calendrier.
- Moteur de classement par vieillissement relatif à la priorité et sélection au coût de requête.
- Alertes en application avec état activé, seuil et machine à états de franchissement/réarmement.
- Connexion Supabase Auth, récupération de mot de passe et synchronisation par compte des actifs, alertes et préférences.
- Migrations RLS, garde d’univers, réservation atomique du quota et première Edge Function d’ingestion.

## Limites de cette livraison

- Les historiques de prix et données de marché sont lus depuis Supabase; la synchronisation automatique des prix, alertes push et tâches planifiées nécessitent encore la configuration du backend de marché.
- Pour conserver un démarrage sans dépendances ni téléchargement, l’interface est écrite en JavaScript natif modulaire plutôt qu’avec React/TypeScript/Vite. Le modèle reste modulaire; une migration du shell UI vers la pile préférée peut être faite ensuite.
- La fonction Edge récupère des closes journaliers et les range en historique partagé; l’intégration UI↔Supabase, le calcul persistant des indicateurs dans l’Edge Function et la configuration réelle de Cron restent à terminer avant l’usage cloud.
- Le bouton push demande l’autorisation navigateur pour une notification de démonstration locale. L’abonnement Web Push, l’envoi backend et le parcours sur appareil réel ne sont pas configurés ou vérifiés.
- L’évaluation de fraîcheur locale est volontairement approximative; elle ne charge pas les calendriers de jours fériés des bourses.
- Le backend appelle un endpoint par actif. Les séries hebdomadaires/mensuelles sont documentées mais la fonction de synchronisation stocke les closes journaliers afin de bâtir elle-même ses périodes.
- Un hôte HTTPS statique reste requis pour l’installation publique et les push. Ce dépôt ne contient aucun secret de déploiement ni compte d’hébergement.

## Architecture

Voir [architecture](docs/architecture.md), [moteur de calcul](docs/indicators.md), [Alpha Vantage](docs/alpha-vantage.md), [quotas](docs/quotas.md), [tâches planifiées](docs/scheduling.md), [notifications](docs/notifications.md) et [déploiement](docs/deployment.md).
