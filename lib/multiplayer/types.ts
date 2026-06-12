export type RoomStatus = "waiting" | "starting" | "playing" | "paused" | "finished";
export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "lost" | "error";
export type WeaponId = "standard" | "cluster" | "nuke";

export interface MultiplayerPlayer {
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

export interface MultiplayerRoomState {
  id: string;
  matchId: string;
  status: RoomStatus;
  players: MultiplayerPlayer[];
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

export interface ProjectileSpawnedEvent {
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

export interface ImpactEvent {
  type: "SERVER_IMPACT" | "IMPACT";
  projectileId: string;
  x: number;
  y: number;
  radius: number;
  damageMap: Record<string, number>;
  affectedPlayers: Array<{ playerId: string; damage: number; newHp: number }>;
  terrainMod: { fromX: number; heights: number[] };
  state: MultiplayerRoomState;
}

export type ServerEvent =
  | { type: "JOINED"; playerId: string | null; slot: number | null; roomId: string }
  | { type: "SYNC_STATE"; state: MultiplayerRoomState }
  | { type: "MATCH_START"; state: MultiplayerRoomState }
  | { type: "TURN_START"; playerId: string; playerIndex: number; state: MultiplayerRoomState }
  | ProjectileSpawnedEvent
  | ImpactEvent
  | { type: "MATCH_END"; winnerId: string | null; state: MultiplayerRoomState }
  | { type: "ERROR"; code: string; message: string }
  | { type: "PONG"; now: number };

export interface MultiplayerSession {
  roomCode: string;
  clientId: string;
  playerId: string | null;
  matchId: string | null;
  isHost: boolean;
}
