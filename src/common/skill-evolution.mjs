import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

import { model, SKILL_DIR } from './model.mjs'
import { parseSkillFormatter, loadSkill } from './skill-system.mjs'

/**
 * s25
 * 这里用最简实现教核心思路：feedback → mutate → evaluate → select
 */

class EvalExample {
  /**
   * @param {string} taskInput
   * @param {string} expectedBehavior
   * @param {string} [difficulty="medium"]
   */
  constructor(taskInput, expectedBehavior, difficulty = 'medium') {
    this.taskInput = taskInput
    this.expectedBehavior = expectedBehavior
    this.difficulty = difficulty
  }
}

/**
 * 评估数据集，分为训练/验证/测试三个子集。
 *
 * train: 优化器用来评估和改进（可以"看到"）
 * val:   优化器用来选择最佳版本（防止过拟合 train）
 * holdout: 最终评估用，优化过程中从不使用
 */
class EvalDataset {
  /**
   * @param {EvalExample[]} [train=[]]
   * @param {EvalExample[]} [val=[]]
   * @param {EvalExample[]} [holdout=[]]
   */
  constructor(train = [], val = [], holdout = []) {
    this.train = train
    this.val = val
    this.holdout = holdout
  }
  /**
   * 返回所有示例
   * @returns {EvalExample[]}
   */
  get allExamples() {
    return [...this.train, ...this.val, ...this.holdout]
  }
  /**
   * 保存拆分到 JSONL 文件
   * @param {string} dirPath
   */
  async save(dirPath) {
    await mkdir(dirPath, { recursive: true })
    const splits = [
      ['train', this.train],
      ['val', this.val],
      ['holdout', this.holdout],
    ]
    for (const [splitName, splitData] of splits) {
      const lines = splitData.map((ex) =>
        JSON.stringify({
          task_input: ex.taskInput,
          expected_behavior: ex.expectedBehavior,
          difficulty: ex.difficulty,
        }),
      )
      await writeFile(
        path.join(dirPath, `${splitName}.jsonl`),
        lines.join('\n') + '\n',
        'utf-8',
      )
    }
  }
  /**
   * 从 JSONL 文件加载拆分
   * @param {string} dirPath
   * @returns {EvalDataset}
   */
  static async load(dirPath) {
    const dataset = new EvalDataset()
    const splitNames = ['train', 'val', 'holdout']
    for (const splitName of splitNames) {
      const splitFile = path.join(dirPath, `${splitName}.jsonl`)
      try {
        const content = await readFile(splitFile, 'utf-8')
        const examples = []
        for (const line of content.split('\n')) {
          if (line.trim()) {
            const d = JSON.parse(line)
            examples.push(new EvalExample(d.task_input, d.expected_behavior, d.difficulty))
          }
        }
        dataset[splitName] = examples
      } catch {
        // 文件不存在则跳过
      }
    }
    return dataset
  }
}

// s26 新增
/** 
 * 三个组件：数据集生成、适应度函数、约束门控。
*/

// 用 LLM 读 skill 文本，自动生成评估用例
class SyntheticDatasetBuilder {
  static GENERATE_PROMPT = `You are generating test cases for an AI agent skill.
Read the skill below and create {num_cases} diverse evaluation cases.

SKILL:
{skill_text}

For each test case, output a JSON object with:
- task_input: a realistic user request that this skill should handle
- expected_behavior: what a good response should contain (rubric, NOT exact text)
- difficulty: easy/medium/hard

Return a JSON array of {num_cases} test cases. Only JSON, no other text.`

  // 从 skill 文本生成合成评估数据集。
  async generate(skillText, numCases = 15) {
    const prompt = SyntheticDatasetBuilder.GENERATE_PROMPT
      .replace('{skill_text}', skillText.slice(0, 5000))
      .replace(/{num_cases}/g, String(numCases))

    let cases = []
    try {
      const response = await model.invoke([new HumanMessage(prompt)], {
        maxTokens: 4000,
      })
      // TODO: 要根据 langchain 的 response 类型来处理
      // 只是讲原理实现，就先不处理了
      const raw = response.content || '[]'

      // 提取 JSON 数组
      const match = raw.match(/\[[\s\S]*\]/)
      cases = match ? JSON.parse(match[0]) : []
    } catch (exc) {
      console.log(`  [eval] dataset generation error: ${exc.message}`)
      cases = []
    }

    const examples = cases
      .filter((c) => c.task_input && c.expected_behavior)
      .map(
        (c) =>
          new EvalExample(
            c.task_input,
            c.expected_behavior,
            c.difficulty || 'medium',
          ),
      )

    // 打乱后按 60/20/20 分割
    const shuffled = [...examples].sort(() => Math.random() - 0.5)
    const n = shuffled.length
    const nTrain = Math.max(1, Math.floor(n * 0.6))
    const nVal = Math.max(1, Math.floor(n * 0.2))

    return new EvalDataset(
      shuffled.slice(0, nTrain),
      shuffled.slice(nTrain, nTrain + nVal),
      shuffled.slice(nTrain + nVal),
    )
  }
}

// 多维评分结果
class FitnessScore {
  constructor(correctness = 0.0, procedureFollowing = 0.0, conciseness = 0.0, feedback = '') {
    this.correctness = correctness
    this.procedureFollowing = procedureFollowing
    this.conciseness = conciseness
    this.feedback = feedback
  }
 
  // 加权复合得分：正确性 50%，流程遵循 30%，简洁度 20%。
  get composite() {
    return 0.5 * this.correctness + 0.3 * this.procedureFollowing + 0.2 * this.conciseness
  }
}

const JUDGE_PROMPT = `You are a strict judge evaluating an AI agent's response.

SKILL INSTRUCTIONS the agent was following:
{skill_text}

TASK the agent was given:
{task_input}

EXPECTED BEHAVIOR (rubric):
{expected_behavior}

AGENT'S RESPONSE:
{agent_output}

Score the response on three dimensions (0.0 to 1.0 each):
1. correctness: Did the response correctly address the task?
2. procedure_following: Did it follow the skill's procedure?
3. conciseness: Was it appropriately concise?

Also provide specific, actionable feedback on what the SKILL INSTRUCTIONS could change to produce better results (not feedback on the agent's response).

Return JSON: {"correctness": 0.0, "procedure_following": 0.0, "conciseness": 0.0, "feedback": "..."}`

/**
 * 让 agent 用 skill 处理任务，再用 LLM-as-judge 打分。
 *
 * 两步：
 * 1. 把 skill 注入 system prompt，让 agent 处理 task_input
 * 2. 把 agent 输出 + rubric 喂给另一个 LLM 打分
 *
 * use_llm=false 时用快速启发式评分（keyword overlap），
 * 和 Hermes 的 skill_fitness_metric() 一致——优化过程中用来加速。
 */
async function evaluateSkill(skillText, example, useLLM = true) {
  if (!useLLM) {
    // 快速启发式：keyword overlap（和 Hermes 的 fitness.py 一致）
    const expectedWords = new Set(example.expectedBehavior.toLowerCase().split(/\s+/))
    if (expectedWords.size === 0) {
      return new FitnessScore(0.5, 0, 0, 'empty rubric')
    }
    const skillWords = new Set(skillText.toLowerCase().split(/\s+/))
    const overlap =
      [...expectedWords].filter((w) => skillWords.has(w)).length / expectedWords.size
    const score = 0.3 + 0.7 * overlap
    return new FitnessScore(
      score,
      score,
      Math.min(1.0, 1000 / Math.max(1, skillText.length)),
      'heuristic scoring',
    )
  }

  // 第一步：让 agent 用 skill 处理任务
  let agentOutput
  try {
    const response = await model.invoke(
      [
        new SystemMessage(`Follow these instructions:\n${skillText}`),
        new HumanMessage(example.taskInput),
      ], 
    {
      maxTokens: 2000,
    })
    agentOutput = response.content || ''
  } catch {
    agentOutput = '(agent call failed)'
  }

  // 第二步：LLM-as-judge 打分
  const judgePrompt = JUDGE_PROMPT.replace('{skill_text}', skillText.slice(0, 3000))
    .replace('{task_input}', example.taskInput)
    .replace('{expected_behavior}', example.expectedBehavior)
    .replace('{agent_output}', agentOutput.slice(0, 3000))

  let scores = {}
  try {
    const judgeResponse = await model.invoke([new HumanMessage(judgePrompt)], {
      maxTokens: 500,
    })
    const raw = judgeResponse.content || '{}'
    const match = raw.match(/\{[\s\S]*\}/)
    scores = match ? JSON.parse(match[0]) : {}
  } catch {
    scores = {}
  }

  function clamp(v, lo = 0.0, hi = 1.0) {
    try {
      return Math.min(hi, Math.max(lo, parseFloat(v)))
    } catch {
      return 0.5
    }
  }

  return new FitnessScore(
    clamp(scores.correctness, 0.5),
    clamp(scores.procedure_following, 0.5),
    clamp(scores.conciseness, 0.5),
    String(scores.feedback || ''),
  )
}

// 约束检查结果。对齐 Hermes 的 evolution/core/constraints.py。
class ConstraintResult {
  constructor(passed, constraintName, message) {
    this.passed = passed
    this.constraintName = constraintName
    this.message = message
  }
}

// 技能最大 15KB（和 Hermes 实际一致）
const MAX_SKILL_SIZE = 15000
// 进化后不能比原始版本大 20% 以上
const MAX_GROWTH = 0.2

/**
 * 验证进化后的文本是否满足硬约束。不管分数多高，约束不过就拒绝。
 *
 * 四个约束直接对齐 Hermes 的 constraints.py：
 * 1. size_limit: 不超过 15KB
 * 2. growth_limit: 不超过原始大小的 120%
 * 3. non_empty: 不能为空
 * 4. skill_structure: 必须有合法的 markdown 结构
 */
class ConstraintValidator {
  /**
   * @param {string} text
   * @param {string|null} [baseline=null]
   * @returns {ConstraintResult[]}
   */
  validateAll(text, baseline = null) {
    const results = []
    results.push(this._checkSize(text))
    if (baseline) {
      results.push(this._checkGrowth(text, baseline))
    }
    results.push(this._checkNonEmpty(text))
    results.push(this._checkStructure(text))
    return results
  }

  /**
   * @param {string} text
   * @returns {ConstraintResult}
   */
  _checkSize(text) {
    const size = text.length
    if (size <= MAX_SKILL_SIZE) {
      return new ConstraintResult(true, 'size_limit', `${size}/${MAX_SKILL_SIZE} chars`)
    }
    return new ConstraintResult(false, 'size_limit', `exceeded: ${size}/${MAX_SKILL_SIZE}`)
  }

  /**
   * @param {string} text
   * @param {string} baseline
   * @returns {ConstraintResult}
   */
  _checkGrowth(text, baseline) {
    const growth = (text.length - baseline.length) / Math.max(1, baseline.length)
    if (growth <= MAX_GROWTH) {
      return new ConstraintResult(true, 'growth_limit', `${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(1)}%`)
    }
    return new ConstraintResult(false, 'growth_limit', `exceeded: ${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(1)}% (max ${(MAX_GROWTH * 100).toFixed(1)}%)`)
  }

  /**
   * @param {string} text
   * @returns {ConstraintResult}
   */
  _checkNonEmpty(text) {
    if (text.trim()) {
      return new ConstraintResult(true, 'non_empty', 'OK')
    }
    return new ConstraintResult(false, 'non_empty', 'artifact is empty')
  }

  /**
   * @param {string} text
   * @returns {ConstraintResult}
   */
  _checkStructure(text) {
    const trimmed = text.trim()
    const hasHeading = trimmed.startsWith('#') || trimmed.startsWith('---')
    if (hasHeading) {
      return new ConstraintResult(true, 'skill_structure', 'has valid structure')
    }
    return new ConstraintResult(false, 'skill_structure', 'missing heading or frontmatter')
  }
}

// 一次完整进化的结果
class EvolutionResult {
  constructor(originalText, evolvedText, originalScore, evolvedScore, iterations, improvement = 0.0, feedbacks = []) {
    this.originalText = originalText
    this.evolvedText = evolvedText
    this.originalScore = originalScore
    this.evolvedScore = evolvedScore
    this.iterations = iterations
    this.improvement = improvement
    this.feedbacks = feedbacks
  }
}

const MUTATE_PROMPT = `You are optimizing an AI agent skill file to improve performance.

CURRENT SKILL TEXT:
{current_text}

PERFORMANCE FEEDBACK from evaluation:
{feedback}

Based on this feedback, rewrite the skill text to address the issues.
Keep the same general purpose and structure, but improve:
- Clarity of instructions
- Handling of edge cases mentioned in feedback
- Step-by-step procedure

Return ONLY the improved skill text, no explanations.`

/**
 * 教学版优化器：模拟 GEPA 的核心思路，不依赖 DSPy。
 *
 * 真正的 GEPA 通过 dspy.GEPA() 驱动——它读执行 trace，
 * 理解"为什么"失败，然后做针对性变异。
 *
 * 这里的简化版做同样的事：
 * 1. 在 train set 上评估当前版本，收集 feedback
 * 2. 把 feedback 喂给 LLM，让它重写 skill
 * 3. 在 val set 上评估新版本
 * 4. 如果更好就保留，否则回退
 * 5. 重复
 */
class SkillOptimizer {
  /**
   * @param {boolean} [useLLM=true]
   */
  constructor(useLLM = true) {
    this.useLLM = useLLM
  }

  // 运行完整的优化循环
  async optimize(skillText, dataset, iterations = 5) {
    let current = skillText
    let best = skillText
    let bestScore = await this._scoreOnSplit(current, dataset.val)
    const originalScore = bestScore
    const allFeedbacks = []

    console.log(`  [evolve] baseline score: ${originalScore.toFixed(3)}`)

    for (let i = 0; i < iterations; i++) {
      // 1. 在 train set 上评估，收集 feedback
      const feedbacks = []
      for (const ex of dataset.train) {
        const fs = await evaluateSkill(current, ex, this.useLLM)
        if (fs.feedback) {
          feedbacks.push(fs.feedback)
        }
      }

      const combinedFeedback = feedbacks.slice(0, 5).join('\n')
      allFeedbacks.push(combinedFeedback)

      // 2. 让 LLM 基于 feedback 生成变异版本
      const variant = await this._mutate(current, combinedFeedback)
      if (!variant || variant.trim() === current.trim()) {
        console.log(`  [evolve] iter ${i + 1}: no change, skipping`)
        continue
      }

      // 3. 在 val set 上评估变异版本
      const variantScore = await this._scoreOnSplit(variant, dataset.val)

      // 4. 如果更好就保留
      if (variantScore > bestScore) {
        const improvement = variantScore - bestScore
        console.log(`  [evolve] iter ${i + 1}: ${bestScore.toFixed(3)} -> ${variantScore.toFixed(3)} (+${improvement.toFixed(3)})`)
        best = variant
        bestScore = variantScore
        current = variant
      } else {
        console.log(`  [evolve] iter ${i + 1}: ${variantScore.toFixed(3)} (no improvement)`)
      }
    }

    return new EvolutionResult(
      skillText,
      best,
      originalScore,
      bestScore,
      iterations,
      bestScore - originalScore,
      allFeedbacks,
    )
  }

  // 在一个数据子集上计算平均 composite 得分
  async _scoreOnSplit(skillText, examples) {
    if (!examples || examples.length === 0) {
      return 0.0
    }
    const scores = []
    for (const ex of examples) {
      const fs = await evaluateSkill(skillText, ex, this.useLLM)
      scores.push(fs.composite)
    }
    return scores.reduce((sum, s) => sum + s, 0) / scores.length
  }

