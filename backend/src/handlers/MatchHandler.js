import { PhysicsEngine, WORLD } from "./PhysicsEngine";
import { ReplaySaver } from "./ReplaySaver";

const PLAYER_COLORS = ["#22d3ee", "#fb7185"];
const PLAYER_NAMES = ["Alpha", "Omega"];
const RECONNECT_GRACE_MS = 60_000;

export class MatchHandler {
  physics = new PhysicsEngine();
  replay = [];
  startedAt = Date.now();
  impactTimer = null;
  pauseTimer = null;

  constructor(party) {
    this.party = party;
    this.replaySaver = new ReplaySaver(party.env ?? {});
    this.state = this.createInitialState();
  }

  handleJoin(conn) {
    this.send(conn, {
      type: "JOINED",
      playerId: null,
      slot: null,
      roomId: this.state.id
    });
    this.sendSync(conn);
  }

  handleClose(conn) {
    const player = this.state.players.find((candidate) => candidate.connectionId === conn.id);
    if (!player || this.state.status === "finished") return;

    this.state = {
      ...this.state,
      status: this.state.status === "playing" ? "paused" : this.state.status,
      disconnectDeadlineAt: Date.now() + RECONNECT_GRACE_MS,
      players: this.state.players.map((candidate) =>
        candidate.id === player.id
          ? { ...candidate, connected: false, connectionId: null }
          : candidate
      )
    };

    this.record("PLAYER_DISCONNECTED", { playerId: player.id });
    this.broadcastSync();
    this.scheduleForfeit(player.id);
  }

  async processEvent(event, sender) {
    try {
      switch (event.type) {
        case "HELLO":
          this.handleHello(event, sender);
          return;
        case "AIM":
          this.handleAim(event.angle, event.power, sender);
          return;
        case "FIRE":
        case "FIRE_WEAPON":
          this.handleFire(event, sender);
          return;
        case "PING":
          this.send(sender, { type: "PONG", now: Date.now() });
          return;
        default:
          this.sendError(sender, "UNKNOWN_EVENT", "Unsupported event type.");
      }
    } catch (error) {
      this.sendError(sender, "EVENT_FAILED", error instanceof Error ? error.message : "Event failed.");
    }
  }

  handleHello(event, conn) {
    const existing = event.playerId
      ? this.state.players.find((player) => player.id === event.playerId)
      : undefined;
    const claimedByClient = !existing && event.clientId
      ? this.state.players.find((player) => player.clientId === event.clientId)
      : undefined;
    const claimedByUser = !existing && event.userId
      ? this.state.players.find((player) => player.userId === event.userId)
      : undefined;
    const target = existing
      ?? claimedByClient
      ?? claimedByUser
      ?? this.state.players.find((player) => player.connectionId === conn.id)
      ?? this.attachConnection(conn, event.clientId);

    if (!target) {
      this.sendError(conn, "ROOM_FULL", "This match already has two players.");
      return;
    }

    this.state = {
      ...this.state,
      status: this.state.status === "paused" && this.connectedPlayerCount() + 1 >= 2 ? "playing" : this.state.status,
      disconnectDeadlineAt: null,
      players: this.state.players.map((player) =>
        player.id === target.id
          ? {
              ...player,
              clientId: event.clientId ?? player.clientId,
              connectionId: conn.id,
              connected: true,
              userId: event.userId ?? player.userId,
              name: this.safeName(event.name) ?? player.name
            }
          : player
      )
    };

    this.clearPauseTimer();
    this.send(conn, {
      type: "JOINED",
      playerId: target.id,
      slot: target.slot,
      roomId: this.state.id
    });
    this.broadcastSync();

    if (this.state.status === "waiting" && this.state.players.length === 2 && this.connectedPlayerCount() === 2) {
      this.startMatch();
    }
  }

  handleAim(angle, power, conn) {
    const player = this.requirePlayer(conn);
    if (!player || this.state.status !== "playing") return;

    this.state = {
      ...this.state,
      players: this.state.players.map((candidate) =>
        candidate.id === player.id
          ? {
              ...candidate,
              angle: angle === undefined ? candidate.angle : this.physics.clamp(angle, 0, 180),
              power: power === undefined ? candidate.power : this.physics.clamp(power, 1, 100)
            }
          : candidate
      )
    };

    this.broadcastSync();
  }

