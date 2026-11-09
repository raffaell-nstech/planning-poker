'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Configuração (todas sobrescrevíveis por variável de ambiente)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
// Sala sem ninguém conectado é apagada depois deste tempo.
const ROOM_TTL_MINUTES = Number(process.env.ROOM_TTL_MINUTES) || 60;
// Jogador que caiu (F5, rede) fica na mesa por este tempo antes de sair.
const PLAYER_GRACE_SECONDS = Number(process.env.PLAYER_GRACE_SECONDS) || 30;
const MAX_PLAYERS_PER_ROOM = 50;
const MAX_ISSUES_PER_ROOM = 200;
const MAX_ROOMS = 1000;

const DECKS = {
  fibonacci: { label: 'Fibonacci', cards: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'] },
  modified: { label: 'Fibonacci modificado', cards: ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'] },
  tshirt: { label: 'T-shirt', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'] },
  powers: { label: 'Potências de 2', cards: ['0', '1', '2', '4', '8', '16', '32', '64', '?', '☕'] },
};

// ---------------------------------------------------------------------------
// Estado em memória: tudo some quando o processo reinicia.
// ---------------------------------------------------------------------------
/** @type {Map<string, any>} */
const rooms = new Map();

function newId(size) {
  // Sem caracteres ambíguos (0/O, 1/I/l).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function cardNumber(card) {
  if (card === '½') return 0.5;
  const n = Number(card);
  return Number.isFinite(n) ? n : null;
}

function onlineCount(room) {
  let count = 0;
  for (const p of room.players.values()) count += p.sockets.size;
  return count;
}

function canControl(room, playerId) {
  if (!room.onlyFacilitatorReveal) return true;
  if (playerId === room.facilitatorId) return true;
  // Se o facilitador não está conectado, ninguém fica travado.
  const facilitator = room.players.get(room.facilitatorId);
  return !facilitator || facilitator.sockets.size === 0;
}

function summarize(room) {
  const votes = [];
  for (const p of room.players.values()) {
    if (!p.spectator && p.vote !== null) votes.push(p.vote);
  }
  const counts = {};
  for (const v of votes) counts[v] = (counts[v] || 0) + 1;

  const numeric = votes.map(cardNumber).filter((n) => n !== null);
  const average = numeric.length ? Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10 : null;

  let mostVoted = null;
  let best = 0;
  for (const card of room.deck.cards) {
    if ((counts[card] || 0) > best) {
      best = counts[card];
      mostVoted = card;
    }
  }

  return {
    totalVotes: votes.length,
    counts,
    average,
    mostVoted,
    consensus: votes.length > 1 && Object.keys(counts).length === 1,
  };
}

// Estimativa sugerida para a issue: carta numérica mais próxima da média,
// ou a mais votada quando o baralho não é numérico (T-shirt).
function suggestedEstimate(room, summary) {
  if (summary.average !== null) {
    let closest = null;
    let diff = Infinity;
    for (const card of room.deck.cards) {
      const n = cardNumber(card);
      if (n === null) continue;
      const d = Math.abs(n - summary.average);
      if (d < diff) {
        diff = d;
        closest = card;
      }
    }
    return closest;
  }
  return summary.mostVoted;
}

function stateFor(room, viewerId) {
  return {
    id: room.id,
    name: room.name,
    deck: room.deck,
    revealed: room.revealed,
    facilitatorId: room.facilitatorId,
    onlyFacilitatorReveal: room.onlyFacilitatorReveal,
    canControl: canControl(room, viewerId),
    currentIssueId: room.currentIssueId,
    issues: room.issues,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      spectator: p.spectator,
      online: p.sockets.size > 0,
      hasVoted: p.vote !== null,
      // Voto dos outros só vai para o navegador depois de revelar.
      vote: room.revealed || p.id === viewerId ? p.vote : null,
    })),
    summary: room.revealed ? summarize(room) : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP + Socket.IO
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/decks', (_req, res) => res.json(DECKS));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.sockets.size === 0) continue;
    const state = stateFor(room, p.id);
    for (const sid of p.sockets) io.to(sid).emit('state', state);
  }
}

function resetVotes(room) {
  for (const p of room.players.values()) p.vote = null;
  room.revealed = false;
}

