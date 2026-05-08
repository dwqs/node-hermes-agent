import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'

// 这里用最简实现教核心思路：feedback → mutate → evaluate → select

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