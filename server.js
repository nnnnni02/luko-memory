import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'memory.db');

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'daily',
    tags TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/memories', (req, res) => {
  const { category = 'all', limit = 50 } = req.query;
  let rows;
  if (category === 'all') {
    rows = db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(Number(limit));
  } else {
    rows = db.prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT ?').all(category, Number(limit));
  }
  res.json(rows);
});

app.post('/api/memories', (req, res) => {
  const { content, category = 'daily', tags = '' } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const result = db.prepare('INSERT INTO memories (content, category, tags) VALUES (?, ?, ?)').run(content, category, tags);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/memories/:id', (req, res) => {
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(Number(req.params.id));
  res.json({ deleted: result.changes });
});

app.put('/api/memories/:id', (req, res) => {
  const { content } = req.body;
  const result = db.prepare("UPDATE memories SET content = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(content, Number(req.params.id));
  res.json({ updated: result.changes });
});

const mcpServer = new McpServer({ name: 'luko-memory', version: '1.0.0' });

mcpServer.tool('write_memory', '寫入一條記憶', {
  content: z.string(),
  category: z.enum(['core', 'daily', 'diary']).default('daily'),
  tags: z.string().default(''),
}, async ({ content, category, tags }) => {
  const result = db.prepare('INSERT INTO memories (content, category, tags) VALUES (?, ?, ?)').run(content, category, tags);
  return { content: [{ type: 'text', text: `已寫入記憶 #${result.lastInsertRowid}` }] };
});

mcpServer.tool('read_memories', '讀取記憶', {
  category: z.enum(['core', 'daily', 'diary', 'all']).default('all'),
  limit: z.number().default(20),
}, async ({ category, limit }) => {
  const rows = category === 'all'
    ? db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT ?').all(category, limit);
  const text = rows.length === 0 ? '沒有記憶' : rows.map(r => `[#${r.id} ${r.category} ${r.created_at}]\n${r.content}${r.tags ? `\n標籤: ${r.tags}` : ''}`).join('\n\n---\n\n');
  return { content: [{ type: 'text', text }] };
});

mcpServer.tool('search_memory', '搜尋記憶', {
  keyword: z.string(),
}, async ({ keyword }) => {
  const rows = db.prepare("SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 10").all(`%${keyword}%`, `%${keyword}%`);
  const text = rows.length === 0 ? '找不到' : rows.map(r => `[#${r.id} ${r.category} ${r.created_at}]\n${r.content}`).join('\n\n---\n\n');
  return { content: [{ type: 'text', text }] };
});

mcpServer.tool('update_memory', '更新一條記憶', {
  id: z.number(),
  content: z.string(),
}, async ({ id, content }) => {
  const result = db.prepare("UPDATE memories SET content = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(content, id);
  return { content: [{ type: 'text', text: result.changes ? `已更新 #${id}` : `找不到 #${id}` }] };
});

mcpServer.tool('delete_memory', '刪除一條記憶', {
  id: z.number(),
}, async ({ id }) => {
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return { content: [{ type: 'text', text: result.changes ? `已刪除 #${id}` : `找不到 #${id}` }] };
});

mcpServer.tool('memory_stats', '查看記憶統計', {}, async () => {
  const total = db.prepare('SELECT COUNT(*) as n FROM memories').get().n;
  const byCategory = db.prepare("SELECT category, COUNT(*) as n FROM memories GROUP BY category").all();
  return { content: [{ type: 'text', text: `總計 ${total} 條\n` + byCategory.map(r => `${r.category}: ${r.n}`).join('\n') }] };
});

const transports = {};
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await mcpServer.connect(transport);
});

app.post('/messages', async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) return res.status(400).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res, req.body);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`luko-memory running on port ${PORT}`));
