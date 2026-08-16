// server.js — serveur WebSocket multijoueur de TheFall.io 3D Clone.
//
// Lancement :
//   npm install
//   npm start          (ou : node server.js)
//
// Le serveur écoute sur le port 8787 par défaut (ou process.env.PORT en
// hébergement). Les clients (index.html / thefall-3d-clone.html) s'y
// connectent via l'adresse indiquée dans PARAMÈTRES > "Serveur multijoueur".
//
// Rôle du serveur :
//  - regroupe les joueurs en SALLES (Room) publiques : plusieurs manches
//    peuvent tourner en même temps, chacune avec sa propre arène/ses propres
//    objets/son propre décompte de joueurs vivants — voir la classe Room
//  - démarre automatiquement une manche dès qu'assez de joueurs sont réunis
//    dans une salle publique (voir checkPublicRoomStart)
//  - fait autorité sur l'état des blocs (cassure / destruction / réapparition /
//    régénération de masse) pour que tous les clients d'une même salle voient
//    la même arène ; la régénération de masse s'arrête en finale (voir Room)
//  - fait autorité sur les pièces/boosts (apparitions, rareté de la 2e vie en
//    finale) pour éviter les doublons entre clients d'une même salle
//  - suit les joueurs vivants d'une salle (message "fell" envoyé par le
//    client qui tombe) pour déclencher la finale (5 restants) puis la fin de
//    manche (1 restant = gagnant), et relance automatiquement une nouvelle
//    manche pour les joueurs encore connectés
//  - relaie les poussées d'armes (pistolet, chamboule-tout) au joueur visé,
//    qui applique lui-même le recul sur sa propre physique

const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8787;

// --- Constantes qui DOIVENT rester cohérentes avec index.html / thefall-3d-clone.html ---
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

// --- Constantes du déroulement d'une manche ---
const MAX_ROOM_SIZE = 10;             // capacité max d'une salle ("map adaptée pour 10 joueurs")
const PUBLIC_MIN_PLAYERS = 2;         // seuil minimum pour qu'une manche publique démarre
const PUBLIC_START_GRACE_MS = 15000;  // délai laissé à d'autres joueurs pour rejoindre une fois le seuil atteint
const COUNTDOWN_MS = 3000;            // décompte immobile avant le début de la manche
const ROUND_END_DELAY_MS = 6000;      // affichage du résultat avant la manche suivante
const FINALE_THRESHOLD = 5;           // "c'est la finale" dès qu'il ne reste que 5 joueurs vivants
const FINALE_EXTRA_LIFE_CHANCE = 0.15; // la 2e vie devient rare en finale (tirage normal sinon)

const wss = new WebSocketServer({ port: PORT });
console.log(`Serveur multijoueur TheFall.io en écoute sur ws://0.0.0.0:${PORT}`);

let nextPlayerId = 1;
let nextRoomId = 1;
const rooms = new Map(); // id -> Room
let publicWaitingRoom = null; // salle publique actuellement en attente de joueurs (ou null)

function keyOf(col, row) { return col + ',' + row; }
function inGrid(col, row) { return col >= 0 && row >= 0 && col < GRID_SIZE && row < GRID_SIZE; }

/* =========================================================================
   SALLE (Room) : une arène + ses objets + ses joueurs + le déroulement de
   sa manche en cours, entièrement indépendante des autres salles.
   ========================================================================= */
class Room {
  constructor() {
    this.id = nextRoomId++;
    this.players = new Map(); // id -> { id, ws, name, x, y, z, facingAngle, moving, onGround, bodyColor, skinColor }
    this.blocks = new Map();  // "col,row" -> { alive, breaking, breakTimer, respawnTimer }
    this.collectibles = new Map();
    this.nextCollectibleId = 1;
    this.destroyedCount = 0;
    this.phase = 'waiting'; // waiting | countdown | playing | finale | ended
    this.aliveIds = new Set();
    this.roundSize = 0;     // nombre de joueurs au tout début de la manche en cours (pour savoir si une "finale" a un sens)
    this.startTimer = null;
    this.countdownTimer = null;
    this.restartTimer = null;
    this.spawnInterval = setInterval(() => this.trySpawnCollectible(), SPAWN_INTERVAL_MS);
  }

