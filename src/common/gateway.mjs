import readline from 'node:readline/promises'
import crypto from 'node:crypto'
import chalk from 'chalk'

import { initDB, getSessionMessages } from './persistent.mjs'
import { buildSystemPrompt } from './system-prompt-builder.mjs'
import runConversation from './runConversation.mjs'

const MessageType = {
  TEXT: 'text',
  IMAGE: 'image',
  AUDIO: 'audio',
  DOCUMENT: 'document',
}

class SessionSource {
  constructor(platform, chatId, userId, userName, chatType) {
    this.platform = platform
    this.chatId = chatId
    this.sender = userId 
    this.senderName = userName
    this.chatType = chatType // dm: 私聊 group: 群聊
  }

  toJSON() {
    return {
      platform: this.platform,
      chatId: this.chatId,
      sender: this.sender,
      senderName: this.senderName,
      chatType: this.chatType,
    }
  }
}

// 所有平台来的消息都翻译成 MessageEvent，下游代码只看这个结构
class MessageEvent {
  constructor(msgId, text, source, msgType, mediaUrls) {
    this.msgId = msgId
    this.text = text
    this.source = source // SessionSource
    this.msgType = msgType
    this.mediaUrls = mediaUrls
  }

  toJSON() {
    return {
      msgId: this.msgId,
      text: this.text,
      source: this.source.toJSON(),
      msgType: this.msgType,
      mediaUrls: this.mediaUrls,
    }
  }
}

function buildSessionKey(source, agentName = 'main') {
  const { platform, chatId, chatType } = source.toJSON()
  /**
   * 格式: agent:{name}:{platform}:{chat_type}:{chat_id}[:user_id]
   * 群聊按 user_id 隔离 → 同一群里的张三和李四各自有独立对话。
   */
  const key = [`agent:${agentName}:${platform}:${chatType}:${chatId}`]
  if(chatType === 'group') {
    key.push(`${source.sender}`)
  }
  return key.join(`:`)
}

/**
 * 平台适配器基类
 * 所有平台适配器必须实现的契约
 *
 * 子类需实现：
 *   - connect()      开始接收消息
 *   - disconnect()   停止
 *   - send()         把回复发回平台
 */
class BasePlatformAdapter {
  constructor(platformName) {
    if (new.target === BasePlatformAdapter) {
      throw new Error('BasePlatformAdapter 是抽象类，不能直接实例化')
    }
    this.platformName = platformName
    this._onMessage = null  // 由 GatewayRunner 注入
    this._running = false
  }

  /**
   * 开始接收消息
   * @returns {Promise<boolean>} 连接成功返回 true
   */
  async connect() {
    throw new Error('子类必须实现 connect()')
  }

  /**
   * 停止接收消息并清理资源
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('子类必须实现 disconnect()')
  }

  /**
   * 将回复发送到指定对话
   * @param {string} chatId - 对话 ID
   * @param {string} content - 回复内容
   * @returns {Promise<boolean>} 发送成功返回 true
   */
  async send(chatId, content) {
    throw new Error('子类必须实现 send()')
  }

  /**
   * 将翻译后的事件转发给 GatewayRunner 回调
   * @param {MessageEvent} event - 消息事件
   */
  async handleMessage(event) {
    if (this._onMessage) {
      await this._onMessage(event)
    }
  }
}

/**
 * 终端适配器 — 用于测试的最小化适配器
 * 不连任何外部平台，直接从终端读输入。用来验证 Gateway 流程。
 * 每行输入都会变成一个来自 'console_user' 的 MessageEvent。
 */
export class ConsolePlatformAdapter extends BasePlatformAdapter {
  constructor() {
    super('console')
    this._rl = null
  }

  async connect() {
    this._running = true
    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    // 延迟启动读取循环，确保 connect() 先返回，[gateway] 连接日志先打印
    setImmediate(() => this._readLoop())
    return true
  }

  async disconnect() {
    this._running = false
    if(this._rl) {
      this._rl.close()
      this._rl = null
    }
    return true
  }

  async send(chatId, content) {
    // 使用 readline.write 输出，避免打断 prompt 显示
    const testMsg = chalk.green(`[${this.platformName}] chatId: ${chatId}`)
    if (this._rl) {
      this._rl.write(`\n${testMsg}\n\n`)
    }
    return true
  }

  async _readLoop() {
   if(!this._rl || !this._running) {
    return
   }

   const input = await this._rl.question('[console] You: ')
   const str = input.trim()
   if(!str) {
    this._readLoop()
    return
   }

   if(str === 'exit') {
    this._running = false
    this._rl.close()
    this._rl = null
    return
   }

   const event = new MessageEvent(
    crypto.randomUUID().slice(0, 8),
    str,
    new SessionSource('console', 'console_user', 'console_user', 'Console User', 'dm'),
    MessageType.TEXT,
    []
   )
   // 不 await，让 handleMessage 在后台运行，读取循环立即继续显示下一个提示符
   await this.handleMessage(event).catch(() => {})
   this._readLoop()
  }
}

