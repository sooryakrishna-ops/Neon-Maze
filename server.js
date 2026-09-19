const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin2026';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'competitions.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helpers: Load & Save Persistent Data
function loadCompetitionsData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (!data.rooms) data.rooms = [];
      return data;
    }
  } catch (err) {
    console.error('Error loading competitions.json:', err);
  }
  return { rooms: [] };
}

function saveCompetitionsData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving competitions.json:', err);
  }
}

// Format duration in MM:SS.ss
function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return '--';
  const totalSeconds = ms / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Format MM:SS for duration display
function formatMMSS(seconds) {
  if (!seconds || isNaN(seconds)) return '05:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Unique IDs
function generateId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
}

// Clean 6-character room codes (avoids 0, 1, 5, O, I, S to eliminate confusion)
const ROOM_CODE_CHARS = '2346789ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

// Sanitize inputs
function sanitizeText(str, maxLen = 30) {
  if (typeof str !== 'string') return '';
  return str.replace(/[^\w\s\-\.\#\(\)\/]/gi, '').trim().substring(0, maxLen);
}

// ==========================================
// 50 UNIQUE RETRO ARCADE PLAYER COLORS PALETTE
// ==========================================
function hslToHex(h, s, l) {
  l /= 100;
  const a = s * Math.min(l, 1 - l) / 100;
  const f = n => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// 50 distinct neon colors distributed via the golden ratio for maximum consecutive contrast
const PLAYER_COLOR_PALETTE = (() => {
  const palette = [];
  for (let i = 0; i < 50; i++) {
    const h = Math.round((i * 137.508) % 360);
    palette.push(hslToHex(h, 95, 62));
  }
  return palette;
})();

// ==========================================
// PROCEDURAL MAZE GENERATOR & VALIDATOR
// ==========================================
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function bfsPath(grid, sc, sr, ec, er) {
  const R = grid.length, C = grid[0].length;
  const vis = Array(R).fill(0).map(() => new Uint8Array(C));
  const par = Array(R).fill(0).map(() => Array(C).fill(null));
  const q = [[sc, sr]];
  vis[sr][sc] = 1;

  while (q.length) {
    const [c, r] = q.shift();
    if (c === ec && r === er) {
      const p = [];
      let cur = [ec, er];
      while (cur) {
        p.unshift(cur);
        cur = par[cur[1]][cur[0]];
      }
      return p;
    }
    for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nc = c + dc, nr = r + dr;
      if (nc >= 0 && nc < C && nr >= 0 && nr < R && !vis[nr][nc] && grid[nr][nc] === 0) {
        vis[nr][nc] = 1;
        par[nr][nc] = [c, r];
        q.push([nc, nr]);
      }
    }
  }
  return null;
}

function generateValidatedRoomMaze(initialSeed) {
  const C = 51, R = 35; // Arcade dimensions
  let currentSeed = initialSeed;

  for (let attempt = 0; attempt < 50; attempt++) {
    const rng = mkRng(currentSeed);
    const grid = Array(R).fill(0).map(() => new Uint8Array(C).fill(1));

    function shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    // Depth-first search with backtracking
    const stk = [[1, 1]];
    grid[1][1] = 0;

    while (stk.length) {
      const [c, r] = stk[stk.length - 1];
      const dirs = shuffle([[0, -2], [0, 2], [-2, 0], [2, 0]]);
      let moved = false;
      for (const [dc, dr] of dirs) {
        const nc = c + dc, nr = r + dr;
        if (nc > 0 && nc < C - 1 && nr > 0 && nr < R - 1 && grid[nr][nc] === 1) {
          grid[r + dr / 2][c + dc / 2] = 0;
          grid[nr][nc] = 0;
          stk.push([nc, nr]);
          moved = true;
          break;
        }
      }
      if (!moved) stk.pop();
    }

    // Add loops and alternative routes (14% chance on interior wall dividing corridors)
    for (let r = 2; r < R - 2; r += 2) {
      for (let c = 2; c < C - 2; c += 2) {
        if (grid[r][c] === 1 && rng() < 0.14) {
          const horiz = grid[r][c - 1] === 0 && grid[r][c + 1] === 0;
          const vert = grid[r - 1][c] === 0 && grid[r + 1][c] === 0;
          if (horiz || vert) grid[r][c] = 0;
        }
      }
    }

    // Carve Exit area in bottom-right corner
    const ec = C - 2, er = R - 2;
    grid[er][ec] = 0;
    grid[er - 1][ec] = 0;
    grid[er][ec - 1] = 0;

    // Find programmatic solution path from Start [1, 1] to Exit [ec, er]
    const solutionPath = bfsPath(grid, 1, 1, ec, er);
    if (!solutionPath || solutionPath.length < 60) {
      currentSeed = (currentSeed + 1337) >>> 0;
      continue;
    }

    // Section solution path to place exactly 5 checkpoints at progression intervals:
    // ~18%, ~38%, ~58%, ~78%, ~90%
    const fractions = [0.18, 0.38, 0.58, 0.78, 0.90];
    const checkpoints = fractions.map((frac, idx) => {
      const pIdx = Math.floor(solutionPath.length * frac);
      const cell = solutionPath[pIdx];
      return {
        id: idx + 1,
        c: cell[0],
        r: cell[1],
        pathStep: pIdx,
        pathPercent: Math.round(frac * 100),
        done: false,
      };
    });

    // Validate sequential solvability:
    // START -> CP1 -> CP2 -> CP3 -> CP4 -> CP5 -> EXIT
    let valid = true;
    let prevC = 1, prevR = 1;
    for (const cp of checkpoints) {
      const subPath = bfsPath(grid, prevC, prevR, cp.c, cp.r);
      if (!subPath) { valid = false; break; }
      prevC = cp.c;
      prevR = cp.r;
    }
    if (valid) {
      const finalLeg = bfsPath(grid, prevC, prevR, ec, er);
      if (!finalLeg) valid = false;
    }

    if (!valid) {
      currentSeed = (currentSeed + 1337) >>> 0;
      continue;
    }

    // Generate Timed Spikes (Traps)
    // Avoid Start, Exit, and Checkpoints (+ buffer)
    const occupied = new Set([
      '1,1', '1,2', '2,1',
      `${ec},${er}`, `${ec - 1},${er}`, `${ec},${er - 1}`,
      ...checkpoints.flatMap(cp => [
        `${cp.c},${cp.r}`,
        `${cp.c + 1},${cp.r}`, `${cp.c - 1},${cp.r}`,
        `${cp.c},${cp.r + 1}`, `${cp.c},${cp.r - 1}`
      ])
    ]);

    const candidates = [];
    for (let r = 1; r < R - 1; r++) {
      for (let c = 1; c < C - 1; c++) {
        if (grid[r][c] === 0 && !occupied.has(`${c},${r}`)) {
          candidates.push([c, r]);
        }
      }
    }

    shuffle(candidates);
    const spikeCount = 20;
    const spikes = candidates.slice(0, spikeCount).map((pos, i) => ({
      c: pos[0],
      r: pos[1],
      phase: 'safe',
      timer: i * 650,
      prog: 0,
    }));

    // Convert grid to array of compact strings for easy network transport
    const gridStrings = grid.map(row => Array.from(row).join(''));

    return {
      seed: currentSeed,
      width: C,
      height: R,
      grid: gridStrings,
      start: { c: 1, r: 1 },
      exit: { c: ec, r: er },
      checkpoints,
      spikes,
      solutionPath: solutionPath, // full path for progress calculation
      solutionPathLength: solutionPath.length,
    };
  }

  throw new Error('Failed to generate valid maze after 50 attempts');
}

// ==========================================
// COMPETITION ROOM CLASS
// ==========================================
class CompetitionRoom {
  constructor(code = null, seed = null, durationSeconds = 300) {
    this.id = generateId('room');
    this.code = code || generateRoomCode();
    this.status = 'WAITING'; // WAITING, READY, STARTED, FINISHED, CLOSED
    this.createdAt = Date.now();
    this.startTime = null;
    this.endTime = null;
    this.durationSeconds = Math.max(60, Math.min(3600, durationSeconds || 300));
    this.maxPlayers = 50;
    this.totalCheckpoints = 5;
    this.players = new Map(); // playerId -> player
    this.countdownTimer = null;
    this.expiryTimer = null; // Server-side timer to end competition at endTime

    // Room-specific color pool (up to 50 players)
    this.availableColors = [...PLAYER_COLOR_PALETTE];

    // Procedural room maze generated once per room and persisted
    this.mazeSeed = seed || Math.floor(100000 + Math.random() * 900000);
    this.maze = generateValidatedRoomMaze(this.mazeSeed);
  }

  // Register a player into this room (class field removed)
  registerPlayer(name, playerClass, clientToken = null) {
    const cleanName = sanitizeText(name, 24);
    // playerClass is accepted but not required (backward compat)

    if (!cleanName) return { success: false, error: 'NAME REQUIRED' };

    if (this.status === 'STARTED') return { success: false, error: 'ROOM ALREADY STARTED' };
    if (this.status === 'FINISHED' || this.status === 'CLOSED') return { success: false, error: 'ROOM IS CLOSED' };

    // Check reconnection by token first (existing player reconnecting)
    if (clientToken) {
      for (const p of this.players.values()) {
        if (p.token === clientToken) {
          p.connected = true;
          return { success: true, player: p, isReconnect: true };
        }
      }
    }

    // Check capacity for new players (Strictly max 50 players)
    if (this.players.size >= this.maxPlayers) {
      return { success: false, error: 'ROOM FULL (MAX 50 PLAYERS)' };
    }

    // Check duplicate name in this room
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === cleanName.toLowerCase() && p.status !== 'DNF') {
        return { success: false, error: `A PLAYER NAMED "${cleanName}" IS ALREADY IN THIS ROOM` };
      }
    }

    const playerId = generateId('plr');
    const token = generateId('tok');

    // Assign unique color from 50-color palette for this room
    const color = this.availableColors.length > 0
      ? this.availableColors.shift()
      : PLAYER_COLOR_PALETTE[this.players.size % PLAYER_COLOR_PALETTE.length];

    const player = {
      id: playerId,
      token,
      name: cleanName,
      color,
      roomId: this.id,
      roomCode: this.code,
      status: this.status === 'STARTED' ? 'PLAYING' : 'READY',
      currentCp: 0,
      totalCps: this.totalCheckpoints,
      attempts: 1,
      score: 0,
      connected: true,
      finishServerTime: null,
      durationMs: null,
      durationStr: '--',
      rank: null,
      registrationTime: Date.now(),
      ws: null,
      x: 1 * 28 + 14,
      y: 1 * 28 + 14,
      c: 1,
      r: 1,
      direction: 0,
      sliding: false,
      // Progress tracking fields
      progressPercentage: 0,
      lastCompletedCheckpoint: -1, // -1 = none (respawn at start)
      lastCompletedCheckpointPos: null, // { c, r }
      solutionPathProgress: 0,
      progressTimestamp: Date.now(),
    };

    this.players.set(playerId, player);
    this.persistSnapshot();
    return { success: true, player, isReconnect: false };
  }

  getPlayerByToken(token) {
    if (!token) return null;
    for (const p of this.players.values()) {
      if (p.token === token) return p;
    }
    return null;
  }

  startCountdown(leadTimeMs = 3800) {
    if (this.status !== 'WAITING' && this.status !== 'READY') {
      return { success: false, error: `CANNOT START ROOM IN STATUS: ${this.status}` };
    }
    if (this.players.size === 0) {
      return { success: false, error: 'CANNOT START: NO PLAYERS IN ROOM' };
    }

    this.status = 'READY';
    this.startTime = Date.now() + leadTimeMs;
    // Compute authoritative endTime: start + configured duration
    this.endTime = this.startTime + this.durationSeconds * 1000;

    for (const p of this.players.values()) {
      p.status = 'READY';
    }

    this.persistSnapshot();
    return { success: true, roomStartTime: this.startTime, roomEndTime: this.endTime };
  }

  startCompetitionNow() {
    this.status = 'STARTED';
    for (const p of this.players.values()) {
      if (p.status !== 'FINISHED' && p.status !== 'DNF') {
        p.status = 'PLAYING';
      }
    }

    // Schedule automatic room expiry at server-authoritative endTime
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const msUntilExpiry = this.endTime - Date.now();
    if (msUntilExpiry > 0) {
      this.expiryTimer = setTimeout(() => {
        if (this.status === 'STARTED') {
          console.log(`⏰ Room ${this.code} timer expired — ending competition automatically`);
          this.endCompetition('TIMER_EXPIRED');
          broadcastToRoom(this.code, {
            type: 'ROOM_COMPLETED',
            roomCode: this.code,
            reason: 'COMPETITION TIMER EXPIRED',
            leaderboard: this.getLeaderboardData(),
            summary: this.getSummary(),
            serverTime: Date.now(),
          });
          broadcastRoomLeaderboard(this);
        }
      }, msUntilExpiry);
    }

    this.persistSnapshot();
  }

  handlePlayerCpEnter(playerId, cpIndex) {
    const player = this.players.get(playerId);
    if (!player) return null;
    if (player.status !== 'FINISHED' && player.status !== 'DNF') {
      player.status = 'CHECKPOINT';
    }
    return player;
  }

  handlePlayerCpClear(playerId, cpIndex, progressPercentage) {
    const player = this.players.get(playerId);
    if (!player) return null;
    player.currentCp = Math.max(player.currentCp, cpIndex + 1);
    if (player.status !== 'FINISHED' && player.status !== 'DNF') {
      player.status = 'PLAYING';
    }

    // Update last completed checkpoint for respawn logic
    if (cpIndex >= player.lastCompletedCheckpoint) {
      player.lastCompletedCheckpoint = cpIndex;
      // Store actual checkpoint position from maze data
      const cpData = this.maze && this.maze.checkpoints && this.maze.checkpoints[cpIndex];
      if (cpData) {
        player.lastCompletedCheckpointPos = { c: cpData.c, r: cpData.r };
      }
    }

    // Update progress tracking
    if (typeof progressPercentage === 'number' && !isNaN(progressPercentage)) {
      player.progressPercentage = Math.max(player.progressPercentage, Math.min(100, progressPercentage));
    } else {
      // Estimate from checkpoint index if client didn't send it
      const fractions = [0.18, 0.38, 0.58, 0.78, 0.90, 1.0];
      player.progressPercentage = Math.max(player.progressPercentage, Math.round(fractions[cpIndex] * 100));
    }
    player.progressTimestamp = Date.now();

    return player;
  }

  // handlePlayerReset — for checkpoint failure, only resets to last completed checkpoint
  // Spike hits still call this too, but now it respects lastCompletedCheckpoint
  handlePlayerReset(playerId, reason) {
    const player = this.players.get(playerId);
    if (!player) return null;
    // Do NOT reset currentCp to 0 — keep progress at lastCompletedCheckpoint + 1
    // Only reset attempts counter for tracking
    player.attempts += 1;
    if (player.status !== 'FINISHED' && player.status !== 'DNF') {
      player.status = 'PLAYING';
    }
    return player;
  }

  handlePlayerFinish(playerId, score = 0) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, error: 'PLAYER NOT FOUND' };
    if (this.status !== 'STARTED') return { success: false, error: 'ROOM COMPETITION HAS NOT STARTED' };
    if (player.status === 'FINISHED') return { success: false, error: 'PLAYER ALREADY FINISHED' };
    if (player.currentCp < this.totalCheckpoints) {
      return { success: false, error: `ONLY CLEARED ${player.currentCp}/${this.totalCheckpoints} CHECKPOINTS` };
    }

    const now = Date.now();

    // Server-side deadline validation: finish event must arrive before endTime
    if (this.endTime && now > this.endTime + 2000) {
      // Allow 2 second grace window for network lag
      return { success: false, error: 'COMPETITION DEADLINE EXCEEDED' };
    }

    // Guard against duplicate finish submissions
    if (player.finishServerTime) {
      return { success: false, error: 'PLAYER ALREADY FINISHED' };
    }

    player.finishServerTime = now;
    player.durationMs = Math.max(0, now - (this.startTime || now));
    player.durationStr = formatDuration(player.durationMs);
    player.status = 'FINISHED';
    player.score = score;
    player.progressPercentage = 100;
    player.progressTimestamp = now;

    this.updateRankings();
    this.persistSnapshot();

    // Check if all connected players finished
    const activePlayers = Array.from(this.players.values()).filter(p => p.connected);
    const allFinished = activePlayers.length > 0 && activePlayers.every(p => p.status === 'FINISHED');
    if (allFinished) {
      this.endCompetition('ALL_PLAYERS_FINISHED');
    }

    return { success: true, player, allFinished };
  }

  endCompetition(reason = 'ADMIN_ENDED') {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.status = 'FINISHED';
    if (!this.endTime) this.endTime = Date.now();

    for (const p of this.players.values()) {
      if (p.status !== 'FINISHED') {
        p.status = 'DNF';
      }
    }

    this.updateRankings();
    this.persistSnapshot();
    return { success: true, reason };
  }

  // Deterministic ranking:
  // 1. FINISHED players ranked by durationMs ascending
  // 2. Non-finished: ranked by progressPercentage desc → checkpoint count desc → progressTimestamp asc → playerId
  updateRankings() {
    const playerList = Array.from(this.players.values());

    playerList.sort((a, b) => {
      // FINISHED always ranks above unfinished
      if (a.status === 'FINISHED' && b.status === 'FINISHED') {
        return (a.durationMs || Infinity) - (b.durationMs || Infinity);
      }
      if (a.status === 'FINISHED') return -1;
      if (b.status === 'FINISHED') return 1;

      // Among unfinished: progress percentage descending
      const progDiff = (b.progressPercentage || 0) - (a.progressPercentage || 0);
      if (Math.abs(progDiff) > 0.5) return progDiff;

      // Same progress: checkpoint count descending
      const cpDiff = (b.currentCp || 0) - (a.currentCp || 0);
      if (cpDiff !== 0) return cpDiff;

      // Same checkpoint: earlier progress timestamp wins (achieved it first)
      const tsDiff = (a.progressTimestamp || 0) - (b.progressTimestamp || 0);
      if (tsDiff !== 0) return tsDiff;

      // Final deterministic tie-breaker: playerId string comparison
      return a.id < b.id ? -1 : 1;
    });

    let rank = 1;
    playerList.forEach((p) => {
      p.rank = rank++;
    });
  }

  getLeaderboardData() {
    this.updateRankings();
    return Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      status: p.status,
      currentCp: p.currentCp,
      totalCps: p.totalCps,
      attempts: p.attempts,
      durationMs: p.durationMs,
      durationStr: p.durationStr || formatDuration(p.durationMs),
      rank: p.rank,
      connected: p.connected,
      score: p.score,
      progressPercentage: p.progressPercentage || 0,
      lastCompletedCheckpoint: p.lastCompletedCheckpoint,
      progressTimestamp: p.progressTimestamp,
    }));
  }

  getSummary() {
    const players = Array.from(this.players.values());
    const now = Date.now();
    const timeRemainingMs = (this.status === 'STARTED' && this.endTime)
      ? Math.max(0, this.endTime - now)
      : null;

    return {
      roomId: this.id,
      roomCode: this.code,
      status: this.status,
      createdAt: this.createdAt,
      startTime: this.startTime,
      endTime: this.endTime,
      durationSeconds: this.durationSeconds,
      durationStr: formatMMSS(this.durationSeconds),
      timeRemainingMs,
      timeRemainingStr: timeRemainingMs !== null ? formatMMSS(Math.ceil(timeRemainingMs / 1000)) : '--',
      mazeSeed: this.mazeSeed,
      totalCheckpoints: this.totalCheckpoints,
      maxPlayers: this.maxPlayers,
      totalPlayers: players.length,
      connectedPlayers: players.filter(p => p.connected).length,
      finishedPlayers: players.filter(p => p.status === 'FINISHED').length,
      playingPlayers: players.filter(p => ['PLAYING', 'CHECKPOINT', 'READY'].includes(p.status)).length,
      dnfPlayers: players.filter(p => p.status === 'DNF').length,
    };
  }

  persistSnapshot() {
    try {
      const db = loadCompetitionsData();
      const existingIdx = db.rooms.findIndex(r => r.roomId === this.id);
      const roomRecord = {
        roomId: this.id,
        roomCode: this.code,
        status: this.status,
        createdAt: this.createdAt,
        startTime: this.startTime,
        endTime: this.endTime,
        durationSeconds: this.durationSeconds,
        mazeSeed: this.mazeSeed,
        maze: this.maze,
        maxPlayers: this.maxPlayers,
        players: Array.from(this.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          color: p.color,
          status: p.status,
          currentCp: p.currentCp,
          attempts: p.attempts,
          score: p.score,
          durationMs: p.durationMs,
          durationStr: p.durationStr,
          rank: p.rank,
          registrationTime: p.registrationTime,
          progressPercentage: p.progressPercentage,
          lastCompletedCheckpoint: p.lastCompletedCheckpoint,
          progressTimestamp: p.progressTimestamp,
        })),
        leaderboard: this.getLeaderboardData(),
      };

      if (existingIdx >= 0) {
        db.rooms[existingIdx] = roomRecord;
      } else {
        db.rooms.unshift(roomRecord);
      }
      saveCompetitionsData(db);
    } catch (e) {
      console.error('Failed to persist room snapshot:', e);
    }
  }
}