  handleFire(event, conn) {
    const player = this.requirePlayer(conn);
    if (!player) return;
    if (this.state.status !== "playing") {
      this.sendError(conn, "MATCH_NOT_PLAYING", "Cannot fire until the match is active.");
      return;
    }

    const activePlayer = this.state.players[this.state.activePlayerIndex];
    if (activePlayer?.id !== player.id) {
      this.sendError(conn, "NOT_YOUR_TURN", "Only the active player can fire.");
      return;
    }

    const weaponId = this.normalizeWeapon(event.weaponId ?? event.weapon);
    const ammo = player.ammo[weaponId] ?? 0;
    if (ammo <= 0) {
      this.sendError(conn, "NO_AMMO", `No ammo remaining for ${weaponId}.`);
      return;
    }

    const angle = this.physics.clamp(event.angle, 0, 180);
    const power = this.physics.clamp(event.power, 1, 100);
    const updatedPlayer = { ...player, angle, power, ammo: { ...player.ammo, [weaponId]: ammo - 1 } };
    const playersForSimulation = this.state.players.map((candidate) =>
      candidate.id === player.id ? updatedPlayer : candidate
    );
    const projectile = this.physics.simulateProjectile(
      crypto.randomUUID(),
      updatedPlayer,
      this.state.terrain,
      playersForSimulation,
      angle,
      power,
      weaponId,
      this.state.wind
    );

    this.state = {
      ...this.state,
      players: playersForSimulation
    };

    const projectileEvent = {
      type: "SERVER_PROJECTILE_SPAWNED",
      id: projectile.id,
      playerId: player.id,
      weaponId,
      x: projectile.start.x,
      y: projectile.start.y,
      vx: projectile.velocity.x,
      vy: projectile.velocity.y,
      tti: projectile.tti
    };

    this.record(projectileEvent.type, projectileEvent);
    this.broadcast(projectileEvent);
    this.scheduleImpact(projectile);
  }

  scheduleImpact(projectile) {
    if (this.impactTimer) clearTimeout(this.impactTimer);

    this.impactTimer = setTimeout(() => {
      const beforePlayers = this.state.players;
      const result = this.physics.applyExplosion(
        this.state.terrain,
        beforePlayers,
        projectile.impact,
        projectile.weapon.explosionRadius,
        projectile.weapon.damage
      );
      const damageMap = this.physics.getDamageMap(beforePlayers, result.players);
      const affectedPlayers = result.players
        .map((player) => ({
          playerId: player.id,
          damage: damageMap[player.id] ?? 0,
          newHp: player.hp
        }))
        .filter((entry) => entry.damage > 0);

      const alive = result.players.filter((player) => player.hp > 0);
      const winnerId = alive.length === 1 ? alive[0].id : alive.length === 0 ? null : this.state.winnerId;
      const hasWinner = alive.length <= 1;
      const nextActivePlayerIndex = hasWinner
        ? this.state.activePlayerIndex
        : this.nextLivingPlayerIndex(this.state.activePlayerIndex, result.players);

      this.state = {
        ...this.state,
        status: hasWinner ? "finished" : "playing",
        activePlayerIndex: nextActivePlayerIndex,
        terrain: result.terrain,
        players: result.players,
        turnStartedAt: hasWinner ? null : Date.now(),
        winnerId
      };

      const impactEvent = {
        type: "SERVER_IMPACT",
        projectileId: projectile.id,
        x: projectile.impact.x,
        y: projectile.impact.y,
        radius: projectile.weapon.explosionRadius,
        damageMap,
        affectedPlayers,
        terrainMod: result.terrainMod,
        state: this.state
      };

      this.record(impactEvent.type, impactEvent);
      this.broadcast(impactEvent);

      if (hasWinner) {
        this.endMatch();
      } else {
        this.broadcastTurnStart();
      }
    }, projectile.tti);
  }

  startMatch() {
    const terrainSeed = this.state.terrainSeed || this.randomSeed();
    const terrain = this.physics.generateTerrain(terrainSeed);
    const players = this.physics.placePlayersOnTerrain(this.state.players, terrain);

    this.state = {
      ...this.state,
      status: "playing",
      terrain,
      terrainSeed,
      players,
      activePlayerIndex: 0,
      turnStartedAt: Date.now(),
      disconnectDeadlineAt: null
    };
    this.startedAt = Date.now();

    const event = {
      type: "MATCH_START",
      state: this.state
    };
    this.record(event.type, event);
    this.broadcast(event);
    this.broadcastTurnStart();
  }

