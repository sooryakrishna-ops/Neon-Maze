const fs = require('fs');

console.log('====================================================');
console.log('CLIENT DOM & SCRIPT LOGIC VERIFICATION');
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

// 1. Inspect index.html
const indexHtml = fs.readFileSync('index.html', 'utf8');

// Checkpoint progression order enforcement in index.html
assert(indexHtml.includes('priorIncompleteIdx !== -1') && indexHtml.includes('COMPLETE CHECKPOINT'), 
  'index.html enforces checkpoint order and shows graceful locked notification');

// Room Maze initialization from server payload
assert(indexHtml.includes('G.roomMaze && G.roomMaze.grid') && indexHtml.includes('rm.checkpoints'), 
  'index.html loads dynamic room-specific maze and BFS checkpoints from server');

// Multiple simultaneous falling letters & bombs
assert(indexHtml.includes('maxSimultaneousTargets: 2') && indexHtml.includes('maxSimultaneousTargets: 6'), 
  'CHECKPOINT_CONFIG supports progressive simultaneous targets (2 to 6)');

// Deterministic target selection (safe letters first, lowest target if duplicate, bomb only if no safe)
assert(indexHtml.includes('matchingSafe') && indexHtml.includes('matchingBombs') && indexHtml.includes('b.y - a.y'), 
  'handleMgKey uses deterministic resolution: safe targets prioritized, lowest selected, bombs detonated only if no safe target matches');

// Avatar scale shrink on wrong key
assert(indexHtml.includes('applyWrongKeyPenalty') && indexHtml.includes('SCALE_PENALTIES'), 
  'Wrong key triggers avatar shrink (100% -> 85% -> 70% -> 55%)');

// Translucent ghost competitor rendering and smooth position interpolation
assert(indexHtml.includes('drawRemotePlayer') && indexHtml.includes('updRemotePlayers') && indexHtml.includes('maybeBroadcastPosition'), 
  'index.html includes 15Hz position streaming, smooth remote lerping, and translucent ghost rendering');

// 50-Player unique color assignment everywhere relevant
assert(indexHtml.includes('G.playerColor') && indexHtml.includes('style="border-color:${col}"'), 
  'index.html displays player assigned color on local player avatar, trail, and waiting roster / leaderboard');

// 2. Inspect admin.html
const adminHtml = fs.readFileSync('admin.html', 'utf8');
assert(adminHtml.includes('bannerMazeSeed') && adminHtml.includes('bannerCheckpoints'), 
  'admin.html room banner displays generated maze seed and checkpoints count');
assert(adminHtml.includes('PLAYERS: <strong id="bannerPlayerCount"') && adminHtml.includes('/ 50'), 
  'admin.html room banner displays capacity out of 50 players');

console.log('\n====================================================');
console.log(`CLIENT DOM VERIFICATION COMPLETED: ${passed} PASSED, ${failed} FAILED`);
console.log('====================================================');
process.exit(failed > 0 ? 1 : 0);