// ==========================================
// ROOM MANAGER (Handles Multiple Rooms)
// ==========================================
class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> CompetitionRoom
    this.roomsByCode = new Map(); // roomCode (uppercase) -> CompetitionRoom
  }

  createRoom(durationSeconds = 300, customCode = null) {
    let code = customCode ? customCode.toUpperCase().trim() : null;
    if (!code || this.roomsByCode.has(code)) {
      do {
        code = generateRoomCode();
      } while (this.roomsByCode.has(code));
    }

    const seed = Math.floor(100000 + Math.random() * 900000);
    const room = new CompetitionRoom(code, seed, durationSeconds);
    this.rooms.set(room.id, room);
    this.roomsByCode.set(code, room);
    room.persistSnapshot();
    return room;
  }

  getRoomByCode(code) {
    if (!code) return null;
    return this.roomsByCode.get(code.toUpperCase().trim()) || null;
  }

  getRoomById(id) {
    if (!id) return null;
    return this.rooms.get(id) || null;
  }

  getAllRoomsSummary() {
    return Array.from(this.rooms.values()).map(r => r.getSummary());
  }
}

const roomManager = new RoomManager();

// ==========================================
// EXPRESS APP & REST APIS (Dual-Layer Reliability)
// ==========================================
const app = express();
app.use(express.json());

