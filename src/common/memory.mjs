import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'

import { ENTRY_SEP, MEMORY_FILE, MEMORY_CHAR_LIMIT, MEMORY_DIR, USER_FILE, USER_CHAR_LIMIT } from './model.mjs'

/**
 * 将使用节标记符分隔的文本分割为条目列表
 * @param {string} text - 要解析的文本
 * @returns {string[]} 非空修剪后的条目数组
 */
function parseEntries(text) {
  if (!text?.trim()) {
      return []
  }
  return text.split('\u00a7')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
}

export function renderEntries(entries) {
  return entries.join(ENTRY_SEP)
}

export function loadMemory(filePath) {
  if (!existsSync(filePath)) {
    return ''
  }
  return parseEntries(readFileSync(filePath, 'utf-8').slice(0, MEMORY_CHAR_LIMIT))
}

function saveMemory(filePath, entries, charLimit = MEMORY_CHAR_LIMIT) {
  // 确保目录存在
  mkdirSync(MEMORY_DIR, { recursive: true })
  
  let text = renderEntries(entries)
  let warning = ''
  // 超出上限就从末尾 pop（默认新条目在末尾追加，所以 FIFO 效果等价于"丢弃最早的新条目"）
  if (text.length > charLimit) {
      while (entries.length > 0 && renderEntries(entries).length > charLimit) {
          entries.pop()
      }
      text = renderEntries(entries)
      warning = `已裁剪至 ${entries.length} 个条目，以保持在 ${charLimit} 字符限制内。`
  }
  writeFileSync(filePath, text, 'utf-8')
  return warning
}

/**
 * 管理记忆条目（读取、添加、删除）
 * @param {string} action - 'read'、'add' 或 'remove'
 * @param {string} target - 'memory' 或 'user'
 * @param {string} content - 添加/删除操作的内容
 * @returns {string} 结果消息
 */
export function manageMemory(action, target, content) {
  const filePath = target === 'user' ? USER_FILE : MEMORY_FILE
  const charLimit = target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT
  if (action === 'read') {
    const entries = loadMemory(filePath)
    if (entries.length === 0) {
      return `(${target} 为空)`
    }
      return `=== ${target.toUpperCase()} (${entries.length} 个条目) ===\n` + renderEntries(entries)
  }
  if (action === 'add') {
    if (!content) {
      return '（错误：没有提供内容）'
    }
    const entries = loadMemory(filePath)
    entries.push(content)
    const warning = saveMemory(filePath, entries, charLimit)
    let message = `已添加到 ${target}。总计：${entries.length} 个条目。`
    if (warning) {
      message += ` 警告：${warning}`
    }
    return message
  }
  if (action === 'remove') {
    if (!content) {
      return '（错误：没有提供内容）'
    }
    let entries = loadMemory(filePath)
    const beforeCount = entries.length
    const keyword = content.toLowerCase()
    entries = entries.filter(entry => !entry.toLowerCase().includes(keyword))
    const removedCount = beforeCount - entries.length
    if (removedCount === 0) {
      return `在 ${target} 中未找到匹配 '${content}' 的条目。`
    }
    saveMemory(filePath, entries, charLimit)
    return `从 ${target} 中移除了 ${removedCount} 个条目。剩余：${entries.length} 个。`
  }
  return `（错误：未知操作 '${action}'。请使用 add/remove/read）`
}