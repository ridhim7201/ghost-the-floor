const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function rndCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

const PLAYER_COLORS = ['#F5C842','#00C8FF','#00E676','#FF6B35','#B388FF','#FF4757'];

io.on('connection', (socket) => {

  // ── LOBBY ──────────────────────────────────────────

  socket.on('create_room', ({ nick }) => {
    const code = rndCode();
    rooms[code] = {
      code,
      players: [{
        id: socket.id, nick,
        charId: null, style: 0,
        locked: false, isHost: true,
        color: PLAYER_COLORS[0],
        briefReady: false,
        personal: 0,
      }],
      started: false,
      briefReadyCount: 0,
      vanLoot: 0,
    };
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('room_update', rooms[code]);
  });

  socket.on('join_room', ({ code, nick }) => {
    const room = rooms[code];
    if (!room)          { socket.emit('error', 'Room not found');    return; }
    if (room.started)   { socket.emit('error', 'Game already started'); return; }
    if (room.players.length >= 6) { socket.emit('error', 'Room is full'); return; }
    const color = PLAYER_COLORS[room.players.length] || '#EDE8DC';
    room.players.push({
      id: socket.id, nick,
      charId: null, style: 0,
      locked: false, isHost: false,
      color,
      briefReady: false,
      personal: 0,
    });
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('room_update', room);
  });

  socket.on('select_char', ({ charId, style }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const taken = room.players.find(p => p.id !== socket.id && p.charId === charId);
    if (taken) { socket.emit('char_taken', charId); return; }
    player.charId = charId;
    player.style  = style || 0;
    player.locked = true;
    io.to(socket.roomCode).emit('room_update', room);
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const host = room.players.find(p => p.isHost);
    if (host?.id !== socket.id) return;
    if (room.players.length < 3) return;
    const allLocked = room.players.every(p => p.locked);
    if (!allLocked) return;
    room.started = true;
    room.briefReadyCount = 0;
    room.players.forEach(p => p.briefReady = false);
    io.to(socket.roomCode).emit('game_start', room);
  });

  // ── BRIEFING READY ─────────────────────────────────

  socket.on('player_brief_ready', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.briefReady) return;
    player.briefReady = true;
    room.briefReadyCount = room.players.filter(p => p.briefReady).length;
    io.to(socket.roomCode).emit('room_update', room);
    if (room.briefReadyCount === room.players.length) {
      io.to(socket.roomCode).emit('all_ready');
    }
  });

  // ── GAME EVENTS ────────────────────────────────────

  socket.on('player_move', ({ x, y, zone }) => {
    socket.to(socket.roomCode).emit('other_player_move', {
      id: socket.id, x, y, zone,
    });
  });

  socket.on('loot_stolen', ({ zoneId, lootIdx }) => {
    io.to(socket.roomCode).emit('loot_stolen', { zoneId, lootIdx });
  });

  socket.on('hall_drop', ({ x, y, val, icon, weight }) => {
    io.to(socket.roomCode).emit('hall_loot_dropped', {
      x, y, val, icon, weight, byId: socket.id,
    });
  });

  socket.on('loot_deposited', ({ amount }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    room.vanLoot = (room.vanLoot || 0) + amount;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.personal = (player.personal || 0) + amount;
    io.to(socket.roomCode).emit('loot_deposited', {
      playerId: socket.id,
      amount,
      vanTotal: room.vanLoot,
    });
  });

  socket.on('player_personal_update', ({ personal }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.personal = personal;
    io.to(socket.roomCode).emit('player_personal_update', {
      playerId: socket.id, personal,
    });
  });

  socket.on('guard_state', ({ guards }) => {
    socket.to(socket.roomCode).emit('guard_update', { guards });
  });

  socket.on('timer_tick', ({ timeLeft }) => {
    socket.to(socket.roomCode).emit('timer_sync', { timeLeft });
  });

  // ── CONFRONTATION ──────────────────────────────────

  socket.on('confrontation_start', () => {
    socket.to(socket.roomCode).emit('teammate_confronted', { id: socket.id });
  });

  socket.on('confrontation_end', ({ outcome }) => {
    io.to(socket.roomCode).emit('confrontation_resolved', {
      id: socket.id, outcome,
    });
  });

  socket.on('confrontation_auto_resolved', () => {
    io.to(socket.roomCode).emit('confrontation_auto_resolved');
  });

  // ── TOKENS ─────────────────────────────────────────

  socket.on('token_used', ({ tokenId, targetZone }) => {
    socket.to(socket.roomCode).emit('token_activated', {
      id: socket.id, tokenId, targetZone,
    });
  });

  socket.on('riot_call', ({ fromZone }) => {
    io.to(socket.roomCode).emit('riot_call', { fromZone, byId: socket.id });
  });

  socket.on('riot_resolved', () => {
    io.to(socket.roomCode).emit('riot_resolved');
  });

  socket.on('source_grant_access', ({ toId, zone }) => {
    // Tell the target player they now have access
    io.to(toId).emit('master_key_grant', { toId, zone });
    // Notify the room
    socket.to(socket.roomCode).emit('token_activated', {
      id: socket.id, tokenId: 'source', targetZone: zone,
    });
  });

  // ── GAME OVER ──────────────────────────────────────

  socket.on('game_over', ({ result }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    // Only broadcast if host sends it (or result is genuine)
    const player = room.players.find(p => p.id === socket.id);
    if (player?.isHost || result === 'victory') {
      io.to(socket.roomCode).emit('game_over', { result });
    }
  });

  // ── DISCONNECT ─────────────────────────────────────

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const leaving = room.players.find(p => p.id === socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[code];
    } else {
      if (!room.players.find(p => p.isHost)) {
        room.players[0].isHost = true;
      }
      if (leaving) {
        io.to(code).emit('player_disconnected', { nick: leaving.nick });
      }
      io.to(code).emit('room_update', room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Ghost the Floor running on port ${PORT}`);
});