// Enable CORS for flexibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(__dirname));

// Client routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// --- ADMIN REST APIS ---

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASS) {
    const adminToken = generateId('adm');
    return res.json({
      success: true,
      adminToken,
      message: 'AUTHENTICATION SUCCESSFUL'
    });
  }
  return res.status(401).json({
    success: false,
    error: 'INVALID CREDENTIALS'
  });
});

// Admin Rooms List
app.get('/api/admin/rooms', (req, res) => {
  const rooms = roomManager.getAllRoomsSummary();
  const db = loadCompetitionsData();
  res.json({
    success: true,
    rooms,
    history: db.rooms || [],
  });
});

// Admin Create Room — accepts optional durationSeconds and code in body
app.post('/api/admin/rooms/create', (req, res) => {
  const { durationSeconds, code } = req.body || {};
  const dur = parseInt(durationSeconds, 10) || 300;
  const room = roomManager.createRoom(dur, code);
  res.json({
    success: true,
    room: room.getSummary(),
    message: `ROOM ${room.code} CREATED SUCCESSFULLY`
  });
});

// Admin Get Room Details
app.get('/api/admin/rooms/:code', (req, res) => {
  const room = roomManager.getRoomByCode(req.params.code);
  if (!room) {
    return res.status(404).json({ success: false, error: 'ROOM NOT FOUND' });
  }
  res.json({
    success: true,
    room: room.getSummary(),
    leaderboard: room.getLeaderboardData(),
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      status: p.status,
      currentCp: p.currentCp,
      totalCps: p.totalCps,
      attempts: p.attempts,
      durationMs: p.durationMs,
      durationStr: p.durationStr,
      connected: p.connected,
      score: p.score,
      progressPercentage: p.progressPercentage || 0,
      lastCompletedCheckpoint: p.lastCompletedCheckpoint,
    }))
  });
});

