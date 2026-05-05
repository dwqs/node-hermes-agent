import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DURATION_UNITS = {
  's': 1,
  'm': 60,
  'h': 3600,
  'd': 86400,
}

function parseDuration(duration) {
  const d = duration.trim()
  if(!d) {
    throw new Error('empty duration')
  }
  const unit = d.slice(-1).toLowerCase()
  if (!(unit in DURATION_UNITS)) {
    throw new Error(`unknown duration unit: '${unit}'`)
  }

  const value = parseFloat(d.slice(0, -1))
  if (isNaN(value)) {
    throw new Error(`invalid duration value: '${d}'`)
  }

  return value * DURATION_UNITS[unit]
}

/**
 * 解析单个 cron 字段为匹配函数 (int → bool)
 * 支持: * (任意),  N-M (范围), N,M,... (列表), N (精确值)
 * @param {string} str - cron 字段字符串
 * @param {[number, number]} valueRange - 值范围 [最小, 最大]
 * @returns {Function} 匹配函数，返回 boolean
 */
function parseCronField(str, valueRange) {
  const [lo, hi] = valueRange
  
  if(str === '*') {
    return (value) => true
  }

  // */N 步长匹配
  if (str.startsWith('*/')) {
    const step = parseInt(str.slice(2), 10)
    return (v) => v % step === 0
  }

  // N,M,... 列表匹配 
  if (str.includes(',')) {
    const values = new Set(str.split(',').map(x => parseInt(x.trim(), 10)))
    return (v) => values.has(v)
  }

  // N-M 范围匹配
  if (str.includes('-')) {
    const [a, b] = str.split('-', 2).map(x => parseInt(x.trim(), 10))
    return (v) => a <= v && v <= b
  }

  // N 精确值匹配
  const exact = parseInt(str, 10)
  return (v) => v === exact
}

/**
 * 找到下一个匹配 5 字段 cron 表达式的时间点
 * @param {string} expr - cron 表达式（分 时 日 月 周）
 * @returns {number} 匹配时间的时间戳（毫秒）
 * @throws {Error} 格式错误或 366 天内无匹配时抛出
 */
