// Shared plumbing for the headless integration tests.
//
// These drive the real SpacetimeDB module over a websocket, exactly the way the
// browser client does — no mocks. They need a local instance with the module
// published:
//
//   spacetime start                                        # terminal 1
//   spacetime publish -s local -p stdb-module pocket-artillery --delete-data
//   npm run test:integration                               # terminal 2

import { DbConnection } from "../../module_bindings";

const URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI || "ws://localhost:3000";
const DB = process.env.NEXT_PUBLIC_SPACETIMEDB_MODULE || "pocket-artillery";

export type Client = {
  label: string;
  conn: DbConnection;
  identity: string;
  /** Auth token — pass it back to `connectClient` to reconnect as the same player. */
  token: string;
  disconnect: () => void;
};

/**
 * Connect a client and subscribe it to one room's rows.
 *
 * Without `token` the client gets a brand-new identity, like a separate
 * browser. Passing a previous client's token reconnects as that same player,
 * which is how the reconnect/resume paths are exercised.
 */
export async function connectClient(
  label: string,
  roomCode: string,
  token?: string
): Promise<Client> {
  let issuedToken = token ?? "";
  const conn = await new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: connect timed out`)), 15_000);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((c, _identity, freshToken) => {
        clearTimeout(timer);
        if (freshToken) issuedToken = freshToken;
        resolve(c);
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timer);
        reject(error);
      })
      .build();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: subscription timed out`)), 15_000);
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve();
      })
      .onError((_ctx, error) => {
        clearTimeout(timer);
        reject(error);
      })
      .subscribe([
        `SELECT * FROM match_room WHERE room_code = '${roomCode}'`,
        `SELECT * FROM player WHERE room_code = '${roomCode}'`,
        `SELECT * FROM projectile WHERE room_code = '${roomCode}'`,
      ]);
  });

  return {
    label,
    conn,
    identity: conn.identity!.toHexString(),
    token: issuedToken,
    disconnect: () => conn.disconnect(),
  };
}

export function room(client: Client, roomCode: string) {
  for (const r of client.conn.db.match_room.iter()) {
    if (r.roomCode === roomCode) return r;
  }
  return null;
}

export function players(client: Client, roomCode: string) {
  return Array.from(client.conn.db.player.iter())
    .filter((p) => p.roomCode === roomCode)
    .sort((a, b) => a.slot - b.slot);
}

export function projectiles(client: Client, roomCode: string) {
  return Array.from(client.conn.db.projectile.iter()).filter((p) => p.roomCode === roomCode);
}

/** Poll until `check` returns truthy, or fail with `describe` in the message. */
export async function waitFor<T>(
  describe: string,
  check: () => T | null | undefined | false,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${describe}`);
    await sleep(50);
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomCode(prefix: string) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = prefix.toUpperCase();
  while (out.length < 8) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** Minimal test registry: keeps output readable and sets the exit code. */
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
export function test(name: string, fn: () => Promise<void>) {
  cases.push({ name, fn });
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${message} (expected ${expected}, got ${actual})`);
  }
}

export async function run(suite: string) {
  console.log(`\n${suite}`);
  let failed = 0;
  for (const { name, fn } of cases) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ok   ${name}  (${Date.now() - started}ms)`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}  (${Date.now() - started}ms)`);
      console.error(`       ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exitCode = 1;
  // The SDK keeps its sockets open; nothing else is pending, so bail out.
  setTimeout(() => process.exit(process.exitCode ?? 0), 250);
}
