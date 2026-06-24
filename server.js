const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the game files
app.use(express.static(path.join(__dirname, 'public')));

// Store active rooms
const rooms = {};

io.on('connection', (socket) => {

  // Player creates a room
  socket.on('create_room', ({ code, nick }) => {
    rooms[code] = {
      code,
      players: [{ id: socket.id, nick, charId: null, locked: false, color: '#F5C842', isHost: true }],
      started: false,
      gameState: null,
    };
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('room_update', rooms[code]);
  });

  // Player joins a room
  socket.on('join_room', ({ code, nick }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.started) { socket.emit('error', 'Game already started'); return; }
    if (room.players.length >= 6) { socket.emit('error', 'Room is full'); return; }

    const colors = ['#00C8FF','#00E676','#FFB300','#FF6B35','#B388FF','#FF4757'];
    const usedColors = room.players.map(p => p.color);
    const color = colors.find(c => !usedColors.includes(c)) || '#EDE8DC';

    room.players.push({ id: socket.id, nick, charId: null, locked: false, color, isHost: false });
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('room_update', room);
  });

  // Player selects a character
  socket.on('select_char', ({ charId, style }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    // Check not taken
    const taken = room.players.find(p => p.id !== socket.id && p.charId === charId);
    if (taken) { socket.emit('char_taken', charId); return; }
    player.charId = charId;
    player.style = style || 0;
    player.locked = true;
    io.to(socket.roomCode).emit('room_update', room);
  });

  // Host starts the game
  socket.on('start_game', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const host = room.players.find(p => p.isHost);
    if (host?.id !== socket.id) return;
    if (room.players.length < 3) return;
    room.started = true;
    io.to(socket.roomCode).emit('game_start', room);
  });

  // Player moved
  socket.on('player_move', ({ x, y, roomId }) => {
    socket.to(socket.roomCode).emit('other_player_move', { id: socket.id, x, y, roomId });
  });

  // Loot stolen
  socket.on('loot_stolen', ({ roomId, lootId }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    io.to(socket.roomCode).emit('loot_stolen', { roomId, lootId });
  });

  // Loot dropped off at van
  socket.on('loot_dropoff', ({ amount }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    io.to(socket.roomCode).emit('loot_dropoff', { id: socket.id, amount });
  });

  // Confrontation — broadcast to whole room so others see
  socket.on('confrontation_start', () => {
    socket.to(socket.roomCode).emit('teammate_confronted', { id: socket.id });
  });

  socket.on('confrontation_end', ({ outcome }) => {
    io.to(socket.roomCode).emit('confrontation_resolved', { id: socket.id, outcome });
  });

  // Timer sync — host is the authority
  socket.on('timer_tick', ({ timeLeft }) => {
    socket.to(socket.roomCode).emit('timer_sync', { timeLeft });
  });

  // Guard state — host broadcasts
  socket.on('guard_state', ({ guards }) => {
    socket.to(socket.roomCode).emit('guard_update', { guards });
  });

  // Power token used
  socket.on('token_used', ({ tokenId, targetRoom }) => {
    io.to(socket.roomCode).emit('token_activated', { id: socket.id, tokenId, targetRoom });
  });

  // Victory / defeat
  socket.on('game_over', ({ result }) => {
    io.to(socket.roomCode).emit('game_over', { result });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
    if (rooms[code].players.length === 0) {
      delete rooms[code];
    } else {
      // Pass host to next player if host left
      if (!rooms[code].players.find(p => p.isHost)) {
        rooms[code].players[0].isHost = true;
      }
      io.to(code).emit('room_update', rooms[code]);
    }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Ghost the Floor running on port ${PORT}`);
});