/**
 * Gateway 核心：启动适配器、路由消息、管理活跃会话
 * _handleMessage 是所有适配器的汇聚点，不关心消息从哪个平台来
 */
export class GatewayRunner {
  constructor(config, dbPath) {
    this.config = config
    this.dbPath = dbPath
    this.adapters = new Map()
    this.agentName = config?.gateway?.agentName || 'main'
    this.config = config
    this.dbPath = dbPath

    // session key → agent 运行状态（Promise resolve 函数用于中断信号）
    this._activeSessions = new Map()
    this._pendingMessages = new Map()
    // session key → cached system prompt
    this._prompts = new Map()
    
    // 数据库连接（延迟初始化，首次使用时创建）
    this._db = null
    this._history = [] // 历史消息记录
    
    // source → sessionKey 缓存，避免重复计算
    this._sessionKeyCache = new Map()
  }

  // 注册适配器
  addAdapter(adapter) {
    adapter._onMessage = this._handleMessage.bind(this)
    this.adapters.set(adapter.platformName, adapter)
  }

  async start() {
    for (const [name, adapter] of this.adapters) {
      const ok = await adapter.connect()
      if (ok) {
        console.log(`  [gateway] ${name} 已连接`)
      } else {
        console.log(`  [gateway] ${name} 连接失败`)
      }
    }
  }

  async stop() {
    for (const adapter of this.adapters.values()) {
      await adapter.disconnect()
    }
    // 关闭数据库连接
    if (this._db) {
      this._db.close()
      this._db = null
    }
  }

  /**
   * 获取数据库连接（延迟初始化，复用连接）
   * @returns {Database} SQLite 数据库连接
   */
  async _getDB() {
    if (!this._db) {
      this._db = await initDB(this.dbPath)
    }
    return this._db
  }

  /**
   * 所有平台在此汇聚。此函数：
   * 1. 构建 session key
   * 2. 如果 session 已激活 → 中断它，暂存新消息
   * 3. 否则 → 在后台处理消息
   * @param {MessageEvent} event
   */
  async _handleMessage(event) {
    // 使用缓存避免重复计算 session key
    const sourceKey = `${event.source.platform}:${event.source.chatId}:${event.source.sender}`
    let sessionKey = this._sessionKeyCache.get(sourceKey)
    if (!sessionKey) {
      sessionKey = buildSessionKey(event.source, this.agentName)
      this._sessionKeyCache.set(sourceKey, sessionKey)
    }
    
    if(this._activeSessions.has(sessionKey)) {
      // 正在处理中 → 暂存新消息（只保留最后一条），发中断信号
      this._pendingMessages.set(sessionKey, event)
      const interrupt = this._activeSessions.get(sessionKey)
      if(interrupt) {
        interrupt()
      }
      console.log(`  [gateway] ${sessionKey}: 已排队 (agent 忙)`)
      return
    }

    // 没有活跃 agent → 启动后台处理
    let interruptResolve = null
    new Promise(resolve => { interruptResolve = resolve })
    this._activeSessions.set(sessionKey, interruptResolve)

    await this._processInBackground(event, sessionKey).catch(() => {})
  }

  async _processInBackground(event, sessionKey) {
    try {
      const response = await this._runAgent(event, sessionKey)
      // 发回复
      const adapter = this.adapters.get(event.source.platform)
      if (adapter && response) {
        await adapter.send(event.source.chatId, response)
      }
    } catch (err) {
      console.log(chalk.red(`  [gateway] 错误: ${err.message}`))
    }

    if (this._pendingMessages.has(sessionKey)) {
      // 处理暂存消息
      const nextEvent = this._pendingMessages.get(sessionKey)
      this._pendingMessages.delete(sessionKey)

      // 重置中断信号，继续处理下一条
      let interruptResolve = null
      new Promise(resolve => { interruptResolve = resolve })
      this._activeSessions.set(sessionKey, interruptResolve)
      await this._processInBackground(nextEvent, sessionKey)
    } else {
      // 清除标记
      this._activeSessions.delete(sessionKey)
    }
  }

  /** 
   * 为一条消息运行核心对话循环
   * Gateway 不修改核心循环，只是换了一个"消息从哪来"
  */
  async _runAgent(event, sessionKey) {
    const db = await this._getDB()
    if(!this._history.length) {
      this._history = getSessionMessages(db, sessionKey)
    }
    const model = this.config?.model || process.env.model || process.env.AI_MODEL_NAME
    const data = event.toJSON()
    
    if(!this._history.length) {
      // 首次会话，创建记录
      db.prepare(`
        INSERT INTO sessions (id, source, model, started_at)
        VALUES (?, ?, ?, ?)
      `).run(sessionKey, data.source.platform, model, Date.now())
    }

    // 组装 system prompt（按 session 缓存）
    if (!this._prompts.has(sessionKey)) {
      this._prompts.set(sessionKey, buildSystemPrompt())
    }

    const result = await runConversation(
      data.text, db, sessionKey, this._prompts.get(sessionKey)
    )
    return result
  }
}