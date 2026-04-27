/** 
 * 1. 保留头尾关键信息
 * 2. 压缩中间工具调用结果，并调用 LLM 进行结构化输出
*/
import { HumanMessage } from '@langchain/core/messages'

import { model } from './model.mjs'
import { KEEP_RECENT_TOOL_RESULTS, PROTECT_FIRST, TAIL_TOKEN_BUDGET } from './model.mjs'

/**
 * Replace old tool outputs with placeholders, keeping only the recent ones.
 * 只替换 content，不删除消息本身——必须保留 tool_call_id 以维持 assistant↔tool 的配对
 * @param {Array<{role: string, content?: string}>} messages
 * @param {number} [keepRecent=KEEP_RECENT_TOOL_RESULTS]
 * @returns {Array<{role: string, content?: string}>}
 */
function pruneOldToolResults(messages, keepRecent = KEEP_RECENT_TOOL_RESULTS) {
  // 找出所有 role 为 "tool" 的消息索引
  const toolIndices = messages
    .map((msg, index) => ({ index, type: msg.type }))
    .filter(({ type }) => type === 'tool')
    .map(({ index }) => index)
  // 只替换 content，保留最后 keepRecent 个
  for (let i = 0; i < toolIndices.length - keepRecent; i++) {
    const index = toolIndices[i]
    messages[index] = {
      ...messages[index],
      content: '[Old tool output cleared]',
    }
  }
  return messages
}

/**
 * Find the compressible middle region: protect head + protect tail.
 * 从尾部往前累加 token，直到 tail_start 处的累计量逼近预算；中间段 [head_end, tail_start) 就是要摘要的部分
 * @param {Array<{content?: string}>} messages
 * @param {number} protectFirst
 * @param {number} tailTokenBudget
 * @returns {[number, number]} [headEnd, tailStart]
 */
function findBoundaries(messages, protectFirst = PROTECT_FIRST, tailTokenBudget = TAIL_TOKEN_BUDGET) {
  const headEnd = protectFirst
  let tailStart = messages.length
  let tailTokens = 0

  // 从尾部往前遍历，直到 headEnd
  for (let index = messages.length - 1; index >= headEnd; index--) {
    const msgTokens = Math.floor(String(messages[index].content ?? '').length / 4)
    
    if (tailTokens + msgTokens > tailTokenBudget) {
      break
    }
    
    tailTokens += msgTokens
    tailStart = index
  }

  return [headEnd, tailStart]
}

/**
 * Use an auxiliary LLM call to summarize the middle conversation turns.
 * 固定段落结构让模型照格子填，便于后面主对话复用；每条消息截 500 字避免 prompt 爆炸
 * @param {Array<{role: string, content?: string}>} turns
 * @returns {Promise<string>}
 */
async function summarizeMiddle(turns) {
  // 构建 prompt
  let prompt =
    '请用简洁的文字总结以下对话内容，并保持对话的上下文和逻辑关系，不要遗漏任何重要信息。\n' +
    '总结内容包括：目标、进展、关键决策、文件修改、下一步行动等。\n\n'
  
  for (const msg of turns) {
    const contentPreview = String(msg.content ?? '').slice(0, 500)
    prompt += `[${msg.role}] ${contentPreview}\n`
  }
  try {
    // 调用模型进行压缩
    const response = await model.invoke([new HumanMessage(prompt)])
    return response.content || '(summary failed)'
  } catch (exc) {
    return `(summary error: ${exc})`
  }
}

/**
 * Rough token estimate: character count / 4.
 * 粗略但够用：英文约 4 char/token，中文更高估，偏保守是好事
 * @param {Array<{content?: string}>} messages
 * @returns {number}
 */
export function estimateTokens(messages) {
  const totalChars = messages.reduce((sum, msg) => {
    return sum + String(msg.content ?? '').length
  }, 0)
  return Math.floor(totalChars / 4)
}

/**
 * Perform one round of context compression.
 * 1) prune 老 tool 输出；2) 定位中段；3) LLM 摘要后拼回
 * @param {Array<{role: string, content?: string}>} messages
 * @returns {Promise<Array<{role: string, content?: string}>>}
 */
export async function compress(messages) {
  // 1) prune 老 tool 输出
  messages = pruneOldToolResults([...messages])
  
  // 2) 定位中段
  const [headEnd, tailStart] = findBoundaries(messages)

  // 尾部已经覆盖到头部保护区之前：说明总量本来就不大，不值得摘要
  if (tailStart <= headEnd) {
    return messages
  }

  const middle = messages.slice(headEnd, tailStart)
  const summary = await summarizeMiddle(middle)

  console.log(
    `  [compress] 压缩了 ${middle.length} 消息 \n`,
    `summary 长度： (${summary.length} chars) \n`,
    `summary 内容: ${summary} \n`,
  )

  // 3) 用一条 [上下文压缩]
  // 伪装成 human 消息
  return [
    ...messages.slice(0, headEnd),
    new HumanMessage(`[上下文压缩]\n${summary}`),
    ...messages.slice(tailStart)
  ]
}