// Admin Start Room Competition
app.post('/api/admin/rooms/:code/start', (req, res) => {
  const room = roomManager.getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ success: false, error: 'ROOM NOT FOUND' });

  const result = room.startCountdown(3800);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }

  // Setup countdown completion timer for this room
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  room.countdownTimer = setTimeout(() => {
    if (room.status === 'READY') {
      room.startCompetitionNow();
      broadcastToRoom(room.code, {
        type: 'ROOM_COMPETITION_STARTED',
        roomCode: room.code,
        startTime: room.startTime,
        endTime: room.endTime,
        durationSeconds: room.durationSeconds,
        serverTime: Date.now(),
      });
      broadcastRoomLeaderboard(room);
    }
  }, 3800);

  // Broadcast countdown to players in this room
  broadcastToRoom(room.code, {
    type: 'ROOM_START_COUNTDOWN',
    roomCode: room.code,
    roomStartTime: result.roomStartTime,
    roomEndTime: result.roomEndTime,
    durationSeconds: room.durationSeconds,
    serverTime: Date.now(),
    leaderboard: room.getLeaderboardData(),
  });

  res.json({
    success: true,
    roomStartTime: result.roomStartTime,
    roomEndTime: result.roomEndTime,
    durationSeconds: room.durationSeconds,
    message: `COMPETITION STARTING IN ROOM ${room.code}`
  });
});

