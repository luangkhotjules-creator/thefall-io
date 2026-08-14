# TheFall.io — clone 3D

Jeu solo/multijoueur jouable directement dans le navigateur (Three.js), avec
un petit serveur Node.js optionnel pour le multijoueur.

## Jouer en local

```
python3 -m http.server 8080
```
puis ouvrir http://localhost:8080/index.html

## Rendre le site public et gratuit

### 1. Le jeu (site statique) → GitHub Pages

1. Crée un dépôt GitHub (public) et pousse ce dossier dedans :
   ```
   gh auth login          # une seule fois, suit les instructions à l'écran
   gh repo create thefall-io --public --source=. --remote=origin --push
   ```
2. Sur GitHub : **Settings → Pages → Source : Deploy from a branch → Branch : main / (root) → Save**.
3. Le site est en ligne quelques minutes après, à une adresse du type :
   `https://<ton-pseudo-github>.github.io/thefall-io/`

### 2. Le serveur multijoueur (`server.js`) → Render.com (gratuit)

1. Va sur https://render.com et connecte-toi avec ton compte GitHub.
2. **New → Web Service**, choisis le dépôt `thefall-io` que tu viens de créer.
3. Render détecte automatiquement `render.yaml` (déjà présent dans ce dépôt) :
   Node, plan **Free**, `npm install` puis `npm start`. Clique **Deploy**.
4. Une fois déployé, Render te donne une adresse du type :
   `https://thefall-io-server.onrender.com`
   → à utiliser dans le jeu sous la forme `wss://thefall-io-server.onrender.com`
   (remplace `https` par `wss`, c'est le même nom d'hôte).

### 3. Relier le jeu au serveur

Dans le jeu → **PARAMÈTRES → Serveur multijoueur**, colle l'adresse `wss://...`
obtenue à l'étape précédente, puis **JOUER**. Fais de même sur l'appareil d'un
ami pour jouer ensemble.

> Note : le plan gratuit de Render met le serveur en veille après 15 minutes
> sans trafic ; la première connexion après une pause peut prendre ~30-60s
> le temps qu'il se réveille (ensuite c'est instantané).
