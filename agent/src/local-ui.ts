/**
 * Local terminal UI — makes claude-remote feel like a native terminal experience.
 * Colorized output, input prompt, status indicators, and clear message separation.
 */

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const MAGENTA = '\x1b[35m'
const BLUE = '\x1b[34m'
const BG_DIM = '\x1b[48;5;236m'

// Box-drawing chars
const HR = '─'.repeat(60)

export function printBanner(version: string, project: string, hub: string, resume?: string) {
  console.log('')
  console.log(`  ${BOLD}${CYAN}Remo Code Agent${RESET} ${DIM}v${version}${RESET}`)
  console.log(`  ${DIM}${HR}${RESET}`)
  console.log(`  ${DIM}Project:${RESET} ${project}`)
  console.log(`  ${DIM}Hub:${RESET}     ${hub}`)
  if (resume) console.log(`  ${DIM}Resume:${RESET}  ${resume}`)
  console.log('')
}

export function printConnected(sessionId: string) {
  console.log(`  ${GREEN}●${RESET} Connected ${DIM}(session ${sessionId.slice(0, 8)})${RESET}`)
  console.log(`  ${DIM}Send messages from the web UI or type below${RESET}`)
  console.log(`  ${DIM}${HR}${RESET}`)
  console.log('')
}

export function printUserMessage(content: string) {
  console.log(`${GREEN}${BOLD}You:${RESET} ${content}`)
  console.log('')
}

export function printThinking(content: string) {
  // Thinking in dim italic
  process.stdout.write(`${DIM}${ITALIC}${content}${RESET}`)
}

export function printThinkingEnd() {
  console.log('')
  console.log('')
}

export function printToolUse(tool: string, input: unknown) {
  // Tool name in cyan with icon
  const inputStr = typeof input === 'object' ? JSON.stringify(input) : String(input)
  const preview = inputStr.length > 80 ? inputStr.slice(0, 80) + '...' : inputStr
  console.log(`  ${CYAN}⚡ ${tool}${RESET} ${DIM}${preview}${RESET}`)
}

export function printToolResult(content: string, isError?: boolean) {
  if (isError) {
    const preview = content.slice(0, 200)
    console.log(`  ${RED}✗ ${preview}${RESET}`)
  } else {
    const lines = content.split('\n')
    const preview = lines.length > 3 ? lines.slice(0, 3).join('\n') + `\n  ${DIM}... (${lines.length} lines)${RESET}` : content
    if (preview.trim()) {
      console.log(`  ${DIM}✓ ${preview.split('\n').join(`\n  ${DIM}`)}${RESET}`)
    } else {
      console.log(`  ${DIM}✓ Done${RESET}`)
    }
  }
  console.log('')
}

export function printTextDelta(content: string) {
  process.stdout.write(content)
}

export function printResponseEnd(cost: number, durationMs: number) {
  console.log('')
  console.log(`  ${DIM}$${cost.toFixed(4)} · ${(durationMs / 1000).toFixed(1)}s${RESET}`)
  console.log('')
}

export function printStatus(state: string) {
  if (state === 'thinking') {
    process.stdout.write(`${DIM}${ITALIC}`)
  }
}

export function printDisconnected() {
  console.log(`  ${YELLOW}● Disconnected${RESET} ${DIM}— reconnecting...${RESET}`)
}

export function printPermissionRequest(toolName: string, toolInput: unknown) {
  const inputStr = typeof toolInput === 'object' ? JSON.stringify(toolInput) : String(toolInput)
  const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '...' : inputStr
  console.log(`  ${YELLOW}⚠ Permission needed:${RESET} ${BOLD}${toolName}${RESET}`)
  console.log(`  ${DIM}${preview}${RESET}`)
  console.log(`  ${DIM}Approve from web UI at https://app.remo-code.com${RESET}`)
  console.log('')
}

export function printQuestion(question: string, options?: Array<{ label: string; description?: string }>) {
  console.log(`  ${MAGENTA}? ${BOLD}Question:${RESET} ${question}`)
  if (options?.length) {
    for (const opt of options) {
      const desc = opt.description ? ` ${DIM}— ${opt.description}${RESET}` : ''
      console.log(`    ${MAGENTA}•${RESET} ${opt.label}${desc}`)
    }
  }
  console.log(`  ${DIM}Answer from web UI at https://app.remo-code.com${RESET}`)
  console.log('')
}

export function printError(message: string) {
  console.log(`  ${RED}✗ ${message}${RESET}`)
}
