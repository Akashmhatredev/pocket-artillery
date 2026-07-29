'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameEngine } from '@/lib/engine';
import { Slider } from '@radix-ui/react-slider';
import {
    Bomb,
    Bot,
    Check,
    Clipboard,
    Link2,
    Loader2,
    LogOut,
    Pencil,
    Radio,
    RotateCcw,
    Share2,
    Shield,
    Skull,
    Swords,
    Target,
    Timer,
    User,
    Users,
    WifiOff,
    X
} from 'lucide-react';
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
    MULTIPLAYER_STORAGE_KEY,
    generateRoomCode,
    getOrCreateClientId,
    normalizeRoomCode
} from '@/lib/multiplayer/client';
import { MultiplayerConnection } from '@/lib/multiplayer/spacetime';
import {
    appendFeed,
    buildSummary,
    describeEvent,
    describeOutcome,
    difficultyLabel
} from '@/lib/game/feed';

function cn(...inputs) {
    return twMerge(clsx(inputs));
}

const EMPTY_GAME_STATE = {
    players: [],
    currentPlayerIndex: 0,
    isFiring: false,
    winner: null,
};

const WEAPONS = [
    { id: 'standard', name: 'Standard', icon: Target },
    { id: 'cluster', name: 'Cluster', icon: Bomb },
    { id: 'nuke', name: 'Mini Nuke', icon: Skull },
];

// 'practice' is the offline hot-seat sandbox driven purely by the local engine.
// 'solo' and 'multi' are both real server-backed matches — the only difference
// is that solo's opponent is a robot the module seats for you.
const MODE = {
    PRACTICE: 'practice',
    SOLO: 'solo',
    MULTI: 'multi',
};

const DIFFICULTIES = [
    { id: 'easy', name: 'Easy', hint: 'Rookie aim, hoards its specials' },
    { id: 'normal', name: 'Normal', hint: 'Solid aim, saves the nuke' },
    { id: 'hard', name: 'Hard', hint: 'Ruthless aim, punishes mistakes' },
];

const DEFAULT_PLAYER_NAME = 'Commander';

// Seconds each player gets to aim and pick a weapon before the shot fires
// automatically. Must match TURN_MS in stdb-module/src/lib.rs.
const TURN_SECONDS = 30;

// Minimum gap between outbound aim syncs. Slider drags fire ~60 events/s;
// sending each one floods the websocket and lags everything behind it.
const AIM_SYNC_MS = 100;

const GameSlider = ({
    value,
    onValueChange,
    max,
    min,
    color,
    disabled = false,
}) => (
    <Slider
        className={cn("relative flex items-center select-none touch-none w-full h-4 group", disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer")}
        value={[value]}
        onValueChange={([val]) => onValueChange(val)}
        max={max}
        min={min}
        step={1}
        disabled={disabled}
    >
        <div className="bg-slate-800 relative grow rounded-full h-1.5 overflow-hidden">
            <div
                className={cn("absolute h-full rounded-full transition-all duration-200", color || "bg-gradient-to-r from-cyan-600 to-cyan-400")}
                style={{ width: `${((value - min) / (max - min)) * 100}%` }}
            />
        </div>
        <div
            className="block w-4 h-4 bg-white rounded-full shadow-lg absolute transform -translate-x-1/2 group-hover:scale-110 active:scale-110 transition-transform"
            style={{ left: `${((value - min) / (max - min)) * 100}%` }}
        />
    </Slider>
);

const getPlayerTheme = (index) => {
    return index === 0 ? {
        border: "border-cyan-500",
        ring: "ring-cyan-500/20",
        bgLight: "bg-cyan-900/30",
        text: "text-cyan-400",
        glow: "from-cyan-600 to-cyan-400",
        shadowGlow: "shadow-[0_0_8px_rgba(34,211,238,0.5)]",
        fireGlow: "from-cyan-600 to-blue-600"
    } : {
        border: "border-rose-500",
        ring: "ring-rose-500/20",
        bgLight: "bg-rose-900/30",
        text: "text-rose-400",
        glow: "from-rose-600 to-rose-400",
        shadowGlow: "shadow-[0_0_8px_rgba(251,113,133,0.5)]",
        fireGlow: "from-rose-600 to-pink-600"
    };
};

const getStoredSession = () => {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(MULTIPLAYER_STORAGE_KEY);
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const storeSession = (session) => {
    if (typeof window === 'undefined') return;
    if (!session) {
        window.localStorage.removeItem(MULTIPLAYER_STORAGE_KEY);
        return;
    }
    window.localStorage.setItem(MULTIPLAYER_STORAGE_KEY, JSON.stringify(session));
};

const PLAYER_NAME_STORAGE_KEY = 'pocket-artillery.player-name';

const getStoredName = () => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY);
};

const storeName = (name) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
};

const resolveName = (value) => (value ?? '').trim().slice(0, 24) || DEFAULT_PLAYER_NAME;

