export type RoomStatus = "waiting" | "starting" | "playing" | "paused" | "finished";

export type WeaponId = "standard" | "cluster" | "cluster-fragment" | "nuke";

export interface Vec2 {
  x: number;
  y: number;
}

export interface PlayerState {
  id: string;
  clientId?: string;
  slot: number;
  connectionId: string | null;
  userId?: string;
  name: string;
  color: string;
  hp: number;
  angle: number;
  power: number;
  x: number;
  y: number;
  connected: boolean;
  ammo: Record<string, number>;
}

export interface RoomState {
  id: string;
  matchId: string;
  status: RoomStatus;
  players: PlayerState[];
  activePlayerIndex: number;
  terrain: number[];
  terrainSeed: number;
  wind: number;
  width: number;
  height: number;
  turnStartedAt: number | null;
  winnerId: string | null;
  disconnectDeadlineAt: number | null;
}

export interface ClientHelloEvent {
  type: "HELLO";
  clientId?: string;
  playerId?: string;
  userId?: string;
  name?: string;
}

export interface ClientAimEvent {
  type: "AIM";
  angle?: number;
  power?: number;
}

export interface ClientFireEvent {
  type: "FIRE_WEAPON" | "FIRE";
  angle: number;
  power: number;
  weaponId?: WeaponId;
  weapon?: WeaponId;
}

export interface ClientPingEvent {
  type: "PING";
}

export type ClientEvent = ClientHelloEvent | ClientAimEvent | ClientFireEvent | ClientPingEvent;

export interface ServerJoinedEvent {
  type: "JOINED";
  playerId: string | null;
  slot: number | null;
  roomId: string;
}

export interface ServerSyncStateEvent {
  type: "SYNC_STATE";
  state: RoomState;
}

export interface ServerMatchStartEvent {
  type: "MATCH_START";
  state: RoomState;
}

export interface ServerTurnStartEvent {
  type: "TURN_START";
  playerId: string;
  playerIndex: number;
  state: RoomState;
}

export interface ServerProjectileEvent {
  type: "SERVER_PROJECTILE_SPAWNED" | "PROJECTILE_SPAWNED";
  id: string;
  playerId: string;
  weaponId: WeaponId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tti: number;
}

export interface DamageEntry {
  playerId: string;
  damage: number;
  newHp: number;
}

export interface TerrainModification {
  fromX: number;
  heights: number[];
}

export interface ServerImpactEvent {
  type: "SERVER_IMPACT" | "IMPACT";
  projectileId: string;
  x: number;
  y: number;
  radius: number;
  damageMap: Record<string, number>;
  affectedPlayers: DamageEntry[];
  terrainMod: TerrainModification;
  state: RoomState;
}

export interface ServerMatchEndEvent {
  type: "MATCH_END";
  winnerId: string | null;
  state: RoomState;
}

export interface ServerErrorEvent {
  type: "ERROR";
  code: string;
  message: string;
}

export interface ReplayEvent {
  tick: number;
  type: string;
  payload: unknown;
}

export interface WeaponConfig {
  id: WeaponId;
  projectileRadius: number;
  explosionRadius: number;
  damage: number;
}

export interface ProjectileSimulation {
  id: string;
  weapon: WeaponConfig;
  playerId: string;
  start: Vec2;
  velocity: Vec2;
  impact: Vec2;
  tti: number;
  steps: Vec2[];
}
