#!/usr/bin/env node
/**
 * NEON MAZE REMOTE COMPETITION SIMULATOR
 * =====================================================
 * Simulates up to 49 real participants on the deployed game using Playwright.
 * Each bot joins through the real UI. Bots wait for admin to start.
 * Uses BFS pathfinding + keyboard inputs to navigate the maze.
 * Handles checkpoint mini-games with skill-appropriate accuracy.
 *
 * Usage:
 *   node tests/competition-simulator.js <ROOM_CODE> [options]
 *
 * Options:
 *   --players=N       Number of bot players (1-49, default: 49)
 *   --url=<URL>       Target URL (default: https://neon-maze-nice.vercel.app)
 *   --headed          Run in headed mode
 *   --visible=N       Visible bots in headed mode (default: 3)
 *   --batch=N         Bots per join batch (default: 5)
 *   --batch-delay=N   Ms between batches (default: 1200)
 *   --stuck-timeout=N Ms before bot declared stuck (default: 45000)
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// CLI
const args = process.argv.slice(2);
const ROOM_CODE = (args.find(a => !a.startsWith('--')) || '').toUpperCase().trim();
const getArg = (name, def) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : def; };
const hasFlag = (name) => args.includes(`--${name}`);

const TARGET_URL      = getArg('url', 'https://neon-maze-nice.vercel.app');
const PLAYER_COUNT    = Math.max(1, Math.min(49, parseInt(getArg('players', '49'), 10)));
const HEADED          = hasFlag('headed');
const VISIBLE_COUNT   = parseInt(getArg('visible', '3'), 10);
const BATCH_SIZE      = parseInt(getArg('batch', '5'), 10);
const BATCH_DELAY_MS  = parseInt(getArg('batch-delay', '1200'), 10);
const STUCK_TIMEOUT_MS= parseInt(getArg('stuck-timeout', '45000'), 10);

if (!ROOM_CODE) {
  console.error('\n  ERROR: Room code required.\n  Usage: node tests/competition-simulator.js <ROOM_CODE> [--players=49]\n');
  process.exit(1);
}

// Directories
const RESULTS_DIR     = path.join(__dirname, 'results');
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, 'screenshots');
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Skill profiles
const SKILL_PROFILES = {
  EXPERT:  { reactionMs:[80,160],   accuracy:0.97, missChance:0.03, wrongKeyChance:0.01, moveDelayMs:[60,120]  },
  GOOD:    { reactionMs:[150,280],  accuracy:0.88, missChance:0.10, wrongKeyChance:0.05, moveDelayMs:[100,200] },
  AVERAGE: { reactionMs:[280,500],  accuracy:0.76, missChance:0.20, wrongKeyChance:0.12, moveDelayMs:[160,320] },
  POOR:    { reactionMs:[500,900],  accuracy:0.60, missChance:0.35, wrongKeyChance:0.22, moveDelayMs:[280,600] },
};

function assignSkill(idx, total) {
  const t = idx / total;
  if (t < 0.10) return 'EXPERT';
  if (t < 0.35) return 'GOOD';
  if (t < 0.70) return 'AVERAGE';
  return 'POOR';
}

const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const rand   = (min, max) => min + Math.random() * (max - min);

function formatTime(ms) {
  if (!ms || ms <= 0) return '--';
  const totalSec = ms / 1000;
  const m  = Math.floor(totalSec / 60);
  const s  = Math.floor(totalSec % 60);
  const cs = Math.floor((totalSec - Math.floor(totalSec)) * 100);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

// BFS on sliding maze
function bfsSliding(maze, startC, startR, endC, endR) {
  if (!maze || !maze.length) return null;
  const rows = maze.length, cols = maze[0].length;
  const key    = (c,r) => `${c},${r}`;
  const isWall = (c,r) => c < 0 || r < 0 || c >= cols || r >= rows || maze[r][c] === 1;

  function slide(c, r, dc, dr) {
    let nc = c + dc, nr = r + dr;
    if (isWall(nc, nr)) return null;
    while (!isWall(nc + dc, nr + dr)) { nc += dc; nr += dr; }
    return { c: nc, r: nr };
  }

  const DIRS = [
    { dc:0, dr:-1, key:'ArrowUp'    },
    { dc:0, dr:1,  key:'ArrowDown'  },
    { dc:-1,dr:0,  key:'ArrowLeft'  },
    { dc:1, dr:0,  key:'ArrowRight' },
  ];

  const visited = new Map();
  const queue   = [{ c:startC, r:startR, path:[] }];
  visited.set(key(startC, startR), true);

  while (queue.length) {
    const { c, r, path } = queue.shift();
    if (c === endC && r === endR) return path;
    for (const dir of DIRS) {
      const res = slide(c, r, dir.dc, dir.dr);
      if (!res) continue;
      const k = key(res.c, res.r);
      if (!visited.has(k)) {
        visited.set(k, true);
        queue.push({ c:res.c, r:res.r, path:[...path, dir.key] });
      }
    }
  }
  return null;
}

// BotState
class BotState {
  constructor(idx) {
    this.idx            = idx;
    this.name           = `SIM-${String(idx).padStart(2,'0')}`;
    this.skill          = assignSkill(idx - 1, PLAYER_COUNT);
    this.profile        = SKILL_PROFILES[this.skill];
    this.status         = 'INIT';
    this.cpProgress     = 0;
    this.startTime      = null;
    this.finishTime     = null;
    this.durationMs     = null;
    this.errors         = [];
    this.reconnects     = 0;
    this.cpFailures     = [0,0,0,0,0];
    this.joinTimeMs     = null;
    this.pageLoadMs     = null;
    this.lastMoveTime   = Date.now();
    this.lastGameState  = null;
    this.maze           = null;
    this.stuckCount     = 0;
    this.networkErrors  = 0;
    this.page           = null;
    this.context        = null;
  }

  log(msg) {
    process.stdout.write(`\r  [${new Date().toLocaleTimeString()}] ${this.name}(${this.skill.padStart(7)}) ${msg}\n`);
  }

  err(msg) {
    this.errors.push({ time: Date.now(), msg });
    this.log(`WARN: ${msg}`);
  }
}

const globalStats = {
  roomStartDetected: false,
  roomEndDetected:   false,
  realtimeErrors:    0,
  leaderboardDelays: 0,
  duplicatePlayers:  0,
};

// Confirmation
async function confirmRun() {
  const W = 56;
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log('\n' + '='.repeat(W));
  console.log(pad('  NEON MAZE REMOTE COMPETITION SIMULATOR', W));
  console.log('='.repeat(W));
  console.log(`  URL    : ${TARGET_URL}`);
  console.log(`  ROOM   : ${ROOM_CODE}`);
  console.log(`  BOTS   : ${PLAYER_COUNT}`);
  console.log('');
  console.log('  WARNING: REMOTE TEST');
  console.log(`  This will create ${PLAYER_COUNT} REAL records in the live room.`);
  console.log('  You must manually START COMPETITION from the admin panel.');
  console.log('');
  console.log('  Type exactly:  RUN TEST  (or Ctrl+C to abort)');
  console.log('='.repeat(W) + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  > ', answer => {
      rl.close();
      if (answer.trim() === 'RUN TEST') { resolve(true); }
      else { console.log('\n  Aborted.\n'); resolve(false); }
    });
  });
}

// Read lightweight game state from page JS context
async function readGameState(page) {
  try {
    return await page.evaluate(() => {
      if (typeof G === 'undefined') return null;
      return {
        state:                  G.state,
        plrC:                   G.plr ? G.plr.c : 0,
        plrR:                   G.plr ? G.plr.r : 0,
        plrSliding:             G.plr ? G.plr.sliding : false,
        cps:                    G.cps ? G.cps.map(cp => ({ c:cp.c, r:cp.r, done:cp.done })) : [],
        exit:                   G.exit,
        cpIdx:                  G.cpIdx,
        mgLives:                G.mgLives,
        mgScore:                G.mgScore,
        mgDone:                 G.mgDone,
        timerRunning:           G.timerRunning,
        roomEndTime:            G.roomEndTime,
        progressPercentage:     G.progressPercentage || 0,
        lastCompletedCheckpoint:G.lastCompletedCheckpoint,
      };
    });
  } catch(_) { return null; }
}

async function readMaze(page) {
  try {
    return await page.evaluate(() => {
      if (typeof G === 'undefined' || !G.maze) return null;
      return {
        maze:  G.maze,
        exit:  G.exit,
        cps:   G.cps ? G.cps.map(cp => ({ c:cp.c, r:cp.r, done:cp.done })) : [],
        width: G.maze[0] ? G.maze[0].length : 0,
        height:G.maze.length,
      };
    });
  } catch(_) { return null; }
}

async function readActiveTargets(page) {
  try {
    return await page.evaluate(() => {
      const items = document.querySelectorAll('#mgarea .li-item:not(.pop):not(.boom)');
      const result = [];
      items.forEach(item => {
        const ch = item.querySelector('.lchar');
        const isBomb = item.classList.contains('bomb');
        if (ch) result.push({ letter: ch.textContent.trim().toUpperCase(), isBomb, y: parseFloat(item.style.top) || 0 });
      });
      return result;
    });
  } catch(_) { return []; }
}

// Join room via real UI
async function botJoin(bot) {
  try {
    bot.status = 'JOINING';
    const navStart = Date.now();
    await bot.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    bot.pageLoadMs = Date.now() - navStart;

    await bot.page.waitForSelector('#bstart', { timeout: 15000 });
    await sleep(rand(200,500));
    await bot.page.click('#bstart');
    await bot.page.waitForSelector('#regName', { timeout: 10000 });
    await sleep(rand(100,300));

    await bot.page.fill('#regName', bot.name);
    await sleep(rand(80,200));
    await bot.page.fill('#regRoom', ROOM_CODE);
    await sleep(rand(80,200));

    const joinStart = Date.now();
    await bot.page.click('#btnJoinRoom');
    await bot.page.waitForSelector('#swait.active', { timeout: 20000 });
    bot.joinTimeMs = Date.now() - joinStart;
    bot.status = 'WAITING';
    bot.log(`Joined in ${bot.joinTimeMs}ms`);
    return true;

  } catch(err) {
    bot.status = 'ERROR';
    bot.err(`Join failed: ${err.message.slice(0,100)}`);
    try { await bot.page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${bot.name}-join-fail.png`) }); } catch(_){}
    return false;
  }
}

// Wait for real competition start (no timeout — admin starts manually)
async function botWaitForStart(bot) {
  try {
    bot.log('Waiting for admin to start...');
    await bot.page.waitForSelector('#cdo.on, #game-wrapper.active', { timeout: 0 });
    bot.status = 'PLAYING';
    bot.startTime = Date.now();
    globalStats.roomStartDetected = true;
    bot.log('Game started!');
    return true;
  } catch(err) {
    bot.err(`Wait for start failed: ${err.message.slice(0,80)}`);
    return false;
  }
}

// Checkpoint mini-game handler
async function botPlayCheckpoint(bot) {
  const profile = bot.profile;
  bot.status = 'CHECKPOINT';
  const cpIdx = bot.lastGameState ? (bot.lastGameState.cpIdx || 0) : 0;
  bot.log(`Checkpoint ${cpIdx+1} (${bot.skill})`);

  const deadline = Date.now() + 35000;
  let noTargetStreak = 0;

  while (Date.now() < deadline) {
    const state = await readGameState(bot.page);
    if (!state) { await sleep(150); continue; }

    if (state.state === 'MAZE' || state.state === 'DYING') {
      if (state.state === 'MAZE') {
        bot.cpProgress = state.cps.filter(cp => cp.done).length;
        bot.log(`CP ${cpIdx+1} cleared! ${bot.cpProgress}/5`);
      } else {
        bot.cpFailures[cpIdx] = (bot.cpFailures[cpIdx] || 0) + 1;
        bot.log(`CP ${cpIdx+1} failed`);
      }
      bot.status = 'PLAYING';
      await sleep(rand(300,700));
      return;
    }

    if (state.state !== 'CHECKPOINT') { await sleep(150); continue; }

    const targets = await readActiveTargets(bot.page);
    const safeTargets = targets.filter(t => !t.isBomb).sort((a,b) => b.y - a.y);

    if (!safeTargets.length) {
      noTargetStreak++;
      if (noTargetStreak > 40) bot.log('No targets visible during checkpoint');
      await sleep(80);
      continue;
    }
    noTargetStreak = 0;

    const t = safeTargets[0];
    await sleep(rand(profile.reactionMs[0], profile.reactionMs[1]));

    if (Math.random() < profile.wrongKeyChance) {
      const wrong = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('').filter(k => k !== t.letter);
      try { await bot.page.keyboard.press(wrong[Math.floor(Math.random() * wrong.length)]); } catch(_){}
    } else if (Math.random() >= (1 - profile.missChance)) {
      await sleep(rand(300,600));
    } else {
      try { await bot.page.keyboard.press(t.letter); } catch(_){}
    }

    await sleep(rand(40,100));
  }

  bot.log(`CP ${cpIdx+1} timed out`);
  bot.status = 'PLAYING';
}

// Main maze navigation loop
async function botNavigateMaze(bot) {
  const profile = bot.profile;
  let mazeData = null;

  for (let i = 0; i < 8; i++) {
    mazeData = await readMaze(bot.page);
    if (mazeData && mazeData.maze && mazeData.maze.length) break;
    await sleep(500);
  }

  if (!mazeData) { bot.err('Could not read maze'); return; }
  bot.maze = mazeData.maze;
  bot.log(`Maze: ${mazeData.width}x${mazeData.height}`);

  const MOVE_KEYS = { ArrowUp:'w', ArrowDown:'s', ArrowLeft:'a', ArrowRight:'d' };

  let currentPath = [];
  let lastC = -1, lastR = -1;
  let stuckMs = 0;

  const getTarget = (cps) => {
    for (let i = 0; i < cps.length; i++) {
      if (!cps[i].done) return { type:'CP', idx:i, c:cps[i].c, r:cps[i].r };
    }
    return mazeData.exit ? { type:'EXIT', c:mazeData.exit.c, r:mazeData.exit.r } : null;
  };

  while (true) {
    const state = await readGameState(bot.page);
    if (!state) { await sleep(200); continue; }
    bot.lastGameState = state;

    // Terminal
    if (state.state === 'VICTORY') {
      bot.status = 'FINISHED';
      bot.finishTime = Date.now();
      bot.durationMs = bot.startTime ? bot.finishTime - bot.startTime : null;
      bot.cpProgress = 5;
      bot.log(`FINISHED! ${formatTime(bot.durationMs)}`);
      return;
    }

    if (state.state === 'COMPLETED') {
      bot.status = 'DNF';
      bot.log(`Room ended. CP: ${state.cps.filter(c=>c.done).length}/5`);
      globalStats.roomEndDetected = true;
      return;
    }

    // Check timer
    if (state.roomEndTime && Date.now() > state.roomEndTime + 5000) {
      bot.status = 'DNF';
      bot.log(`Timer expired. CP: ${bot.cpProgress}/5`);
      return;
    }

    if (state.state === 'CHECKPOINT') {
      await botPlayCheckpoint(bot);
      mazeData = await readMaze(bot.page) || mazeData;
      currentPath = [];
      continue;
    }

    if (state.state === 'DYING') { await sleep(2200); currentPath = []; continue; }
    if (state.state === 'COUNTDOWN') { await sleep(200); continue; }
    if (state.state !== 'MAZE') { await sleep(150); continue; }

    const { plrC, plrR, plrSliding } = state;
    bot.cpProgress = state.cps.filter(c=>c.done).length;

    // Stuck detection
    if (plrC === lastC && plrR === lastR) {
      stuckMs += 250;
      if (stuckMs >= STUCK_TIMEOUT_MS) {
        bot.stuckCount++;
        bot.log(`STUCK at (${plrC},${plrR}) — attempt ${bot.stuckCount}`);
        try { await bot.page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${bot.name}-stuck-${Date.now()}.png`) }); } catch(_){}
        currentPath = [];
        stuckMs = 0;
        for (const k of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight']) {
          try { await bot.page.keyboard.press(k); } catch(_){}
          await sleep(rand(200,400));
        }
        if (bot.stuckCount > 5) {
          bot.status = 'STUCK';
          bot.err('Permanently stuck after 5 recovery attempts');
          return;
        }
      }
    } else {
      stuckMs = 0; lastC = plrC; lastR = plrR;
      bot.lastMoveTime = Date.now();
    }

    // Compute path if needed
    if (!currentPath.length) {
      mazeData.cps = state.cps;
      const target = getTarget(state.cps);
      if (!target) { await sleep(500); continue; }

      const p = bfsSliding(bot.maze, plrC, plrR, target.c, target.r);
      if (!p || !p.length) {
        await sleep(rand(400,800));
        continue;
      }
      currentPath = p;
    }

    // Execute next move
    if (currentPath.length && !plrSliding) {
      const nextKey = currentPath.shift();
      await sleep(rand(profile.moveDelayMs[0], profile.moveDelayMs[1]));
      try { await bot.page.keyboard.press(MOVE_KEYS[nextKey] || nextKey); } catch(_){ bot.networkErrors++; }
    } else {
      await sleep(80);
    }
  }
}

// Full bot lifecycle
async function runBot(bot, browser, startSignal) {
  try {
    bot.context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: `NeonMazeSim/${bot.name}`,
    });
    bot.page = await bot.context.newPage();
    bot.page.on('pageerror', err => bot.err(`PageError: ${err.message.slice(0,60)}`));

    if (!await botJoin(bot)) return;
    startSignal.ready++;
    if (!await botWaitForStart(bot)) return;
    await botNavigateMaze(bot);

  } catch(err) {
    bot.status = 'ERROR';
    bot.err(`Fatal: ${err.message.slice(0,100)}`);
    try { if (bot.page) await bot.page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${bot.name}-fatal.png`) }); } catch(_){}
  } finally {
    try { if (bot.context) await bot.context.close(); } catch(_){}
  }
}

function printProgress(bots, phase) {
  const c = (s) => bots.filter(b => b.status === s).length;
  const joining   = c('JOINING');
  const waiting   = c('WAITING');
  const playing   = c('PLAYING') + c('CHECKPOINT');
  const finished  = c('FINISHED');
  const dnf       = c('DNF');
  const error     = c('ERROR') + c('STUCK');
  process.stdout.write(`\r  [${phase}] Join:${joining} Wait:${waiting} Play:${playing} Fin:${finished} DNF:${dnf} Err:${error}   `);
}

function generateReport(bots, roomCode) {
  const finished  = bots.filter(b => b.status === 'FINISHED');
  const dnf       = bots.filter(b => b.status === 'DNF');
  const errors    = bots.filter(b => b.status === 'ERROR' || b.status === 'STUCK');
  const joined    = bots.filter(b => b.joinTimeMs !== null);

  const fastest      = finished.length ? finished.reduce((a,b) => a.durationMs < b.durationMs ? a : b) : null;
  const slowest      = finished.length ? finished.reduce((a,b) => a.durationMs > b.durationMs ? a : b) : null;
  const times        = finished.map(b => b.durationMs).filter(Boolean);
  const avgMs        = times.length ? times.reduce((a,b) => a+b, 0) / times.length : 0;

  const cpF = [0,0,0,0,0];
  bots.forEach(b => b.cpFailures.forEach((v,i) => cpF[i] += v));

  const totalNetErr  = bots.reduce((s,b) => s + b.networkErrors, 0);
  const totalReconn  = bots.reduce((s,b) => s + b.reconnects,    0);

  const report = {
    timestamp:      new Date().toISOString(),
    url:            TARGET_URL,
    roomCode,
    players:        PLAYER_COUNT,
    joined:         joined.length,
    started:        bots.filter(b => b.startTime).length,
    finished:       finished.length,
    dnf:            dnf.length,
    errors:         errors.length,
    fastest:        fastest  ? { name: fastest.name,  durationStr: formatTime(fastest.durationMs)  } : null,
    slowestFinish:  slowest  ? { name: slowest.name,  durationStr: formatTime(slowest.durationMs)  } : null,
    averageTimeStr: formatTime(avgMs),
    cpFailures:     cpF,
    network:        { realtimeErrors: totalNetErr, reconnects: totalReconn, leaderboardDelays: globalStats.leaderboardDelays },
    room:           { startDetected: globalStats.roomStartDetected, endDetected: globalStats.roomEndDetected },
    botDetails:     bots.map(b => ({ name:b.name, skill:b.skill, status:b.status, cpProgress:b.cpProgress, durationStr:formatTime(b.durationMs), joinTimeMs:b.joinTimeMs, stuckCount:b.stuckCount, networkErrors:b.networkErrors, cpFailures:b.cpFailures, errors:b.errors })),
  };

  const reportPath = path.join(RESULTS_DIR, 'latest-test.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const L = '=' .repeat(40);
  const l = '-'.repeat(40);
  console.log('\n\n' + L);
  console.log('  NEON MAZE REMOTE TEST');
  console.log(L);
  console.log(`\n  URL    : ${TARGET_URL}`);
  console.log(`  ROOM   : ${roomCode}`);
  console.log(`  PLAYERS: ${PLAYER_COUNT}`);
  console.log(`\n  STARTED  : ${report.started}`);
  console.log(`  FINISHED : ${finished.length}`);
  console.log(`  DNF      : ${dnf.length}`);
  console.log(`  ERRORS   : ${errors.length}`);
  if (fastest)  console.log(`\n  FASTEST : ${fastest.name} -- ${formatTime(fastest.durationMs)}`);
  if (slowest)  console.log(`  SLOWEST : ${slowest.name} -- ${formatTime(slowest.durationMs)}`);
  if (avgMs > 0)console.log(`  AVERAGE : ${formatTime(avgMs)}`);
  console.log(`\n${l}`);
  console.log('  CHECKPOINT FAILURES');
  console.log(l);
  cpF.forEach((v,i) => console.log(`  CP${i+1}: ${v} failures`));
  console.log(`\n${l}`);
  console.log('  NETWORK');
  console.log(l);
  console.log(`  Realtime errors   : ${totalNetErr}`);
  console.log(`  Reconnects        : ${totalReconn}`);
  console.log(`  Leaderboard delay : ${globalStats.leaderboardDelays}`);
  console.log(`\n${l}`);
  console.log('  ROOM');
  console.log(l);
  console.log(`  Start detected : ${globalStats.roomStartDetected ? 'YES' : 'NO'}`);
  console.log(`  End detected   : ${globalStats.roomEndDetected   ? 'YES' : 'NO'}`);
  console.log(`\n${l}`);
  console.log('  RESULTS BY SKILL');
  console.log(l);
  ['EXPERT','GOOD','AVERAGE','POOR'].forEach(skill => {
    const sb = bots.filter(b => b.skill === skill);
    const sf = sb.filter(b => b.status === 'FINISHED').length;
    console.log(`  ${skill.padEnd(8)}: ${sb.length} bots, ${sf} finished`);
  });
  const issues = [];
  if (joined.length < PLAYER_COUNT) issues.push(`Only ${joined.length}/${PLAYER_COUNT} bots joined`);
  if (errors.length > 0)            issues.push(`${errors.length} bots errored`);
  if (!globalStats.roomStartDetected) issues.push('Room start never detected');
  if (issues.length) {
    console.log(`\n${l}\n  ISSUES`);
    console.log(l);
    issues.forEach(i => console.log(`  !! ${i}`));
  }
  console.log(`\n  Report: ${reportPath}`);
  console.log(L + '\n');
}

// Main
async function main() {
  const confirmed = await confirmRun();
  if (!confirmed) process.exit(0);

  console.log('\n  Launching Playwright browser...\n');

  const bots = Array.from({ length: PLAYER_COUNT }, (_, i) => new BotState(i + 1));

  console.log('  Skill distribution:');
  ['EXPERT','GOOD','AVERAGE','POOR'].forEach(s => {
    const c = bots.filter(b => b.skill === s).length;
    console.log(`    ${s.padEnd(8)}: ${c} bots`);
  });
  console.log('');

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });

  const startSignal = { ready: 0 };
  const botPromises = [];

  try {
    console.log(`  Joining ${PLAYER_COUNT} bots in batches of ${BATCH_SIZE}...\n`);

    for (let i = 0; i < bots.length; i++) {
      botPromises.push(runBot(bots[i], browser, startSignal));
      if ((i + 1) % BATCH_SIZE === 0 && i < bots.length - 1) {
        await sleep(BATCH_DELAY_MS);
      } else {
        await sleep(rand(150, 350));
      }
      printProgress(bots, 'JOINING');
    }

    // Wait for join phase
    const joinDeadline = Date.now() + 120000;
    while (Date.now() < joinDeadline) {
      const done = bots.filter(b => ['WAITING','PLAYING','FINISHED','DNF','ERROR'].includes(b.status)).length;
      if (done >= bots.length) break;
      printProgress(bots, 'JOINING');
      await sleep(500);
    }

    const ready   = bots.filter(b => b.status === 'WAITING').length;
    const failed  = bots.filter(b => b.status === 'ERROR').length;

    console.log('\n\n' + '='.repeat(56));
    console.log(`  ${ready} / ${PLAYER_COUNT} PLAYERS JOINED SUCCESSFULLY`);
    if (failed > 0) console.log(`  WARNING: ${failed} bots failed to join`);
    console.log('');
    console.log('  WAITING FOR ADMIN TO START...');
    console.log('');
    console.log('  Admin steps:');
    console.log('  1. Go to /admin');
    console.log('  2. Authenticate');
    console.log(`  3. Open room: ${ROOM_CODE}`);
    console.log('  4. Press START COMPETITION');
    console.log('='.repeat(56) + '\n');

    const progressInterval = setInterval(() => printProgress(bots, 'PLAYING'), 2000);
    await Promise.allSettled(botPromises);
    clearInterval(progressInterval);

  } finally {
    await browser.close();
  }

  generateReport(bots, ROOM_CODE);
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });
