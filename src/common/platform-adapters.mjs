import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as setTimeoutPromise } from 'node:timers/promises'

import { BasePlatformAdapter, MessageEvent, SessionSource, MessageType, buildSessionKey } from './gateway.mjs'

/**
 * 计算 UTF-16 code units 数量（Telegram 用于长度限制）
 * 大部分字符 = 1 unit，但很多 emoji = 2 units (surrogate pair)
 * @param {string} text - 要计算的文本
 * @returns {number} UTF-16 code units 数量
 */
function utf16Len(text) {
  // Node.js Buffer.byteLength 返回字节数，除以 2 得到 code units
  return Math.floor(Buffer.byteLength(text, 'utf16le') / 2)
}

/**
 * 将文本截断到指定的 UTF-16 code units 数量内
 * @param {string} text - 要截断的文本
 * @param {number} maxUnits - 最大 UTF-16 code units
 * @returns {string} 截断后的文本
 */
function truncateUtf16(text, maxUnits) {
  if (utf16Len(text) <= maxUnits) {
    return text
  }
  
  const result = []
  let total = 0
  
  for (const ch of text) {
    const chUnits = Buffer.byteLength(ch, 'utf16le') >> 1
    if (total + chUnits > maxUnits) {
      break
    }
    result.push(ch)
    total += chUnits
  }
  
  return result.join('')
}

// 消息去重，用 message_id 做去重，FIFO 淘汰旧记录
class MessageDeduplicator {
  constructor(maxSize = 1000) {
    this._messageIdMap = new Map()
    this._maxSize = maxSize
    this._order = []
  }

  isDuplicated(messageId) {
    if(this._messageIdMap.has(messageId)) {
      return true
    }

    this._messageIdMap.set(messageId, true)
    this._order.push(messageId)
    if(this._order.length > this._maxSize) {
      const oldestMessageId = this._order.shift()
      this._messageIdMap.delete(oldestMessageId)
    }
    return false
  }
}

/**
 * 文本批处理器
 * 将同一会话的快速连续文本片段合并为一条消息
 * 当平台客户端拆分长文本时，多条消息在毫秒级内到达
 */
class TextBatchProcessor {
  constructor(callback) {
    this._callback = callback // async function(event: MessageEvent)
    this._buffers = new Map() // sessionKey -> text[]
    this._events = new Map() // sessionKey -> MessageEvent
    this._timers = new Map() // sessionKey -> timeoutId
  }

  /**
   * 缓冲文本片段，安静期后合并
   * @param {string} sessionKey - 会话标识
   * @param {string} text - 文本片段
   * @param {Object} event - 事件对象
   * @param {number} splitThreshold - 拆分阈值（默认 3900）
   */
  async enqueue(sessionKey, text, event, splitThreshold = 3900) {
    if(!this._buffers.has(sessionKey)) {
      this._buffers.set(sessionKey, [])
    }
    this._buffers.get(sessionKey).push(text)
    this._events.set(sessionKey, event) 

    // 取消旧定时器
    const oldTimer = this._timers.get(sessionKey)
    oldTimer && clearTimeout(oldTimer)

    const delay = text.length >= splitThreshold ? 2000 : 600
    this._timers.set(sessionKey, setTimeout(() => {
      this._flush(sessionKey)
    }, delay))
  }

  // 刷新指定会话的缓冲区
  async _flush(sessionKey) {
    const chunks = this._buffers.get(sessionKey) || []
    const event = this._events.get(sessionKey)
    
    this._buffers.delete(sessionKey)
    this._events.delete(sessionKey)
    this._timers.delete(sessionKey)

    if(chunks.length && event) {
      event.text = chunks.join('')
      await this._callback(event)
    }
  }
}

const CACHE_DIR = process.env.HERMES_HOME + '/cache'

/**
 * 保存媒体文件到本地缓存
 * @param {Buffer|string} data - 二进制数据或 base64 字符串
 * @param {string} filename - 文件名
 * @param {'images'|'audios'} type - 媒体类型
 * @returns {string} 本地文件路径
 */
export function cacheMedia(data, filename, type) {
  const dir = path.join(CACHE_DIR, type)
  mkdirSync(dir, { recursive: true })
  
  // 如果是 base64 字符串，转换为 Buffer
  const buffer = typeof data === 'string' 
    ? Buffer.from(data, 'base64') 
    : data
  
  const filePath = path.join(dir, filename)
  writeFileSync(filePath, buffer)
  return filePath
}


// 模拟平台，用于测试基础功能
export class SimulatedPlatformAdapter extends BasePlatformAdapter {
  constructor() {
    super('simulated')
    this._dedup = new MessageDeduplicator()
    this._batcher = null
    this._replies = [] // (chatId, content) 日志

    // 默认脚本：演示分片合并
    this._script = [
      // 正常消息
      { text: '你好，帮我查个东西', user: 'alice', delay: 0 },
      // 模拟分片：两条消息间隔 0.1 秒，第一条接近 4000 字符
      { text: '这是一段很长的文本' + '。'.repeat(40), user: 'bob', delay: 1000 },
      { text: '这是被拆开的第二部分', user: 'bob', delay: 100 },
      // 重复消息（同一个 message_id）
      { text: '你好', user: 'alice', delay: 1000, msgId: 'dup_001' },
      { text: '你好', user: 'alice', delay: 50, msgId: 'dup_001' },
    ]
  }

  async connect() {
    this._running = true
    this._batcher = new TextBatchProcessor((event) => this.handleMessage(event))
    this._replayScript().catch(() => {})
    return true
  }

  async disconnect() {
    this._running = false
    if(this._batcher) {
      this._batcher = null
    }
  }
  
  async send(chatId, content) {
    this._replies.push([chatId, content])
    process.stdout.write(`\n[simulated] Reply to ${chatId}: ${content.slice(0, 100)}...\n`)
    return true
  }

  async _replayScript() {
    for (let i = 0; i < this._script.length; i++) {
      if (!this._running) {
        break
      }
      
      const msg = this._script[i]
      await setTimeoutPromise(msg.delay || 500)

      const msgId = msg.msgId || `sim_${i}`
      if (this._dedup.isDuplicated(msgId)) {
        process.stdout.write(`  [simulated] dedup: skipped ${msgId}\n`)
        continue
      }
      const event = new MessageEvent(
        msgId,
        msg.text,
        new SessionSource('simulated', msg.user || 'user1', msg.user || 'user1', msg.user || 'user1', 'dm'),
        MessageType.TEXT,
        []
      )
      const sessionKey = buildSessionKey(event.source)
      // 所有文本消息都过 batcher
      await this._batcher.enqueue(sessionKey, event.text, event)
    }
    // 等 batcher 的最后一次刷新完成
    await setTimeoutPromise(3000)
    this._running = false
  }
}