  broadcast(msg, exceptId) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      if (p.ws.readyState === 1) p.ws.send(data);
    }
  }
  sendTo(id, msg) {
    const p = this.players.get(id);
    if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  destroy() {
    clearInterval(this.spawnInterval);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const b of this.blocks.values()) {
      if (b.breakTimer) clearTimeout(b.breakTimer);
      if (b.respawnTimer) clearTimeout(b.respawnTimer);
    }
    rooms.delete(this.id);
  }

  /* ---- Blocs ---- */
  getBlock(col, row) {
    const k = keyOf(col, row);
    let b = this.blocks.get(k);
    if (!b) { b = { alive: true, breaking: false, breakTimer: null, respawnTimer: null }; this.blocks.set(k, b); }
    return b;
  }
  requestBreak(col, row) {
    if (!inGrid(col, row)) return;
    const b = this.getBlock(col, row);
    if (!b.alive || b.breaking) return;
    b.breaking = true;
    this.broadcast({ t: 'blockBreak', col, row }, null);
    b.breakTimer = setTimeout(() => this.destroyBlock(col, row), BREAK_DELAY_MS);
  }
  destroyBlock(col, row) {
    const b = this.getBlock(col, row);
    if (!b.alive) return;
    b.alive = false;
    b.breaking = false;
    this.destroyedCount++;
    const delay = REGEN_MIN_MS + Math.random() * (REGEN_MAX_MS - REGEN_MIN_MS);
    this.broadcast({ t: 'blockDestroy', col, row, delay }, null);
    b.respawnTimer = setTimeout(() => this.respawnBlock(col, row), delay);
    this.checkMassRegen();
  }
  respawnBlock(col, row) {
    const b = this.getBlock(col, row);
    if (b.alive) return;
    b.alive = true;
    b.breaking = false;
    this.destroyedCount = Math.max(0, this.destroyedCount - 1);
    this.broadcast({ t: 'blockRespawn', col, row }, null);
  }
  instantDestroy(col, row) {
    if (!inGrid(col, row)) return;
    const b = this.getBlock(col, row);
    if (!b.alive) return;
    if (b.breakTimer) clearTimeout(b.breakTimer);
    this.destroyBlock(col, row);
  }
  checkMassRegen() {
    // En finale, l'arène arrête de régénérer en masse : elle doit vraiment
    // rétrécir jusqu'au bout, pas repartir à zéro comme en temps normal.
    if (this.phase === 'finale') return;
    if (this.destroyedCount / TOTAL_BLOCKS < MASS_REGEN_RATIO) return;
    for (const b of this.blocks.values()) {
      if (b.breaking) continue; // laisse les cassures déjà en cours se terminer
      if (b.breakTimer) clearTimeout(b.breakTimer);
      if (b.respawnTimer) clearTimeout(b.respawnTimer);
      b.breakTimer = null; b.respawnTimer = null;
      b.alive = true; b.breaking = false;
    }
    this.destroyedCount = 0;
    this.broadcast({ t: 'massRegen' }, null);
  }
  resetArena() {
    for (const b of this.blocks.values()) {
      if (b.breakTimer) clearTimeout(b.breakTimer);
      if (b.respawnTimer) clearTimeout(b.respawnTimer);
    }
    this.blocks.clear();
    this.destroyedCount = 0;
    this.collectibles.clear();
    this.broadcast({ t: 'arenaReset' }, null);
  }

  /* ---- Collectibles ---- */
  trySpawnCollectible() {
    if (this.phase !== 'playing' && this.phase !== 'finale') return;
    const values = [...this.collectibles.values()];
    const finale = this.phase === 'finale';
    let type = null;

    if (Math.random() < BOOST_SPAWN_CHANCE) {
      const counts = {};
      BOOST_KEYS.forEach(k => { counts[k] = 0; });
      values.forEach(c => { if (counts[c.type] !== undefined) counts[c.type]++; });
      let available = BOOST_KEYS.filter(k => counts[k] < MAX_PER_BOOST_TYPE);
      // La 2e vie devient rare en finale plutôt qu'un boost comme les autres.
      if (finale && available.includes('extraLife') && Math.random() > FINALE_EXTRA_LIFE_CHANCE) {
        available = available.filter(k => k !== 'extraLife');
      }
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
      const b = this.getBlock(col, row);
      if (!b.alive || b.breaking) continue;
      if (values.some(c => c.col === col && c.row === row)) continue;
      const id = this.nextCollectibleId++;
      const item = { id, col, row, type };
      this.collectibles.set(id, item);
      this.broadcast({ t: 'collectibleSpawn', ...item }, null);
      return;
    }
  }

  /* ---- Déroulement de la manche ---- */
  startRound() {
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    this.resetArena();
    const ids = [...this.players.keys()];
    this.roundSize = ids.length;
    this.aliveIds = new Set(ids);
    this.phase = 'countdown';
    // Chaque joueur reçoit son propre index de spawn ; le CLIENT calcule la
    // position réelle (cercle espacé) avec la même formule qu'en solo, pour
    // ne pas avoir à dupliquer/synchroniser la géométrie de l'arène ici.
    ids.forEach((id, i) => this.sendTo(id, {
      t: 'roundStart', spawnIndex: i, totalSpawns: ids.length, countdownMs: COUNTDOWN_MS
    }));
    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      if (this.phase === 'countdown') this.phase = 'playing';
    }, COUNTDOWN_MS);
  }

  markEliminated(id) {
    if (!this.aliveIds.has(id)) return;
    this.aliveIds.delete(id);
    this.broadcast({ t: 'playerEliminated', id }, null);
    this.checkRoundProgress();
  }

  checkRoundProgress() {
    if (this.phase !== 'playing' && this.phase !== 'finale') return;
    if (this.phase === 'playing' && this.roundSize > FINALE_THRESHOLD && this.aliveIds.size === FINALE_THRESHOLD) {
      this.phase = 'finale';
      this.broadcast({ t: 'finale' }, null);
    }
    if (this.aliveIds.size <= 1) {
      const winnerId = this.aliveIds.size === 1 ? [...this.aliveIds][0] : null;
      this.phase = 'ended';
      this.broadcast({ t: 'roundEnd', winnerId }, null);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.players.size > 0) this.startRound();
        else this.phase = 'waiting';
      }, ROUND_END_DELAY_MS);
    }
  }

  addPlayer(player) {
    this.players.set(player.id, player);
  }
  removePlayer(id) {
    this.players.delete(id);
    if (this.aliveIds.has(id)) this.markEliminated(id);
    this.broadcast({ t: 'playerLeave', id }, null);
    if (this.players.size === 0) {
      this.destroy();
      if (publicWaitingRoom === this) publicWaitingRoom = null;
    }
  }
}

