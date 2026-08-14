// server.js — petit serveur WebSocket pour le multijoueur LAN de TheFall.io 3D Clone.
//
// Lancement :
//   npm install
//   npm start          (ou : node server.js)
//
// Le serveur écoute sur le port 8787 par défaut. Les clients (thefall-3d-clone.html)
// s'y connectent via l'adresse indiquée dans PARAMÈTRES > "Serveur multijoueur"
// (par défaut ws://<même-machine>:8787, à remplacer par l'IP locale du serveur
// pour jouer entre plusieurs ordinateurs sur le même réseau).
//
// Rôle du serveur :
//  - relaie la position/l'état de chaque joueur aux autres (mouvement, tirs visuels)
//  - fait autorité sur l'état des blocs (cassure / destruction / réapparition /
//    régénération de masse) pour que tous les clients voient la même arène
//  - fait autorité sur les pièces/boosts (un seul serveur qui les fait apparaître,
//    pour éviter que deux joueurs ne voient pas les mêmes objets ou ramassent
//    "en double")
//  - relaie les poussées d'armes (pistolet, chamboule-tout) au joueur visé,
//    qui applique lui-même le recul sur sa propre physique

const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8787;

// --- Constantes qui DOIVENT rester cohérentes avec thefall-3d-clone.html ---
const GRID_SIZE = 32;
const BREAK_DELAY_MS = 500;
const REGEN_MIN_MS = 5000;
const REGEN_MAX_MS = 10000;
const MASS_REGEN_RATIO = 0.4;
const BOOST_KEYS = ['pistol', 'bazooka', 'shield', 'chaos', 'extraLife'];
const MAX_COINS = 60;
const MAX_ORBS = 14;
const MAX_PER_BOOST_TYPE = 6;
const SPAWN_INTERVAL_MS = 350;
const BOOST_SPAWN_CHANCE = 0.75;
const TOTAL_BLOCKS = GRID_SIZE * GRID_SIZE;

const wss = new WebSocketServer({ port: PORT });
console.log(`Serveur multijoueur TheFall.io en écoute sur ws://0.0.0.0:${PORT}`);

let nextPlayerId = 1;
const players = new Map(); // id -> { id, ws, name, x, y, z, facingAngle, moving, onGround, bodyColor, skinColor }

