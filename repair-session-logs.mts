/**
 * dsh 会话日志体检 + 修复工具
 *
 * 用途：当 Web 界面能打开但某个会话历史报
 *   "history unavailable ... corrupt session log: seq gap in committed region"
 * 时，用本脚本扫描 ~/.dsh/sessions 下全部会话日志，并对可自动识别的
 * “重复写入（中断修复边界与真实续写各写了一份）”类损坏做备份+修复。
 *
 * 用法（在 deepseek-harness 仓库根目录运行）：
 *   node --import tsx/esm repair-session-logs.mts             # 只扫描报告，不改任何文件
 *   node --import tsx/esm repair-session-logs.mts --repair    # 扫描 + 修复可自动修复的日志（先备份）
 *
 * 修复前会先备份为 <原文件>.bak-<时间戳>；修复后会用读取器 + 回合结构
 * 双重校验，校验不过绝不覆盖原文件。
 */
import { readFileSync, writeFileSync, copyFileSync, statSync, renameSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { scanZstdFrames, createZstdFrameDecoder, compressZstdFrame } from './packages/session/session-persistence-jsonl/src/zstd.ts'
import { SessionLogScanner } from './packages/session/session-persistence-jsonl/src/format.ts'
import { decodeStorageRecord } from './packages/core/session/src/chunk-rows.ts'
import { foldScheduleEvents } from './packages/schedule/schedule/src/domain.ts'

const REPAIR = process.argv.includes('--repair')
const ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

interface LogFile { path: string; zstd: boolean }
function collectLogs(root: string): LogFile[] {
  const out: LogFile[] = []
  for (const project of readdirSync(root)) {
    const pp = join(root, project)
    let entries
    try { entries = readdirSync(pp, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dp = join(pp, e.name)
      let files
      try { files = readdirSync(dp) } catch { continue }
      for (const name of files) {
        if (name === 'session.jsonl.zstd') out.push({ path: join(dp, name), zstd: true })
        else if (name === 'session.jsonl') out.push({ path: join(dp, name), zstd: false })
      }
    }
  }
  return out
}

function decodeLog(log: LogFile): { text: string; frames: number } {
  const buffer = readFileSync(log.path)
  if (!log.zstd) return { text: buffer.toString('utf8'), frames: 0 }
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (tornStart !== undefined) throw new Error('torn tail (crash fragment) — 属可自动恢复的崩溃残留，非本次修复范围')
  if (frames.length === 0) throw new Error('empty zstd log')
  const dec = createZstdFrameDecoder()
  let text = ''
  for (const p of dec.decode(buffer, frames)) text += p.toString('utf8')
  dec.close()
  return { text, frames: frames.length }
}

function scan(text: string): { ok: boolean; error?: string; events: number } {
  const lines = text.split('\n')
  try {
    const scanner = new SessionLogScanner(Buffer.from(lines[0] + '\n'))
    scanner.write(Buffer.from(lines.slice(1).join('\n') + '\n'))
    const { events } = scanner.finish()
    return { ok: true, events: events.length }
  } catch (e) {
    return { ok: false, error: String((e as Error).message), events: 0 }
  }
}

/** 识别“中断修复边界 + 真实续写重复写入”模式；返回待删除的 4 行起始下标，找不到返回 -1。 */
function findSpuriousBoundary(lines: string[]): number {
  for (let i = 1; i < lines.length - 4; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    let p: any
    try { p = JSON.parse(l) } catch { continue }
    if (p.type !== 'tool/result' || typeof p.data?.message?.id !== 'string') continue
    if (!p.data.message.id.startsWith('interrupted-tool-result-')) continue
    let n1: any, n2: any, n3: any, n4: any
    try { n1 = JSON.parse(lines[i + 1]); n2 = JSON.parse(lines[i + 2]); n3 = JSON.parse(lines[i + 3]); n4 = JSON.parse(lines[i + 4]) } catch { continue }
    if (n1.type === 'step/end' && n2.type === 'turn/end' && n3.type === 'session/end-seed'
      && n4.type === 'tool/result' && n4.seq === p.seq) {
      return i
    }
  }
  return -1
}

function rebuild(log: LogFile, lines: string[], dropStart: number): Buffer | string {
  const kept = [...lines.slice(0, dropStart), ...lines.slice(dropStart + 4)]
  const headerLine = kept[0]
  const body = kept.slice(1).filter(l => l.trim() !== '').join('\n') + '\n'
  if (!log.zstd) return headerLine + '\n' + body
  return Buffer.concat([compressZstdFrame(headerLine + '\n'), compressZstdFrame(body)])
}

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

async function main(): Promise<number> {
  console.log(`会话日志根目录: ${ROOT}`)
  const logs = collectLogs(ROOT)
  console.log(`共发现 ${logs.length} 个会话日志${REPAIR ? '（修复模式）' : '（仅扫描，未改动任何文件）'}\n`)

  let ok = 0, fail = 0, repaired = 0, skipped = 0
  for (const log of logs) {
    let text: string
    try {
      text = decodeLog(log).text
    } catch (e) {
      console.log(`[跳过] ${basename(log.path)} :: ${(e as Error).message}`)
      skipped++
      continue
    }
    const result = scan(text)
    if (result.ok) {
      console.log(`[正常] ${basename(log.path)}  events=${result.events}`)
      ok++
      continue
    }
    fail++
    console.log(`[损坏] ${basename(log.path)} :: ${result.error}`)
    if (!REPAIR) continue

    const lines = text.split('\n')
    const dropStart = findSpuriousBoundary(lines)
    if (dropStart === -1) {
      console.log(`        该损坏模式无法自动识别，请把上面报错发给我人工处理（不动文件）`)
      skipped++
      continue
    }
    const dropped = lines.slice(dropStart, dropStart + 4).map(l => { const p = JSON.parse(l) as any; return `seq=${p.seq} ${p.type}` }).join('; ')
    const rebuilt = rebuild(log, lines, dropStart)
    // 校验：读取器 + 回合结构，通不过就放弃
    const checkText = typeof rebuilt === 'string' ? rebuilt : (() => {
      const buffer = rebuilt as Buffer
      const { frames } = scanZstdFrames(buffer)
      const dec = createZstdFrameDecoder()
      let t = ''
      for (const p of dec.decode(buffer, frames)) t += p.toString('utf8')
      dec.close()
      return t
    })()
    const check = scan(checkText)
    if (!check.ok) { console.log(`        修复后校验失败，放弃：${check.error}`); skipped++; continue }
    const evs = checkText.split('\n').slice(1).flatMap(l => { try { const p = JSON.parse(l); return p && p.type === 'session' ? [] : decodeStorageRecord(p) } catch { return [] } })
    try {
      foldScheduleEvents(evs, 0)
    } catch (e) {
      console.log(`        修复后回合结构校验失败，放弃：${(e as Error).message}`)
      skipped++
      continue
    }
    // 备份 + 写入
    const backup = log.path + '.bak-' + STAMP
    copyFileSync(log.path, backup)
    const tmpWrite = log.path + '.fixed-' + STAMP
    writeFileSync(tmpWrite, rebuilt)
    renameSync(tmpWrite, log.path)
    const after = statSync(log.path)
    console.log(`        已修复：删除 4 行重复边界（${dropped}）→ events=${check.events}，备份: ${basename(backup)}，新大小 ${after.size} 字节`)
    repaired++
  }

  console.log(`\n汇总: 正常 ${ok}，损坏 ${fail}，已修复 ${repaired}，跳过 ${skipped}`)
  return fail - repaired > 0 ? 1 : 0
}

main().then(code => process.exit(code))
