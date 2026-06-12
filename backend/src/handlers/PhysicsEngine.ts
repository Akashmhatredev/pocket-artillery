import type {
  PlayerState,
  ProjectileSimulation,
  TerrainModification,
  Vec2,
  WeaponConfig,
  WeaponId
} from "../types";

export const WORLD = {
  width: 1200,
  height: 800,
  gravity: 0.2,
  maxTicks: 1800,
  tickMs: 16
} as const;

const WEAPONS: Record<WeaponId, WeaponConfig> = {
  standard: { id: "standard", projectileRadius: 5, explosionRadius: 60, damage: 25 },
  cluster: { id: "cluster", projectileRadius: 5, explosionRadius: 45, damage: 15 },
  "cluster-fragment": { id: "cluster-fragment", projectileRadius: 3.5, explosionRadius: 40, damage: 18 },
  nuke: { id: "nuke", projectileRadius: 8, explosionRadius: 130, damage: 55 }
};

export class PhysicsEngine {
  readonly width = WORLD.width;
  readonly height = WORLD.height;
  readonly gravity = WORLD.gravity;

  generateTerrain(seed: number): number[] {
    const terrain = new Array<number>(this.width);
    const offset1 = this.seededRange(seed, 1) * 1000;
    const offset2 = this.seededRange(seed, 2) * 1000;
    const offset3 = this.seededRange(seed, 3) * 1000;

    for (let x = 0; x < this.width; x++) {
      let y = this.height * 0.6;
      y += Math.sin((x + offset1) / 200) * 80;
      y += Math.sin((x + offset2) / 70) * 30;
      y += Math.sin((x + offset3) / 15) * 5;
      terrain[x] = Math.round(y * 100) / 100;
    }

    return terrain;
  }

  placePlayersOnTerrain(players: PlayerState[], terrain: number[]): PlayerState[] {
    return players.map((player) => ({
      ...player,
      y: this.getTerrainHeight(terrain, player.x)
    }));
  }

  getWeapon(weaponId: WeaponId | undefined): WeaponConfig {
    return WEAPONS[weaponId ?? "standard"] ?? WEAPONS.standard;
  }

  simulateProjectile(
    projectileId: string,
    player: PlayerState,
    terrain: number[],
    players: PlayerState[],
    angle: number,
    power: number,
    weaponId: WeaponId | undefined,
    wind: number
  ): ProjectileSimulation {
    const weapon = this.getWeapon(weaponId);
    const radians = (this.clamp(angle, 0, 180) * Math.PI) / 180;
    const speed = this.clamp(power, 1, 100) * 0.35 + 2;
    const start = {
      x: player.x + Math.cos(radians) * 20,
      y: player.y - 15 - Math.sin(radians) * 20
    };
    const velocity = {
      x: Math.cos(radians) * speed,
      y: -Math.sin(radians) * speed
    };

    const steps: Vec2[] = [];
    let x = start.x;
    let y = start.y;
    let vx = velocity.x;
    let vy = velocity.y;
    let impact = { x, y };
    let tick = 0;

    for (; tick < WORLD.maxTicks; tick++) {
      x += vx;
      y += vy;
      vy += this.gravity;
      vx += wind;

      impact = { x, y };
      steps.push(impact);

      if (this.hasCollided(impact, terrain, players)) {
        break;
      }
    }

    return {
      id: projectileId,
      weapon,
      playerId: player.id,
      start,
      velocity,
      impact: this.roundPoint(impact),
      tti: Math.max(WORLD.tickMs, (tick + 1) * WORLD.tickMs),
      steps
    };
  }

  applyExplosion(
    terrain: number[],
    players: PlayerState[],
    center: Vec2,
    radius: number,
    damage: number
  ): { terrain: number[]; terrainMod: TerrainModification; players: PlayerState[] } {
    const nextTerrain = [...terrain];
    const fromX = Math.max(0, Math.floor(center.x - radius));
    const toX = Math.min(this.width - 1, Math.floor(center.x + radius));
    const heights: number[] = [];

    for (let x = fromX; x <= toX; x++) {
      const dx = x - center.x;
      const dy = Math.sqrt(Math.max(0, radius * radius - dx * dx));
      if (nextTerrain[x] < center.y + dy) {
        nextTerrain[x] = Math.min(this.height, Math.round((center.y + dy) * 100) / 100);
      }
      heights.push(nextTerrain[x]);
    }

    const nextPlayers = players.map((player) => {
      const dist = Math.hypot(player.x - center.x, player.y - 8 - center.y);
      let hp = player.hp;

      if (dist < radius + 15) {
        const appliedDamage = Math.floor(damage * Math.max(0.1, 1 - dist / (radius + 15)));
        hp = Math.max(0, player.hp - appliedDamage);
      }

      return {
        ...player,
        hp,
        y: this.getTerrainHeight(nextTerrain, player.x)
      };
    });

    return {
      terrain: nextTerrain,
      terrainMod: { fromX, heights },
      players: nextPlayers
    };
  }

  getDamageMap(before: PlayerState[], after: PlayerState[]): Record<string, number> {
    return Object.fromEntries(
      before
        .map((player) => {
          const next = after.find((candidate) => candidate.id === player.id);
          return [player.id, Math.max(0, player.hp - (next?.hp ?? player.hp))] as const;
        })
        .filter(([, damage]) => damage > 0)
    );
  }

  clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  private hasCollided(point: Vec2, terrain: number[], players: PlayerState[]): boolean {
    const ix = Math.floor(point.x);

    if (point.y > this.height || point.x < 0 || point.x > this.width) {
      return true;
    }

    if (ix >= 0 && ix < this.width && point.y >= terrain[ix]) {
      return true;
    }

    return players.some((player) => {
      if (player.hp <= 0) return false;
      return Math.hypot(player.x - point.x, player.y - 8 - point.y) < 15;
    });
  }

  private getTerrainHeight(terrain: number[], x: number): number {
    const ix = Math.floor(x);
    if (ix >= 0 && ix < this.width) return terrain[ix];
    return this.height;
  }

  private seededRange(seed: number, salt: number): number {
    let value = seed + salt * 0x9e3779b9;
    value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
    value = (value ^ (value >>> 16)) >>> 0;
    return value / 0xffffffff;
  }

  private roundPoint(point: Vec2): Vec2 {
    return {
      x: Math.round(point.x * 100) / 100,
      y: Math.round(point.y * 100) / 100
    };
  }
}