  // 让 LLM 基于 feedback 重写 skill。
  async _mutate(currentText, feedback) {
    if (!feedback.trim()) {
      return currentText
    }

    const prompt = MUTATE_PROMPT.replace('{current_text}', currentText.slice(0, 5000))
      .replace('{feedback}', feedback.slice(0, 2000))

    try {
      const response = await model.invoke([new HumanMessage(prompt)], {
        maxTokens: 4000,
      })
      return response.content || currentText
    } catch (exc) {
      console.log(`  [evolve] mutation error: ${exc.message}`)
      return currentText
    }
  }
}

/**
 * 完整的 7 步进化管线，对齐 Hermes 的 evolve_skill.py。
 *
 * 1. 查找并加载 skill
 * 2. 生成评估数据集
 * 3. 验证 baseline 约束
 * 4. 运行优化器
 * 5. 验证进化后约束
 * 6. 在 holdout set 上评估
 * 7. 保存结果
 */
export async function evolveSkill(skillName, iterations = 5, useLLM = true) {
  const skillFile = path.join(SKILL_DIR, skillName, 'SKILL.md')
  let raw
  try {
    raw = await readFile(skillFile, 'utf-8')
  } catch {
    console.log(`  [evolve] skill '${skillName}' not found`)
    return null
  }

  const [metadata, body] = parseSkillFormatter(raw)
  console.log(`  [evolve] loaded: ${skillName} (${body.length} chars)`)

  // 2. 生成评估数据集
  console.log('  [evolve] generating eval dataset...')
  const builder = new SyntheticDatasetBuilder()
  const dataset = await builder.generate(body, 12)
  console.log(`  [evolve] dataset: ${dataset.train.length}t/${dataset.val.length}v/${dataset.holdout.length}h`)
  if (!dataset.train || dataset.train.length === 0) {
    console.log('  [evolve] no training examples generated, aborting')
    return null
  }

  // 3. 验证 baseline 约束
  const validator = new ConstraintValidator()
  const baselineChecks = validator.validateAll(body)
  for (const c of baselineChecks) {
    const tag = c.passed ? 'OK' : 'FAIL'
    console.log(`  [evolve] baseline ${c.constraintName}: ${tag} (${c.message})`)
  }

  // 4. 运行优化器
  console.log(`  [evolve] running optimizer (${iterations} iterations)...`)
  const optimizer = new SkillOptimizer(useLLM)
  const result = await optimizer.optimize(body, dataset, iterations)

  // 5. 验证进化后约束
  const evolvedChecks = validator.validateAll(result.evolvedText, body)
  let allPass = true
  for (const c of evolvedChecks) {
    const tag = c.passed ? 'OK' : 'FAIL'
    console.log(`  [evolve] evolved ${c.constraintName}: ${tag} (${c.message})`)
    if (!c.passed) {
      allPass = false
    }
  }
  if (!allPass) {
    console.log('  [evolve] FAILED constraint check, not deploying')
    return result
  }

  // 6. 在 holdout set 上评估
  if (dataset.holdout && dataset.holdout.length > 0) {
    const holdoutScore = await optimizer._scoreOnSplit(result.evolvedText, dataset.holdout)
    console.log(`  [evolve] holdout score: ${holdoutScore.toFixed(3)}`)
  }

  // 7. 保存结果（备份原始 + 写入进化版）
  if (result.improvement > 0) {
    const backupDir = path.join(SKILL_DIR, skillName, 'backups')
    await mkdir(backupDir, { recursive: true })
    const timestamp = new Date().toLocaleString('zh-CN').replace(/[:.]/g, '').slice(0, 15)
    await writeFile(path.join(backupDir, `SKILL_${timestamp}.md.bak`), raw, 'utf-8')
    const evolvedFull = loadSkill(
      metadata.name || skillName,
      metadata.description || '',
      result.evolvedText,
    )
    await writeFile(skillFile, evolvedFull, 'utf-8')
    console.log(`  [evolve] deployed! improvement: ${result.improvement >= 0 ? '+' : ''}${result.improvement.toFixed(3)}`)
  } else {
    console.log(`  [evolve] no improvement (${result.improvement >= 0 ? '+' : ''}${result.improvement.toFixed(3)}), keeping original`)
  }
  return result
}