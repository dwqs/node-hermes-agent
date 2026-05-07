import { runReview } from './run-review.mjs'
import { initDB } from './persistent.mjs'

const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool. If nothing is worth saving, just say "Nothing to save." and stop.`

const SKILL_REVIEW_PROMPT = `Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome?

If a relevant skill already exists, update it with what you learned. Otherwise, create a new skill if the approach is reusable.
If nothing is worth saving, just say "Nothing to save." and stop.`

const COMBINED_REVIEW_PROMPT = `Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona, desires, preferences, or personal details? Has the user expressed expectations about how you should behave? If so, save using the memory tool.

**Skills**: Was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way? If a relevant skill already exists, update it. Otherwise, create a new one if the approach is reusable.

Only act if there's something genuinely worth saving. If nothing stands out, just say "Nothing to save." and stop.`

export class ReviewState {
  /**
   * 追踪何时触发后台回顾。
   * @param {number} [memoryNudgeInterval=10] - 每 N 个用户回合触发一次
   * @param {number} [skillNudgeInterval=10] - 每 N 个工具调用迭代触发一次
   */
  constructor(memoryNudgeInterval = 10, skillNudgeInterval = 10) {
    this.turnsSinceMemory = 0
    this.itersSinceSkill = 0
    this.memoryNudgeInterval = memoryNudgeInterval
    this.skillNudgeInterval = skillNudgeInterval
  }

  /**
   * 当用户消息到达时调用。
   */
  onUserMessage() {
    this.turnsSinceMemory += 1
  }

  /**
   * 当工具调用完成时调用。
   */
  onToolIteration() {
    this.itersSinceSkill += 1
  }

  /**
   * 当用户显式使用记忆/技能工具时调用。
   */
  onManualMemoryOrSkill() {
    this.turnsSinceMemory = 0
    this.itersSinceSkill = 0
  }

  /**
   * 检查是否应触发回顾。
   * @returns {[boolean, boolean]} - [是否回顾记忆, 是否回顾技能]
   */
  shouldReview() {
    const reviewMemory =
      this.memoryNudgeInterval > 0 &&
      this.turnsSinceMemory >= this.memoryNudgeInterval
    const reviewSkills =
      this.skillNudgeInterval > 0 &&
      this.itersSinceSkill >= this.skillNudgeInterval
    return [reviewMemory, reviewSkills]
  }

  /**
   * 触发回顾后重置计数器。
   */
  reset() {
    this.turnsSinceMemory = 0
    this.itersSinceSkill = 0
  }
}



/**
 * 启动后台任务来回顾对话。
 *
 * 参数:
 * @param {Object[]} messagesSnapshot - 对话历史的副本（不是引用）
 * @param {boolean} reviewMemory - 是否回顾以更新记忆
 * @param {boolean} reviewSkills - 是否回顾以创建技能
 * @param {Function} dbFactory - 返回新 SQLite 连接的工厂函数
 * @param {string} cachedPrompt - 回顾代理的系统提示词
 * @param {Function|null} [reviewCallback] - 可选的回调函数用于报告结果
 * @returns {Promise<void>}
 */
function spawnBackgroundReview(
  messagesSnapshot,
  reviewMemory,
  reviewSkills,
  dbFactory,
  cachedPrompt,
  reviewCallback = null
) {
  let prompt
  if (reviewMemory && reviewSkills) {
    prompt = COMBINED_REVIEW_PROMPT
  } else if (reviewMemory) {
    prompt = MEMORY_REVIEW_PROMPT
  } else {
    prompt = SKILL_REVIEW_PROMPT
  }

  // 启动后台任务并返回 Promise
  const reviewPromise = runReview(
    messagesSnapshot,
    prompt,
    dbFactory,
    cachedPrompt,
    reviewCallback,
  ).catch((e) => {
    console.log('Error running review2:', e.message)
  } )

  return reviewPromise
}

export function maybeTriggerReview(reviewState, messages, db, cachedPrompt, reviewCallback) {
  if (!reviewState) {
    return
  }
  const [reviewMemory, reviewSkills] = reviewState.shouldReview()
  if (!reviewMemory && !reviewSkills) {
    return
  }
  reviewState.reset()

  // 获取数据库路径
  const dbPath = db.prepare('PRAGMA database_list').get().file
  console.log('=====dbPath=====\n', dbPath, '\n=====\n')

  async function dbFactory() {
    return await initDB(dbPath)
  }

  spawnBackgroundReview(
    [...messages], // 快照，不是引用
    reviewMemory,
    reviewSkills,
    dbFactory,
    cachedPrompt,
    reviewCallback,
  )
}