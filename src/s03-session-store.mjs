import { tool } from '@langchain/core/tools'
import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { execSync } from 'child_process'
import readline from 'readline/promises'
import chalk from 'chalk'
import fs from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'

import { model, MAX_ITERATIONS, ENABLED_TOOLSETS, BLOCKED_COMMANDS, TOOL_TIMEOUT } from './common.mjs'

class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  registerTool(tool) {
    this.tools.set(tool.name, tool)
  }

  async dispatch(name, args) {
    const tool = this.tools.get(name)
    if (!tool) {
      return JSON.stringify({ error: `Tool not found: ${name}` })
    }
    return await tool.invoke(args)
  }

  getDefinitions(enabledToolsets = []) {
    const definitions = []
    for (const [name, tool] of this.tools.entries()) {
      const item = enabledToolsets.find(t => name.includes(t))
      if (item) {
        definitions.push(tool)
      }
    }
    return definitions
  }
}

const shellTool = tool(
  ({ command }) => {
    for (const blocked of BLOCKED_COMMANDS) {
      if (command.includes(blocked)) {
        return JSON.stringify({ error: `Blocked: ${blocked}` })
      }
    }
    try {
      const output = execSync(command, { encoding: 'utf-8', timeout: TOOL_TIMEOUT })
      return output.slice(0, 1000) || '(no output)'
    } catch (err) {
      if (err.killed) {
        return '(command timed out after 30s)'
      }
      const output = (err.stdout || '') + (err.stderr || '')
      return output.slice(0, 1000) || `(error: ${err.message})`
    }
  },
  {
    name: 'terminal',
    description: '执行 shell 命令并返回输出结果',
    schema: z.object({ command: z.string().describe('执行 shell 命令并返回输出结果') })
  }
)

const readFileTool = tool(
  async ({ filePath }) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return `文件内容:\n${content}`;
    } catch (error) {
      console.log(`  [工具调用] read_file("${filePath}") - 错误: ${error.message}`);
      return `读取文件失败: ${error.message}`;
    }
  },
  {
    name: 'read_file',
    description: '用此工具来读取文件内容。当用户要求读取文件、查看代码、分析文件内容时，调用此工具。输入文件路径（可以是相对路径或绝对路径）。',
    schema: z.object({
      filePath: z.string().describe('要读取的文件路径'),
    }),
  }
)

const writeFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return `文件写入成功: ${filePath}`;
    } catch (error) {
      return `写入文件失败: ${error.message}`;
    }
  },
  {
    name: 'write_file',
    description: '向指定路径写入文件内容，自动创建目录',
    schema: z.object({
      filePath: z.string().describe('文件路径'),
      content: z.string().describe('要写入的文件内容'),
    }),
  }
)

const toolRegistry = new ToolRegistry()
toolRegistry.registerTool(shellTool)
toolRegistry.registerTool(readFileTool)
toolRegistry.registerTool(writeFileTool)

const tools = toolRegistry.getDefinitions(ENABLED_TOOLSETS)
const modelWithTools = model.bindTools(tools)

const systemMessage = new SystemMessage('你是一个能执行终端命令/读写文件/网络搜索的 AI 助手，会话信息都存储在 SQLite 数据库中')

async function initDB() {
  const db = new Database(process.env.DB_PATH, { verbose: console.log })
  // WAL 模式：读不阻塞写，多进程场景更安全；对单用户 CLI 也没坏处
  db.pragma('journal_mode = WAL');
  const sql = await fs.readFile('./state-db.sql', 'utf8')
  db.exec(sql)
  return db
}

function createSession(db, source='cli') {
  const sessionId = uuidv4()
  db.prepare(`
    INSERT INTO sessions (id, source, model, started_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, source, process.env.AI_MODEL_NAME, Date.now())
  return sessionId
}

function searchSessions(db, query) {
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

function getSessionMessages(db, sessionId) {
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

function addMessage(db, sessionId, msg) {
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

async function runConversation(input, db, sessionId) {
  const messages = getSessionMessages(db, sessionId)
  const humanMsg = new HumanMessage(input)
  messages.push(humanMsg)
  addMessage(db, sessionId, { role: humanMsg.type, content: humanMsg.content })

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const roundLabel = `第 ${i + 1} 轮`
    console.log(chalk.yellow(`⏳ ${roundLabel} - 正在等待 AI 思考...`));

    const response = await modelWithTools.invoke([systemMessage, ...messages]);
    // response 是 AIMessage 类型
    messages.push(response);

    let toolCalls = null
    if (response.tool_calls && response.tool_calls.length > 0) {
      toolCalls = response.tool_calls.map(item => ({
        id: item.id,
        name: item.name,
        args: item.args
      }))
    }
    addMessage(db, sessionId, { tool_calls: toolCalls, role: response.type, content: response.content })

    if (!response.tool_calls || response.tool_calls.length === 0) {
      console.log(`\n✨ AI 回复:\n${response.content}\n`);
      return response.content;
    }

    console.log(chalk.bgBlue(`🔍 工具调用: ${response.tool_calls.map(t => t.name).join(', ')}`));
    for (const toolCall of response.tool_calls) {
      console.log(chalk.green(`🔍 工具调用: ${toolCall.name} - 参数: ${JSON.stringify(toolCall.args)}`));
      const toolResult = await toolRegistry.dispatch(toolCall.name, toolCall.args);
      const toolMsg = new ToolMessage({ content: toolResult, tool_call_id: toolCall.id, name: toolCall.name });
      messages.push(toolMsg);
      addMessage(db, sessionId, { role: toolMsg.type, content: toolResult, tool_call_id: toolCall.id  });
    }
  }

  console.log(chalk.red('⚠️  达到最大迭代次数'));
  return messages[messages.length - 1].content;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const db = await initDB()
  const sessionId = createSession(db)
  
  console.log('=== s03: Session Store ===')
  console.log(`模型名称: ${process.env.AI_MODEL_NAME}`, `数据库路径: ${process.env.DB_PATH}`)
  console.log(`会话ID: ${sessionId}`)
  console.log("输入exit退出\n")

  while (true) {
    const input = await rl.question('You: ')
    const str = input.trim()
    
    if (!str || str === 'exit') {
      break
    }

    if(str.startsWith('/search'))  {
      const results = searchSessions(db, str.slice(8))
      console.log('results', results, '\n')
      continue
    }
    await runConversation(input.trim(), db, sessionId)
  }
  db.close()
  rl.close()
}

main()