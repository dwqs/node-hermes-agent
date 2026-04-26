import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs/promises'

export async function initDB() {
  const db = new Database(process.env.DB_PATH, { verbose: console.log })
  // WAL 模式：读不阻塞写，多进程场景更安全；对单用户 CLI 也没坏处
  db.pragma('journal_mode = WAL');
  const sql = await fs.readFile('./state-db.sql', 'utf8')
  db.exec(sql)
  return db
}

export function createSession(db, source='cli') {
  const sessionId = uuidv4()
  db.prepare(`
    INSERT INTO sessions (id, source, model, started_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, source, process.env.AI_MODEL_NAME, Date.now())
  return sessionId
}

export function searchSessions(db, query) {
  // FTS5 通配符只能在词尾: '日期*' 匹配以 "日期" 开头的词
  // 注意: 中文分词后每个词单独索引，所以需要拆词查询
  const searchPattern = `${query}*`

  const rows = db.prepare(`
    SELECT m.session_id, m.content
    FROM messages_fts f
    JOIN messages m ON f.rowid = m.id
    WHERE f.content MATCH ?
    LIMIT 10
  `).all(searchPattern)

  return rows.map(row => ({
    session_id: row.session_id,
    snippet: row.content.slice(0, 200)
  }))
}

export function getSessionMessages(db, sessionId) {
  const rows = db.prepare(`
    SELECT role, content, tool_calls, tool_call_id
    FROM messages
    WHERE session_id = ?
    ORDER BY id
  `).all(sessionId)

  const messages = []
  for (const row of rows) {
    const msg = {
      role: row.role,
      content: row.content || ''
    }
    if (row.tool_calls) {
      msg.tool_calls = JSON.parse(row.tool_calls)
    }
    if (row.tool_call_id) {
      msg.tool_call_id = row.tool_call_id
    }
    messages.push(msg)
  }
  return messages
}

export function addMessage(db, sessionId, msg) {
  let toolCallsJson = null
  if (msg.tool_calls) {
    toolCallsJson = JSON.stringify(msg.tool_calls)
  }

  db.prepare(`
    INSERT INTO messages
      (session_id, role, content, tool_calls, tool_call_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, msg.role, msg.content || '', toolCallsJson, msg.tool_call_id || null, Date.now())
}