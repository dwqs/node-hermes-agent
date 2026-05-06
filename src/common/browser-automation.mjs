import { z } from 'zod'

/** 
 * 模拟浏览器自动化
*/

class PageElement {
  /**
   * @param {string} ref - 'e1', 'e2', ...
   * @param {string} role - 'link', 'button', 'textbox', 'heading', ...
   * @param {string} name - visible text / label
   * @param {string} [value=''] - current value (for inputs)
   */
  constructor(ref, role, name, value = '') {
    this.ref = ref
    this.role = role
    this.name = name
    this.value = value
  }
}

class SimulatedPage {
  /**
   * A fake web page with a title, URL, and interactive elements.
   * @param {string} url - page URL
   * @param {string} title - page title
   * @param {PageElement[]} [elements=[]] - interactive elements
   */
  constructor(url, title, elements = []) {
    this.url = url
    this.title = title
    this.elements = elements
  }
}

 /**
 * An in-memory mock browser for testing the browser tool flow.
 *
 * No real Chromium, no CDP, no Node.js -- just JavaScript objects simulating
 * pages with accessibility trees. Demonstrates how browser_navigate,
 * browser_click, browser_type, and browser_snapshot work end-to-end.
 */
class SimulatedBrowser {
  constructor() {
    this._currentPage = null
    this._history = []
    this._cookies = {}

    this._pages = {
      'https://github.com': new SimulatedPage(
        'https://github.com',
        'GitHub',
        [
          new PageElement('e1', 'link', 'Sign in'),
          new PageElement('e2', 'link', 'Sign up'),
          new PageElement('e3', 'search', 'Search GitHub'),
          new PageElement('e4', 'heading', "Let's build from here"),
        ],
      ),
      'https://github.com/login': new SimulatedPage(
        'https://github.com/login',
        'Sign in to GitHub',
        [
          new PageElement('e1', 'textbox', 'Username'),
          new PageElement('e2', 'textbox', 'Password'),
          new PageElement('e3', 'button', 'Sign in'),
        ],
      ),
      'https://github.com/search': new SimulatedPage(
        'https://github.com/search',
        'Search results',
        [
          new PageElement('e1', 'link', 'NousResearch/hermes-agent'),
          new PageElement('e2', 'text', 'Self-improving AI agent'),
          new PageElement('e3', 'link', 'NousResearch/hermes-agent-ui'),
          new PageElement('e4', 'text', 'Web UI for Hermes Agent'),
        ],
      ),
    }
  }

  navigate(url) {
    if(this._currentPage) {
      this._history.push(this._currentPage.url)
    }

    let page = this._pages[url]
    if(!page) {
      page = new SimulatedPage(url, `Page: ${url}`,[
        new PageElement('e1', 'text', `Content of ${url}`),
      ])
    }

    this._currentPage = page
    return this.snapshot()
  }

  // Return the accessibility tree of the current page
  snapshot() {
    if(!this._currentPage) {
      return '(no page loaded)'
    }

    const lines = [
      `page '${this._currentPage.title}' url='${this._currentPage.url}'`,
    ]
    for (const el of this._currentPage.elements) {
      const valuePart = el.value ? ` value='${el.value}'` : ''
      lines.push(`  ${el.role} '${el.name}' [ref=${el.ref}]${valuePart}`)
    }
    return lines.join('\n')
  }

  click(ref) {
    if(!this._currentPage) {
      return '(no page loaded)'
    }

    const element = this._findElement(ref)
    if (!element) {
      return `(error: element ${ref} not found)`
    }

    if (element.role === 'link' && element.name === 'Sign in') {
      return this.navigate('https://github.com/login')
    }

    if (element.role === 'button' && element.name === 'Sign in') {
      this._cookies.session = 'logged_in';
      return `Clicked '${element.name}'. Login successful.`
    }
    return `Clicked '${element.name}'.`
  }

  typeText(ref, text) {
    if(!this._currentPage) {
      return '(no page loaded)'
    }

    const element = this._findElement(ref)
    if (!element) {
      return `(error: element ${ref} not found)`
    }
    element.value = text
    return `Typed '${text}' into '${element.name}'.`
  }

  pressKey(key) {
    if (
      this._currentPage &&
      this._currentPage.url === 'https://github.com' &&
      key.toLowerCase() === 'enter'
    ) {
      return this.navigate('https://github.com/search')
    }
    return `Pressed ${key}.`
  }

  back() {
    if (this._history.length === 0) {
      return '(no history)'
    }
    const url = this._history.pop()
    return this.navigate(url)
  }

  console(expression = '') {
    if (!expression) {
      return '(no console errors)'
    }
    if (expression === 'document.title') {
      return this._currentPage ? this._currentPage.title : ''
    }
    if (expression === 'document.cookie') {
      return Object.entries(this._cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
    }
    return `(eval: ${expression})`
  }

  _findElement(ref) {
    if(!this._currentPage) {
      return null
    }

    for (const el of this._currentPage.elements) {
      if(el.ref === ref) {
        return el
      }
    }
    return null
  }
}

const browser = new SimulatedBrowser()

export const browserTools = [
  {
    handler: browser.navigate.bind(browser),
    meta: {
      name: 'browser_navigate',
      description: '浏览器导航到指定URL',
      schema: z.object({
        url: z.string().describe('要访问的URL'),
      }),
    }
  },
  {
    handler: browser.click.bind(browser),
    meta: {
      name: 'browser_click',
      description: '浏览器点击指定元素',
      schema: z.object({
        ref: z.string().describe('要点击的元素的引用'),
      }),
    }
  },
  {
    handler: browser.typeText.bind(browser),
    meta: {
      name: 'browser_click',
      description: '输入文本到指定元素',
      schema: z.object({
        ref: z.string().describe('要输入的元素的引用'),
        text: z.string().describe('要输入的文本'),
      }),
    }
  },
  {
    handler: browser.pressKey.bind(browser),
    meta: {
      name: 'browser_press',
      description: '按压键盘按键',
      schema: z.object({
        key: z.string().describe('键盘按键'),
      }),
    }
  },
  {
    handler: browser.back.bind(browser),
    meta: {
      name: 'browser_back',
      description: '浏览器后退',
    }
  },
  {
    handler: browser.console.bind(browser),
    meta: {
      name: 'browser_console',
      description: '浏览器控制台执行表达式',
      schema: z.object({
        expression: z.string().describe('要执行的表达式'),
      }),
    }
  },
]