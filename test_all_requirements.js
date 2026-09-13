const http = require('http');
const WebSocket = require('ws');

const BASE_URL = 'http://127.0.0.1:3000';
const WS_URL = 'ws://127.0.0.1:3000';

function post(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE_URL + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(buf) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: buf });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(BASE_URL + endpoint, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(buf) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: buf });
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('TEST SUITE: NEON MAZE PHASE 4 REQUIREMENTS');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  // --- TEST 1: Room Creation with Dynamic Mazes & Unique Seeds ---
  console.log('TEST 1: Dynamic Maze per Room (Requirements #5-#9)');
  const r1 = await post('/api/admin/rooms/create', {});
  const roomA = r1.data.room;
  assert(roomA && roomA.roomCode, `Room A created: ${roomA.roomCode}`);
  assert(roomA.mazeSeed > 0, `Room A mazeSeed: ${roomA.mazeSeed}`);

  const r2 = await post('/api/admin/rooms/create', {});
  const roomB = r2.data.room;
  assert(roomB && roomB.roomCode, `Room B created: ${roomB.roomCode}`);
  assert(roomB.mazeSeed > 0, `Room B mazeSeed: ${roomB.mazeSeed}`);
  assert(roomA.mazeSeed !== roomB.mazeSeed, `Different rooms have different seeds (${roomA.mazeSeed} vs ${roomB.mazeSeed})`);

  // --- TEST 2: Players In Room A Receive Identical Maze ---
  console.log('\nTEST 2: Same Maze for All Players in Room A (Requirement #8)');
  const jA1 = await post('/api/rooms/join', { name: 'AlphaPlayer', playerClass: 'S5-CS', roomCode: roomA.roomCode });
  const jA2 = await post('/api/rooms/join', { name: 'BetaPlayer', playerClass: 'S5-CS', roomCode: roomA.roomCode });
  const jA3 = await post('/api/rooms/join', { name: 'GammaPlayer', playerClass: 'S5-CS', roomCode: roomA.roomCode });

  assert(jA1.data.maze && jA2.data.maze && jA3.data.maze, 'All players received room maze');
  assert(jA1.data.maze.seed === jA2.data.maze.seed, 'Player 1 and 2 share identical seed');
  assert(jA1.data.maze.grid.join('') === jA2.data.maze.grid.join(''), 'Player 1 and 2 receive identical grid walls');
  assert(jA1.data.maze.checkpoints.length === 5, 'Room has exactly 5 checkpoints');

  // Players in Room B receive Room B's maze
  const jB1 = await post('/api/rooms/join', { name: 'DeltaPlayer', playerClass: 'S7-IT', roomCode: roomB.roomCode });
  assert(jB1.data.maze.seed === roomB.mazeSeed, 'Room B player gets Room B maze seed');
  assert(jA1.data.maze.grid.join('') !== jB1.data.maze.grid.join(''), 'Room A grid differs from Room B grid');

  // --- TEST 3: Checkpoints Lie on Solution Path (Requirements #1-#4) ---
  console.log('\nTEST 3: Checkpoints along BFS Solution Path (Requirements #1-#4)');
  const mazeA = jA1.data.maze;
  assert(mazeA.checkpoints.length === 5, 'Checkpoints count is 5');
  
  // Verify checkpoints have strictly increasing pathStep
  let strictlyIncreasing = true;
  for (let i = 1; i < mazeA.checkpoints.length; i++) {
    if (mazeA.checkpoints[i].pathStep <= mazeA.checkpoints[i - 1].pathStep) {
      strictlyIncreasing = false;
    }
  }
  assert(strictlyIncreasing, 'Checkpoints are strictly ordered along the BFS solution path');
  console.log('    Checkpoint steps along path:', mazeA.checkpoints.map(cp => `CP${cp.id}@${cp.pathPercent}%(step ${cp.pathStep})`).join(' -> '));

  // --- TEST 4: 50-Player Unique Color Palette & Cap (Requirements #22-#25) ---
  console.log('\nTEST 4: 50-Player Unique Color System & 50-Player Limit (Requirements #22-#25)');
  assert(jA1.data.player.color && jA2.data.player.color, 'Players receive assigned colors');
  assert(jA1.data.player.color !== jA2.data.player.color, `Player 1 (${jA1.data.player.color}) != Player 2 (${jA2.data.player.color})`);
  assert(jA2.data.player.color !== jA3.data.player.color, `Player 2 != Player 3`);

  // Fill up Room A to 50 players
  console.log('    Registering players up to capacity (50)...');
  const colorsUsed = new Set([jA1.data.player.color, jA2.data.player.color, jA3.data.player.color]);
  for (let p = 4; p <= 50; p++) {
    const res = await post('/api/rooms/join', { name: `Tester${p}`, playerClass: 'S3-EC', roomCode: roomA.roomCode });
    if (res.data.success && res.data.player) {
      colorsUsed.add(res.data.player.color);
    }
  }
  assert(colorsUsed.size === 50, `Exactly 50 unique colors assigned to 50 players (count=${colorsUsed.size})`);

  // Attempt 51st player
  const jA51 = await post('/api/rooms/join', { name: 'PlayerFiftyOne', playerClass: 'S1-CS', roomCode: roomA.roomCode });
  assert(!jA51.data.success, '51st player registration is rejected');
  assert(jA51.data.error.includes('ROOM FULL'), `Rejection message: "${jA51.data.error}"`);

  // Reconnection of existing player preserves color
  const recon = await post('/api/rooms/join', {
    name: 'AlphaPlayer',
    playerClass: 'S5-CS',
    roomCode: roomA.roomCode,
    token: jA1.data.player.token
  });
  assert(recon.data.success && recon.data.player.color === jA1.data.player.color, `Reconnecting preserves assigned color: ${recon.data.player.color}`);

  // --- TEST 5: Admin Inspection View (Requirement #39) ---
  console.log('\nTEST 5: Admin Inspection Details (Requirement #39)');
  const adminDetails = await get(`/api/admin/rooms/${roomA.roomCode}`);
  assert(adminDetails.data.success, 'Admin room details retrieved');
  const summary = adminDetails.data.room;
  assert(summary.roomCode === roomA.roomCode, `Admin view Room Code: ${summary.roomCode}`);
  assert(summary.mazeSeed === roomA.mazeSeed, `Admin view Maze Seed: ${summary.mazeSeed}`);
  assert(summary.totalCheckpoints === 5, `Admin view Checkpoints: ${summary.totalCheckpoints}`);
  assert(summary.totalPlayers === 50, `Admin view Players: ${summary.totalPlayers} / 50`);
  assert(summary.status === 'WAITING', `Admin view Status: ${summary.status}`);

  // --- TEST 6: Multiplayer WebSocket Streaming & Ghost Player Updates (Requirements #26-#32) ---
  console.log('\nTEST 6: Real-Time Multiplayer WebSocket Streaming (Requirements #26-#32)');
  await new Promise((resolve) => {
    const ws1 = new WebSocket(WS_URL);
    const ws2 = new WebSocket(WS_URL);

    let ws1Subscribed = false;
    let ws2Subscribed = false;

    ws1.on('open', () => {
      ws1.send(JSON.stringify({
        type: 'SUBSCRIBE_ROOM',
        roomCode: roomB.roomCode,
        playerToken: jB1.data.player.token
      }));
    });

    let jB2Token = null;

    ws1.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'ROOM_SUBSCRIBED') {
        ws1Subscribed = true;
        // Join Player B2
        const jB2 = await post('/api/rooms/join', { name: 'EpsilonPlayer', playerClass: 'S7-IT', roomCode: roomB.roomCode });
        jB2Token = jB2.data.player.token;
        ws2.send(JSON.stringify({
          type: 'SUBSCRIBE_ROOM',
          roomCode: roomB.roomCode,
          playerToken: jB2Token
        }));
      }

      if (msg.type === 'REMOTE_PLAYER_MOVE') {
        assert(msg.name === 'EpsilonPlayer', `Player 1 received ghost movement of ${msg.name}`);
        assert(msg.x === 140 && msg.y === 210, `Ghost position received correctly: (${msg.x}, ${msg.y})`);
        assert(msg.color, `Ghost unique color attached: ${msg.color}`);
        ws1.close();
        ws2.close();
        resolve();
      }
    });

    ws2.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'ROOM_SUBSCRIBED') {
        ws2Subscribed = true;
        // Broadcast movement from Player 2
        ws2.send(JSON.stringify({
          type: 'PLAYER_MOVE',
          x: 140,
          y: 210,
          c: 5,
          r: 7,
          direction: 1,
          sliding: true,
          status: 'MAZE'
        }));
      }
    });
  });

  console.log('\n====================================================');
  console.log(`ALL TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
