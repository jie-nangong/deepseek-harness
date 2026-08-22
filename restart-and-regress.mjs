#!/usr/bin/env node
/**
 * 0.2.1（上游 0.1.1-rc.2）升级后的运行回归：
 *   重启 3080 服务（带 --no-open，不自动弹浏览器）→ 就绪探测 → 模型目录 live 校验 →
 *   repair-session-logs.mts 体检。
 * 独立后台运行，重启会短暂中断当前 GUI 会话，但脚本能完整跑完。
 * 用法：node restart-and-regress.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const PORT = 3080
const HOST = '127.0.0.1'

function sh(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], ...opts })
}
const pw = (cmd) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { cwd: ROOT, encoding: 'utf8' })
const report = []
const check = (name, ok, detail = '') => {
  report.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---- 0. 前置确认当前服务（旧构建）存在 ----
const listenPid = () => Number(String(pw(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`).stdout || '').trim())
const oldPid = listenPid()
console.log(`当前 3080 服务 pid=${oldPid}（旧构建）`)

// ---- 1. 定向终止旧服务（非 taskkill /T）----
if (oldPid > 0) {
  try { process.kill(oldPid, 'SIGTERM'); console.log(`已终止旧服务 pid=${oldPid}`) } catch (e) { console.log('终止旧服务跳过: ' + e.message) }
  await sleep(3000)
}

// ---- 2. 重新 spawn 服务（带 --no-open）----
const bin = `${ROOT}/apps/cli/src/bin.ts`
const child = spawn('node', ['--import', 'tsx/esm', bin, '--profile', 'web', '--host', HOST, '--port', String(PORT), '--no-open'], {
  cwd: ROOT, stdio: 'ignore', detached: true,
})
child.unref()
console.log(`已 spawn 新服务 pid=${child.pid}（--no-open）`)

// ---- 3. 就绪探测（最长 3 分钟）----
let ready = false
for (let i = 0; i < 36; i++) {
  await sleep(5000)
  const code = String(pw(`(Invoke-WebRequest -Uri 'http://${HOST}:${PORT}/' -UseBasicParsing -TimeoutSec 4).StatusCode`).stdout || '').trim()
  if (code === '200') { ready = true; break }
  console.log(`  就绪探测 #${i + 1}: ${code || '未响应'}`)
}
check('3080 服务就绪(200)', ready)

// ---- 4. 模型目录 live 校验（vision-exp + imagePixelBudget）----
const cat = pw(`(Invoke-WebRequest -Uri 'http://${HOST}:${PORT}/api/llm.models' -Method POST -Body '{"type":"client-request","rpcId":"reg","method":"llm.models","payload":{}}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 10).Content`)
let hasVision = false, hasBudget = false, ids = []
try {
  const j = JSON.parse(cat.stdout)
  const deep = j.result?.value?.groups?.find(g => g.id === 'deepseek-official')
  ids = (deep?.models ?? []).map(m => m.id)
  hasVision = ids.includes('deepseek-v4-flash-vision-exp')
  const full = readFileSync(`${ROOT}/packages/llm/llm-deepseek/src/index.ts`, 'utf8')
  hasBudget = full.includes('imagePixelBudget')
} catch (e) { console.log('模型目录解析失败: ' + e.message) }
check('模型目录含 vision-exp', hasVision, ids.join(', '))
check('模型目录含 imagePixelBudget(上游完整版)', hasBudget)

// ---- 5. repair-session-logs 体检 ----
const rep = sh('node', ['repair-session-logs.mts'], { stdio: 'pipe' })
const repOut = String(rep.stdout || '') + String(rep.stderr || '')
const okText = /11\/11|OK|正常|done|pass/i.test(repOut)
check('repair-session-logs.mts 体检通过', !rep.error && rep.status === 0, repOut.split('\n').slice(-2).join(' | '))

// ---- 6. 汇总 ----
const failed = report.filter(r => !r.ok)
console.log(`\n==== REGRESSION: ${report.length - failed.length}/${report.length} passed ====`)
writeFileSync(`${ROOT}/regression-0.2.1.result.json`, JSON.stringify(report, null, 2))
process.exit(failed.length ? 1 : 0)