function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}
function sendTo(id, msg) {
  const p = players.get(id);
  if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

/* =========================================================================
   ÉTAT AUTORITAIRE DES BLOCS
   ========================================================================= */
const blocks = new Map(); // "col,row" -> { alive, breaking, breakTimer, respawnTimer }
let destroyedCount = 0;

function keyOf(col, row) { return col + ',' + row; }
function getBlock(col, row) {
  const k = keyOf(col, row);
  let b = blocks.get(k);
  if (!b) { b = { alive: true, breaking: false, breakTimer: null, respawnTimer: null }; blocks.set(k, b); }
  return b;
}
function inGrid(col, row) { return col >= 0 && row >= 0 && col < GRID_SIZE && row < GRID_SIZE; }

function requestBreak(col, row) {
  if (!inGrid(col, row)) return;
  const b = getBlock(col, row);
  if (!b.alive || b.breaking) return;
  b.breaking = true;
  broadcast({ t: 'blockBreak', col, row }, null);
  b.breakTimer = setTimeout(() => destroyBlock(col, row), BREAK_DELAY_MS);
}

function destroyBlock(col, row) {
  const b = getBlock(col, row);
  if (!b.alive) return;
  b.alive = false;
  b.breaking = false;
  destroyedCount++;
  const delay = REGEN_MIN_MS + Math.random() * (REGEN_MAX_MS - REGEN_MIN_MS);
  broadcast({ t: 'blockDestroy', col, row, delay }, null);
  b.respawnTimer = setTimeout(() => respawnBlock(col, row), delay);
  checkMassRegen();
}

function respawnBlock(col, row) {
  const b = getBlock(col, row);
  if (b.alive) return;
  b.alive = true;
  b.breaking = false;
  destroyedCount = Math.max(0, destroyedCount - 1);
  broadcast({ t: 'blockRespawn', col, row }, null);
}

// Bazooka : casse immédiatement la case visée, sans le délai de "cassure" normal.
function instantDestroy(col, row) {
  if (!inGrid(col, row)) return;
  const b = getBlock(col, row);
  if (!b.alive) return;
  if (b.breakTimer) clearTimeout(b.breakTimer);
  destroyBlock(col, row);
}

function checkMassRegen() {
  if (destroyedCount / TOTAL_BLOCKS < MASS_REGEN_RATIO) return;
  for (const b of blocks.values()) {
    if (b.breaking) continue; // laisse les cassures déjà en cours se terminer (même règle que le client)
    if (b.breakTimer) clearTimeout(b.breakTimer);
    if (b.respawnTimer) clearTimeout(b.respawnTimer);
    b.breakTimer = null; b.respawnTimer = null;
    b.alive = true; b.breaking = false;
  }
  destroyedCount = 0;
  broadcast({ t: 'massRegen' }, null);
}

/* =========================================================================
   COLLECTIBLES (pièces, orbes, boosts) — le serveur est la seule source de
   vérité, pour que tous les joueurs voient exactement les mêmes objets.
   ========================================================================= */
const collectibles = new Map(); // id -> { id, col, row, type }
let nextCollectibleId = 1;

function trySpawnCollectible() {
  const values = [...collectibles.values()];
  let type = null;

  if (Math.random() < BOOST_SPAWN_CHANCE) {
    const counts = {};
    BOOST_KEYS.forEach(k => { counts[k] = 0; });
    values.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
    const available = BOOST_KEYS.filter(k => counts[k] < MAX_PER_BOOST_TYPE);
    if (available.length > 0) type = available[Math.floor(Math.random() * available.length)];
  }
  if (!type) {
    const coinCount = values.filter(c => c.type === 'coin').length;
    const orbCount = values.filter(c => c.type === 'speed' || c.type === 'jump').length;
    const spawnOrb = orbCount < MAX_ORBS && Math.random() < 0.25;
    if (!spawnOrb && coinCount >= MAX_COINS) return;
    if (spawnOrb && orbCount >= MAX_ORBS) return;
    type = spawnOrb ? (Math.random() < 0.5 ? 'speed' : 'jump') : 'coin';
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const col = Math.floor(Math.random() * GRID_SIZE);
    const row = Math.floor(Math.random() * GRID_SIZE);
    const b = getBlock(col, row);
    if (!b.alive || b.breaking) continue;
    if (values.some(c => c.col === col && c.row === row)) continue;
    const id = nextCollectibleId++;
    const item = { id, col, row, type };
    collectibles.set(id, item);
    broadcast({ t: 'collectibleSpawn', ...item }, null);
    return;
  }
}
setInterval(trySpawnCollectible, SPAWN_INTERVAL_MS);

/* =========================================================================
   CONNEXIONS
   ========================================================================= */
wss.on('connection', (ws) => {
  const id = nextPlayerId++;
  const player = {
    id, ws, name: 'Joueur ' + id,
    x: 0, y: 0, z: 0, facingAngle: 0, moving: false, onGround: true,
    bodyColor: 0xff8a00, skinColor: 0xffd9a0
  };
  players.set(id, player);

  sendTo(id, {
    t: 'welcome',
    id,
    players: [...players.values()].filter(p => p.id !== id).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, facingAngle: p.facingAngle,
      moving: p.moving, onGround: p.onGround, bodyColor: p.bodyColor, skinColor: p.skinColor
    })),
    blocks: [...blocks.entries()]
      .filter(([, b]) => !b.alive || b.breaking)
      .map(([k, b]) => {
        const [col, row] = k.split(',').map(Number);
        return { col, row, alive: b.alive, breaking: b.breaking };
      }),
    collectibles: [...collectibles.values()]
  });
  broadcast({ t: 'playerJoin', id, name: player.name }, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'update':
        player.x = msg.x; player.y = msg.y; player.z = msg.z;
        player.facingAngle = msg.facingAngle;
        player.moving = !!msg.moving; player.onGround = !!msg.onGround;
        if (msg.bodyColor != null) player.bodyColor = msg.bodyColor;
        if (msg.skinColor != null) player.skinColor = msg.skinColor;
        broadcast({
          t: 'update', id,
          x: msg.x, y: msg.y, z: msg.z, facingAngle: msg.facingAngle,
          moving: !!msg.moving, onGround: !!msg.onGround,
          bodyColor: player.bodyColor, skinColor: player.skinColor
        }, id);
        break;

      case 'requestBreak':
        requestBreak(msg.col, msg.row);
        break;

      case 'bazookaHit':
        instantDestroy(msg.col, msg.row);
        break;

      case 'pickup': {
        const c = collectibles.get(msg.id);
        if (c) {
          collectibles.delete(msg.id);
          broadcast({ t: 'collectibleRemove', id: msg.id }, null); // aussi renvoyé à l'auteur : confirmation
          sendTo(id, { t: 'collectibleRemove', id: msg.id });
        }
        break;
      }

      case 'push':
        sendTo(msg.targetId, { t: 'push', fromId: id, dirX: msg.dirX, dirZ: msg.dirZ, force: msg.force });
        break;

      case 'shot':
        // relaie le tir visuel (position/direction/arme) pour que les autres voient le projectile
        broadcast({ t: 'shot', id, x: msg.x, y: msg.y, z: msg.z, dirX: msg.dirX, dirZ: msg.dirZ, weapon: msg.weapon }, id);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ t: 'playerLeave', id }, null);
  });

  ws.on('error', () => {});
});