function nextCronFire(expr) {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron needs 5 fields, got ${fields.length}: ${expr}`)
  }

  const matchers = [
    parseCronField(fields[0], [0, 59]),   // 分钟
    parseCronField(fields[1], [0, 23]),   // 小时
    parseCronField(fields[2], [1, 31]),    // 日期
    parseCronField(fields[3], [1, 12]),    // 月份
    parseCronField(fields[4], [0, 6]),     // 星期（0=周日）
  ]

  const now = new Date()
  let t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0)

  const maxIterations = 366 * 24 * 60
  for (let i = 0; i < maxIterations; i++) {
    // JS getDay(): 0=周日...6=周六，正好匹配 cron 的 weekday
    const cronDow = t.getDay()
    if (matchers[0](t.getMinutes()) &&
        matchers[1](t.getHours()) &&
        matchers[2](t.getDate()) &&
        matchers[3](t.getMonth() + 1) && // JS month 是 0-11
        matchers[4](cronDow)) {
      return t.getTime()
    }
    // 增加一分钟
    t = new Date(t.getTime() + 60000)
  }
  throw new Error(`no match in 366 days for: ${expr}`)
}

/**
 * 解析调度表达式
 * @param {string} expr - 调度表达式
 * @returns {[number, boolean]} [下次触发时间戳, 是否一次性]
 * 支持格式:
 *   "30m"           → 30分钟后，一次性
 *   "2h"            → 2小时后，一次性
 *   "every 30m"     → 每30分钟，重复
 *   "every 2h"      → 每2小时，重复
 *   "每 1m"          → 每1分钟，重复
 *   "0 9 * * 1-5"   → cron表达式，重复
 */
function parseSchedule(expr) {
  expr = expr.trim()
  const now = Date.now()

  // "every Xm" / "every Xh" / "每 xx" → recurring interval
  if (expr.startsWith('every ') || expr.startsWith('每 ')) {
    const seconds = parseDuration(expr.startsWith('every ') ? expr.slice(6) : expr.slice(2))
    return [now + seconds * 1000, false]
  }

  // "Xm" / "Xh" → 一次性延迟
  try {
    const seconds = parseDuration(expr)
    return [now + seconds * 1000, true]
  } catch (err) {
    // 不是时长格式，继续尝试 cron
  }

  // cron 表达式 → 重复
  const nextTs = nextCronFire(expr)
  return [nextTs, false]
}

/**
 * 单个定时任务
 */
class CronJob {
  /**
   * @param {string} jobId - 任务 ID
   * @param {string} schedule - 原始调度表达式
   * @param {string} prompt - 触发时发送的消息
   * @param {string} sessionKey - 触发的会话标识
   * @param {string} createdAt - 创建时间
   * @param {number} nextFire - 下次触发时间戳
   * @param {boolean} oneShot - 是否一次性（触发后删除）
   */
  constructor(jobId, schedule, prompt, sessionKey, createdAt, nextFire, oneShot) {
    this.jobId = jobId
    this.schedule = schedule
    this.prompt = prompt
    this.sessionKey = sessionKey
    this.createdAt = createdAt
    this.nextFire = nextFire
    this.oneShot = oneShot // true 表示一次性，触发后就删除；false 表示重复，触发后更新下次触发时间
  }
}

/**
 * 定时任务的 CRUD + 持久化存储
 * 使用 jobs.json（而非 SQLite），因为：
 * - 任务数量少（通常每个用户 < 20 个）
 * - 人类可读，方便调试
 * - 无需 FTS 或并发写入
 */
export class JobStore {
  /**
   * @param {string} [storePath] - 存储文件路径，默认为 HERMES_HOME/jobs.json
   */
  constructor(storePath = null) {
    this._path = storePath || path.join(process.env.HERMES_HOME || '.hermes', 'jobs.json')
    this._jobs = new Map()
    this._lock = Promise.resolve() // 简单锁机制
    this._load()
  }

  /**
   * 获取锁（简单串行化）
   * @returns {Promise<Function>} 释放锁的函数
   */
  async _acquireLock() {
    const prev = this._lock
    let release
    this._lock = new Promise(resolve => { release = resolve })
    await prev
    return release
  }

  /**
   * 添加任务
   * @param {CronJob} job - 任务对象
   */
  async add(job) {
    const release = await this._acquireLock()
    try {
      this._jobs.set(job.jobId, job)
      this._save()
    } finally {
      release()
    }
  }

  /**
   * 删除任务
   * @param {string} jobId - 任务 ID
   * @returns {boolean} 是否成功删除
   */
  async remove(jobId) {
    const release = await this._acquireLock()
    try {
      if (this._jobs.has(jobId)) {
        this._jobs.delete(jobId)
        this._save()
        return true
      }
      return false
    } finally {
      release()
    }
  }

  /**
   * 获取所有任务
   * @returns {CronJob[]} 任务列表
   */
  listAll() {
    return Array.from(this._jobs.values())
  }

  /**
   * 获取到期的任务（next_fire 已过的）
   * @returns {CronJob[]} 到期任务列表
   */
  getDue() {
    const now = Date.now()
    return Array.from(this._jobs.values()).filter(j => now >= j.nextFire)
  }

  /**
   * 推进任务时间（重复任务更新下次触发时间，一次性任务删除）
   * @param {CronJob} job - 任务对象
   */
  async advance(job) {
    const release = await this._acquireLock()
    try {
      if (job.oneShot) {
        this._jobs.delete(job.jobId)
      } else {
        const [nextTs] = parseSchedule(job.schedule)
        job.nextFire = nextTs
      }
      this._save()
    } finally {
      release()
    }
  }

  /**
   * 保存到文件（原子写入：先写临时文件再重命名）
   */
  _save() {
    const data = Array.from(this._jobs.values()).map(j => ({
      job_id: j.jobId,
      schedule: j.schedule,
      prompt: j.prompt,
      session_key: j.sessionKey,
      created_at:  j.createdAt,
      next_fire: j.nextFire,
      one_shot: j.oneShot,
    }))

    const tmpPath = this._path + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmpPath, this._path)
  }

  /**
   * 从文件加载
   */
  _load() {
    if (!existsSync(this._path)) {
      return
    }
    try {
      const text = readFileSync(this._path, 'utf-8')
      const items = JSON.parse(text)
      for (const item of items) {
        const job = new CronJob(
          item.job_id,
          item.schedule,
          item.prompt,
          item.session_key,
          item.created_at,
          item.next_fire,
          item.one_shot
        )
        this._jobs.set(job.jobId, job)
      }
    } catch (err) {
      // JSON 损坏，降级为空列表
    }
  }
}

const jobStore = new JobStore()

/**
 * 后台定时任务调度器
 * 每 interval 秒检查一次到期任务
 * 使用 setTimeout 实现，在 Node.js 中同时适用于 CLI 和 Gateway 模式
 */
export class JobScheduler {
  /**
   * @param {Function} fireCallback - 任务触发回调 (job) => void
   * @param {number} [interval] - 检查间隔（秒），默认 30
   */
  constructor(fireCallback, interval = 30) {
    this._fire = fireCallback
    this._interval = interval * 1000 // 转毫秒
    this._running = false
    this._timer = null
  }

  /**
   * 启动调度器
   */
  start() {
    if (this._running) {
      return
    }
    this._running = true
    this._loop()
  }

  /**
   * 停止调度器
   */
  stop() {
    this._running = false
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  /**
   * 调度循环
   */
  async _loop() {
    if (!this._running) {
      return
    }

    // 检查并执行到期任务
    const dueJobs = jobStore.getDue()

    for (const job of dueJobs) {
      try {
        await this._fire(job)
      } catch (err) {
        console.error(`  [scheduler] job ${job.jobId} failed: ${err.message}`)
      }
      await jobStore.advance(job)
    }

    // 安排下一次检查
    this._timer = setTimeout(() => {
      this._loop()
    }, this._interval)
  }
}

export function handleCronTool(args, kwargs={}) {
  const action = args.action || 'list'
  if(action === 'create') {
    const scheduleExpr = args.schedule || ''
    const prompt = args.prompt || ''
    if (!scheduleExpr || !prompt) {
      return "Error: 'schedule' and 'prompt' are required."
    }

    let nextFire, oneShot
    try {
      [nextFire, oneShot] = parseSchedule(scheduleExpr)
    } catch (err) {
      return `Error parsing schedule: ${err.message}`
    }

    // session_key 从 kwargs 传入（由调用方设置）
    const sessionKey = kwargs.session_key || 'cli'
    const job = new CronJob(
      crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      scheduleExpr,
      prompt,
      sessionKey,
      new Date().toLocaleString('zh-CN'),
      nextFire,
      oneShot
    )
    jobStore.add(job)

    const fireTime = new Date(nextFire).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    const kind = oneShot ? 'one-shot' : 'recurring'
    return `Job ${job.jobId} created (${kind}). Next fire: ${fireTime}`
  }

  if(action === 'list') {
    const jobs = jobStore.listAll()
    if (jobs.length === 0) {
      return 'No scheduled jobs.'
    }

    const lines = []
    for (const j of jobs) {
      const fireTime = new Date(j.nextFire).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
      const kind = j.oneShot ? 'once' : 'recurring'
      const schedulePadded = j.schedule.padEnd(15)
      const promptPreview = j.prompt.slice(0, 40)
      lines.push(`  ${j.jobId}  ${schedulePadded}  ${kind.padEnd(9)}  next: ${fireTime}  ${promptPreview}`)
    }
    return 'Jobs:\n' + lines.join('\n')
  }

  if (action === 'delete') {
    const jobId = args.job_id || ''
    if (!jobId) {
      return "Error: 'job_id' is required."
    }
    if (jobStore.remove(jobId)) {
      return `Job ${jobId} deleted.`
    }
    return `Job ${jobId} not found.`
  }
  return `Unknown action: ${action}`
}
