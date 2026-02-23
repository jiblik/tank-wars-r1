const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4000;

// Simple static file server with gzip + caching
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};

// Pre-cache gzipped files in memory
const fileCache = new Map();

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(__dirname, 'public', filePath);

  // Serve from cache if available
  if (fileCache.has(filePath)) {
    const cached = fileCache.get(filePath);
    const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    if (acceptGzip && cached.gzip) {
      res.writeHead(200, { 'Content-Type': cached.type, 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });
      res.end(cached.gzip);
    } else {
      res.writeHead(200, { 'Content-Type': cached.type, 'Cache-Control': 'no-cache' });
      res.end(cached.raw);
    }
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    // Cache and gzip text files
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      zlib.gzip(data, (gzErr, gzData) => {
        fileCache.set(filePath, { raw: data, gzip: gzErr ? null : gzData, type: contentType });
        const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
        if (acceptGzip && !gzErr) {
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });
          res.end(gzData);
        } else {
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
          res.end(data);
        }
      });
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });

});

// Clear cache when files change (single watcher, outside request handler)
try {
  fs.watch(path.join(__dirname, 'public'), { recursive: true }, () => { fileCache.clear(); });
} catch (e) { /* fs.watch not supported on all platforms */ }

// WebSocket server
const wss = new WebSocketServer({ server });

// Room management
const rooms = new Map(); // code -> { host: ws, guest: ws, mode: string }

function generateCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

wss.on('connection', (ws) => {
  let myRoom = null;
  let myRole = null; // 'host' or 'guest'

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const code = generateCode();
        rooms.set(code, { host: ws, guest: null, mode: msg.mode || 'coop' });
        myRoom = code;
        myRole = 'host';
        ws.send(JSON.stringify({ type: 'room_created', code }));
        console.log(`Room ${code} created (${msg.mode || 'coop'})`);
        break;
      }

      case 'join_room': {
        const room = rooms.get(msg.code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'join_error', message: 'ROOM NOT FOUND' }));
          return;
        }
        if (room.guest) {
          ws.send(JSON.stringify({ type: 'join_error', message: 'ROOM FULL' }));
          return;
        }
        room.guest = ws;
        myRoom = msg.code;
        myRole = 'guest';
        // Notify both (pass mode to guest)
        room.host.send(JSON.stringify({ type: 'player_joined' }));
        ws.send(JSON.stringify({ type: 'join_ok', mode: room.mode }));
        console.log(`Player joined room ${msg.code}`);
        break;
      }

      case 'input': {
        // Forward P2 input to host
        if (myRoom && myRole === 'guest') {
          const room = rooms.get(myRoom);
          if (room && room.host && room.host.readyState === 1) {
            room.host.send(JSON.stringify(msg));
          }
        }
        break;
      }

      case 'state':
      case 'game_over':
      case 'level_complete':
      case 'pvp_result':
      case 'restart': {
        // Forward host messages to guest
        if (myRoom && myRole === 'host') {
          const room = rooms.get(myRoom);
          if (room && room.guest && room.guest.readyState === 1) {
            room.guest.send(raw.toString());
          }
        }
        // Also allow guest to send restart request to host
        if (myRoom && myRole === 'guest' && msg.type === 'restart') {
          const room = rooms.get(myRoom);
          if (room && room.host && room.host.readyState === 1) {
            room.host.send(raw.toString());
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myRoom) {
      const room = rooms.get(myRoom);
      if (room) {
        // Notify the other player
        const other = myRole === 'host' ? room.guest : room.host;
        if (other && other.readyState === 1) {
          other.send(JSON.stringify({ type: 'game_over' }));
        }
        rooms.delete(myRoom);
        console.log(`Room ${myRoom} closed`);
      }
    }
  });
});

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

server.listen(PORT, () => {
  console.log(`TANK WARS R1 server running on http://localhost:${PORT}`);
  console.log(`Open this URL on your phone (use your computer's local IP for co-op)`);
});
