import { createSession, addMessage } from './persistent.mjs'
import runConversation from './runConversation.mjs'


// 执行回顾任务
export async function runReview(
  messagesSnapshot,
  prompt,
  dbFactory,
  cachedPrompt,
  reviewCallback = null
) {
  const db = await dbFactory()
  const sessionId = createSession(db)

  // 预先填充历史记录，让回顾代理看到完整对话
  for (const msg of messagesSnapshot) {
    addMessage(db, sessionId, msg)
  }

  let result = null

  try {
    result = await runConversation(prompt, db, sessionId, cachedPrompt, null, null, 8)
  } catch (error) {
    result = null
  }

  console.log('===== Review Result =====\n', result, '\n=====\n')

  if (reviewCallback && result) {
    if (!result.toLowerCase().includes('nothing to save')) {
      try {
        reviewCallback(`[bg-review] ${result.slice(0, 200)}`)
      } catch (err) {
        // 忽略回调错误
      }
    }
  }
  db.close()
}