/* =========================================================================
   MATCHMAKING PUBLIC : plusieurs manches peuvent tourner en même temps —
   dès qu'une salle publique atteint PUBLIC_MIN_PLAYERS, un délai de grâce
   laisse d'éventuels autres joueurs la rejoindre avant le début automatique
   de la manche (immédiat si la salle est pleine avant la fin du délai).
   ========================================================================= */
function getPublicRoomForJoin() {
  if (!publicWaitingRoom || publicWaitingRoom.phase !== 'waiting' || publicWaitingRoom.players.size >= MAX_ROOM_SIZE) {
    publicWaitingRoom = new Room();
    rooms.set(publicWaitingRoom.id, publicWaitingRoom);
  }
  return publicWaitingRoom;
}
function checkPublicRoomStart(room) {
  if (room.phase !== 'waiting') return;
  if (room.players.size >= MAX_ROOM_SIZE) {
    room.startRound();
    if (publicWaitingRoom === room) publicWaitingRoom = null;
    return;
  }
  if (room.players.size >= PUBLIC_MIN_PLAYERS) {
    if (!room.startTimer) {
      room.startTimer = setTimeout(() => {
        room.startTimer = null;
        if (room.phase === 'waiting' && room.players.size >= PUBLIC_MIN_PLAYERS) {
          room.startRound();
          if (publicWaitingRoom === room) publicWaitingRoom = null;
        }
      }, PUBLIC_START_GRACE_MS);
    }
  } else if (room.startTimer) {
    clearTimeout(room.startTimer);
    room.startTimer = null;
  }
}

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

  // Pour l'instant, tout le monde rejoint le matchmaking public (pas encore
  // de lobbys privés avec code côté client — à venir).
  const room = getPublicRoomForJoin();
  room.addPlayer(player);

  room.sendTo(id, {
    t: 'welcome',
    id,
    phase: room.phase,
    players: [...room.players.values()].filter(p => p.id !== id).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, facingAngle: p.facingAngle,
      moving: p.moving, onGround: p.onGround, bodyColor: p.bodyColor, skinColor: p.skinColor
    })),
    blocks: [...room.blocks.entries()]
      .filter(([, b]) => !b.alive || b.breaking)
      .map(([k, b]) => {
        const [col, row] = k.split(',').map(Number);
        return { col, row, alive: b.alive, breaking: b.breaking };
      }),
    collectibles: [...room.collectibles.values()]
  });
  room.broadcast({ t: 'playerJoin', id, name: player.name }, id);
  checkPublicRoomStart(room);

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
        room.broadcast({
          t: 'update', id,
          x: msg.x, y: msg.y, z: msg.z, facingAngle: msg.facingAngle,
          moving: !!msg.moving, onGround: !!msg.onGround,
          bodyColor: player.bodyColor, skinColor: player.skinColor
        }, id);
        break;

      case 'requestBreak':
        room.requestBreak(msg.col, msg.row);
        break;

      case 'bazookaHit':
        room.instantDestroy(msg.col, msg.row);
        break;

      case 'pickup': {
        const c = room.collectibles.get(msg.id);
        if (c) {
          room.collectibles.delete(msg.id);
          room.broadcast({ t: 'collectibleRemove', id: msg.id }, null); // aussi renvoyé à l'auteur : confirmation
          room.sendTo(id, { t: 'collectibleRemove', id: msg.id });
        }
        break;
      }

      case 'push':
        room.sendTo(msg.targetId, { t: 'push', fromId: id, dirX: msg.dirX, dirZ: msg.dirZ, force: msg.force });
        break;

      case 'shot':
        // relaie le tir visuel (position/direction/arme) pour que les autres voient le projectile
        room.broadcast({ t: 'shot', id, x: msg.x, y: msg.y, z: msg.z, dirX: msg.dirX, dirZ: msg.dirZ, weapon: msg.weapon }, id);
        break;

      case 'fell':
        // Le client signale sa propre chute dans le vide (game over local) :
        // le serveur décrémente le nombre de joueurs vivants de la salle,
        // ce qui peut déclencher la finale puis la fin de manche.
        room.markEliminated(id);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    room.removePlayer(id);
  });

  ws.on('error', () => {});
});
