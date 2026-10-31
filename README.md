# Patrimoine

Appli web perso de suivi de patrimoine : graphique du patrimoine net façon Google Finance, placements cotés (ETF, actions, crypto) avec achats/ventes et prix récupéré automatiquement, biens (voiture, immobilier, livrets) et dettes.

- `index.html` : l'appli (fichier unique, données stockées dans le navigateur).
- `worker.js` : relais de prix à déployer sur Cloudflare Workers (Yahoo Finance + CORS).

## Mise en route
1. Déployer `worker.js` sur Cloudflare Workers et copier son adresse.
2. Activer GitHub Pages (Settings → Pages → branche `main`, dossier `/`).
3. Ouvrir l'appli, Réglages → coller l'adresse du relais → Tester → Enregistrer.