// Admin End Room Competition
app.post('/api/admin/rooms/:code/end', (req, res) => {
  const room = roomManager.getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ success: false, error: 'ROOM NOT FOUND' });

  room.endCompetition('ADMIN_ENDED');
  broadcastToRoom(room.code, {
    type: 'ROOM_COMPLETED',
    roomCode: room.code,
    reason: 'ADMINISTRATOR ENDED COMPETITION',
    leaderboard: room.getLeaderboardData(),
    summary: room.getSummary(),
    serverTime: Date.now(),
  });

  res.json({
    success: true,
    message: `ROOM ${room.code} COMPETITION ENDED`,
    summary: room.getSummary()
  });
});

// Admin Kick Player from Room
app.post('/api/admin/rooms/:code/kick', (req, res) => {
  const room = roomManager.getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ success: false, error: 'ROOM NOT FOUND' });

  const { playerId } = req.body || {};
  const target = room.players.get(playerId);
  if (target) {
    if (target.ws && target.ws.readyState === WebSocket.OPEN) {
      target.ws.send(JSON.stringify({ type: 'KICKED', reason: 'REMOVED BY ADMINISTRATOR' }));
      target.ws.close();
    }
    room.players.delete(playerId);
    room.persistSnapshot();
    broadcastRoomLeaderboard(room);
    return res.json({ success: true, message: `PLAYER ${target.name} REMOVED` });
  }
  res.status(404).json({ success: false, error: 'PLAYER NOT FOUND' });
});