io.on('connection', (socket) => {
  const reply = (ack, payload) => {
    if (typeof ack === 'function') ack(payload);
  };

  // Retorna sala + jogador do socket atual, ou null.
  const context = () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return null;
    const player = room.players.get(socket.data.playerId);
    if (!player) return null;
    return { room, player };
  };

  socket.on('create-room', (data, ack) => {
    if (rooms.size >= MAX_ROOMS) return reply(ack, { error: 'Limite de salas atingido. Tente mais tarde.' });
    const deckKey = DECKS[data?.deck] ? data.deck : 'fibonacci';
    let id;
    do id = newId(6); while (rooms.has(id));

    rooms.set(id, {
      id,
      name: cleanText(data?.name, 60) || 'Planning Poker',
      deck: { key: deckKey, ...DECKS[deckKey] },
      onlyFacilitatorReveal: Boolean(data?.onlyFacilitatorReveal),
      facilitatorId: cleanText(data?.playerId, 64),
      revealed: false,
      players: new Map(),
      issues: [],
      currentIssueId: null,
      emptySince: Date.now(),
    });
    reply(ack, { roomId: id });
  });

  socket.on('join', (data, ack) => {
    const room = rooms.get(cleanText(data?.roomId, 16).toUpperCase());
    if (!room) return reply(ack, { error: 'Sala não encontrada. Ela pode ter expirado.' });

    const playerId = cleanText(data?.playerId, 64);
    const name = cleanText(data?.name, 30);
    if (!playerId || !name) return reply(ack, { error: 'Informe seu nome.' });

    let player = room.players.get(playerId);
    if (!player) {
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) return reply(ack, { error: 'Sala cheia.' });
      player = { id: playerId, name, spectator: Boolean(data?.spectator), vote: null, sockets: new Set(), removeTimer: null };
      room.players.set(playerId, player);
    } else {
      player.name = name;
      if (typeof data?.spectator === 'boolean') player.spectator = data.spectator;
    }

    clearTimeout(player.removeTimer);
    player.removeTimer = null;
    player.sockets.add(socket.id);
    room.emptySince = null;

    socket.data.roomId = room.id;
    socket.data.playerId = playerId;
    socket.join(room.id);

    reply(ack, { ok: true });
    broadcast(room);
  });

  socket.on('vote', (data) => {
    const ctx = context();
    if (!ctx || ctx.room.revealed || ctx.player.spectator) return;
    const card = data?.card;
    if (card === null) ctx.player.vote = null;
    else if (ctx.room.deck.cards.includes(card)) ctx.player.vote = card;
    else return;
    broadcast(ctx.room);
  });

  socket.on('reveal', () => {
    const ctx = context();
    if (!ctx || ctx.room.revealed || !canControl(ctx.room, ctx.player.id)) return;
    const { room } = ctx;
    room.revealed = true;
    const summary = summarize(room);
    const issue = room.issues.find((i) => i.id === room.currentIssueId);
    if (issue && summary.totalVotes > 0) issue.estimate = suggestedEstimate(room, summary);
    broadcast(room);
  });

  socket.on('reset', () => {
    const ctx = context();
    if (!ctx || !canControl(ctx.room, ctx.player.id)) return;
    resetVotes(ctx.room);
    broadcast(ctx.room);
  });

  socket.on('set-spectator', (data) => {
    const ctx = context();
    if (!ctx) return;
    ctx.player.spectator = Boolean(data?.spectator);
    if (ctx.player.spectator) ctx.player.vote = null;
    broadcast(ctx.room);
  });

  socket.on('add-issue', (data) => {
    const ctx = context();
    if (!ctx) return;
    const title = cleanText(data?.title, 200);
    if (!title || ctx.room.issues.length >= MAX_ISSUES_PER_ROOM) return;
    ctx.room.issues.push({ id: newId(8), title, estimate: null });
    broadcast(ctx.room);
  });

  socket.on('remove-issue', (data) => {
    const ctx = context();
    if (!ctx || !canControl(ctx.room, ctx.player.id)) return;
    const { room } = ctx;
    room.issues = room.issues.filter((i) => i.id !== data?.issueId);
    if (room.currentIssueId === data?.issueId) room.currentIssueId = null;
    broadcast(room);
  });

  socket.on('select-issue', (data) => {
    const ctx = context();
    if (!ctx || !canControl(ctx.room, ctx.player.id)) return;
    const { room } = ctx;
    const issueId = data?.issueId ?? null;
    if (issueId !== null && !room.issues.some((i) => i.id === issueId)) return;
    room.currentIssueId = issueId;
    resetVotes(room);
    broadcast(room);
  });

  socket.on('set-estimate', (data) => {
    const ctx = context();
    if (!ctx || !canControl(ctx.room, ctx.player.id)) return;
    const issue = ctx.room.issues.find((i) => i.id === data?.issueId);
    if (!issue) return;
    const estimate = data?.estimate;
    if (estimate !== null && !ctx.room.deck.cards.includes(estimate)) return;
    issue.estimate = estimate;
    broadcast(ctx.room);
  });

  socket.on('disconnect', () => {
    const ctx = context();
    if (!ctx) return;
    const { room, player } = ctx;
    player.sockets.delete(socket.id);

    if (player.sockets.size === 0) {
      player.removeTimer = setTimeout(() => {
        if (player.sockets.size > 0) return;
        room.players.delete(player.id);
        broadcast(room);
      }, PLAYER_GRACE_SECONDS * 1000);
    }
    if (onlineCount(room) === 0) room.emptySince = Date.now();
    broadcast(room);
  });
});

// Limpeza: apaga salas vazias há mais de ROOM_TTL_MINUTES.
setInterval(() => {
  const limit = Date.now() - ROOM_TTL_MINUTES * 60 * 1000;
  for (const [id, room] of rooms) {
    if (room.emptySince !== null && room.emptySince < limit) {
      for (const p of room.players.values()) clearTimeout(p.removeTimer);
      rooms.delete(id);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Planning poker rodando em http://localhost:${PORT}`);
  console.log(`Salas vazias expiram em ${ROOM_TTL_MINUTES} min.`);
});
