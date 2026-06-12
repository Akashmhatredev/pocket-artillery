# Pocket Artillery Backend

PartyKit authoritative room server for Pocket Artillery.

## Run

```bash
cd backend
npm install
npm run dev
```

## Deploy

```bash
cd backend
npm run deploy
```

## Environment

Replay persistence is optional. Set these PartyKit environment variables to enable Supabase writes when a match ends:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## Client Messages

- `HELLO`: claims or reconnects a player slot with optional `playerId`, `userId`, and `name`.
- `AIM`: updates authoritative `angle` and/or `power` for the connected player.
- `FIRE_WEAPON`: validates turn and ammo, then emits the deterministic projectile and impact sequence.

## Server Messages

- `JOINED`
- `SYNC_STATE`
- `MATCH_START`
- `TURN_START`
- `SERVER_PROJECTILE_SPAWNED`
- `SERVER_IMPACT`
- `MATCH_END`
- `ERROR`
