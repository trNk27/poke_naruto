// Serves the web client and relays player positions between players in the
// same room. Rooms exist only while someone is in them; nothing is stored.
//
//   PORT=8080 node server.js

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const MAX_PLAYERS_PER_ROOM = 5; // the ROM shows up to 4 remote players
const MAX_MESSAGE_BYTES = 16 * 1024;
const PING_INTERVAL_MS = 15000;
const PROTOCOL_VERSION = 1;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.bps': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// The emulator uses threads (SharedArrayBuffer), which browsers only allow on
// cross-origin isolated pages.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.resolve(WEB_ROOT, '.' + pathname);
  if (!filePath.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      ...ISOLATION_HEADERS,
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, ISOLATION_HEADERS).end('Not found');
  }
}

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  serveStatic(req, res);
});

/** @type {Map<string, Map<number, import('ws').WebSocket>>} */
const rooms = new Map();
let nextPlayerId = 1;

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room, message, exceptId) {
  const data = JSON.stringify(message);
  for (const [id, peer] of room) {
    if (id !== exceptId && peer.readyState === peer.OPEN) peer.send(data);
  }
}

function sanitizeRoomCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function sanitizeName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Trainer';
}

// Only relay the fields the client understands, as small integers.
function sanitizeState(s) {
  if (typeof s !== 'object' || s === null) return null;
  const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : 0);
  return {
    active: s.active ? 1 : 0,
    mapGroup: int(s.mapGroup, 0, 255),
    mapNum: int(s.mapNum, 0, 255),
    facing: int(s.facing, 0, 4),
    x: int(s.x, -32768, 32767),
    y: int(s.y, -32768, 32767),
    elevation: int(s.elevation, 0, 15),
    avatarFlags: int(s.avatarFlags, 0, 255),
    gender: int(s.gender, 0, 1),
    link: int(s.link, 0, 2),
    name: Array.isArray(s.name) ? s.name.slice(0, 8).map((b) => int(b, 0, 255)) : [],
  };
}

const MAX_LINK_PACKETS = 64;
const LINK_PACKET_WORDS = 16;

function sanitizePackets(p) {
  if (!Array.isArray(p) || p.length === 0 || p.length > MAX_LINK_PACKETS) return null;
  for (const packet of p) {
    if (!Array.isArray(packet) || packet.length !== LINK_PACKET_WORDS) return null;
    if (!packet.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)) return null;
  }
  return p;
}

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  let roomCode = null;
  let playerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'join' && playerId === null) {
      if (msg.v !== PROTOCOL_VERSION) {
        send(ws, { t: 'error', reason: 'version', message: 'Please reload the page to get the latest version.' });
        ws.close();
        return;
      }
      const code = sanitizeRoomCode(msg.room);
      if (!code) {
        send(ws, { t: 'error', reason: 'room', message: 'Invalid room code.' });
        ws.close();
        return;
      }
      const room = rooms.get(code) ?? new Map();
      if (room.size >= MAX_PLAYERS_PER_ROOM) {
        send(ws, { t: 'error', reason: 'full', message: `Room is full (max ${MAX_PLAYERS_PER_ROOM} players).` });
        ws.close();
        return;
      }
      roomCode = code;
      playerId = nextPlayerId++;
      ws.playerName = sanitizeName(msg.name);
      ws.lastState = null;
      rooms.set(code, room);

      send(ws, {
        t: 'welcome',
        id: playerId,
        room: code,
        peers: [...room].map(([id, peer]) => ({ id, name: peer.playerName, s: peer.lastState })),
      });
      room.set(playerId, ws);
      broadcast(room, { t: 'join', id: playerId, name: ws.playerName }, playerId);
      return;
    }

    // Virtual link cable traffic goes only to the linked partner.
    if (msg.t === 'link' && playerId !== null) {
      const partner = rooms.get(roomCode)?.get(msg.to);
      const packets = sanitizePackets(msg.p);
      if (!partner || !packets) return;
      send(partner, { t: 'link', from: playerId, p: packets, g: Number.isInteger(msg.g) ? msg.g : 0 });
      return;
    }

    if (msg.t === 'state' && playerId !== null) {
      const state = sanitizeState(msg.s);
      if (!state) return;
      ws.lastState = state;
      broadcast(rooms.get(roomCode), { t: 'state', id: playerId, s: state }, playerId);
    }
  });

  ws.on('close', () => {
    if (playerId === null) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.delete(playerId);
    if (room.size === 0) rooms.delete(roomCode);
    else broadcast(room, { t: 'leave', id: playerId });
  });
});

const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);
wss.on('close', () => clearInterval(pingTimer));

httpServer.listen(PORT, () => {
  console.log(`Serving ${WEB_ROOT} on http://localhost:${PORT} (WebSocket at /ws)`);
});