export default function Home() {
    const canvasRef = useRef(null);
    const engineRef = useRef(null);
    const requestRef = useRef(0);
    const connectionRef = useRef(null);
    const playerNameRef = useRef(DEFAULT_PLAYER_NAME);
    const myPlayerIdRef = useRef(null);
    const aimSyncRef = useRef({ last: 0, timer: null, angle: null, power: null });

    const [screen, setScreen] = useState('home');
    const [mode, setMode] = useState(MODE.PRACTICE);
    const [gameState, setGameState] = useState(EMPTY_GAME_STATE);
    const [roomState, setRoomState] = useState(null);
    const [session, setSession] = useState(null);
    const [connectionStatus, setConnectionStatus] = useState('idle');
    const [joinCode, setJoinCode] = useState('');
    const [weapon, setWeapon] = useState('standard');
    const [angle, setAngle] = useState(45);
    const [power, setPower] = useState(60);
    const [loading, setLoading] = useState(false);
    const [toast, setToast] = useState(null);
    const [playerName, setPlayerName] = useState(DEFAULT_PLAYER_NAME);
    const [renameOpen, setRenameOpen] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [confirmQuit, setConfirmQuit] = useState(false);
    const [practiceDeadline, setPracticeDeadline] = useState(null);
    const [timeLeft, setTimeLeft] = useState(null);
    const [difficulty, setDifficulty] = useState('normal');
    const [feed, setFeed] = useState([]);

    const feedIdRef = useRef(0);

    const showToast = useCallback((message) => {
        setToast(message);
        window.setTimeout(() => setToast(null), 2600);
    }, []);

    const isOnline = mode === MODE.MULTI || mode === MODE.SOLO;

    // Latest known roster, so feed lines for events that don't carry a full
    // state (a projectile spawn) can still name who did what.
    const rosterRef = useRef([]);

    const pushFeed = useCallback((event) => {
        const entry = describeEvent(event, rosterRef.current, myPlayerIdRef.current);
        if (!entry) return;
        feedIdRef.current += 1;
        const id = feedIdRef.current;
        setFeed((current) => appendFeed(current, entry, id));
    }, []);

    const syncRoomToEngine = useCallback((state) => {
        engineRef.current?.applyServerState(state);
        setRoomState(state);
        if (state.matchId) {
            setSession((current) => {
                if (!current) return current;
                const nextSession = { ...current, matchId: state.matchId };
                storeSession(nextSession);
                return nextSession;
            });
        }
    }, []);

    // Trailing-edge throttle: always ends up sending the latest aim, but at
    // most one reducer call per AIM_SYNC_MS.
    const sendAimThrottled = useCallback((nextAngle, nextPower) => {
        const sync = aimSyncRef.current;
        sync.angle = nextAngle;
        sync.power = nextPower;
        if (sync.timer !== null) return;
        const wait = Math.max(0, AIM_SYNC_MS - (Date.now() - sync.last));
        sync.timer = window.setTimeout(() => {
            sync.timer = null;
            sync.last = Date.now();
            connectionRef.current?.aim(sync.angle, sync.power);
        }, wait);
    }, []);

    const handleServerEvent = useCallback((event) => {
        if (event.state?.players) {
            rosterRef.current = event.state.players;
        }
        pushFeed(event);

        if (event.type === 'AIM_UPDATE') {
            // Hot path: move the canvas barrel directly; only mirror the
            // sliders for the opponent's aim (our own echo would fight the drag).
            engineRef.current?.applyAimUpdate(event);
            if (event.playerId && event.playerId !== myPlayerIdRef.current) {
                setAngle(event.angle);
                setPower(event.power);
            }
            return;
        }

        if (event.type === 'JOINED') {
            // Set the ref now rather than waiting for the session effect, so the
            // very first feed line already knows which tank is ours.
            myPlayerIdRef.current = event.playerId ?? null;
            setSession((current) => {
                if (!current) return current;
                const nextSession = { ...current, playerId: event.playerId };
                storeSession(nextSession);
                return nextSession;
            });
            return;
        }

        if (event.type === 'SYNC_STATE') {
            setRoomState(event.state);
            if (event.state.status === 'playing' || event.state.status === 'finished') {
                syncRoomToEngine(event.state);
                setScreen('game');
            }
            return;
        }

        if (event.type === 'MATCH_START') {
            setScreen('match-found');
            syncRoomToEngine(event.state);
            window.setTimeout(() => setScreen('game'), 800);
            return;
        }

        if (event.type === 'TURN_START') {
            syncRoomToEngine(event.state);
            setScreen('game');
            return;
        }

        if (event.type === 'SERVER_PROJECTILE_SPAWNED' || event.type === 'PROJECTILE_SPAWNED') {
            engineRef.current?.spawnNetworkProjectile(event);
            return;
        }

        if (event.type === 'SERVER_IMPACT' || event.type === 'IMPACT') {
            engineRef.current?.applyServerImpact(event);
            setRoomState(event.state);
            return;
        }

        if (event.type === 'MATCH_END') {
            syncRoomToEngine(event.state);
            setScreen('game');
            return;
        }

        if (event.type === 'ERROR') {
            showToast(event.message);
        }
    }, [pushFeed, showToast, syncRoomToEngine]);

    // Opens a server-backed match. `options.solo` seats a robot opponent and
    // starts immediately; otherwise we wait in the lobby for a second human.
    const connectToRoom = useCallback((roomCode, isHost, playerId = null, options = {}) => {
        const normalized = normalizeRoomCode(roomCode);
        const clientId = getOrCreateClientId();
        const resolvedName = resolveName(playerNameRef.current);
        const solo = options.solo === true;
        const level = options.difficulty ?? 'normal';
        const nextSession = {
            roomCode: normalized,
            clientId,
            playerId,
            matchId: null,
            isHost,
            name: resolvedName,
            solo,
            difficulty: level,
        };

        connectionRef.current?.disconnect();
        const connection = new MultiplayerConnection(normalized, clientId, playerId, resolvedName, {
            solo,
            difficulty: level,
        });
        connectionRef.current = connection;
        connection.onMessage(handleServerEvent);
        connection.onStatus(setConnectionStatus);
        connection.connect();

        rosterRef.current = [];
        setFeed([]);
        setMode(solo ? MODE.SOLO : MODE.MULTI);
        setScreen('waiting');
        setSession(nextSession);
        storeSession(nextSession);
    }, [handleServerEvent]);

    useEffect(() => {
        const engine = new GameEngine();
        engineRef.current = engine;
        engine.onStateChange = (state) => setGameState(state);
        engine.notifyUI();

        const loop = () => {
            engine.tick();
            const ctx = canvasRef.current?.getContext('2d');
            if (ctx) engine.draw(ctx);
            requestRef.current = requestAnimationFrame(loop);
        };
        requestRef.current = requestAnimationFrame(loop);

        return () => {
            cancelAnimationFrame(requestRef.current);
            connectionRef.current?.disconnect();
            if (aimSyncRef.current.timer !== null) {
                window.clearTimeout(aimSyncRef.current.timer);
            }
        };
    }, []);

    useEffect(() => {
        const storedName = getStoredName();
        if (storedName) {
            playerNameRef.current = storedName;
            setPlayerName(storedName);
        }
    }, []);

    useEffect(() => {
        playerNameRef.current = playerName;
    }, [playerName]);

    useEffect(() => {
        myPlayerIdRef.current = session?.playerId ?? null;
    }, [session]);

    useEffect(() => {
        const storedSession = getStoredSession();
        if (storedSession?.roomCode) {
            window.setTimeout(() => connectToRoom(
                storedSession.roomCode,
                storedSession.isHost,
                storedSession.playerId,
                { solo: storedSession.solo === true, difficulty: storedSession.difficulty }
            ), 0);
        }
    }, [connectToRoom]);

    const activePlayer = gameState.players[gameState.currentPlayerIndex];
    const currentTheme = getPlayerTheme(gameState.currentPlayerIndex);
    const myPlayer = roomState?.players.find((player) => player.id === session?.playerId);
    const isMyTurn = !isOnline || (!!myPlayer && roomState?.players[roomState.activePlayerIndex]?.id === myPlayer.id);
    const controlsDisabled = gameState.isFiring || !!gameState.winner || (isOnline && (!isMyTurn || roomState?.status !== 'playing'));
    const connectedCount = roomState?.players.filter((player) => player.connected).length ?? 0;
    const opponent = roomState?.players.find((player) => player.id !== session?.playerId);
    const roomUrl = typeof window === 'undefined' || !session ? '' : `${window.location.origin}?room=${session.roomCode}`;
    const summary = useMemo(
        () => (gameState.winner ? buildSummary(roomState, session?.playerId) : []),
        [gameState.winner, roomState, session?.playerId]
    );

    // Re-seed the sliders from server state only when the turn changes —
    // running this on every state sync would fight an in-progress drag.
    useEffect(() => {
        if (!activePlayer || gameState.isFiring) return;
        const syncControlState = window.setTimeout(() => {
            setAngle(activePlayer.angle);
            setPower(activePlayer.power);
        }, 0);
        return () => window.clearTimeout(syncControlState);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gameState.currentPlayerIndex, gameState.isFiring, mode, screen]);

    // Offline practice keeps its own 30s clock per turn; server-backed matches
    // trust turn_started_at (the module auto-fires on timeout).
    useEffect(() => {
        if (isOnline || screen !== 'game' || gameState.isFiring || gameState.winner || gameState.players.length === 0) {
            setPracticeDeadline(null);
            return;
        }
        setPracticeDeadline(Date.now() + TURN_SECONDS * 1000);
    }, [isOnline, screen, gameState.currentPlayerIndex, gameState.isFiring, gameState.winner, gameState.players.length]);

    const turnDeadline = isOnline
        ? (roomState?.status === 'playing' && roomState.turnStartedAt
            ? roomState.turnStartedAt + (roomState.turnDurationMs ?? TURN_SECONDS * 1000)
            : null)
        : practiceDeadline;

    useEffect(() => {
        if (!turnDeadline || gameState.isFiring || gameState.winner) {
            setTimeLeft(null);
            return;
        }
        const update = () => {
            const remaining = Math.ceil((turnDeadline - Date.now()) / 1000);
            setTimeLeft(Math.min(TURN_SECONDS, Math.max(0, remaining)));
        };
        update();
        const id = window.setInterval(update, 200);
        return () => window.clearInterval(id);
    }, [turnDeadline, gameState.isFiring, gameState.winner]);

    // Practice auto-shoot when the clock hits zero, using the current aim +
    // weapon. Server-backed matches are auto-fired by the module instead.
    useEffect(() => {
        if (isOnline || timeLeft !== 0 || !practiceDeadline) return;
        if (gameState.isFiring || gameState.winner) return;
        setPracticeDeadline(null);
        engineRef.current?.fire(weapon);
    }, [isOnline, timeLeft, practiceDeadline, gameState.isFiring, gameState.winner, weapon]);

    const createGame = async () => {
        setLoading(true);
        try {
            const response = await fetch('/api/rooms', { method: 'POST' });
            const data = await response.json();
            connectToRoom(data.roomCode, true);
            showToast('Room created');
        } catch {
            showToast('Could not create room');
        } finally {
            setLoading(false);
        }
    };

    const joinGame = async () => {
        const normalized = normalizeRoomCode(joinCode);
        if (normalized.length < 4) {
            showToast('Enter a valid room code');
            return;
        }

        setLoading(true);
        try {
            const response = await fetch(`/api/rooms/${normalized}`);
            if (!response.ok) throw new Error('Invalid room');
            connectToRoom(normalized, false);
            showToast('Joining room');
        } catch {
            showToast('Could not join that room');
        } finally {
            setLoading(false);
        }
    };

    // Solo play is a real server-backed match; the module seats the robot and
    // starts it immediately, so there is no lobby to wait in.
    const startSoloMatch = useCallback((level = difficulty) => {
        setWeapon('standard');
        setAngle(45);
        setPower(60);
        connectToRoom(generateRoomCode(), true, null, { solo: true, difficulty: level });
    }, [connectToRoom, difficulty]);

    const startPractice = () => {
        connectionRef.current?.disconnect();
        connectionRef.current = null;
        storeSession(null);
        setMode(MODE.PRACTICE);
        setSession(null);
        setRoomState(null);
        setConnectionStatus('idle');
        setFeed([]);
        setScreen('game');
        engineRef.current?.reset(true);
        engineRef.current?.setLocalName(resolveName(playerNameRef.current));
        setWeapon('standard');
    };

    const leaveRoom = () => {
        connectionRef.current?.disconnect();
        connectionRef.current = null;
        storeSession(null);
        setSession(null);
        setRoomState(null);
        setConnectionStatus('idle');
        setMode(MODE.PRACTICE);
        setScreen('home');
        setFeed([]);
        rosterRef.current = [];
        engineRef.current?.reset(true);
    };

    const quitMatch = () => {
        setConfirmQuit(false);
        leaveRoom();
        showToast('Left the match');
    };

    const saveName = (raw) => {
        const next = resolveName(raw);
        setPlayerName(next);
        storeName(next);
        setSession((current) => {
            if (!current) return current;
            const nextSession = { ...current, name: next };
            storeSession(nextSession);
            return nextSession;
        });
        if (isOnline) {
            connectionRef.current?.rename(next);
        } else {
            engineRef.current?.setLocalName(next);
        }
    };

    const openRename = () => {
        setNameDraft(playerName);
        setRenameOpen(true);
    };

    const submitRename = () => {
        saveName(nameDraft);
        setRenameOpen(false);
        showToast('Callsign updated');
    };

    const handleAngleChange = (val) => {
        if (controlsDisabled) return;
        setAngle(val);
        engineRef.current?.updateAngle(val);
        if (isOnline) sendAimThrottled(val, power);
    };

    const handlePowerChange = (val) => {
        if (controlsDisabled) return;
        setPower(val);
        engineRef.current?.updatePower(val);
        if (isOnline) sendAimThrottled(angle, val);
    };

    const handleWeaponSelect = (weaponId) => {
        if (controlsDisabled) return;
        setWeapon(weaponId);
        // Sync the pick so a server-side turn timeout auto-fires this weapon.
        if (isOnline) connectionRef.current?.selectWeapon(weaponId);
    };

    const handleFire = () => {
        if (controlsDisabled) return;
        if (isOnline) {
            connectionRef.current?.fire(angle, power, weapon);
        } else {
            engineRef.current?.fire(weapon);
        }
    };

    const handleRestart = async () => {
        setWeapon('standard');
        setAngle(45);
        setPower(60);

        if (mode === MODE.SOLO) {
            // A fresh room code keeps the finished match's rows out of the way.
            startSoloMatch(session?.difficulty ?? difficulty);
            return;
        }

        if (mode === MODE.MULTI) {
            connectionRef.current?.disconnect();
            if (session?.isHost) {
                await createGame();
            } else {
                leaveRoom();
                showToast('Ask the host for the next room code');
            }
            return;
        }

        engineRef.current?.reset(true);
    };

    const copyRoomCode = async () => {
        if (!session?.roomCode) return;
        await navigator.clipboard?.writeText(session.roomCode);
        showToast('Room code copied');
    };

    const shareRoom = async () => {
        if (!session?.roomCode) return;
        const text = `Join my Pocket Artillery match: ${session.roomCode}`;
        if (navigator.share) {
            await navigator.share({ title: 'Pocket Artillery', text, url: roomUrl });
        } else {
            await navigator.clipboard?.writeText(text);
            showToast('Invite copied');
        }
    };

    const matchStatusText = useMemo(() => {
        if (connectionStatus === 'connecting') return 'Connecting';
        if (connectionStatus === 'reconnecting') return 'Reconnecting';
        if (connectionStatus === 'connected') return 'Online';
        if (connectionStatus === 'error') return 'Connection issue';
        return 'Offline';
    }, [connectionStatus]);

    return (
        <main className="min-h-screen max-h-screen bg-[#0A0B10] text-slate-100 flex flex-col font-sans overflow-hidden relative">
            {toast && (
                <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 rounded border border-cyan-500/40 bg-[#101522] px-4 py-2 text-xs font-bold uppercase tracking-wider text-cyan-100 shadow-2xl">
                    {toast}
                </div>
            )}

            {renameOpen && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#0A0B10]/80 backdrop-blur-md p-4">
                    <div className="w-full max-w-sm border border-slate-800 bg-[#11131C] rounded-lg p-6 shadow-2xl">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-xl font-black text-white uppercase tracking-wider flex items-center gap-2"><User className="w-5 h-5 text-cyan-400" /> Callsign</h2>
                            <button onClick={() => setRenameOpen(false)} className="text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
                        </div>
                        <p className="text-xs text-slate-400 mb-4">Shown to your opponent and saved on this device.</p>
                        <input
                            autoFocus
                            value={nameDraft}
                            onChange={(event) => setNameDraft(event.target.value.slice(0, 24))}
                            onKeyDown={(event) => { if (event.key === 'Enter') submitRename(); }}
                            placeholder={DEFAULT_PLAYER_NAME}
                            maxLength={24}
                            className="w-full h-12 rounded-lg border border-slate-700 bg-[#0A0B10] px-4 text-lg font-bold text-white outline-none focus:border-cyan-400"
                        />
                        <div className="mt-4 flex gap-3">
                            <button onClick={submitRename} className="flex-1 h-12 rounded-lg border border-cyan-500 bg-cyan-500/10 text-cyan-100 font-black uppercase tracking-wider hover:bg-cyan-500/20 transition flex items-center justify-center gap-2">
                                <Check className="w-4 h-4" /> Save
                            </button>
                            <button onClick={() => setRenameOpen(false)} className="h-12 px-5 rounded-lg border border-slate-700 bg-[#0A0B10] text-slate-300 font-black uppercase tracking-wider hover:border-slate-500 transition">
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {confirmQuit && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#0A0B10]/80 backdrop-blur-md p-4">
                    <div className="w-full max-w-sm border border-slate-800 bg-[#11131C] rounded-lg p-6 shadow-2xl text-center">
                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em] mb-2">Leave Match</div>
                        <h2 className="text-2xl font-black text-white tracking-wide mb-2">Quit the battle?</h2>
                        <p className="text-sm text-slate-400 mb-6">
                            {mode === MODE.MULTI
                                ? 'Leaving forfeits this match to your opponent.'
                                : mode === MODE.SOLO
                                    ? 'Leaving forfeits this match to the robot.'
                                    : 'Your current game will be lost.'}
                        </p>
                        <div className="flex gap-3">
                            <button onClick={quitMatch} className="flex-1 h-12 rounded-lg border border-rose-500 bg-rose-500/10 text-rose-100 font-black uppercase tracking-wider hover:bg-rose-500/20 transition flex items-center justify-center gap-2">
                                <LogOut className="w-4 h-4" /> Quit
                            </button>
                            <button onClick={() => setConfirmQuit(false)} className="h-12 px-5 rounded-lg border border-slate-700 bg-[#0A0B10] text-slate-300 font-black uppercase tracking-wider hover:border-slate-500 transition">
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {screen === 'home' && (
                <section className="min-h-screen w-full flex items-center justify-center px-4 py-8 bg-[#0A0B10]">
                    <div className="w-full max-w-5xl grid gap-6 md:grid-cols-[1.1fr_0.9fr] items-stretch">
                        <div className="border border-slate-800 bg-[#11131C] p-6 sm:p-8 rounded-lg flex flex-col justify-between min-h-[420px]">
                            <div>
                                <div className="text-[10px] uppercase tracking-[0.35em] text-cyan-400 font-black mb-4">Pocket Artillery</div>
                                <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-white">Online tank duels, one shot at a time.</h1>
                                <p className="mt-4 text-sm sm:text-base text-slate-400 max-w-xl">Create a private room, share the code, and let the backend settle every turn, projectile, hit, and terrain scar.</p>
                                <div className="mt-6">
                                    <label className="text-[10px] uppercase tracking-[0.3em] text-slate-500 font-black">Your Callsign</label>
                                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0A0B10] px-3 focus-within:border-cyan-400 transition">
                                        <User className="w-4 h-4 text-slate-500 shrink-0" />
                                        <input
                                            value={playerName}
                                            onChange={(event) => { const value = event.target.value.slice(0, 24); setPlayerName(value); storeName(value); }}
                                            placeholder={DEFAULT_PLAYER_NAME}
                                            maxLength={24}
                                            className="w-full h-12 bg-transparent text-white font-bold outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className="mt-8 space-y-4">
                                <div className="grid gap-3 sm:grid-cols-3">
                                    <button onClick={() => startSoloMatch()} className="h-14 rounded-lg border border-violet-500 bg-violet-500/10 text-violet-100 font-black uppercase tracking-wider hover:bg-violet-500/20 transition flex items-center justify-center gap-2">
                                        <Bot className="w-4 h-4" /> Vs Robot
                                    </button>
                                    <button onClick={createGame} disabled={loading} className="h-14 rounded-lg border border-cyan-500 bg-cyan-500/10 text-cyan-100 font-black uppercase tracking-wider hover:bg-cyan-500/20 transition flex items-center justify-center gap-2">
                                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />} Create Game
                                    </button>
                                    <button onClick={() => setScreen('joining')} className="h-14 rounded-lg border border-slate-700 bg-[#1A1D29] text-white font-black uppercase tracking-wider hover:border-rose-400 transition flex items-center justify-center gap-2">
                                        <Link2 className="w-4 h-4" /> Join Game
                                    </button>
                                </div>

                                <div>
                                    <label className="text-[10px] uppercase tracking-[0.3em] text-slate-500 font-black">Robot Skill</label>
                                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                                        {DIFFICULTIES.map((level) => (
                                            <button
                                                key={level.id}
                                                onClick={() => setDifficulty(level.id)}
                                                title={level.hint}
                                                className={cn(
                                                    "h-11 rounded-lg border text-[11px] font-black uppercase tracking-wider transition",
                                                    difficulty === level.id
                                                        ? "border-violet-500 bg-violet-500/10 text-violet-100"
                                                        : "border-slate-700 bg-[#0A0B10] text-slate-400 hover:border-slate-500"
                                                )}
                                            >
                                                {level.name}
                                            </button>
                                        ))}
                                    </div>
                                    <p className="mt-2 text-xs text-slate-500">
                                        {DIFFICULTIES.find((level) => level.id === difficulty)?.hint}
                                    </p>
                                </div>

                                <button onClick={startPractice} className="text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-300 transition flex items-center gap-2">
                                    <Swords className="w-3.5 h-3.5" /> Or practice offline (hot seat)
                                </button>
                            </div>
                        </div>
                        <div className="border border-slate-800 bg-[#11131C] p-6 rounded-lg">
                            <div className="flex items-center gap-3 text-cyan-300 uppercase text-xs font-black tracking-widest mb-5">
                                <Shield className="w-4 h-4" /> Server Authority
                            </div>
                            <div className="space-y-4 text-sm text-slate-400">
                                <StatusRow label="Turns" value="Validated server-side" />
                                <StatusRow label="Projectiles" value="Deterministic backend arcs" />
                                <StatusRow label="Damage" value="Authoritative HP sync" />
                                <StatusRow label="Robot" value="Plays by the same rules" />
                                <StatusRow label="Reconnects" value="60 second grace window" />
                            </div>
                        </div>
                    </div>
                </section>
            )}

            {screen === 'joining' && (
                <section className="min-h-screen flex items-center justify-center px-4 bg-[#0A0B10]">
                    <div className="w-full max-w-md border border-slate-800 bg-[#11131C] rounded-lg p-6 shadow-2xl">
                        <button onClick={() => setScreen('home')} className="ml-auto mb-4 flex text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
                        <h2 className="text-2xl font-black text-white uppercase tracking-wider mb-2">Join Game</h2>
                        <p className="text-sm text-slate-400 mb-6">Enter the room code from the host.</p>
                        <input
                            value={joinCode}
                            onChange={(event) => setJoinCode(normalizeRoomCode(event.target.value))}
                            placeholder="A7K2QZ"
                            className="w-full h-14 rounded-lg border border-slate-700 bg-[#0A0B10] px-4 text-center text-2xl font-black tracking-[0.35em] text-white outline-none focus:border-cyan-400"
                        />
                        <button onClick={joinGame} disabled={loading} className="mt-4 w-full h-14 rounded-lg border border-cyan-500 bg-cyan-500/10 text-cyan-100 font-black uppercase tracking-wider hover:bg-cyan-500/20 transition flex items-center justify-center gap-2">
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />} Connect
                        </button>
                    </div>
                </section>
            )}

            {(screen === 'waiting' || screen === 'match-found') && session && (
                <section className="min-h-screen flex items-center justify-center px-4 bg-[#0A0B10]">
                    <div className="w-full max-w-3xl border border-slate-800 bg-[#11131C] rounded-lg p-5 sm:p-7 shadow-2xl">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
                            <div>
                                <div className={cn("text-[10px] uppercase tracking-[0.35em] font-black", mode === MODE.SOLO ? "text-violet-400" : "text-cyan-400")}>
                                    {mode === MODE.SOLO ? 'Deploying Robot' : 'Waiting Room'}
                                </div>
                                <div className="mt-2 text-4xl font-black tracking-[0.25em] text-white">{session.roomCode}</div>
                            </div>
                            <div className="flex gap-2">
                                <IconButton label="Change callsign" onClick={openRename}><Pencil className="w-4 h-4" /></IconButton>
                                {mode !== MODE.SOLO && (
                                    <>
                                        <IconButton label="Copy code" onClick={copyRoomCode}><Clipboard className="w-4 h-4" /></IconButton>
                                        <IconButton label="Share room" onClick={shareRoom}><Share2 className="w-4 h-4" /></IconButton>
                                    </>
                                )}
                            </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3 mt-5">
                            <StatusTile label="Connection" value={matchStatusText} />
                            <StatusTile label="Players" value={`${connectedCount} / 2`} />
                            <StatusTile
                                label={mode === MODE.SOLO ? 'Robot Skill' : 'Role'}
                                value={mode === MODE.SOLO
                                    ? (difficultyLabel(session.difficulty) ?? 'Normal')
                                    : (session.isHost ? 'Host' : 'Guest')}
                            />
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 mt-5">
                            <PlayerSlot title="You" player={roomState?.players[0]} fallback="Taking position" />
                            <PlayerSlot
                                title={mode === MODE.SOLO ? 'Robot Opponent' : 'Joined Player'}
                                player={roomState?.players[1]}
                                fallback={mode === MODE.SOLO ? 'Booting robot' : 'Waiting for opponent'}
                            />
                        </div>

                        <div className="mt-6 flex flex-col sm:flex-row gap-3">
                            <button
                                disabled={mode === MODE.SOLO || !session.isHost || connectedCount < 2}
                                className={cn(
                                    "h-14 flex-1 rounded-lg border font-black uppercase tracking-wider flex items-center justify-center gap-2 transition",
                                    mode !== MODE.SOLO && session.isHost && connectedCount >= 2 ? "border-cyan-500 bg-cyan-500/10 text-cyan-100" : "border-slate-800 bg-slate-900 text-slate-600 cursor-not-allowed"
                                )}
                            >
                                {screen === 'match-found' || mode === MODE.SOLO ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {mode === MODE.SOLO ? 'Robot Deploying' : (connectedCount >= 2 ? 'Match Starting' : 'Start Match')}
                            </button>
                            <button onClick={leaveRoom} className="h-14 rounded-lg border border-slate-700 bg-[#0A0B10] px-6 text-slate-300 font-black uppercase tracking-wider hover:border-rose-400">
                                Leave
                            </button>
                        </div>
                    </div>
                </section>
            )}

            {screen === 'game' && (
                <>
                    <header className="flex-none h-20 w-full flex items-center justify-between px-4 sm:px-8 bg-gradient-to-b from-[#141620] to-transparent z-20 absolute top-0 inset-x-0 pointer-events-none">
                        <div className="flex w-full items-center justify-between max-w-6xl mx-auto pointer-events-auto">
                            <PlayerHud player={gameState.players[0]} fallback="Player 1" side="left" />
                            <div className="px-4 flex-col items-center hidden sm:flex">
                                <div className="text-[10px] uppercase tracking-tighter text-slate-500 mb-1 font-bold">{isOnline ? matchStatusText : 'Velocity'}</div>
                                <div className="flex items-center gap-3">
                                    <span className="text-xs font-mono text-slate-400">{isOnline ? (isMyTurn ? 'Your Turn' : "Opponent's Turn") : 'Neutral'}</span>
                                    <div className="w-16 h-4 bg-[#1A1D29] border border-slate-700 rounded flex items-center px-1">
                                        <div className="h-1.5 w-6 bg-slate-500 rounded-sm mx-auto"></div>
                                    </div>
                                </div>
                            </div>
                            <PlayerHud player={gameState.players[1]} fallback="Player 2" side="right" />
                        </div>
                    </header>

                    <div className="flex-grow flex items-center justify-center relative overflow-hidden bg-[#0A0B10] pt-16 sm:pt-20 pb-4">
                        {connectionStatus === 'reconnecting' && isOnline && (
                            <div className="absolute top-24 left-1/2 -translate-x-1/2 z-30 rounded border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs font-black uppercase tracking-wider text-amber-100 flex items-center gap-2">
                                <WifiOff className="w-4 h-4" /> Connection Lost
                            </div>
                        )}

                        {!gameState.winner && !gameState.isFiring && gameState.players.length > 0 && (
                            <div className="absolute top-20 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 pointer-events-none z-10">
                                <div className={cn("text-[10px] font-bold uppercase tracking-[0.3em] hidden sm:block", isMyTurn ? currentTheme.text : "text-slate-500")}>
                                    {isOnline ? (isMyTurn ? 'Your Turn' : `${opponent?.name ?? 'Opponent'} Aiming`) : `Turn: ${activePlayer?.name}`}
                                </div>
                                {timeLeft !== null && (
                                    <div className={cn(
                                        "flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-sm font-black tabular-nums",
                                        timeLeft <= 10 ? "border-rose-500/60 bg-rose-950/70 text-rose-300 animate-pulse" : "border-slate-700 bg-[#101522]/80 text-slate-200"
                                    )}>
                                        <Timer className="w-3.5 h-3.5" />
                                        <span>{timeLeft}s</span>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="w-full h-full relative border-y sm:border border-slate-800/50 shadow-2xl sm:max-w-6xl sm:h-auto sm:aspect-[16/9] sm:rounded-lg overflow-hidden mx-auto bg-gradient-to-b from-[#1E212E] to-[#0A0B10] z-0">
                            <canvas
                                ref={canvasRef}
                                width={1200}
                                height={800}
                                className="w-full h-full object-cover sm:object-contain mix-blend-screen"
                            />

                            {feed.length > 0 && (
                                <div className="absolute top-3 left-3 z-10 w-[210px] sm:w-[250px] pointer-events-none hidden sm:block">
                                    <div className="rounded-lg border border-slate-800/80 bg-[#0A0B10]/70 backdrop-blur-sm p-2.5">
                                        <div className="text-[9px] font-black uppercase tracking-[0.25em] text-slate-500 mb-1.5">Battle Log</div>
                                        <ul className="space-y-1">
                                            {feed.slice(-6).map((entry) => (
                                                <li key={entry.id} className={cn("text-[10px] leading-snug flex items-start gap-1.5", FEED_TONES[entry.tone] ?? "text-slate-400")}>
                                                    {entry.robot && <Bot className="w-3 h-3 shrink-0 mt-px text-violet-400" />}
                                                    <span>{entry.text}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            )}

                            {gameState.winner && (
                                <div className="absolute inset-0 bg-[#0A0B10]/80 backdrop-blur-md flex items-center justify-center animate-in fade-in duration-500 z-10 p-4 overflow-y-auto">
                                    <div className="text-center p-7 bg-[#11131C] border border-slate-800 rounded-lg shadow-[0_0_50px_rgba(0,0,0,0.5)] max-w-md w-full">
                                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-[0.3em] mb-2">Match Concluded</div>
                                        <h2 className="text-3xl sm:text-4xl font-black text-white tracking-widest mb-6">
                                            {isOnline
                                                ? describeOutcome(roomState, session?.playerId).toUpperCase()
                                                : (gameState.winner.name === 'Draw' ? "DRAW" : `${gameState.winner.name} WINS`)}
                                        </h2>

                                        {summary.length > 0 && (
                                            <div className="mb-6 space-y-2 text-left">
                                                {summary.map((row) => (
                                                    <div
                                                        key={row.id}
                                                        className={cn(
                                                            "rounded-lg border p-3",
                                                            row.isWinner ? "border-emerald-500/50 bg-emerald-500/5" : "border-slate-800 bg-[#0A0B10]"
                                                        )}
                                                    >
                                                        <div className="flex items-center justify-between gap-2">
                                                            <div className="flex items-center gap-2 min-w-0">
                                                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
                                                                <span className="font-black text-white text-sm truncate">{row.name}</span>
                                                                {row.isRobot && <RobotBadge difficulty={row.difficulty} />}
                                                                {row.isMe && <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">You</span>}
                                                            </div>
                                                            {row.isWinner && (
                                                                <span className="text-[9px] font-black uppercase tracking-widest text-emerald-400 shrink-0">Winner</span>
                                                            )}
                                                        </div>
                                                        <div className="mt-2 flex gap-4 text-[10px] font-mono text-slate-400">
                                                            <span>{row.hp} / 100 HP</span>
                                                            <span>{row.shotsFired} {row.shotsFired === 1 ? 'shot' : 'shots'}</span>
                                                            <span>{row.survived ? 'Survived' : 'Destroyed'}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        <button
                                            onClick={handleRestart}
                                            className="w-full h-12 relative group overflow-hidden bg-[#0A0B10] rounded-lg border border-cyan-500 hover:border-cyan-400 text-white font-bold tracking-widest uppercase transition-all shadow-[0_0_15px_rgba(34,211,238,0.2)] hover:shadow-[0_0_20px_rgba(34,211,238,0.4)] active:scale-95 flex items-center justify-center gap-2"
                                        >
                                            <RotateCcw className="w-4 h-4" /> Deploy Again
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <footer className="flex-none bg-[#11131C] border-t border-slate-800/50 backdrop-blur-md z-30 p-4 sm:px-10 shrink-0 shadow-[0_-20px_50px_rgba(0,0,0,0.5)] relative">
                        <div className="max-w-6xl mx-auto w-full flex items-center justify-between gap-3 mb-4">
                            <button
                                onClick={openRename}
                                title="Change callsign"
                                className="h-9 px-3 rounded-lg border border-slate-700 bg-[#0A0B10] text-slate-200 hover:border-cyan-400 hover:text-cyan-200 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider transition"
                            >
                                <User className="w-3.5 h-3.5" />
                                <span className="max-w-[140px] truncate normal-case">{playerName}</span>
                                <Pencil className="w-3 h-3 opacity-60" />
                            </button>
                            <button
                                onClick={() => setConfirmQuit(true)}
                                title="Quit match"
                                className="h-9 px-3 rounded-lg border border-slate-700 bg-[#0A0B10] text-slate-300 hover:border-rose-500 hover:text-rose-200 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider transition"
                            >
                                <LogOut className="w-3.5 h-3.5" /> Quit
                            </button>
                        </div>
                        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center gap-6 sm:gap-12 h-auto sm:h-40">
                            <div className="flex flex-col gap-4 w-full sm:min-w-[180px] sm:w-auto mt-2 sm:mt-0">
                                <ControlLabel label="Angle" value={`${angle.toFixed(1)} deg`} theme={currentTheme.text} />
                                <GameSlider min={0} max={180} value={angle} color={`bg-gradient-to-r ${currentTheme.glow}`} disabled={controlsDisabled} onValueChange={handleAngleChange} />
                                <ControlLabel label="Power" value={`${power} / 100`} theme={currentTheme.text} />
                                <GameSlider min={1} max={100} value={power} color={`bg-gradient-to-r ${currentTheme.glow}`} disabled={controlsDisabled} onValueChange={handlePowerChange} />
                            </div>

                            <div className="flex-grow flex items-center justify-center gap-3 overflow-x-auto w-full no-scrollbar px-2">
                                {WEAPONS.map(w => {
                                    const Icon = w.icon;
                                    const isActive = weapon === w.id;
                                    return (
                                        <button
                                            key={w.id}
                                            disabled={controlsDisabled}
                                            onClick={() => handleWeaponSelect(w.id)}
                                            className={cn(
                                                "min-w-[90px] h-24 sm:h-28 bg-[#1A1D29] rounded-lg flex flex-col items-center justify-center gap-2 transition-all shrink-0",
                                                isActive ? `border-2 ${currentTheme.border} ring-4 ${currentTheme.ring}` : "border border-slate-700 hover:border-slate-500 grayscale opacity-40 hover:grayscale-0 hover:opacity-100",
                                                controlsDisabled && "opacity-30 grayscale cursor-not-allowed"
                                            )}
                                        >
                                            <div className={cn("w-10 h-10 rounded flex items-center justify-center", isActive ? `${currentTheme.bgLight} rounded-full shadow-inner` : "bg-slate-800")}>
                                                <Icon className={cn("w-5 h-5", isActive ? currentTheme.text : "text-slate-400")} />
                                            </div>
                                            <span className={cn("text-[9px] uppercase font-bold", isActive ? currentTheme.text : "text-slate-500")}>{w.name}</span>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="flex items-center justify-center shrink-0">
                                <div className="group relative">
                                    {!controlsDisabled && (
                                        <div className={cn("absolute -inset-1 rounded-full blur opacity-25 group-hover:opacity-100 transition duration-1000 group-hover:duration-200", `bg-gradient-to-r ${currentTheme.fireGlow}`)}></div>
                                    )}
                                    <button
                                        disabled={controlsDisabled}
                                        onClick={handleFire}
                                        className={cn(
                                            "relative w-24 h-24 sm:w-32 sm:h-32 bg-[#0A0B10] border-2 rounded-full flex flex-col items-center justify-center shadow-2xl active:scale-95 transition-transform",
                                            controlsDisabled ? "border-slate-800 opacity-50 cursor-not-allowed" : currentTheme.border
                                        )}
                                    >
                                        <span className={cn("text-2xl font-black tracking-tighter text-white", controlsDisabled && "text-slate-600")}>
                                            {gameState.isFiring ? 'WAIT' : 'FIRE'}
                                        </span>
                                        <span className={cn("text-[8px] tracking-widest mt-1 uppercase font-bold", controlsDisabled ? "text-slate-600" : currentTheme.text)}>
                                            {isOnline && !isMyTurn ? 'Stand By' : 'Engage'}
                                        </span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </footer>
                </>
            )}
        </main>
    );
}

const FEED_TONES = {
    info: "text-slate-400",
    good: "text-emerald-300",
    bad: "text-rose-300",
    warn: "text-amber-300",
};

function RobotBadge({ difficulty, className }) {
    return (
        <span
            title={difficulty ? `Robot opponent — ${difficulty}` : 'Robot opponent'}
            className={cn(
                "inline-flex items-center gap-1 rounded border border-violet-500/60 bg-violet-500/15 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-violet-200 shrink-0",
                className
            )}
        >
            <Bot className="w-2.5 h-2.5" /> AI{difficulty ? ` · ${difficulty}` : ''}
        </span>
    );
}

function StatusRow({ label, value }) {
    return (
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <span className="text-slate-500 uppercase text-xs font-black tracking-wider">{label}</span>
            <span className="text-slate-200 font-semibold">{value}</span>
        </div>
    );
}

function StatusTile({ label, value }) {
    return (
        <div className="rounded-lg border border-slate-800 bg-[#0A0B10] p-4">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-black">{label}</div>
            <div className="mt-2 text-lg font-black text-white">{value}</div>
        </div>
    );
}

function PlayerSlot({ title, player, fallback }) {
    return (
        <div className="rounded-lg border border-slate-800 bg-[#0A0B10] p-4">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-black">{title}</div>
            <div className="mt-3 flex items-center justify-between gap-2">
                <span className="font-black text-white flex items-center gap-2 min-w-0">
                    <span className="truncate">{player?.name ?? fallback}</span>
                    {player?.isRobot && <RobotBadge difficulty={difficultyLabel(player.robotDifficulty)} />}
                </span>
                <span className={cn("text-[10px] uppercase tracking-wider font-black shrink-0", player?.connected ? "text-emerald-400" : "text-slate-600")}>
                    {player?.connected ? 'Ready' : 'Open'}
                </span>
            </div>
        </div>
    );
}

function IconButton({ label, onClick, children }) {
    return (
        <button title={label} aria-label={label} onClick={onClick} className="w-11 h-11 rounded-lg border border-slate-700 bg-[#0A0B10] text-slate-200 hover:border-cyan-400 hover:text-cyan-200 flex items-center justify-center transition">
            {children}
        </button>
    );
}

function PlayerHud({ player, fallback, side }) {
    const isRight = side === 'right';
    return (
        <div className={cn("flex flex-col flex-1 max-w-[200px]", isRight && "items-end")}>
            <span className={cn("text-[10px] uppercase tracking-widest font-bold mb-1 flex items-center gap-1.5 max-w-full", isRight ? "text-rose-400 flex-row-reverse" : "text-cyan-400")}>
                <span className="truncate">{player?.name || fallback}</span>
                {player?.isRobot && <RobotBadge />}
            </span>
            <div className={cn("w-full h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700", isRight && "flex justify-end")}>
                <div className={cn("h-full transition-all duration-300", isRight ? "bg-gradient-to-l from-rose-600 to-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.5)]" : "bg-gradient-to-r from-cyan-600 to-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.5)]")} style={{ width: `${player?.hp ?? 100}%` }} />
            </div>
            <div className={cn("flex justify-between mt-1 text-[10px] font-mono text-slate-400 italic", isRight && "w-full flex-row-reverse")}>
                <span>{player?.hp ?? 100} / 100 HP</span>
            </div>
        </div>
    );
}

function ControlLabel({ label, value, theme }) {
    return (
        <div className="flex justify-between text-[10px] uppercase font-bold tracking-wider text-slate-500 -mb-3">
            <span>{label}</span>
            <span className={cn("font-mono", theme)}>{value}</span>
        </div>
    );
}
