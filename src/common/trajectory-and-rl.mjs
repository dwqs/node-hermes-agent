/** 
 * 对话轨迹的收集、格式化、压缩和奖励打分
 * 这是 Hermes Agent 的离线进化机制——把对话经验变成训练数据用于强化学习。
*/
import fs from 'node:fs'

import { estimateTokens } from './context-compression.mjs'
import { initDB, createSession } from './persistent.mjs'
import { buildSystemPrompt } from './system-prompt-builder.mjs'
import runConversation from './runConversation.mjs'

/** 
 * 将 OpenAI 格式的消息转换为 ShareGPT 轨迹格式
 * 角色映射：system→system, user→human, assistant→gpt, tool→tool
 * 工具调用包装在 <tool_call> 标签中，工具结果在 <tool_response> 中
*/
function convertToTrajectory(messages) {
  const trajectory = []

  for (const msg of messages) {
    const role = msg.role || msg.type || ''
    let content = msg.content || ''
    let fromField
    if (role === 'system') {
      fromField = 'system'
    } else if (role === 'user' || role === 'human') {
      fromField = 'human'
    } else if (role === 'assistant' || role === 'ai') {
      fromField = 'gpt'
      // 将工具调用包装在 <tool_call> 标签中
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args
          try {
            args = JSON.parse(tc.args || '{}')
          } catch {
            args = tc.args || ''
          }
          const tcText = JSON.stringify(
            { name: tc.name || '', arguments: args },
            null,
            2,
          )
          content += `\n<tool_call>\n${tcText}\n</tool_call>`
        }
      }
    } else if (role === 'tool') {
      fromField = 'tool'
      const tcId = msg.tool_call_id || ''
      content =
        `<tool_response>\n` +
        `{"tool_call_id": "${tcId}", "content": ${JSON.stringify(content)}}\n` +
        `</tool_response>`
    } else {
      continue
    }
    if (content) {
      trajectory.push({ from: fromField, value: content })
    }
  }

  return trajectory
}

// 从消息中提取每个工具的成功/失败计数。
function extractToolStats(messages) {
  const stats = {}
  const tcMap = {}
  for (const msg of messages) {
    const role = msg.role || msg.type || ''
    if (role === 'ai' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        tcMap[tc.id] = tc.name || 'unknown'
      }
    } else if (role === 'tool') {
      const tcId = msg.tool_call_id || ''
      const toolName = tcMap[tcId] || 'unknown'
      if (!stats[toolName]) {
        stats[toolName] = { count: 0, success: 0, failure: 0 }
      }
      stats[toolName].count += 1
      const content = (msg.content || '').slice(0, 200).toLowerCase()
      if (content.includes('error') || content.includes('failed')) {
        stats[toolName].failure += 1
      } else {
        stats[toolName].success += 1
      }
    }
  }
  return stats
}

// 统计有多少助手回合包含推理（thinking 块）
function extractReasoningStats(messages) {
  let total = 0
  let withReasoning = 0
  for (const msg of messages) {
    const role = msg.role || msg.type || ''
    if (role === 'ai') {
      total += 1
      const content = msg.content || ''
      if (content.includes('thinking') || content.includes('<REASONING')) {
        withReasoning += 1
      }
    }
  }
  return {
    total_assistant_turns: total,
    turns_with_reasoning: withReasoning,
    turns_without_reasoning: total - withReasoning,
    has_any_reasoning: withReasoning > 0,
  }
}

// Trajectory compression
function summarizeTurns(turns) {
  const toolsUsed = new Set()
  let errors = 0
  for (const t of turns) {
    const value = t.value || ''
    if (value.includes('<tool_call>')) {
      const matches = value.match(/"name":\s*"(\w+)"/g) || []
      for (const match of matches) {
        const nameMatch = match.match(/"name":\s*"(\w+)"/)
        if (nameMatch) {
          toolsUsed.add(nameMatch[1])
        }
      }
    }
    if (t.from === 'tool' && value.slice(0, 200).toLowerCase().includes('error')) {
      errors += 1
    }
  }
  const parts = [`Agent worked through ${turns.length} turns.`]
  if (toolsUsed.size > 0) {
    parts.push(`Tools: ${[...toolsUsed].sort().join(', ')}.`)
  }
  if (errors > 0) {
    parts.push(`Hit ${errors} error(s), recovered and continued.`)
  }
  return parts.join(' ')
}