// --- PLAYER / PUBLIC REST APIS ---

// Validate Room
app.post('/api/rooms/validate', (req, res) => {
  const { roomCode } = req.body || {};
  const cleanCode = (roomCode || '').toUpperCase().trim();
  if (!cleanCode) return res.status(400).json({ valid: false, error: 'ROOM CODE REQUIRED' });

  const room = roomManager.getRoomByCode(cleanCode);
  if (!room) return res.status(404).json({ valid: false, error: 'ROOM NOT FOUND' });
  if (room.status === 'STARTED') return res.status(400).json({ valid: false, error: 'ROOM ALREADY STARTED' });
  if (room.status === 'FINISHED' || room.status === 'CLOSED') return res.status(400).json({ valid: false, error: 'ROOM CLOSED' });
  if (room.players.size >= room.maxPlayers) return res.status(400).json({ valid: false, error: 'ROOM FULL' });

  res.json({
    valid: true,
    room: room.getSummary(),
  });
});

// Join Room — class field is optional, not required
app.post('/api/rooms/join', (req, res) => {
  const { name, playerClass, roomCode, token } = req.body || {};
  const cleanCode = (roomCode || '').toUpperCase().trim();

  if (!cleanCode) return res.status(400).json({ success: false, error: 'ROOM CODE REQUIRED' });
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'NAME REQUIRED' });
  // playerClass is no longer required

  const room = roomManager.getRoomByCode(cleanCode);
  if (!room) return res.status(404).json({ success: false, error: 'INVALID ROOM CODE — ROOM NOT FOUND' });

  const result = room.registerPlayer(name, playerClass || '', token);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }

  const p = result.player;
  res.json({
    success: true,
    player: {
      id: p.id,
      token: p.token,
      name: p.name,
      color: p.color,
      status: p.status,
      currentCp: p.currentCp,
      rank: p.rank,
    },
    room: room.getSummary(),
    maze: room.maze,
    leaderboard: room.getLeaderboardData(),
    serverTime: Date.now(),
  });
});

// ==========================================
// WEBSOCKET REALTIME MULTIPLAYER (Room-Scoped)
// ==========================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track client room subscriptions: ws.roomCode
function broadcastToRoom(roomCode, msgObj) {
  const json = JSON.stringify(msgObj);
  const upperCode = (roomCode || '').toUpperCase();
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      if (client.roomCode === upperCode || client.isAdmin) {
        client.send(json);
      }
    }
  }
}

// Broadcast to other players in room EXCEPT the sender (for smooth remote ghost motion)
function broadcastToRoomExcept(roomCode, senderWs, msgObj) {
  const json = JSON.stringify(msgObj);
  const upperCode = (roomCode || '').toUpperCase();
  for (const client of wss.clients) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      if (client.roomCode === upperCode) {
        client.send(json);
      }
    }
  }
}

