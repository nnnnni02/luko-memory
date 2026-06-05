import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/memories', async (req, res) => {
  try {
    const { category = 'all', limit = 50 } = req.query;
    const q = category === 'all'
      ? await pool.query('SELECT * FROM memories ORDER BY updated_at DESC LIMIT $1', [Number(limit)])
      : await pool.query('SELECT * FROM memories WHERE category = $1 ORDER BY updated_at DESC LIMIT $2', [category, Number(limit)]);
    res.json(q.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/memories', async (req, res) => {
  try {
    const { content, category = 'daily', tags = '' } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const q = await pool.query('INSERT INTO memories (content, category, tags) VALUES ($1, $2, $3) RETURNING id', [content, category, tags]);
    res.json({ id: q.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/memories/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM memories WHERE id = $1', [Number(req.params.id)]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/memories/:id', async (req, res) => {
  try {
    const { content } = req.body;
    await pool.query('UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2', [content, Number(req.params.id)]);
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const mcpServer = new McpServer({ name: 'luko-memory', version: '1.0.0' });

mcpServer.tool('write_memory', '寫入一條記憶', {
  content: z.string(),
  category: z.enum(['core', 'daily', 'diary']).default('daily'),
  tags: z.string().default(''),
}, async ({ content, category, tags }) => {
  const q = await pool.query('INSERT INTO memories (content, category, tags) VALUES ($1, $2, $3) RETURNING id', [content, category, tags]);
  return { content: [{ type: 'text', text: `已寫入記憶 #${q.rows[0].id}` }] };
});

mcpServer.tool('read_memories', '讀取記憶', {
  category: z.enum(['core', 'daily', 'diary', 'all']).default('all'),
  limit: z.number().default(20),
}, async ({ category, limit }) => {
  const q = category === 'all'
    ? await pool.query('SELECT * FROM memories ORDER BY updated_at DESC LIMIT $1', [limit])
    : await pool.query('SELECT * FROM memories WHERE category = $1 ORDER BY updated_at DESC LIMIT $2', [category, limit]);
  const rows = q.rows;
  const text = rows.length === 0 ? '沒有記憶' : rows.map(r => `[#${r.id} ${r.category} ${new Date(r.created_at).toLocaleString('zh-TW')}]\n${r.content}${r.tags ? `\n標籤: ${r.tags}` : ''}`).join('\n\n---\n\n');
  return { content: [{ type: 'text', text }] };
});

mcpServer.tool('search_memory', '搜尋記憶', {
  keyword: z.string(),
}, async ({ keyword }) => {
  const q = await pool.query("SELECT * FROM memories WHERE content ILIKE $1 OR tags ILIKE $1 ORDER BY updated_at DESC LIMIT 10", [`%${keyword}%`]);
  const text = q.rows.length === 0 ? '找不到' : q.rows.map(r => `[#${r.id} ${r.category}]\n${r.content}`).join('\n\n---\n\n');
  return { content: [{ type: 'text', text }] };
});

mcpServer.tool('update_memory', '更新一條記憶', {
  id: z.number(),
  content: z.string(),
}, async ({ id, content }) => {
  await pool.query('UPDATE memories SET content = $1, updated_at = NOW() WHERE id = $2', [content, id]);
  return { content: [{ type: 'text', text: `已更新 #${id}` }] };
});

mcpServer.tool('delete_memory', '刪除一條記憶', {
  id: z.number(),
}, async ({ id }) => {
  await pool.query('DELETE FROM memories WHERE id = $1', [id]);
  return { content: [{ type: 'text', text: `已刪除 #${id}` }] };
});

mcpServer.tool('memory_stats', '查看記憶統計', {}, async () => {
  const total = await pool.query('SELECT COUNT(*) as n FROM memories');
  const byCategory = await pool.query("SELECT category, COUNT(*) as n FROM memories GROUP BY category");
  return { content: [{ type: 'text', text: `總計 ${total.rows[0].n} 條\n` + byCategory.rows.map(r => `${r.category}: ${r.n}`).join('\n') }] };
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
app.listen(PORT, async () => {
  console.log(`luko-memory running on port ${PORT}`);
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'daily',
        tags TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
});
