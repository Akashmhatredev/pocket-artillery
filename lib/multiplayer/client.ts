import type { ServerEvent, WeaponId } from "./types";

type Listener = (event: ServerEvent) => void;
type StatusListener = (status: "connecting" | "connected" | "reconnecting" | "lost" | "error") => void;

export const MULTIPLAYER_STORAGE_KEY = "pocket-artillery.multiplayer-session";
export const MULTIPLAYER_CLIENT_KEY = "pocket-artillery.client-id";

export function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);

  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 255);
    }
  }

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function normalizeRoomCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function getOrCreateClientId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();

  const existing = window.sessionStorage.getItem(MULTIPLAYER_CLIENT_KEY);
  if (existing) return existing;

  const next = crypto.randomUUID();
  window.sessionStorage.setItem(MULTIPLAYER_CLIENT_KEY, next);
  return next;
}

export function getPartyKitSocketUrl(roomCode: string): string {
  const configuredHost = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";
  const partyName = process.env.NEXT_PUBLIC_PARTYKIT_PARTY || "main";
  const hasProtocol = configuredHost.startsWith("ws://") || configuredHost.startsWith("wss://");
  const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  const host = hasProtocol ? configuredHost : `${protocol}://${configuredHost}`;

  return `${host.replace(/\/$/, "")}/parties/${partyName}/${roomCode}`;
}

export class MultiplayerConnection {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectAttempts = 0;
  private closedByUser = false;

  constructor(
    private readonly roomCode: string,
    private readonly clientId: string,
    private playerId: string | null,
    private readonly playerName: string
  ) {}

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  connect(): void {
    this.closedByUser = false;
    this.emitStatus(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    this.socket = new WebSocket(getPartyKitSocketUrl(this.roomCode));

    this.socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.emitStatus("connected");
      this.send({
        type: "HELLO",
        clientId: this.clientId,
        playerId: this.playerId ?? undefined,
        name: this.playerName
      });
    });

    this.socket.addEventListener("message", (message) => {
      const event = JSON.parse(message.data) as ServerEvent;
      if (event.type === "JOINED" && event.playerId) {
        this.playerId = event.playerId;
      }
      this.listeners.forEach((listener) => listener(event));
    });

    this.socket.addEventListener("close", () => {
      if (this.closedByUser) {
        this.emitStatus("lost");
        return;
      }
      this.scheduleReconnect();
    });

    this.socket.addEventListener("error", () => {
      this.emitStatus("error");
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }

  aim(angle: number, power: number): void {
    this.send({ type: "AIM", angle, power });
  }

  fire(angle: number, power: number, weaponId: WeaponId): void {
    this.send({ type: "FIRE_WEAPON", angle, power, weaponId });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    this.emitStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts += 1;
    window.setTimeout(() => this.connect(), delay);
  }

  private emitStatus(status: Parameters<StatusListener>[0]): void {
    this.statusListeners.forEach((listener) => listener(status));
  }
}
