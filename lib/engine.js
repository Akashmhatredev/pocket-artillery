export class GameEngine {
  width = 1200;
  height = 800;
  terrain = [];
  players = [];
  currentPlayerIndex = 0;
  projectiles = [];
  particles = [];

  gravity = 0.2;
  wind = 0;
  isFiring = false;
  winner = null;
  localName = null;

  onStateChange = () => {};

  constructor() {
    this.reset();
  }

  reset(notify = false) {
    this.terrain = new Array(this.width);
    // Smooth procedural terrain
    const offset1 = Math.random() * 1000;
    const offset2 = Math.random() * 1000;
    const offset3 = Math.random() * 1000;
    
    // Add mountains and valleys
    for (let x = 0; x < this.width; x++) {
      let y = this.height * 0.6;
      y += Math.sin((x + offset1) / 200) * 80;
      y += Math.sin((x + offset2) / 70) * 30;
      y += Math.sin((x + offset3) / 15) * 5; // roughness
      this.terrain[x] = y;
    }

    this.players = [
      { id: 1, name: 'Alpha', color: '#22d3ee', hp: 100, angle: 45, power: 60, x: 200, y: 0 },
      { id: 2, name: 'Omega', color: '#fb7185', hp: 100, angle: 135, power: 60, x: 1000, y: 0 },
    ];

    if (this.localName) {
      this.players[0].name = this.localName;
    }

    this.placePlayersOnTerrain();
    this.currentPlayerIndex = 0;
    this.isFiring = false;
    this.winner = null;
    this.projectiles = [];
    this.particles = [];

    if (notify) {
      this.notifyUI();
    }
  }

  placePlayersOnTerrain() {
    for (const p of this.players) {
      p.y = this.getTerrainHeight(p.x);
    }
  }

  setLocalName(name) {
    this.localName = name;
    if (this.players[0]) {
      this.players[0].name = name;
      this.notifyUI();
    }
  }

  getTerrainHeight(x) {
    const ix = Math.floor(x);
    if (ix >= 0 && ix < this.width) return this.terrain[ix];
    return this.height;
  }

  updateAngle(angle) {
    if (this.isFiring || this.winner) return;
    const p = this.players[this.currentPlayerIndex];
    p.angle = angle;
    p.targetAngle = angle;
    // Don't notify UI on every tiny scroll to avoid frame drops, just store internally unless needed
  }

  updatePower(power) {
    if (this.isFiring || this.winner) return;
    const p = this.players[this.currentPlayerIndex];
    p.power = power;
    p.targetPower = power;
  }

  // Lightweight network aim update: set targets and let tick() ease toward
  // them so throttled packets still render as smooth barrel motion.
  applyAimUpdate(event) {
    const p = this.players.find((player) => player.id === event.playerId);
    if (!p) return;
    p.targetAngle = event.angle;
    p.targetPower = event.power;
  }

  fire(weaponId) {
    if (this.isFiring || this.winner) return;
    const p = this.players[this.currentPlayerIndex];
    const rad = (p.angle * Math.PI) / 180;
    const speed = p.power * 0.35 + 2; 
    const vx = Math.cos(rad) * speed;
    const vy = -Math.sin(rad) * speed; 

    let projType = 'standard';
    let radExplode = 60;
    let dmg = 25;
    let radius = 5;
    
    if (weaponId === 'nuke') {
        projType = 'nuke';
        radExplode = 130;
        dmg = 55;
        radius = 8;
    } else if (weaponId === 'cluster') {
        projType = 'cluster';
        radExplode = 45; 
        dmg = 15;
    }

    this.projectiles.push({
      x: p.x + Math.cos(rad) * 20,
      y: p.y - 15 - Math.sin(rad) * 20,
      vx,
      vy,
      radius,
      damage: dmg,
      explosionRadius: radExplode,
      type: projType
    });
    this.isFiring = true;
    this.notifyUI();
  }

  applyServerState(state) {
    this.terrain = [...state.terrain];
    this.players = state.players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      hp: player.hp,
      angle: player.angle,
      power: player.power,
      targetAngle: player.angle,
      targetPower: player.power,
      x: player.x,
      y: player.y,
      connected: player.connected,
      slot: player.slot,
      isRobot: player.isRobot === true,
      robotDifficulty: player.robotDifficulty ?? null,
      shotsFired: player.shotsFired ?? 0,
    }));
    this.currentPlayerIndex = state.activePlayerIndex;
    this.wind = state.wind;
    this.isFiring = false;
    this.projectiles = [];

    if (state.status === 'finished') {
      const winner = this.players.find((player) => player.id === state.winnerId);
      this.winner = winner ?? { id: 'draw', name: 'Draw', color: '#94a3b8', hp: 0, angle: 0, power: 0, x: 0, y: 0 };
    } else {
      this.winner = null;
    }

    this.notifyUI();
  }

  spawnNetworkProjectile(event) {
    const isNuke = event.weaponId === 'nuke';
    const isCluster = event.weaponId === 'cluster';

    this.projectiles = this.projectiles.filter((projectile) => projectile.id !== event.id);
    this.projectiles.push({
      id: event.id,
      x: event.x,
      y: event.y,
      vx: event.vx,
      vy: event.vy,
      radius: isNuke ? 8 : 5,
      damage: isNuke ? 55 : isCluster ? 15 : 25,
      explosionRadius: isNuke ? 130 : isCluster ? 45 : 60,
      type: event.weaponId,
      authoritative: true,
    });
    this.isFiring = true;
    this.notifyUI();
  }

  applyServerImpact(event) {
    this.projectiles = this.projectiles.filter((projectile) => projectile.id !== event.projectileId);
    this.explode(event.x, event.y, event.radius, 0, 'standard');
    this.applyServerState(event.state);
    this.isFiring = false;
    this.notifyUI();
  }

  tick() {
    let stateChanged = false;

    // Ease barrels toward their latest network aim so throttled updates
    // (~10/s) render as continuous motion instead of steps.
    for (const p of this.players) {
      if (typeof p.targetAngle === 'number' && p.angle !== p.targetAngle) {
        const diff = p.targetAngle - p.angle;
        p.angle = Math.abs(diff) < 0.2 ? p.targetAngle : p.angle + diff * 0.3;
      }
      if (typeof p.targetPower === 'number' && p.power !== p.targetPower) {
        const diff = p.targetPower - p.power;
        p.power = Math.abs(diff) < 0.2 ? p.targetPower : p.power + diff * 0.3;
      }
    }

    // Update projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      proj.x += proj.vx;
      proj.y += proj.vy;
      proj.vy += this.gravity;
      proj.vx += this.wind; 

      if (proj.authoritative) {
        continue;
      }

      // Cluster split mechanic
      if (proj.type === 'cluster' && proj.vy > -0.5 && proj.vy < 0.5) {
          this.projectiles.splice(i, 1);
          for(let f = -1; f <= 1; f++) {
              this.projectiles.push({
                  x: proj.x, y: proj.y, 
                  vx: proj.vx + f * 2.5, 
                  vy: proj.vy - Math.random() * 2, 
                  radius: 3.5, 
                  damage: 18, 
                  explosionRadius: 40, 
                  type: 'cluster-fragment'
              });
          }
          continue;
      }

      // Check collision
      const ix = Math.floor(proj.x);
      let hit = false;
      
      // Hit bounds or terrain
      if (proj.y > this.height) { hit = true; }
      else if (proj.x < 0 || proj.x > this.width) { hit = true; }
      else if (ix >= 0 && ix < this.width && proj.y >= this.terrain[ix]) { hit = true; }
      
      // Direct hit on players (optional optimization, basic circle check)
      if (!hit) {
         for (const p of this.players) {
             if (Math.hypot(p.x - proj.x, p.y - 8 - proj.y) < 15) {
                 hit = true;
                 break;
             }
         }
      }

      if (hit) {
        this.explode(proj.x, proj.y, proj.explosionRadius, proj.damage, proj.type);
        this.projectiles.splice(i, 1);
        stateChanged = true;
      }
    }

    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += this.gravity * 0.4;
      p.life--;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }

    // Players falling if terrain destroyed
    for (const p of this.players) {
        const ty = this.getTerrainHeight(p.x);
        if (p.y < ty) {
            p.y += 3;
            if (p.y > ty) p.y = ty;
        }
    }

    // End turn logic
    if (this.isFiring && this.projectiles.length === 0 && this.particles.length === 0) {
      this.isFiring = false;
      stateChanged = true;
      
      // Check win condition
      const alive = this.players.filter(p => p.hp > 0);
      if (alive.length === 0) {
          this.winner = { id: 0, name: 'Draw', color: '#94a3b8', hp: 0, angle:0, power:0, x:0, y:0 };
      } else if (alive.length === 1) {
          this.winner = alive[0];
      } else {
          this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
      }
    }

    if (stateChanged) {
        this.notifyUI();
    }
  }

  explode(cx, cy, radius, damage, type) {
    // Terrain destruction
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.width - 1, Math.floor(cx + radius)); x++) {
      const dx = x - cx;
      const dy = Math.sqrt(radius * radius - dx * dx);
      if (this.terrain[x] < cy + dy) {
         this.terrain[x] = Math.min(this.height, cy + dy);
      }
    }

    for (const p of this.players) {
        // Player hitbox around y - 8 to represent tank body
        const dist = Math.hypot(p.x - cx, (p.y - 8) - cy);
        if (dist < radius + 15) {
            const dmg = Math.floor(damage * Math.max(0.1, (1 - dist / (radius + 15))));
            p.hp = Math.max(0, p.hp - dmg);
        }
    }

    const isNuke = type === 'nuke';
    const pCount = isNuke ? 100 : 40;
    const colors = isNuke ? ['#bef264', '#84cc16', '#4d7c0f', '#fbbf24'] : ['#ef4444', '#f97316', '#fbbf24', '#4b5563', '#1f2937'];
    
    for (let i = 0; i < pCount; i++) {
        const ang = Math.random() * Math.PI * 2;
        const speed = Math.random() * (isNuke ? 8 : 5) + 1;
        this.particles.push({
            x: cx,
            y: cy,
            vx: Math.cos(ang) * speed,
            vy: Math.sin(ang) * speed - (isNuke ? 4 : 2), // upward bias
            life: Math.random() * 30 + 15,
            maxLife: 45,
            color: colors[Math.floor(Math.random() * colors.length)],
        });
    }

    // Smoke trail specifically for nuke
    if (isNuke) {
       for (let i = 0; i < 30; i++) {
          this.particles.push({
            x: cx + (Math.random() - 0.5) * 40,
            y: cy,
            vx: (Math.random() - 0.5) * 1,
            vy: -4 - Math.random() * 6,
            life: Math.random() * 50 + 20,
            maxLife: 70,
            color: '#334155',
          });
       }
    }
  }

  notifyUI() {
    this.onStateChange({
      players: JSON.parse(JSON.stringify(this.players)), // Quick deep clone
      currentPlayerIndex: this.currentPlayerIndex,
      isFiring: this.isFiring,
      winner: this.winner,
    });
  }

  draw(ctx) {
    ctx.clearRect(0, 0, this.width, this.height);

    // Dark grid background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, this.width, this.height);

    // Subtle grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < this.width; x += 50) {
        ctx.moveTo(x, 0); ctx.lineTo(x, this.height);
    }
    for (let y = 0; y < this.height; y += 50) {
        ctx.moveTo(0, y); ctx.lineTo(this.width, y);
    }
    ctx.stroke();

    // Distant mountains
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(0, this.height);
    for (let x = 0; x < this.width; x++) {
        const y = this.height * 0.45 + Math.sin(x/150)*60 + Math.sin(x/80)*25;
        ctx.lineTo(x, y);
    }
    ctx.lineTo(this.width, this.height);
    ctx.fill();

    // Terrain outline
    ctx.strokeStyle = '#2dd4bf'; // Neon teal top trim
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < this.width; x++) {
        if (x === 0) ctx.moveTo(x, this.terrain[x]);
        else ctx.lineTo(x, this.terrain[x]);
    }
    ctx.stroke();

    // Terrain body
    ctx.fillStyle = '#0f766e'; // Tealish dark
    ctx.beginPath();
    ctx.moveTo(0, this.height);
    for (let x = 0; x < this.width; x++) {
        ctx.lineTo(x, this.terrain[x]);
    }
    ctx.lineTo(this.width, this.height);
    ctx.fill();

    // Under terrain shadow
    const grad = ctx.createLinearGradient(0, this.height * 0.5, 0, this.height);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);

    // Trajectory Preview
    if (!this.isFiring && !this.winner) {
        const p = this.players[this.currentPlayerIndex];
        ctx.strokeStyle = p.color; // color matched to player
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([8, 8]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        let tx = p.x;
        let ty = p.y - 15;
        const rad = (p.angle * Math.PI) / 180;
        const speed = p.power * 0.35 + 2;
        let tvx = Math.cos(rad) * speed;
        let tvy = -Math.sin(rad) * speed;
        ctx.moveTo(tx, ty);
        for(let i=0; i<45; i++) {
            tx += tvx * 3;
            ty += tvy * 3;
            tvy += this.gravity * 3;
            ctx.lineTo(tx, ty);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
    }

    // Tanks
    for (const p of this.players) {
        if (p.hp <= 0) continue; // dead

        ctx.fillStyle = p.color;
        
        // Chassis (trapezoid)
        ctx.beginPath();
        ctx.moveTo(p.x - 18, p.y - 6);
        ctx.lineTo(p.x + 18, p.y - 6);
        ctx.lineTo(p.x + 12, p.y - 16);
        ctx.lineTo(p.x - 12, p.y - 16);
        ctx.fill();

        // Treads
        ctx.fillStyle = '#111827';
        ctx.beginPath();
        ctx.roundRect(p.x - 22, p.y - 6, 44, 8, 4);
        ctx.fill();
        ctx.strokeStyle = '#4b5563';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Barrel
        ctx.strokeStyle = '#d1d5db';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 14);
        const rad = (p.angle * Math.PI) / 180;
        ctx.lineTo(p.x + Math.cos(rad) * 22, p.y - 14 - Math.sin(rad) * 22);
        ctx.stroke();

        // Name and HP floaty
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = 'bold 12px Inter, sans-serif';
        ctx.textAlign = 'center';

        if (p.isRobot) {
            // Tag AI tanks on the battlefield itself, so the badge is visible
            // without cross-referencing the HUD.
            const nameWidth = ctx.measureText(p.name).width;
            const badgeWidth = 20;
            const gap = 5;
            const totalWidth = nameWidth + gap + badgeWidth;
            const nameX = p.x - totalWidth / 2 + nameWidth / 2;
            const badgeX = p.x + totalWidth / 2 - badgeWidth;

            ctx.fillText(p.name, nameX, p.y - 38);

            ctx.fillStyle = 'rgba(167,139,250,0.25)';
            ctx.strokeStyle = '#a78bfa';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(badgeX, p.y - 48, badgeWidth, 13, 3);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#ddd6fe';
            ctx.font = 'bold 9px Inter, sans-serif';
            ctx.fillText('AI', badgeX + badgeWidth / 2, p.y - 38.5);
            ctx.font = 'bold 12px Inter, sans-serif';
        } else {
            ctx.fillText(p.name, p.x, p.y - 38);
        }

        ctx.fillStyle = '#ef4444';
        ctx.fillRect(p.x - 20, p.y - 32, 40, 4);
        ctx.fillStyle = '#10b981';
        ctx.fillRect(p.x - 20, p.y - 32, 40 * (p.hp / 100), 4);

        // Turn indicator
        if (p.id === this.players[this.currentPlayerIndex].id && !this.isFiring && !this.winner) {
            ctx.fillStyle = '#fcd34d';
            ctx.beginPath();
            ctx.moveTo(p.x - 6, p.y - 58);
            ctx.lineTo(p.x + 6, p.y - 58);
            ctx.lineTo(p.x, p.y - 48);
            ctx.fill();
        }
    }

    // Projectiles
    for (const proj of this.projectiles) {
        ctx.fillStyle = proj.type === 'nuke' ? '#bef264' : (proj.type === 'cluster' ? '#f59e0b' : '#ef4444');
        ctx.beginPath();
        ctx.arc(proj.x, proj.y, proj.radius, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = `rgba(255,255,255,0.5)`;
        ctx.beginPath();
        ctx.arc(proj.x - proj.vx * 1.5, proj.y - proj.vy * 1.5, proj.radius * 0.8, 0, Math.PI * 2);
        ctx.fill();
    }

    // Particles
    for (const p of this.particles) {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, 3 * (p.life / p.maxLife)), 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1.0;
  }
}