/** 
 * 将轨迹压缩到目标 token 预算内
 * 策略：保护头部（system + 第一个 human + 第一个 gpt）和尾部（最后 N 回合）
*/
function compressTrajectory(trajectory, targetTokens = 15250, protectLastN = 4) {
  const originalTokens = estimateTokens(trajectory)
  if (originalTokens <= targetTokens) {
    return [
      trajectory,
      {
        was_compressed: false,
        original_tokens: originalTokens,
        compressed_tokens: originalTokens,
        turns_removed: 0,
      },
    ]
  }
  // 保护头部：system + 第一个 human + 第一个 gpt
  const head = []
  const rest = [...trajectory]
  for (const role of ['system', 'human', 'gpt']) {
    const idx = rest.findIndex((t) => t.from === role)
    if (idx !== -1) {
      head.push(rest.splice(idx, 1)[0])
    }
  }
  // 保护尾部
  let tail = []
  let middle = []
  if (rest.length > protectLastN) {
    tail = rest.slice(-protectLastN)
    middle = rest.slice(0, -protectLastN)
  } else {
    tail = rest
    middle = []
  }
  // 摘要中间部分
  let compressedMiddle = []
  if (middle.length > 0) {
    const summary = summarizeTurns(middle)
    compressedMiddle = [
      {
        from: 'system',
        value: `[Summary of ${middle.length} middle turns]\n${summary}`,
      },
    ]
  }
  const compressed = head.concat(compressedMiddle, tail)
  const compressedTokens = estimateTokens(compressed)
  return [
    compressed,
    {
      was_compressed: true,
      original_tokens: originalTokens,
      compressed_tokens: compressedTokens,
      turns_removed: middle.length,
    },
  ]
}

// 如果预期答案在补全中找到则为 2.0，否则为 0.0
function correctnessReward(completions, expected) {
  const rewards = []
  for (let i = 0; i < completions.length; i++) {
    const completion = completions[i]
    const answer = expected[i]
    if (answer && completion.includes(answer)) {
      rewards.push(2.0)
    } else {
      rewards.push(0.0)
    }
  }
  return rewards
}

// 根据正确格式（think 标签 + tool_call 标签）最多返回 0.5
function formatReward(completions) {
  const rewards = []
  for (const c of completions) {
    let score = 0.0
    if (c.includes('thinking') && c.includes('discriminator')) {
      score += 0.25
    }
    if (c.includes('<tool_call>')) {
      score += 0.25
    }
    rewards.push(score)
  }
  return rewards
}

/**
 * 在每个提示上运行代理，将轨迹收集到 JSONL。
 *
 * 简化的教学版本。生产环境的 batch_runner 添加：
 * 并行化、检查点、工具集采样、推理过滤。
 * @param {string[]} prompts
 * @param {string} outputPath
 * @returns {Object[]}
 */
async function runBatch(prompts, outputPath) {
  const results = []
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]
    const db = await initDB()
    const sessionId = createSession(db)
    const cached = buildSystemPrompt()
    let entry
    try {
      const result = await runConversation(prompt, db, sessionId, cached)
      const messages = result.messages || []
      const trajectory = convertToTrajectory(messages)
      const toolStats = extractToolStats(messages)
      const reasoning = extractReasoningStats(messages)
      entry = {
        prompt_index: i,
        trajectory: trajectory,
        tool_stats: toolStats,
        reasoning_stats: reasoning,
        completed: result.final_response !== null && result.final_response !== undefined,
        api_calls: messages.filter((m) => (m.role || m.type) === 'ai').length,
      }
      // 过滤：丢弃零推理样本
      if (!reasoning.has_any_reasoning) {
        entry.filtered = 'no_reasoning'
      }
      results.push(entry)
    } catch (e) {
      entry = {
        prompt_index: i,
        trajectory: [],
        completed: false,
        error: e.message,
      }
      results.push(entry)
    } finally {
      db.close()
    }
    const status = results[results.length - 1].completed ? 'OK' : 'FAIL'
    console.log(`  [${i + 1}/${prompts.length}] ${status}`)
  }
  // 写入 JSONL
  const lines = results.map((r) => JSON.stringify(r))
  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf-8')
  const ok = results.filter((r) => r.completed).length
  console.log(`\nBatch: ${ok}/${prompts.length} succeeded → ${outputPath}`)
  return results
}