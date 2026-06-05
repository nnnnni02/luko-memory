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

const mcpServer = new McpServer({
  name: 'luko-memory',
  version: '1.0.0',
});

mcpServer.tool(
  'write_memory',
  '寫入一條記憶',
  {
    content: z.string().describe('記憶內容'),
    category: z.enum(['core', 'daily', 'diary']).default('daily').describe('分類：core=核心設定, daily=日常, diary=日記'),
    tags: z.string().default('').describe('標籤，用逗號分隔'),
  },
  async ({ content, category, tags }) => {
    const stmt = db.prepare('INSERT INTO memories (content, category, tags) VALUES (?, ?, ?)');
    const result = stmt.run(content, category, tags);
    return { content: [{ type: 'text', text: `已寫入記憶 #${result.lastInsertRowid}` }] };
  }
);

mcpServer.tool(
  'read_memories',
  '讀取記憶',
  {
    category: z.enum(['core', 'daily', 'diary', 'all']).default('all').describe('讀取哪個分類'),
    limit: z.number().default(20).describe('最多讀幾條'),
  },
  async ({ category, limit }) => {
    let rows;
    if (category === 'all') {
      rows = db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit);
    } else {
      rows = db.prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT ?').all(category, limit);
    }
    const text = rows.length === 0 ? '沒有記憶' : rows.map(r => `[#${r.id} ${r.category} ${r.created_at}]\n${r.content}${r.tags ? `\n標籤: ${r.tags}` : ''}`).join('\n\n---\n\n');
    return { content: [{ type: 'text', text }] };
  }
);

mcpServer.tool(
  'search_memory',
  '搜尋記憶',
  {
    keyword: z.string().describe('搜尋關鍵字'),
  },
  async ({ keyword }) => {
    const rows = db.prepare("SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 10").all(`%${keyword}%`, `%${keyword}%`);
    const text = rows.length === 0 ? '找不到相關記憶' : rows.map(r => `[#${r.id} ${r.category} ${r.created_at}]\n${r.content}`).join('\n\n---\n\n');
    return { content: [{ type: 'text', text }] };
  }
);

mcpServer.tool(
  'update_memory',
  '更新一條記憶',
  {
    id: z.number().describe('記憶ID'),
    content: z.string().describe('新內容'),
  },
  async ({ id, content }) => {
    const stmt = db.prepare("UPDATE memories SET content = ?, updated_at = datetime('now', 'localtime') WHERE id = ?");
    const result = stmt.run(content, id);
    if (result.changes === 0) return { content: [{ type: 'text', text: `找不到 #${id}` }] };
    return { content: [{ type: 'text', text: `已更新 #${id}` }] };
  }
);

mcpServer.tool(
  'delete_memory',
  '刪除一條記憶',
  {
    id: z.number().describe('記憶ID'),
  },
  async ({ id }) => {
    const stmt = db.prepare('DELETE FROM memories WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes === 0) return { content: [{ type: 'text', text: `找不到 #${id}` }] };
    return { content: [{ type: 'text', text: `已刪除 #${id}` }] };
  }
);

mcpServer.tool(
  'memory_stats',
  '查看記憶統計',
  {},
  async () => {
    const total = db.prepare('SELECT COUNT(*) as n FROM memories').get().n;
    const byCategory = db.prepare("SELECT category, COUNT(*) as n FROM memories GROUP BY category").all();
    const stats = byCategory.map(r => `${r.category}: ${r.n} 條`).join('\n');
    return { content: [{ type: 'text', text: `總計 ${total} 條記憶\n${stats}` }] };
  }
);

const transports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await mcpServer.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).json({ error: 'Session not found' });
  await transport.handlePostMessage(req, res, req.body);
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'luko-memory MCP server' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`luko-memory running on port ${PORT}`));
