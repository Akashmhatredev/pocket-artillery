export const MULTIPLAYER_STORAGE_KEY = "pocket-artillery.multiplayer-session";
export const MULTIPLAYER_CLIENT_KEY = "pocket-artillery.client-id";

export function generateRoomCode() {
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

export function normalizeRoomCode(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function getOrCreateClientId() {
  if (typeof window === "undefined") return crypto.randomUUID();

  const existing = window.sessionStorage.getItem(MULTIPLAYER_CLIENT_KEY);
  if (existing) return existing;

  const next = crypto.randomUUID();
  window.sessionStorage.setItem(MULTIPLAYER_CLIENT_KEY, next);
  return next;
}

export function getPartyKitSocketUrl(roomCode) {
  const configuredHost = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";
  const partyName = process.env.NEXT_PUBLIC_PARTYKIT_PARTY || "main";
  const hasProtocol = configuredHost.startsWith("ws://") || configuredHost.startsWith("wss://");
  const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  const host = hasProtocol ? configuredHost : `${protocol}://${configuredHost}`;

  return `${host.replace(/\/$/, "")}/parties/${partyName}/${roomCode}`;
}

export class MultiplayerConnection {
  socket = null;
  listeners = new Set();
  statusListeners = new Set();
  reconnectAttempts = 0;
  closedByUser = false;

  constructor(roomCode, clientId, playerId, playerName) {
    this.roomCode = roomCode;
    this.clientId = clientId;
    this.playerId = playerId;
    this.playerName = playerName;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  connect() {
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
      const event = JSON.parse(message.data);
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

  disconnect() {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }

  aim(angle, power) {
    this.send({ type: "AIM", angle, power });
  }

  fire(angle, power, weaponId) {
    this.send({ type: "FIRE_WEAPON", angle, power, weaponId });
  }

  rename(name) {
    this.playerName = name;
    this.send({
      type: "HELLO",
      clientId: this.clientId,
      playerId: this.playerId ?? undefined,
      name
    });
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  scheduleReconnect() {
    this.emitStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts += 1;
    window.setTimeout(() => this.connect(), delay);
  }

  emitStatus(status) {
    this.statusListeners.forEach((listener) => listener(status));
  }
}