function broadcastRoomLeaderboard(room) {
  broadcastToRoom(room.code, {
    type: 'ROOM_LEADERBOARD_UPDATE',
    roomCode: room.code,
    status: room.status,
    summary: room.getSummary(),
    leaderboard: room.getLeaderboardData(),
    serverTime: Date.now(),
  });
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;
  ws.isAdmin = false;

  ws.on('message', (rawMsg) => {
    try {
      const data = JSON.parse(rawMsg.toString());

      // 1. Time Synchronization (NTP-style)
      if (data.type === 'TIME_SYNC') {
        ws.send(JSON.stringify({
          type: 'TIME_SYNC_RES',
          clientSendTime: data.clientSendTime,
          serverTime: Date.now(),
        }));
        return;
      }

      // 2. Admin WebSocket Join / Auth
      if (data.type === 'ADMIN_SUBSCRIBE') {
        if (data.password === ADMIN_PASS || data.token) {
          ws.isAdmin = true;
          if (data.roomCode) ws.roomCode = data.roomCode.toUpperCase();
          ws.send(JSON.stringify({
            type: 'ADMIN_SUBSCRIBED',
            rooms: roomManager.getAllRoomsSummary(),
          }));
        }
        return;
      }

      // 2b. Admin Create Room via WebSocket (for serverless compatibility)
      if (data.type === 'ADMIN_CREATE_ROOM') {
        if (!ws.isAdmin) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'NOT AUTHORIZED' }));
          return;
        }
        const dur = parseInt(data.durationSeconds, 10) || 300;
        const room = roomManager.createRoom(dur, data.code || null);
        ws.send(JSON.stringify({
          type: 'ADMIN_ROOM_CREATED',
          success: true,
          room: room.getSummary(),
          maze: room.maze,
          message: `ROOM ${room.code} CREATED SUCCESSFULLY`,
        }));
        return;
      }

      // 2c. Admin Start Room via WebSocket (for serverless compatibility)
      if (data.type === 'ADMIN_START_ROOM') {
        if (!ws.isAdmin) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'NOT AUTHORIZED' }));
          return;
        }
        const cleanCode = (data.roomCode || '').toUpperCase().trim();
        const room = roomManager.getRoomByCode(cleanCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'ADMIN_START_RESULT', success: false, error: 'ROOM NOT FOUND' }));
          return;
        }
        const result = room.startCountdown(3800);
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'ADMIN_START_RESULT', success: false, error: result.error }));
          return;
        }
        // Setup countdown completion
        if (room.countdownTimer) clearTimeout(room.countdownTimer);
        room.countdownTimer = setTimeout(() => {
          if (room.status === 'READY') {
            room.startCompetitionNow();
            broadcastToRoom(room.code, {
              type: 'ROOM_COMPETITION_STARTED',
              roomCode: room.code,
              startTime: room.startTime,
              endTime: room.endTime,
              durationSeconds: room.durationSeconds,
              serverTime: Date.now(),
            });
            broadcastRoomLeaderboard(room);
          }
        }, 3800);
        // Broadcast countdown
        broadcastToRoom(room.code, {
          type: 'ROOM_START_COUNTDOWN',
          roomCode: room.code,
          roomStartTime: result.roomStartTime,
          roomEndTime: result.roomEndTime,
          durationSeconds: room.durationSeconds,
          serverTime: Date.now(),
          leaderboard: room.getLeaderboardData(),
        });
        ws.send(JSON.stringify({
          type: 'ADMIN_START_RESULT',
          success: true,
          roomCode: room.code,
          roomStartTime: result.roomStartTime,
          roomEndTime: result.roomEndTime,
        }));
        return;
      }


      // 3. Player Subscribe to Room
      if (data.type === 'SUBSCRIBE_ROOM') {
        const cleanCode = (data.roomCode || '').toUpperCase().trim();
        const room = roomManager.getRoomByCode(cleanCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'ROOM NOT FOUND' }));
          return;
        }

        ws.roomCode = cleanCode;

        let player = null;
        // If playerToken provided, bind player connection
        if (data.playerToken) {
          player = room.getPlayerByToken(data.playerToken);
          if (player) {
            ws.playerId = player.id;
            player.ws = ws;
            player.connected = true;
          }
        }

        // Gather existing connected players in room to send to new subscriber
        const existingPlayers = Array.from(room.players.values())
          .filter(p => p.id !== (player ? player.id : null) && p.connected)
          .map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            status: p.status,
            x: p.x,
            y: p.y,
            c: p.c,
            r: p.r,
            direction: p.direction,
            sliding: p.sliding,
          }));

        ws.send(JSON.stringify({
          type: 'ROOM_SUBSCRIBED',
          room: room.getSummary(),
          maze: room.maze,
          remotePlayers: existingPlayers,
          leaderboard: room.getLeaderboardData(),
          serverTime: Date.now(),
        }));

        broadcastRoomLeaderboard(room);
        return;
      }

      // Real-time Position Synchronization (10-20 Hz, Room-Scoped, Visual Only)
      if (data.type === 'PLAYER_MOVE') {
        if (!ws.roomCode || !ws.playerId) return;
        const room = roomManager.getRoomByCode(ws.roomCode);
        if (!room) return;
        const player = room.players.get(ws.playerId);
        if (!player) return;

        if (typeof data.x === 'number') player.x = data.x;
        if (typeof data.y === 'number') player.y = data.y;
        if (typeof data.c === 'number') player.c = data.c;
        if (typeof data.r === 'number') player.r = data.r;
        if (data.direction !== undefined) player.direction = data.direction;
        if (data.sliding !== undefined) player.sliding = data.sliding;
        if (data.status) player.status = data.status;

        // Broadcast to other players in this room only (never cross rooms)
        broadcastToRoomExcept(ws.roomCode, ws, {
          type: 'REMOTE_PLAYER_MOVE',
          playerId: player.id,
          name: player.name,
          color: player.color,
          status: player.status,
          x: player.x,
          y: player.y,
          c: player.c,
          r: player.r,
          direction: player.direction,
          sliding: player.sliding,
        });
        return;
      }

      // 4. Checkpoint Events (Scoped to room)
      if (data.type === 'CHECKPOINT_ENTER') {
        if (!ws.roomCode || !ws.playerId) return;
        const room = roomManager.getRoomByCode(ws.roomCode);
        if (!room) return;
        room.handlePlayerCpEnter(ws.playerId, data.cpIndex);
        broadcastRoomLeaderboard(room);
        return;
      }

      if (data.type === 'CHECKPOINT_CLEAR') {
        if (!ws.roomCode || !ws.playerId) return;
        const room = roomManager.getRoomByCode(ws.roomCode);
        if (!room) return;
        room.handlePlayerCpClear(ws.playerId, data.cpIndex, data.progressPercentage);
        broadcastRoomLeaderboard(room);
        return;
      }

      // 5. Maze Attempt Reset (Spikes / 3 Checkpoint Lives Lost)
      if (data.type === 'PLAYER_RESET') {
        if (!ws.roomCode || !ws.playerId) return;
        const room = roomManager.getRoomByCode(ws.roomCode);
        if (!room) return;
        room.handlePlayerReset(ws.playerId, data.reason);
        broadcastRoomLeaderboard(room);
        return;
      }

      // 6. Player Reaches Final Exit (Authoritative Finish in Room)
      if (data.type === 'PLAYER_FINISH') {
        if (!ws.roomCode || !ws.playerId) return;
        const room = roomManager.getRoomByCode(ws.roomCode);
        if (!room) return;

        const result = room.handlePlayerFinish(ws.playerId, data.score || 0);
        if (!result.success) {
          ws.send(JSON.stringify({ type: 'FINISH_ERROR', error: result.error }));
          return;
        }

        const p = result.player;

        // Send confirmation back to finished player
        ws.send(JSON.stringify({
          type: 'ROOM_FINISH_CONFIRMED',
          roomCode: room.code,
          player: {
            id: p.id,
            name: p.name,
            durationMs: p.durationMs,
            durationStr: p.durationStr,
            rank: p.rank,
            score: p.score,
          },
          serverTime: Date.now(),
          leaderboard: room.getLeaderboardData(),
        }));

        // Broadcast announcement to all participants in this room
        broadcastToRoom(room.code, {
          type: 'ROOM_PLAYER_FINISHED',
          roomCode: room.code,
          player: {
            id: p.id,
            name: p.name,
            durationMs: p.durationMs,
            durationStr: p.durationStr,
            rank: p.rank,
            score: p.score,
          },
          leaderboard: room.getLeaderboardData(),
          summary: room.getSummary(),
          serverTime: Date.now(),
        });

        if (result.allFinished) {
          broadcastToRoom(room.code, {
            type: 'ROOM_COMPLETED',
            roomCode: room.code,
            reason: 'ALL PLAYERS IN ROOM FINISHED',
            leaderboard: room.getLeaderboardData(),
            summary: room.getSummary(),
            serverTime: Date.now(),
          });
        }
        return;
      }

    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  });

  ws.on('close', () => {
    if (ws.roomCode && ws.playerId) {
      const room = roomManager.getRoomByCode(ws.roomCode);
      if (room) {
        const player = room.players.get(ws.playerId);
        if (player && player.ws === ws) {
          player.connected = false;
          if (player.status !== 'FINISHED' && player.status !== 'DNF') {
            player.status = 'DISCONNECTED';
          }
          player.ws = null;
          broadcastRoomLeaderboard(room);
          broadcastToRoom(room.code, {
            type: 'REMOTE_PLAYER_LEFT',
            playerId: player.id,
          });
        }
      }
    }
  });
});

// Periodic heartbeat
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.ping();
    }
  }
}, 25000);

// Start server
server.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(`⚡ NEON MAZE ROOM-BASED COMPETITION SERVER ON PORT ${PORT}`);
  console.log(`🎮 Player Game URL:   http://localhost:${PORT}`);
  console.log(`🛠️  Admin Panel URL:  http://localhost:${PORT}/admin`);
  console.log(`🔑 Master Passkey:    ${ADMIN_PASS}`);
  console.log(`===========================================================`);
});