  endMatch() {
    this.state = {
      ...this.state,
      status: "finished",
      turnStartedAt: null,
      disconnectDeadlineAt: null
    };

    const event = {
      type: "MATCH_END",
      winnerId: this.state.winnerId,
      state: this.state
    };
    this.record(event.type, event);
    this.broadcast(event);

    this.replaySaver.saveFinishedMatch(this.state, this.replay).catch((error) => {
      console.error(error);
    });
  }

  broadcastTurnStart() {
    const player = this.state.players[this.state.activePlayerIndex];
    if (!player) return;

    const event = {
      type: "TURN_START",
      playerId: player.id,
      playerIndex: this.state.activePlayerIndex,
      state: this.state
    };
    this.record(event.type, event);
    this.broadcast(event);
  }

  attachConnection(conn, clientId) {
    const current = this.state.players.find((player) => player.connectionId === conn.id);
    if (current) return current;

    const openSlot = this.state.players.length;
    if (openSlot >= 2) return null;

    const player = this.createPlayer(conn.id, openSlot, clientId);
    this.state = {
      ...this.state,
      players: [...this.state.players, player]
    };
    return player;
  }

  createInitialState() {
    const terrainSeed = this.randomSeed();
    return {
      id: this.party.id,
      matchId: crypto.randomUUID(),
      status: "waiting",
      players: [],
      activePlayerIndex: 0,
      terrain: [],
      terrainSeed,
      wind: 0,
      width: WORLD.width,
      height: WORLD.height,
      turnStartedAt: null,
      winnerId: null,
      disconnectDeadlineAt: null
    };
  }

  createPlayer(connectionId, slot, clientId) {
    return {
      id: crypto.randomUUID(),
      clientId,
      slot,
      connectionId,
      name: PLAYER_NAMES[slot] ?? `Player ${slot + 1}`,
      color: PLAYER_COLORS[slot] ?? "#94a3b8",
      hp: 100,
      angle: slot === 0 ? 45 : 135,
      power: 60,
      x: slot === 0 ? 200 : 1000,
      y: 0,
      connected: true,
      ammo: {
        standard: 99,
        cluster: 3,
        nuke: 1
      }
    };
  }

  requirePlayer(conn) {
    const player = this.state.players.find((candidate) => candidate.connectionId === conn.id);
    if (!player) {
      this.sendError(conn, "PLAYER_REQUIRED", "Join the room before sending gameplay events.");
      return null;
    }
    return player;
  }

  nextLivingPlayerIndex(currentIndex, players) {
    for (let offset = 1; offset <= players.length; offset++) {
      const index = (currentIndex + offset) % players.length;
      if (players[index]?.hp > 0) return index;
    }
    return currentIndex;
  }

  scheduleForfeit(playerId) {
    this.clearPauseTimer();
    this.pauseTimer = setTimeout(() => {
      if (this.state.status !== "paused") return;
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      if (!player || player.connected) return;

      const opponent = this.state.players.find((candidate) => candidate.id !== playerId && candidate.hp > 0);
      this.state = {
        ...this.state,
        status: "finished",
        winnerId: opponent?.id ?? null,
        turnStartedAt: null,
        disconnectDeadlineAt: null
      };
      this.record("FORFEIT", { playerId, winnerId: this.state.winnerId });
      this.endMatch();
    }, RECONNECT_GRACE_MS);
  }

  clearPauseTimer() {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }

  connectedPlayerCount() {
    return this.state.players.filter((player) => player.connected).length;
  }

  broadcastSync() {
    this.broadcast({
      type: "SYNC_STATE",
      state: this.state
    });
  }

  sendSync(conn) {
    this.send(conn, {
      type: "SYNC_STATE",
      state: this.state
    });
  }

  broadcast(payload) {
    this.party.broadcast(JSON.stringify(payload));
  }

  send(conn, payload) {
    conn.send(JSON.stringify(payload));
  }

  sendError(conn, code, message) {
    this.send(conn, {
      type: "ERROR",
      code,
      message
    });
  }

  record(type, payload) {
    this.replay.push({
      tick: Date.now() - this.startedAt,
      type,
      payload
    });
  }

  normalizeWeapon(weaponId) {
    if (weaponId === "cluster" || weaponId === "nuke" || weaponId === "standard") {
      return weaponId;
    }
    return "standard";
  }

  randomSeed() {
    return Math.floor(Math.random() * 0x7fffffff);
  }

  safeName(name) {
    const trimmed = name?.trim();
    return trimmed ? trimmed.slice(0, 24) : undefined;
  }
}
