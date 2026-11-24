const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { VirtualOfficeOrchestrator } = require('./engine/orchestrator');
const { ROOT_DIR, DELIVERABLES_DIR, ensureDirs, readAppDeliverable } = require('./engine/storage');

ensureDirs();

const PORT = Number(process.env.SERVER_PORT || process.env.PORT) || 3000;
const HOST = process.env.HOST || process.env.IP || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const orchestrator = new VirtualOfficeOrchestrator();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function serveStaticFile(res, baseDir, reqPath) {
  const safeRel = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(baseDir, safeRel);
  if (!fullPath.startsWith(baseDir) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(fullPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Healthcheck for free 24/7 cloud hosts (Render, Koyeb, Railway, Fly)
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, autopilot: orchestrator.state.autopilotEnabled, cycle: orchestrator.state.cycleCount });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, orchestrator.getPublicState());
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const unsubscribe = orchestrator.subscribe(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  if (pathname === '/api/tick' && req.method === 'POST') {
    await orchestrator.runTick(true);
    return sendJson(res, 200, { ok: true, state: orchestrator.getPublicState() });
  }

  if (pathname === '/api/autopilot' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    orchestrator.toggleAutopilot(body.enabled);
    return sendJson(res, 200, { ok: true, autopilotEnabled: orchestrator.state.autopilotEnabled });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    orchestrator.updateSettings(body);
    return sendJson(res, 200, { ok: true, state: orchestrator.getPublicState() });
  }

  if (pathname === '/api/directive' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body.title) return sendJson(res, 400, { error: 'Title is required' });
    orchestrator.enqueueDirective(body);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/hr/hire' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body.name) return sendJson(res, 400, { error: 'Employee name is required' });
    const agent = orchestrator.hireCustomEmployee(body);
    return sendJson(res, 200, { ok: true, agent });
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body.message) return sendJson(res, 400, { error: 'Message is required' });
    const result = await orchestrator.chatWithAgent(body.agentId || 'ceo', body.message);
    return sendJson(res, 200, { ok: true, reply: result.reply, agentName: result.agent.name });
  }

  if (pathname === '/api/backup' && req.method === 'GET') {
    const backup = orchestrator.exportFullBackup();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="virtual-office-backup.json"',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(backup, null, 2));
    return;
  }

  if (pathname === '/api/restore' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: 'Invalid backup JSON' });
    try {
      orchestrator.restoreBackup(body);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  const appSourceMatch = pathname.match(/^\/api\/deliverables\/app\/([^/]+)\/source$/);
  if (appSourceMatch && req.method === 'GET') {
    const id = appSourceMatch[1].replace(/[^a-zA-Z0-9_-]/g, '');
    const html = readAppDeliverable(id);
    if (!html) return sendJson(res, 404, { error: 'App not found' });
    return sendJson(res, 200, { id, html });
  }

  if (pathname.startsWith('/deliverables/')) {
    const rel = pathname.slice('/deliverables/'.length);
    return serveStaticFile(res, DELIVERABLES_DIR, rel);
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveStaticFile(res, PUBLIC_DIR, 'index.html');
  }

  return serveStaticFile(res, PUBLIC_DIR, pathname.slice(1));
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 AI Virtual Office listening at http://${HOST}:${PORT}`);
  orchestrator.start();
});
