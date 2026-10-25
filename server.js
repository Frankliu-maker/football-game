/**
 * 足球小游戏后端服务器（零依赖，Node.js 原生实现）
 * 功能：
 *   1. 托管前端静态页面（public 目录）
 *   2. REST API 记录 / 查询比赛比分（存储在 data/matches.json）
 *
 * 启动：node server.js   （默认端口 3000）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'matches.json');

// ---------- 数据存储 ----------
function loadMatches() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return []; // 文件不存在或损坏时返回空数组
  }
}

function saveMatches(matches) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(matches, null, 2), 'utf-8');
}

// ---------- 工具函数 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  // 防目录穿越攻击
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- API 路由 ----------
async function handleApi(req, res, urlPath) {
  // 查询所有比赛记录
  if (req.method === 'GET' && urlPath === '/api/matches') {
    return sendJson(res, 200, { matches: loadMatches() });
  }

  // 保存一条比赛结果
  if (req.method === 'POST' && urlPath === '/api/matches') {
    try {
      const body = await readBody(req);
      const blue = Number(body.blue);
      const red = Number(body.red);
      if (!Number.isInteger(blue) || !Number.isInteger(red) || blue < 0 || red < 0) {
        return sendJson(res, 400, { error: '比分必须是大于等于 0 的整数' });
      }
      const matches = loadMatches();
      const match = {
        id: Date.now(),
        blue,
        red,
        duration: Number(body.duration) || 0, // 比赛时长（秒）
        time: new Date().toISOString(),
      };
      matches.unshift(match);
      // 最多保留 100 条，防止文件无限增长
      if (matches.length > 100) matches.length = 100;
      saveMatches(matches);
      return sendJson(res, 201, { ok: true, match });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 简单统计数据（总场次、胜负平）
  if (req.method === 'GET' && urlPath === '/api/stats') {
    const matches = loadMatches();
    const stats = {
      total: matches.length,
      blueWins: matches.filter((m) => m.blue > m.red).length,
      redWins: matches.filter((m) => m.red > m.blue).length,
      draws: matches.filter((m) => m.blue === m.red).length,
      totalGoals: matches.reduce((s, m) => s + m.blue + m.red, 0),
    };
    return sendJson(res, 200, stats);
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

// ---------- 服务器入口 ----------
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath).catch(() => sendJson(res, 500, { error: '服务器内部错误' }));
  } else {
    serveStatic(req, res, urlPath);
  }
});

server.listen(PORT, () => {
  console.log(`⚽ 足球小游戏已启动: http://localhost:${PORT}`);
  console.log(`   API: GET/POST /api/matches  |  GET /api/stats`);
});
