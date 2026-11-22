/**
 * TikTok 本地化流水线 — Host 半边。
 *
 * 批量接收 TikTok 链接（或本地视频），逐条执行：
 *   获取视频 → 画面 OCR（默认；可选并行 ASR）→ 文字事件聚类 → 模型翻译并起标题正文
 *   → 抹除引流信息 + 烧录单行中文字幕 → jpg 封面 → 「序号 已完成」文件夹 → 汇总 Excel
 *
 * 对外暴露：认证的 /api/tiktok-localizer/* 路由（左侧栏面板使用）与 tiktok_localizer 工具。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.join(HERE, 'runtime')
const FFMPEG = path.join(RUNTIME, 'bin', 'ffmpeg')
const OCR = path.join(RUNTIME, 'bin', 'ocrmix')
const FONT = path.join(RUNTIME, 'fonts', 'NotoSansSC-Bold.ttf')
const HELLOTIK = path.join(os.homedir(), '.dsh', 'skills', 'hellotik-tiktok-downloader', 'scripts', 'hellotik.py')
const HELLOTIK_PY = path.join(os.homedir(), 'Downloads', '.venv', 'bin', 'python')
const HELLOTIK_CDP = 'http://127.0.0.1:9222'

const DEFAULTS = {
  outputRoot: '',
  concurrency: 2,
  asrModel: 'small',
  ocrLangs: 'ja-JP,ko-KR,en-US',
  fps: 4,
  maxCharsPerLine: 26,
  provider: '',
  model: '',
  proxy: '',
  downloaders: 'ytdlp,tikwm,hellotik',
  cdp: '',
  python: '',
  ytdlpPath: '',
  ffmpegPath: '',
  ocrPath: '',
  retainWork: false,
  asrMode: 'ocr',
  textScope: 'important',
  qc: true,
  visionQc: true,
  visionFrames: 8,
  qcFps: 1,
}

const SYSTEM_PROMPT = [
  '你是海外短视频本地化编辑，服务对象是中国平台的成品交付。',
  '你只输出一个 JSON 对象，不写解释、不加代码块标记。',
  '中文必须适合短视频：口语、准确、不夸张、不出现 AI 腔（例如“让我们来看看”“总的来说”“在这个视频中”）。',
].join('\n')

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function extractLinks(text) {
  return (String(text || '').match(/https?:\/\/[^\s"'<>]+/g) || [])
    .map((u) => u.replace(/[),.;]+$/, ''))
}

function normalizeInputs(raw) {
  const entries = Array.isArray(raw) ? raw.map(String) : String(raw || '').split(/\r?\n/)
  const out = []
  for (const entry of entries) {
    const text = String(entry || '').trim()
    if (!text) continue
    const urls = extractLinks(text)
    if (urls.length) {
      for (const u of urls) out.push({ kind: 'url', value: u })
      continue
    }
    out.push({ kind: 'file', value: text.replace(/^file:\/\//, '') })
  }
  return out
}

async function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    try {
      await stat(path.join(dir, cmd))
      return path.join(dir, cmd)
    } catch {}
  }
  return ''
}

const MEDIA_WORKSPACE = '/Volumes/Data/媒老板'

function defaultOutputRoot() {
  try {
    if (existsSync(MEDIA_WORKSPACE)) return path.join(MEDIA_WORKSPACE, '海外视频本地化')
  } catch {}
  return path.join(os.homedir(), 'Downloads', '海外视频本地化')
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function parseModelJson(text) {
  const body = String(text || '').trim()
  const candidates = []
  if (body) candidates.push(body)
  for (const m of body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1].trim())
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(body.slice(start, end + 1))
  let depth = 0
  let open = -1
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '{') {
      if (depth === 0) open = i
      depth += 1
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && open >= 0) {
          candidates.push(body.slice(open, i + 1))
          open = -1
        }
      }
    }
  }
  let lastError = null
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i])
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`不是合法 JSON（${lastError ? lastError.message : '空输出'}）`)
}

class Localizer {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.jobs = new Map()
    this.aborts = new Map()
    this.latestId = null
  }

  async resolveProxy() {
    if (this.config.proxy) return this.config.proxy
    let port = 0
    try {
      port = await new Promise((resolve) => {
        const socket = new Socket()
        const done = (value) => { socket.destroy(); resolve(value) }
        socket.setTimeout(800)
        socket.once('connect', () => done(7890))
        socket.once('timeout', () => done(0))
        socket.once('error', () => done(0))
        socket.connect(7890, '127.0.0.1')
      })
    } catch { port = 0 }
    return port ? 'http://127.0.0.1:7890' : ''
  }

  async findYtdlp() {
    if (this.config.ytdlpPath && existsSync(this.config.ytdlpPath)) return this.config.ytdlpPath
    const onPath = await which('yt-dlp')
    if (onPath) return onPath
    for (const candidate of [
      path.join(os.homedir(), 'Downloads', '.venv', 'bin', 'yt-dlp'),
      '/opt/homebrew/bin/yt-dlp',
      '/usr/local/bin/yt-dlp',
    ]) {
      if (existsSync(candidate)) return candidate
    }
    return ''
  }

  async cdpAlive() {
    try {
      const out = await this.curl([(this.config.cdp || HELLOTIK_CDP) + '/json/version'], undefined, 4)
      return /Browser/.test(out)
    } catch {
      return false
    }
  }

  runProcess(command, args, { signal, cwd, env, onLine } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { signal, cwd, env: env ? { ...process.env, ...env } : process.env })
      let stdout = ''
      let stderr = ''
      let buf = ''
      child.stdout.on('data', (d) => {
        const text = String(d)
        stdout += text
        buf += text
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trimEnd()
          buf = buf.slice(idx + 1)
          if (line && onLine) onLine(line)
        }
      })
      child.stderr.on('data', (d) => { stderr += String(d) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  async capabilities() {
    const ffmpeg = this.config.ffmpegPath || (existsSync(FFMPEG) ? FFMPEG : await which('ffmpeg'))
    const python = this.config.python || (await which('python3'))
    let selection = { provider: '', model: '' }
    try {
      const sel = this.ctx.agentDefaultModel?.currentSelection?.()
      if (sel) selection = { provider: sel.provider || '', model: sel.model || '' }
    } catch {}
    return {
      ffmpeg: Boolean(ffmpeg),
      ffmpegPath: ffmpeg,
      ocr: existsSync(this.config.ocrPath || OCR),
      python: Boolean(python),
      pythonPath: python,
      font: existsSync(FONT),
      asr: existsSync(path.join(RUNTIME, 'pylib', 'faster_whisper')),
      download: {
        hellotik: existsSync(HELLOTIK) && existsSync(HELLOTIK_PY),
        cdp: await this.cdpAlive(),
        ytdlp: Boolean(await this.findYtdlp()),
      },
      llm: {
        provider: this.config.provider || selection.provider,
        model: this.config.model || selection.model,
      },
      defaults: {
        concurrency: this.config.concurrency,
        asrModel: this.config.asrModel,
        maxCharsPerLine: this.config.maxCharsPerLine,
        outputRoot: this.config.outputRoot,
      },
    }
  }

  async start({ links, outputRoot, concurrency }) {
    const items = normalizeInputs(links)
    if (items.length === 0) return { ok: false, error: '没有可处理的链接或本地文件' }
    const caps = await this.capabilities()
    if (!caps.ffmpeg) return { ok: false, error: '未找到 ffmpeg（可在插件配置里设置 ffmpegPath）' }
    if (!caps.ocr) return { ok: false, error: '未找到 OCR 组件 runtime/bin/ocrmix' }
    if (!caps.python) return { ok: false, error: '未找到 python3' }
    if (!caps.llm.provider || !caps.llm.model) return { ok: false, error: '没有可用的对话模型，请先在设置里选择模型' }

    const root = String(outputRoot || this.config.outputRoot
      || defaultOutputRoot()).trim()
    const batch = path.join(root, `批次-${stamp()}`)
    const id = crypto.randomUUID()
    const job = {
      id,
      status: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      root: batch,
      workRoot: path.join(batch, '_work'),
      excel: null,
      error: null,
      log: [],
      caps,
      options: { concurrency: 1, ordered: true },
      items: items.map((item, i) => ({
        index: i + 1,
        input: item.value,
        kind: item.kind,
        name: item.kind === 'url' ? item.value : path.basename(item.value),
        stage: 'queued',
        progress: 0,
        message: '等待处理',
        title: '',
        folder: '',
        coverUrl: '',
        error: '',
      })),
    }
    await mkdir(job.workRoot, { recursive: true })
    await writeFile(path.join(job.workRoot, 'job.json'), JSON.stringify({
      id, createdAt: job.createdAt, root: batch,
      items: job.items.map((it) => ({ index: it.index, input: it.input, kind: it.kind, name: it.name })),
    }, null, 1))
    this.jobs.set(id, job)
    this.latestId = id
    for (const [key, old] of this.jobs) {
      if (this.jobs.size <= 10) break
      if (old.status !== 'running' && key !== id) {
        this.jobs.delete(key)
        this.aborts.delete(key)
      }
    }
    const ac = new AbortController()
    this.aborts.set(id, ac)
    void this.run(job, ac).catch((err) => {
      job.status = 'failed'
      job.error = String(err && err.message ? err.message : err)
      job.finishedAt = new Date().toISOString()
      this.note(job, `批次失败：${job.error}`)
    })
    return { ok: true, jobId: id, job: this.snapshot(job) }
  }

  note(job, line) {
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
    if (job.log.length > 240) job.log.splice(0, job.log.length - 240)
  }

  update(job, item, patch) {
    Object.assign(item, patch)
    if (patch.stage) this.note(job, `#${item.index} ${patch.stage}${patch.message ? ' · ' + patch.message : ''}`)
  }

  snapshot(job) {
    if (!job) return null
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      root: job.root,
      excel: job.excel,
      error: job.error,
      options: job.options,
      caps: job.caps,
      log: job.log.slice(-80),
      items: job.items.map((it) => ({ ...it })),
    }
  }

  state() {
    return {
      jobs: [...this.jobs.values()].slice(-8).map((j) => ({
        id: j.id, status: j.status, createdAt: j.createdAt, root: j.root,
        total: j.items.length, done: j.items.filter((i) => i.stage === 'done').length,
        review: j.items.filter((i) => i.qc && i.qc.verdict !== 'pass').length,
      })),
      latest: this.snapshot(this.jobs.get(this.latestId)),
    }
  }

  stop(jobId) {
    const job = this.jobs.get(jobId || this.latestId)
    if (!job) return { ok: false, error: '任务不存在' }
    if (job.status !== 'running') return { ok: false, error: '任务已结束' }
    this.aborts.get(job.id)?.abort()
    job.status = 'stopped'
    job.finishedAt = new Date().toISOString()
    for (const it of job.items) {
      if (['queued', 'download', 'analyze', 'translate', 'render', 'rendered', 'deliver'].includes(it.stage)) {
        it.stage = 'stopped'
        it.message = '已停止'
      }
    }
    this.note(job, '已停止')
    return { ok: true }
  }

  async latestJobFile() {
    const root = this.config.outputRoot || defaultOutputRoot()
    let names = []
    try {
      names = (await readdir(root)).filter((n) => n.startsWith('批次-')).sort()
    } catch {
      return null
    }
    for (let i = names.length - 1; i >= 0; i -= 1) {
      const file = path.join(root, names[i], '_work', 'job.json')
      if (existsSync(file)) {
        try {
          return JSON.parse(await readFile(file, 'utf8'))
        } catch {}
      }
    }
    return null
  }

  async retry(jobId, indexes) {
    const wanted = Array.isArray(indexes) && indexes.length ? new Set(indexes.map(Number)) : null
    const origin = this.jobs.get(jobId || this.latestId)
    if (origin && origin.status === 'running') return { ok: false, error: '批次还在跑，先等它结束或停止' }

    let file = null
    let root = origin ? origin.root : ''
    let workRoot = origin ? origin.workRoot : ''
    if (!root) {
      file = await this.latestJobFile()
      if (!file) return { ok: false, error: '找不到可重试的批次记录' }
      root = file.root
      workRoot = path.join(root, '_work')
    }
    if (!file && existsSync(path.join(workRoot, 'job.json'))) {
      try { file = JSON.parse(await readFile(path.join(workRoot, 'job.json'), 'utf8')) } catch {}
    }

    const known = new Map()
    const remember = (idx, input) => {
      const n = Number(idx)
      if (Number.isInteger(n) && n > 0 && input) known.set(n, String(input))
    }
    if (origin) for (const it of origin.items) remember(it.index, it.input)
    if (file && Array.isArray(file.items)) for (const it of file.items) remember(it.index, it.input)

    let folders = []
    try { folders = await readdir(root) } catch {}
    for (const name of folders) {
      const m = /^(\d+) 已完成$/.exec(name)
      if (!m) continue
      try {
        const meta = JSON.parse(await readFile(path.join(root, name, 'meta.json'), 'utf8'))
        remember(m[1], meta.link)
      } catch {}
    }

    const inputOf = async (idx) => {
      if (known.get(idx)) return known.get(idx)
      try {
        const src = JSON.parse(await readFile(path.join(workRoot, String(idx), 'source.json'), 'utf8'))
        if (src && src.link) return src.link
      } catch {}
      return ''
    }

    let targets
    if (wanted) {
      targets = [...wanted]
    } else if (origin) {
      targets = origin.items.filter((it) => it.stage === 'error').map((it) => it.index)
    } else if (file && Array.isArray(file.items)) {
      targets = file.items
        .filter((it) => !existsSync(path.join(root, `${it.index} 已完成`)))
        .map((it) => Number(it.index))
    } else {
      targets = []
    }
    if (targets.length === 0) return { ok: false, error: '没有需要重试的条目' }

    const items = []
    for (const idx of targets) {
      const input = await inputOf(idx)
      if (!input) continue
      items.push({
        index: Number(idx), input, kind: /^https?:\/\//i.test(input) ? 'url' : 'file',
        name: String(input).split('/').pop() || input,
      })
    }
    if (items.length === 0) return { ok: false, error: '这些条目缺少可重试的链接' }

    const id = crypto.randomUUID()
    const job = {
      id,
      status: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      root,
      workRoot,
      excel: origin ? origin.excel : null,
      error: null,
      log: [],
      caps: (origin && origin.caps) || (await this.capabilities()),
      options: { concurrency: 1, ordered: true, retryOf: origin ? origin.id : (file && file.id) },
      items: items.map((it) => ({
        index: it.index,
        input: it.input,
        kind: it.kind,
        name: it.name,
        stage: 'queued',
        progress: 0,
        message: '等待重试',
        title: '',
        folder: '',
        coverUrl: '',
        error: '',
      })),
    }
    this.jobs.set(id, job)
    this.latestId = id
    const ac = new AbortController()
    this.aborts.set(id, ac)
    this.note(job, `重试 ${job.items.length} 条：${job.items.map((i) => i.index).join(', ')} → ${job.root}`)
    void this.run(job, ac).catch((err) => {
      job.status = 'failed'
      job.error = String(err && err.message ? err.message : err)
      job.finishedAt = new Date().toISOString()
      this.note(job, `重试批次失败：${job.error}`)
    })
    return { ok: true, jobId: id, job: this.snapshot(job), retried: job.items.map((it) => it.index) }
  }

  async runQc(job, item, signal) {
    if (!this.config.qc) return null
    const work = path.join(job.workRoot, String(item.index))
    let result = null
    try {
      const res = await this.runPython(['qc.py', '--work', work, '--index', String(item.index),
        '--out', job.root, '--ffmpeg', this.config.ffmpegPath || FFMPEG,
        '--ocr', this.config.ocrPath || OCR, '--fps', String(this.config.qcFps)], job, item, signal)
      result = this.parseMarker(res.stdout, 'QC_OK')
    } catch (err) {
      this.note(job, `#${item.index} 质检脚本失败：${err.message}`)
      return null
    }
    let detail = {}
    try { detail = JSON.parse(await readFile(path.join(work, 'qc.json'), 'utf8')) } catch {}
    const issues = detail.issues || []
    const review = await this.reviewSubtitles(job, item, work, issues, signal)
    const vision = await this.visionQc(job, item, signal)
    if (!review) this.note(job, `#${item.index} 文本质检未完成（模型无响应）`)
    const merged = {
      verdict: !review ? 'warn' : (review.verdict === 'fail' ? 'fail' : (result.verdict || 'pass')),
      counts: result.counts || {},
      issues: issues.slice(0, 40),
      review: review || null,
      checkedAt: new Date().toISOString(),
    }
    if (review && Array.isArray(review.issues)) merged.issues = merged.issues.concat(review.issues.map((x) => ({ ...x, source: 'review' })))
    if (vision) {
      merged.vision = vision
      merged.issues = merged.issues.concat((vision.issues || []).map((x) => ({ ...x, source: 'vision' })))
    }
    if (merged.issues.some((i) => i.severity === 'high') || (review && review.verdict === 'fail') || (vision && vision.verdict === 'fail')) merged.verdict = 'fail'
    else if (merged.issues.length > 0 || (review && review.verdict === 'warn')) merged.verdict = merged.verdict === 'fail' ? 'fail' : 'warn'
    await writeFile(path.join(work, 'qc.json'), JSON.stringify(merged, null, 1))
    return merged
  }

  async visionQc(job, item, signal) {
    if (!this.config.visionQc || !this.ctx.attachments) return null
    const folder = path.join(job.root, `${item.index} 已完成`)
    let meta = {}
    try { meta = JSON.parse(await readFile(path.join(folder, 'meta.json'), 'utf8')) } catch { return null }
    const video = path.join(folder, meta.video || '')
    if (!existsSync(video)) return null
    const duration = Number(meta.duration) || 10
    const count = Math.max(3, Math.min(12, Number(this.config.visionFrames) || 8))
    const times = []
    for (let i = 0; i < count; i += 1) times.push(Math.round((duration * (i + 0.5) / count) * 10) / 10)

    const refs = []
    for (const t of times) {
      const out = path.join(job.workRoot, String(item.index), `vq_${t}.jpg`)
      try {
        await this.runProcess(this.config.ffmpegPath || FFMPEG, ['-hide_banner', '-loglevel', 'error',
          '-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out], { signal })
        const bytes = await readFile(out)
        const ref = await this.ctx.attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/jpeg', name: `frame-${t}s.jpg` })
        refs.push({ t, ref })
        await rm(out, { force: true })
      } catch (err) {
        this.note(job, `#${item.index} 抽帧失败 ${t}s：${err.message}`)
      }
    }
    if (refs.length === 0) return null

    const text = [
      '## 任务',
      '这些是成品短视频的抽帧（按时间顺序，每张前面标了秒数）。逐张看，检查下面几类问题：',
      '1. 画面里还有没有没抹掉的、**明显**的价格、折扣、优惠券、关注/点赞/私信/链接/店铺等引流信息或博主水印 logo；',
      '   （价格只在“一眼能看清”时算问题：大号价格条、画面中央的价签；商品包装上印刷的微小价格字样不算，忽略它。）',
      '2. 烧录的中文字幕是否清晰、单行、位置偏下、没有叠字/错字/被遮挡；',
      '3. 字幕与画面内容是否对得上（有没有明显错位或答非所问）；',
      '4. 画面是否与标题正文相符。',
      '',
      `标题：${item.title || ''}`,
      `正文：${item.qcBody || ''}`,
      '',
      '## 只输出 JSON',
      '{"verdict":"pass|warn|fail","issues":[{"type":"price|watermark|subtitle|logic|mismatch","t":12.3,"problem":"看到什么","advice":"怎么改"}]}',
      '只列确实看到的问题，最多 8 条；没有问题就 {"verdict":"pass","issues":[]}。',
    ].join('\n')
    const content = [{ type: 'text', text }]
    for (const r of refs) {
      content.push({ type: 'text', text: `第 ${r.t}s 帧：` })
      content.push({ type: 'image', attachment: r.ref })
    }
    try {
      const raw = await this.callModelMessages([{ role: 'user', content }], signal, job)
      const parsed = parseModelJson(raw)
      if (!parsed || typeof parsed !== 'object') return null
      return {
        verdict: String(parsed.verdict || 'warn'),
        issues: Array.isArray(parsed.issues) ? parsed.issues.map((x) => ({ ...x, source: 'vision' })) : [],
        frames: refs.map((r) => r.t),
      }
    } catch (err) {
      this.note(job, `#${item.index} 视觉质检失败：${err.message}`)
      return null
    }
  }

  async reviewSubtitles(job, item, work, issues, signal) {
    try {
      const lines = []
      const srt = await readFile(path.join(job.root, `${item.index} 已完成`, '中外对照字幕.srt'), 'utf8')
      const blocks = srt.replace(/\r/g, '').split(/\n\n+/).filter((b) => b.trim())
      for (const block of blocks.slice(0, 120)) {
        const rows = block.split('\n')
        if (rows.length < 3) continue
        const src = rows[2] || ''
        const zh = rows[rows.length - 1] || ''
        lines.push(`${rows[1].split(' --> ')[0]} ${src} -> ${zh}`)
      }
      const prompt = [
        '## 任务',
        '你在做短视频中文字幕的质检。判断译文中是否存在：错译、漏译、逻辑不通、机器翻译腔（没有活人感）、以及与标题正文不符。',
        '',
        '## 标题与正文',
        `标题：${item.title || ''}`,
        `正文：${item.qcBody || ''}`,
        '',
        '## 字幕（时间 原文 -> 中文）',
        lines.join('\n') || '（无）',
        '',
        '## 机器检查已发现的问题',
        issues.slice(0, 12).map((i) => `${i.type} ${i.t}s ${i.detail || ''}`).join('\n') || '（无）',
        '',
        '## 输出 JSON',
        '{"verdict":"pass|warn|fail","issues":[{"type":"logic|tone|accuracy|title","t":12.3,"problem":"...","advice":"..."}]}',
        '只列真正需要改的，最多 8 条；没有就返回 {"verdict":"pass","issues":[]}。',
      ].join('\n')
      const { parsed } = await this.requestJson(prompt, signal, job, item, '文本质检', 2)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (err) {
      this.note(job, `#${item.index} 文本质检失败：${err.message}`)
      return null
    }
  }

  async qcBatch(jobId, indexes) {
    const origin = this.jobs.get(jobId || this.latestId)
    let root = origin ? origin.root : ''
    let workRoot = origin ? origin.workRoot : ''
    if (!root) {
      const file = await this.latestJobFile()
      if (!file) return { ok: false, error: '找不到批次记录' }
      root = file.root
      workRoot = path.join(root, '_work')
    }
    let names = []
    try { names = await readdir(root) } catch {}
    const wanted = Array.isArray(indexes) && indexes.length ? new Set(indexes.map(Number)) : null
    const items = []
    for (const name of names) {
      const m = /^(\d+) 已完成$/.exec(name)
      if (!m) continue
      const idx = Number(m[1])
      if (wanted && !wanted.has(idx)) continue
      let title = ''
      let folder = name
      try {
        const meta = JSON.parse(await readFile(path.join(root, name, 'meta.json'), 'utf8'))
        title = meta.title || ''
      } catch {}
      items.push({ index: idx, input: '', kind: 'file', name, stage: 'done', progress: 1,
        message: '待质检', title, folder, coverUrl: '', error: '' })
    }
    if (items.length === 0) return { ok: false, error: '这个批次没有成品文件夹' }
    items.sort((a, b) => a.index - b.index)

    const id = crypto.randomUUID()
    const job = {
      id, status: 'running', createdAt: new Date().toISOString(), finishedAt: null,
      root, workRoot, excel: origin ? origin.excel : null, error: null, log: [],
      caps: origin ? origin.caps : await this.capabilities(),
      options: { concurrency: 1, ordered: true, qcOnly: true },
      items,
    }
    this.jobs.set(id, job)
    this.latestId = id
    this.note(job, `质检 ${items.length} 条 → ${root}`)
    const signal = undefined
    for (const item of items) {
      item.stage = 'qc'
      item.message = '质检中'
      item.qc = await this.runQc(job, item, signal)
      item.stage = 'done'
      item.message = item.qc ? `质检 ${item.qc.verdict}` : '质检失败'
    }
    const need = items.filter((i) => i.qc && i.qc.verdict !== 'pass').length
    job.status = need > 0 ? 'review' : 'done'
    job.finishedAt = new Date().toISOString()
    this.note(job, `质检完成：${items.length} 条，${need} 条待确认`)
    return { ok: true, job: this.snapshot(job) }
  }

  async chats(limit = 40) {
    const sq = this.ctx.sessionQuery
    if (!sq || typeof sq.listSessions !== 'function') return { ok: true, items: [] }
    let records = []
    try { records = await sq.listSessions() } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err), items: [] } }
    const picked = records.filter((r) => !r.header.parentSession).slice(0, limit)
    const ids = picked.map((r) => r.header.id)
    let titles = new Map()
    try {
      const obs = await sq.readTitleSnapshots(ids)
      for (const row of obs) {
        if (row.status === 'fulfilled' && row.value && row.value.title) titles.set(row.sessionId, row.value.title.title)
      }
    } catch {}
    return {
      ok: true,
      items: picked.map((r) => ({
        sessionId: r.header.id,
        title: titles.get(r.header.id) || '(未命名对话)',
        createdAt: r.header.createdAt,
        cwd: r.header.cwd || '',
        live: r.live === true,
      })),
    }
  }

  async exportOriginals(job, signal) {
    const dir = path.join(job.root, '原视频')
    const items = (job.items || []).filter((it) => it.stage === 'done' || it.delivered)
    if (items.length === 0) return
    await mkdir(dir, { recursive: true })
    let copied = 0
    for (const it of items) {
      if (signal && signal.aborted) return
      const src = path.join(job.workRoot, String(it.index), 'source.mp4')
      const dst = path.join(dir, `${it.index}.mp4`)
      if (!existsSync(src) || existsSync(dst)) continue
      try {
        await copyFile(src, dst)
        copied += 1
      } catch (err) {
        this.note(job, `#${it.index} 原视频导出失败：${err.message}`)
      }
    }
    if (copied > 0) this.note(job, `原视频素材：${copied} 条 → ${dir}`)
  }

  async history(rootOverride) {
    const root = String(rootOverride || this.config.outputRoot
      || defaultOutputRoot())
    let names = []
    try { names = (await readdir(root)).filter((n) => n.startsWith('批次-')).sort().reverse() } catch { return { ok: true, root, batches: [] } }
    const batches = []
    for (const name of names.slice(0, 20)) {
      const dir = path.join(root, name)
      const work = path.join(dir, '_work')
      let jobCount = 0
      let rejected = 0
      let failed = 0
      let review = 0
      let created = ''
      try {
        const file = JSON.parse(await readFile(path.join(work, 'job.json'), 'utf8'))
        created = file.createdAt || ''
        jobCount = Array.isArray(file.items) ? file.items.length : 0
      } catch {}
      let folders = []
      try { folders = (await readdir(dir)).filter((n) => /^\d+ 已完成$/.test(n)) } catch {}
      for (const f of folders) {
        const idx = Number(f.match(/^(\d+)/)[1])
        try {
          const q = JSON.parse(await readFile(path.join(work, String(idx), 'qc.json'), 'utf8'))
          if (q && q.verdict && q.verdict !== 'pass') review += 1
        } catch {}
      }
      try {
        const workDirs = await readdir(work)
        for (const w of workDirs) {
          if (/^\d+$/.test(w) && existsSync(path.join(work, w, 'rejected.json'))) rejected += 1
        }
      } catch {}
      const total = Math.max(folders.length + rejected, jobCount)
      failed = Math.max(0, total - folders.length - rejected)
      batches.push({
        name, root: dir, createdAt: created || name.replace('批次-', ''),
        total, done: folders.length, review, rejected, failed,
        excel: existsSync(path.join(dir, '本地化汇总.xlsx')) ? path.join(dir, '本地化汇总.xlsx') : '',
      })
    }
    return { ok: true, root, batches }
  }

  async newestBatchRoot() {
    const root = this.config.outputRoot || defaultOutputRoot()
    let names = []
    try { names = (await readdir(root)).filter((n) => n.startsWith('批次-')).sort() } catch { return '' }
    for (let i = names.length - 1; i >= 0; i -= 1) {
      const candidate = path.join(root, names[i])
      if (existsSync(path.join(candidate, '_work'))) return candidate
    }
    return ''
  }

  async loadReviewJob() {
    const root = await this.newestBatchRoot()
    if (!root) return null
    const workRoot = path.join(root, '_work')
    const items = []
    let names = []
    try { names = await readdir(root) } catch { return null }
    for (const name of names) {
      const m = /^(\d+) 已完成$/.exec(name)
      if (!m) continue
      const idx = Number(m[1])
      let qc = null
      let title = ''
      try { qc = JSON.parse(await readFile(path.join(workRoot, String(idx), 'qc.json'), 'utf8')) } catch {}
      try { title = JSON.parse(await readFile(path.join(root, name, 'meta.json'), 'utf8')).title || '' } catch {}
      items.push({ index: idx, input: '', kind: 'file', name, stage: 'done', progress: 1,
        message: qc ? `质检 ${qc.verdict}` : '未质检', title, folder: name, coverUrl: '', error: '', qc })
    }
    if (items.length === 0) return null
    items.sort((a, b) => a.index - b.index)
    const job = {
      id: crypto.randomUUID(), status: 'review', createdAt: new Date().toISOString(), finishedAt: null,
      root, workRoot, excel: path.join(root, '本地化汇总.xlsx'), error: null, log: [],
      caps: await this.capabilities(), options: { concurrency: 1, ordered: true },
      items,
    }
    this.jobs.set(job.id, job)
    this.latestId = job.id
    this.note(job, `从磁盘恢复待复核批次：${items.length} 条 → ${root}`)
    return job
  }

  async fixJob(jobId, indexes, scope = 'all') {
    let origin = this.jobs.get(jobId || this.latestId)
    if (!origin) origin = await this.loadReviewJob()
    if (!origin) return { ok: false, error: '没有可修改的批次' }
    if (origin.status === 'running' || origin.status === 'fixing') return { ok: false, error: '批次还在跑，先等它结束' }
    const wanted = Array.isArray(indexes) && indexes.length ? new Set(indexes.map(Number)) : null
    let targets = origin.items.filter((it) => it.qc && it.qc.verdict !== 'pass' && (!wanted || wanted.has(it.index)))
    if (targets.length === 0) {
      // 当前内存任务里没有这些条目（例如刚重跑过单条）：回退到磁盘上的整批质检结果
      const disk = await this.loadReviewJob()
      if (disk && disk.id !== origin.id) {
        origin = disk
        targets = origin.items.filter((it) => it.qc && it.qc.verdict !== 'pass' && (!wanted || wanted.has(it.index)))
      }
    }
    if (targets.length === 0) return { ok: false, error: '没有需要修改的条目' }
    origin.status = 'fixing'
    this.note(origin, `按质检建议修改 ${targets.length} 条：${targets.map((i) => i.index).join(', ')}`)
    void this.runFixes(origin, targets, scope).catch((err) => {
      origin.status = 'review'
      this.note(origin, `修改批次失败：${err && err.message ? err.message : err}`)
    })
    return { ok: true, job: this.snapshot(origin), started: targets.map((i) => i.index), remaining: 0 }
  }

  async runFixes(job, targets, scope = 'all') {
    const fixed = []
    for (const item of targets) {
      const work = path.join(job.workRoot, String(item.index))
      const issues = (item.qc && item.qc.issues) || []
      const review = (item.qc && item.qc.review) || null
      item.stage = 'fix'
      item.message = '按质检建议修改'
      try {
        const missingIds = [...new Set(issues.filter((i) => i.type === 'missing-translation' && Number.isInteger(i.id)).map((i) => i.id))]
        if (missingIds.length > 0) await this.fillMissingTranslations(work, missingIds, item, job)
        const untranslated = issues.filter((i) => i.type === 'untranslated-ocr')
        if (untranslated.length > 0) await this.fillExtraSubs(work, untranslated, item, job)
        const reviewIssues = (scope === 'subs' || !review || !Array.isArray(review.issues)) ? [] : review.issues
        if (reviewIssues.length > 0) await this.applyReviewFixes(work, reviewIssues, item, job)
        const masks = issues.filter((i) => (i.type === 'promo' || i.type === 'watermark') && i.box)
        if (masks.length > 0) {
          await writeFile(path.join(work, 'extra_masks.json'), JSON.stringify(masks.map((i) => ({
            t0: Math.max(0, (i.t || 0) - 0.3), t1: i.t1 || (i.t + 1.5), box: i.box,
          })), null, 1))
        }
        await this.runPython(['compose.py', '--work', work, '--index', String(item.index),
          '--out', job.root, '--ffmpeg', this.config.ffmpegPath || FFMPEG, '--font', FONT,
          '--fonts-dir', path.join(RUNTIME, 'fonts'), '--max-chars', String(this.config.maxCharsPerLine),
          '--no-folder'], job, item, undefined)
        await this.runPython(['deliver.py', '--work', work, '--index', String(item.index), '--out', job.root],
          job, item, undefined)
        item.qc = await this.runQc(job, item, undefined)
        item.stage = 'done'
        item.message = item.qc ? `已修改 · 质检 ${item.qc.verdict}` : '已修改'
        fixed.push(item.index)
        this.note(job, `#${item.index} 修改完成：质检 ${item.qc ? item.qc.verdict : '—'}`)
      } catch (err) {
        item.stage = 'error'
        item.error = `修改失败：${err && err.message ? err.message : err}`
        item.message = item.error
        this.note(job, `#${item.index} ${item.error}`)
      }
    }
    try {
      const res = await this.runPython(['excel.py', '--root', job.root], job, null, undefined)
      const m = /EXCEL_OK (\S+)/.exec(res.stdout || '')
      if (m) job.excel = m[1]
    } catch {}
    const remaining = job.items.filter((it) => it.qc && it.qc.verdict !== 'pass').length
    job.status = remaining > 0 ? 'review' : 'done'
    job.finishedAt = new Date().toISOString()
    this.note(job, `修改结束：完成 ${fixed.length} 条，仍有 ${remaining} 条待确认`)
  }

  async fillMissingSpeech(work, issues, item, job) {
    const asr = JSON.parse(await readFile(path.join(work, 'asr.json'), 'utf8'))
    const segs = asr.segments || []
    const zhPath = path.join(work, 'zh.json')
    const zh = JSON.parse(await readFile(zhPath, 'utf8'))
    const speech = { ...(zh.speech || {}) }
    const todo = []
    for (const issue of issues) {
      const seg = segs.find((sg) => Math.abs(sg.t0 - issue.t) <= 1.2)
      if (!seg) continue
      const i = segs.indexOf(seg)
      if (speech['s' + i]) continue
      todo.push({ i, seg })
    }
    if (todo.length === 0) return
    const prompt = [
      '## 任务',
      '下面这些口播还没有中文字幕，请翻译成中文短句（每条不超过 20 个汉字，不带标点，像真人说话）。',
      '',
      todo.map((t) => `s${t.i}\t${t.seg.t0}-${t.seg.t1}\t${t.seg.text}`).join('\n'),
      '',
      '## 只输出 JSON',
      '{"s0":"...","s1":"..."}',
    ].join('\n')
    const { parsed } = await this.requestJson(prompt, undefined, job, item, '补译口播', 2)
    for (const [k, v] of Object.entries(parsed || {})) {
      if (typeof v === 'string' && v.trim()) speech[k] = v
    }
    zh.speech = speech
    await writeFile(zhPath, JSON.stringify(zh, null, 1))
  }

  async fillExtraSubs(work, issues, item, job) {
    const zhPath = path.join(work, 'zh.json')
    const zh = JSON.parse(await readFile(zhPath, 'utf8'))
    const extra = Array.isArray(zh.extra_subs) ? zh.extra_subs.slice() : []
    const todo = issues.slice(0, 20)
    if (todo.length === 0) return
    const prompt = [
      '## 任务',
      '下面这些画面外文还没有中文字幕，请逐条翻译成中文（单行、不带标点、不超过 20 个汉字，像真人说话）。',
      '',
      todo.map((i, k) => `${k}\t${i.t}-${i.t1 || (i.t + 1.5)}s\t${i.text}`).join('\n'),
      '',
      '## 只输出 JSON',
      '{"subs":[{"i":0,"zh":"..."}]}',
    ].join('\n')
    let parsed = null
    try {
      const out = await this.requestJson(prompt, undefined, job, item, '补录漏译字幕', 2)
      parsed = out.parsed
    } catch (err) {
      this.note(job, `#${item.index} 补录字幕失败：${err.message}`)
      return
    }
    const subs = (parsed && parsed.subs) || []
    let added = 0
    for (const row of subs) {
      const idx = Number(row.i)
      const text = String(row.zh || '').trim()
      if (!Number.isInteger(idx) || idx < 0 || idx >= todo.length || !text) continue
      const issue = todo[idx]
      extra.push({ t0: issue.t, t1: issue.t1 || (issue.t + 1.5), zh: text, src: issue.text })
      added += 1
    }
    if (added > 0) {
      zh.extra_subs = extra
      await writeFile(zhPath, JSON.stringify(zh, null, 1))
      this.note(job, `#${item.index} 补录 ${added} 条漏译字幕`)
    }
  }

  async applyReviewFixes(work, issues, item, job) {
    const zhPath = path.join(work, 'zh.json')
    const zh = JSON.parse(await readFile(zhPath, 'utf8'))
    const asr = JSON.parse(await readFile(path.join(work, 'asr.json'), 'utf8').catch(() => '{}'))
    const events = JSON.parse(await readFile(path.join(work, 'events.json'), 'utf8').catch(() => '[]'))
    const segs = asr.segments || []
    const speech = { ...(zh.speech || {}) }
    const overlays = { ...(zh.overlays || {}) }
    const payload = []
    for (const issue of issues.slice(0, 10)) {
      const t = Number(issue.t) || 0
      const seg = segs.find((sg) => t >= sg.t0 - 0.6 && t <= sg.t1 + 0.6)
      if (seg) {
        const i = segs.indexOf(seg)
        const key = 's' + i
        payload.push({ key, kind: 'speech', src: seg.text, zh: speech[key] || '', problem: issue.problem, advice: issue.advice })
        continue
      }
      const ev = events.find((e) => Math.abs(e.t0 - t) <= 1.2)
      if (ev) {
        const key = String(ev.id)
        payload.push({ key, kind: 'overlay', src: ev.text, zh: overlays[key] || '', problem: issue.problem, advice: issue.advice })
      }
    }
    if (payload.length === 0) return
    const prompt = [
      '## 任务',
      '下面这些中文字幕被质检指出问题，请按建议重写。要求：忠实原文、口语、单行、不带标点、不超过 20 个汉字；字幕里不允许出现韩文或日文原文（品牌名用英文或中文）。',
      '',
      payload.map((p, idx) => `${idx}. [${p.key}] 原文：${p.src}\n   现译：${p.zh || '（空）'}\n   问题：${p.problem || ''}\n   建议：${p.advice || ''}`).join('\n'),
      '',
      '## 只输出 JSON（键用上面的 key，值是新译文）',
      '{"s0":"...","34":"..."}',
    ].join('\n')
    let parsed = null
    try {
      const out = await this.requestJson(prompt, undefined, job, item, '按质检意见改字幕', 2)
      parsed = out.parsed
    } catch (err) {
      this.note(job, `#${item.index} 改写字幕失败：${err.message}`)
      return
    }
    let changed = 0
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value !== 'string' || !value.trim()) continue
      const entry = payload.find((p) => p.key === key)
      if (!entry) continue
      if (entry.kind === 'speech') speech[key] = value
      else overlays[key] = value
      changed += 1
    }
    zh.speech = speech
    zh.overlays = overlays
    await writeFile(zhPath, JSON.stringify(zh, null, 1))
    if (changed) this.note(job, `#${item.index} 按质检意见改了 ${changed} 条字幕`)
  }

  async fillMissingTranslations(work, missingIds, item, job) {
    const events = JSON.parse(await readFile(path.join(work, 'events.json'), 'utf8'))
    const wanted = events.filter((e) => missingIds.includes(e.id)).slice(0, 30)
    if (wanted.length === 0) return
    const zhPath = path.join(work, 'zh.json')
    const zh = JSON.parse(await readFile(zhPath, 'utf8'))
    const prompt = [
      '## 任务',
      '下面这些画面外文之前漏译了，请补上中文译文；属于噪声/价格/电商卡片小字的写进 drop 或 promo。',
      '中文不带标点，每条不超过 20 个汉字。',
      '',
      this.eventLines(wanted),
      '',
      '## 只输出 JSON',
      '{"overlays":{"0":"..."},"drop":[],"promo":[]}',
    ].join('\n')
    const { parsed } = await this.requestJson(prompt, undefined, job, item, '补译漏掉的画面文字', 2)
    const overlays = { ...(zh.overlays || {}) }
    for (const [k, v] of Object.entries((parsed && parsed.overlays) || {})) {
      if (typeof v === 'string' && v.trim()) overlays[String(k)] = v
    }
    zh.overlays = overlays
    zh.drop = [...new Set([...(zh.drop || []), ...((parsed && parsed.drop) || []).map(Number).filter(Number.isFinite)])]
    zh.promo = [...new Set([...(zh.promo || []), ...((parsed && parsed.promo) || []).map(Number).filter(Number.isFinite)])]
    await writeFile(zhPath, JSON.stringify(zh, null, 1))
  }

  async run(job, ac) {
    const signal = ac.signal
    const items = job.items
    this.note(job, `批次开始：${items.length} 条 → ${job.root}`)
    let cursor = 0
    const worker = async () => {
      while (cursor < items.length && !signal.aborted) {
        const item = items[cursor++]
        try {
          await this.process(job, item, signal)
        } catch (err) {
          if (signal && signal.aborted) {
            item.stage = 'stopped'
            item.message = '已停止'
            return
          }
          item.stage = 'error'
          item.error = String(err && err.message ? err.message : err)
          item.message = item.error.slice(0, 240)
          this.note(job, `#${item.index} 失败：${item.error}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(job.options.concurrency, items.length)) }, worker))

    if (signal && signal.aborted) {
      job.status = 'stopped'
      job.finishedAt = new Date().toISOString()
      return
    }
    // 全部渲染完成后，按链接顺序建「序号 已完成」文件夹并改名归档
    let okCount = 0
    for (const item of items) {
      if (item.stage !== 'rendered') continue
      const work = path.join(job.workRoot, String(item.index))
      this.update(job, item, { stage: 'deliver', progress: 0.99, message: '按顺序建文件夹并改名' })
      try {
        const res = await this.runPython(['deliver.py', '--work', work, '--index', String(item.index),
          '--out', job.root], job, item, signal)
        const meta = this.parseMarker(res.stdout, 'DELIVER_OK')
        item.stage = 'done'
        item.progress = 1
        item.folder = meta.folder
        item.message = `${item.title || meta.video} · ${meta.folder}`
        item.coverUrl = `/api/tiktok-localizer/file?job=${encodeURIComponent(job.id)}&index=${item.index}`
        this.note(job, `#${item.index} 已归档 ${meta.folder}/${meta.video}`)
        item.qcBody = item.qcBody || ''
        try {
          const zh = JSON.parse(await readFile(path.join(job.workRoot, String(item.index), 'zh.json'), 'utf8'))
          item.qcBody = zh.body || ''
        } catch {}
        item.message = `${item.title || meta.video} · ${meta.folder} · 质检中`
        const qc = await this.runQc(job, item, signal)
        if (qc) {
          item.qc = qc
          item.message = `${item.title || meta.video} · 质检${qc.verdict === 'pass' ? '通过' : qc.issues.length + ' 个问题'}`
          this.note(job, `#${item.index} 质检 ${qc.verdict}：${JSON.stringify(qc.counts || {})}`)
        }
        okCount += 1
      } catch (err) {
        if (signal && signal.aborted) {
          item.stage = 'stopped'
          item.message = '已停止'
          continue
        }
        item.stage = 'error'
        item.error = `归档失败：${err.message}`
        item.message = item.error
        this.note(job, `#${item.index} ${item.error}`)
      }
    }
    if (okCount > 0) {
      try {
        await this.exportOriginals(job, signal)
      } catch (err) {
        this.note(job, `原视频导出失败：${err.message}`)
      }
      try {
        const res = await this.runPython(['excel.py', '--root', job.root], job, null, signal)
        const m = /EXCEL_OK (\S+)/.exec(res.stdout || '')
        job.excel = m ? m[1] : path.join(job.root, '本地化汇总.xlsx')
        this.note(job, `汇总表：${job.excel}`)
      } catch (err) {
        job.error = `汇总表生成失败：${err.message}`
        this.note(job, job.error)
      }
    } else {
      job.error = '本批没有成功的视频，未生成汇总表'
      this.note(job, job.error)
    }
    const rejected = items.filter((it) => it.stage === 'rejected')
    if (rejected.length > 0) {
      this.note(job, `不合格未出片 ${rejected.length} 条：${rejected.map((i) => `#${i.index} ${i.rejectReason || ''}`).join('；')}`)
    }
    const noCaption = items.filter((it) => it.notice)
    if (noCaption.length > 0) {
      this.note(job, `⚠ 有 ${noCaption.length} 条没有可用画面字幕：${noCaption.map((i) => i.index).join(', ')}`)
    }
    const needReview = items.filter((it) => it.qc && it.qc.verdict !== 'pass').length
    job.status = needReview > 0 ? 'review' : 'done'
    if (needReview > 0) this.note(job, `质检待确认：${needReview} 条有建议，等你决定是否修改`)
    job.finishedAt = new Date().toISOString()
    const ok = items.filter((i) => i.stage === 'done').length
    this.note(job, `批次结束：成功 ${ok}/${items.length}`)
  }

  async process(job, item, signal) {
    const work = path.join(job.workRoot, String(item.index))
    await mkdir(work, { recursive: true })

    item.progress = 0.01
    item.message = '获取视频'
    let source = null
    try {
      const cached = JSON.parse(await readFile(path.join(work, 'source.json'), 'utf8'))
      if (cached && cached.path && existsSync(cached.path)) {
        source = cached
        item.message = '复用已下载视频'
        this.note(job, `#${item.index} 复用 ${path.basename(cached.path)}`)
      }
    } catch {}
    if (!source) {
      source = await this.acquireVideo(job, item, work, signal)
      await writeFile(path.join(work, 'source.json'), JSON.stringify(source, null, 1))
    }

    const haveEvents = ['events.json', 'asr.json', 'summary.json']
      .every((name) => existsSync(path.join(work, name)))
    if (haveEvents) {
      this.update(job, item, { stage: 'analyze', progress: 0.56, message: '复用已识别结果' })
      item.progress = 0.56
      this.note(job, `#${item.index} 复用已有 OCR/ASR 结果`)
    } else {
      this.update(job, item, { stage: 'analyze', progress: 0.06, message: '识别画面文字与人声' })
    }
    const analyze = haveEvents ? { stdout: '' } : await this.runPython([
      'analyze.py',
      '--video', source.path,
      '--work', work,
      '--fps', String(this.config.fps),
      '--langs', this.config.ocrLangs,
      '--ocr', this.config.ocrPath || OCR,
      '--ffmpeg', this.config.ffmpegPath || FFMPEG,
      '--asr-model', this.config.asrModel,
      '--asr-models', path.join(RUNTIME, 'models'),
      '--ocr-only', // ASR 已停用：始终只做 OCR
    ], job, item, signal, 0.06, 0.56)
    const summary = haveEvents
      ? JSON.parse(await readFile(path.join(work, 'summary.json'), 'utf8'))
      : this.parseMarker(analyze.stdout, 'ANALYZE_OK')
    if (summary.noSpeechNoCaptions) {
      item.stage = 'rejected'
      item.progress = 1
      item.message = '既无朗读也无漂浮字幕，建议替换'
      item.rejectReason = item.message
      try { await writeFile(path.join(work, 'rejected.json'), JSON.stringify({ reason: item.message, at: new Date().toISOString() })) } catch {}
      this.note(job, `#${item.index} 不合格未出片：${item.message}`)
      return
    }
    const cov0 = Number(summary.captionCoverage) || 0
    const capN = Number(summary.captionEvents) || 0
    if (cov0 < 0.15 && capN < 3 && summary.hasSpeech) {
      item.stage = 'rejected'
      item.progress = 1
      item.message = '有朗读但几乎没有画面字幕（ASR 已停用），建议替换或人工补字幕'
      item.rejectReason = item.message
      try { await writeFile(path.join(work, 'rejected.json'), JSON.stringify({ reason: item.message, at: new Date().toISOString() })) } catch {}
      this.note(job, `#${item.index} 不合格未出片：${item.message}`)
      return
    }
    const coverage = Number(summary.captionCoverage)
    const captionCount = Number(summary.captionEvents) || 0
    if (Number.isFinite(coverage) && (coverage < 0.15 || captionCount < 3)) {
      item.notice = `这条没有可用画面字幕（画面文字 ${captionCount} 条 / 覆盖 ${Math.round((coverage || 0) * 100)}%），OCR 无从翻译`
      this.note(job, `#${item.index} ⚠ ${item.notice}`)
    }
    if (summary.asrOk === false) this.note(job, `#${item.index} ASR 未启用：${(summary.asrError || '').slice(0, 160)}`)

    this.update(job, item, { stage: 'translate', progress: 0.58, message: '翻译并生成标题正文' })
    const zh = await this.translate(job, item, work, summary, signal)
    zh.duration = summary.duration
    await writeFile(path.join(work, 'zh.json'), JSON.stringify(zh, null, 1))

    // 投放标准只拦「潮玩」（盲盒/设计师玩具/搪胶公仔）且非泡泡玛特；
    // 模玩（车模/拼装/3D打印模型/展示座）与二次元周边（T恤/海报/立牌/蓝光/画集）不算潮玩，正常出片。
    const verticalText = String(zh.vertical || '')
    const isModelKit = /模玩|模型|车模|拼装|3d打印|展示座|手办/i.test(verticalText)
    const isAnimeMerch = /周边|海报|立牌|蓝光|画集|挂件|服饰/i.test(verticalText)
    const isTrendyToy = !isModelKit && !isAnimeMerch && verticalText.includes('潮玩')
    if (!isModelKit && !isAnimeMerch && (zh.rejected || (isTrendyToy && !/pop\s*mart|泡泡玛特/i.test(`${zh.brand} ${zh.title} ${zh.body}`)))) {
      item.stage = 'rejected'
      item.progress = 1
      item.message = zh.rejectReason || '潮玩非泡泡玛特，按投放标准不做'
      item.rejectReason = item.message
      item.title = zh.title || item.title
      try { await writeFile(path.join(work, 'rejected.json'), JSON.stringify({ reason: item.message, at: new Date().toISOString() })) } catch {}
      this.note(job, `#${item.index} 不合格未出片：${item.message}`)
      return
    }
    // 全屏引流卡（平台榜单/商品列表）：自动剪掉，不打码也不翻译
    try {
      const trim = await this.runPython(['trimcard.py', '--work', work, '--apply'], job, item, signal)
      const last = String(trim.stdout || '').trim().split('\n').pop()
      const info = JSON.parse(last)
      if (info && info.applied) {
        item.notice = (item.notice ? item.notice + '；' : '') + `剪掉引流卡 ${info.removed}s`
        this.note(job, `#${item.index} 自动剪掉全屏引流卡 ${info.removed}s（${JSON.stringify(info.cuts)}）`)
      }
    } catch (err) {
      this.note(job, `#${item.index} 引流卡检测跳过：${err.message}`)
    }
    this.update(job, item, { stage: 'render', progress: 0.68, message: '抹除引流并烧录字幕' })
    const compose = await this.runPython([
      'compose.py',
      '--work', work,
      '--index', String(item.index),
      '--out', job.root,
      '--ffmpeg', this.config.ffmpegPath || FFMPEG,
      '--font', FONT,
      '--fonts-dir', path.join(RUNTIME, 'fonts'),
      '--max-chars', String(this.config.maxCharsPerLine),
      '--text-scope', String(this.config.textScope || 'all'),
      '--no-folder',
    ], job, item, signal, 0.68, 0.99)
    const meta = this.parseMarker(compose.stdout, 'COMPOSE_OK')
    await writeFile(path.join(work, 'meta.json'), JSON.stringify(meta, null, 1))
    this.update(job, item, {
      stage: 'rendered',
      progress: 0.99,
      message: `${meta.cues} 条字幕 · 抹除 ${meta.promotions} 处 · 等待按序归档`,
      title: meta.title,
    })
    if (!this.config.retainWork) {
      await rm(path.join(work, 'frames'), { recursive: true, force: true }).catch(() => {})
    }
  }

  parseMarker(stdout, marker) {
    const re = new RegExp(marker + ' (\\{.*\\})')
    const m = re.exec(String(stdout || ''))
    if (!m) throw new Error(`内部错误：${marker} 缺失`)
    return JSON.parse(m[1])
  }

  async acquireVideo(job, item, work, signal) {
    if (item.kind === 'file') {
      const p = item.input
      const st = await stat(p).catch(() => null)
      if (!st) throw new Error(`本地文件不存在：${p}`)
      if (st.isDirectory()) {
        const pick = (await readdir(p)).find((n) => /\.(mp4|mov|m4v)$/i.test(n))
        if (!pick) throw new Error('目录里没有 mp4 文件')
        return { path: path.join(p, pick), name: pick, link: '' }
      }
      return { path: p, name: path.basename(p), link: '' }
    }

    const chain = String(this.config.downloaders || 'hellotik,ytdlp,tikwm')
      .split(',').map((v) => v.trim()).filter(Boolean)
    const failures = []
    for (const name of chain) {
      if (signal && signal.aborted) throw new Error('已停止')
      try {
        const got = await this.downloadWith(name, job, item, work, signal)
        if (got && got.path) {
          item.message = `已下载（${name}）`
          return { ...got, link: item.input }
        }
      } catch (err) {
        if (signal && signal.aborted) throw err
        failures.push(`${name}: ${err.message}`)
        this.note(job, `#${item.index} ${name} 下载失败：${err.message}`)
      }
    }
    throw new Error(`下载失败（${failures.join('；')}）`)
  }

  downloadWith(name, job, item, work, signal) {
    if (name === 'hellotik') return this.downloadHellotik(job, item, work, signal)
    if (name === 'ytdlp') return this.downloadYtdlp(job, item, work, signal)
    if (name === 'tikwm') return this.downloadTikwm(job, item, work, signal)
    return Promise.reject(new Error(`未知下载器 ${name}`))
  }

  async lastManifestFile(manifest, url) {
    try {
      const text = await readFile(manifest, 'utf8')
      const rows = text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].url === url && rows[i].filePath && existsSync(rows[i].filePath)) return rows[i].filePath
      }
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].filePath && existsSync(rows[i].filePath)) return rows[i].filePath
      }
    } catch {}
    return ''
  }

  async downloadHellotik(job, item, work, signal) {
    if (!existsSync(HELLOTIK) || !existsSync(HELLOTIK_PY)) throw new Error('未安装 hellotik skill 或工作区 venv 缺少 python')
    if (!(await this.cdpAlive())) {
      throw new Error('专用 Chrome 未启动：先运行 launch_chrome.command，并在窗口里看完广告解锁解析点数')
    }
    const wd = path.join(work, 'hellotik')
    const out = path.join(wd, 'out')
    await mkdir(out, { recursive: true })
    item.message = 'hellotik：提交链接'
    const queued = await this.runProcess(HELLOTIK_PY, [HELLOTIK, 'queue', item.input, '--workdir', wd], { signal })
    if (queued.code !== 0) throw new Error(`提交失败：${(queued.stderr || queued.stdout).trim().slice(-300)}`)
    item.message = 'hellotik：解析并下载'
    const ran = await this.runProcess(HELLOTIK_PY,
      [HELLOTIK, 'run', '--limit', '1', '--cdp', this.config.cdp || HELLOTIK_CDP, '--out', out, '--workdir', wd],
      {
        signal,
        onLine: (line) => {
          const text = line.trim()
          if (!text) return
          if (/直链下载成功|经站点代理下载成功/.test(text)) item.message = 'hellotik：下载完成'
          else if (/风控|RATE_LIMITED|TICKET_IP_RESTRICTED|点数|限制/.test(text)) item.message = `hellotik：${text.slice(0, 90)}`
        },
      })
    const file = await this.lastManifestFile(path.join(wd, 'manifest.jsonl'), item.input)
    if (!file) {
      const tail = (ran.stdout || ran.stderr || '').trim().split('\n').slice(-4).join(' ')
      throw new Error(tail.slice(-260) || 'hellotik 没有产出文件')
    }
    const dest = path.join(work, 'source.mp4')
    await copyFile(file, dest)
    return { path: dest, name: path.basename(file) }
  }

  async downloadYtdlp(job, item, work, signal) {
    const bin = await this.findYtdlp()
    if (!bin) throw new Error('未安装 yt-dlp')
    const proxy = await this.resolveProxy()
    item.message = proxy ? 'yt-dlp：经代理下载' : 'yt-dlp：下载'
    const template = path.join(work, 'source.%(ext)s')
    const base = ['--no-playlist', '--no-warnings', '--no-part', '--merge-output-format', 'mp4',
      '-f', 'bv*+ba/b', '-o', template]
    if (proxy) base.push('--proxy', proxy)
    const withImpersonate = [...base, '--impersonate', 'chrome', item.input]
    let ran = await this.runProcess(bin, withImpersonate, { signal })
    if (ran.code !== 0 && /Impersonate target|impersonat/i.test(ran.stderr || '')) {
      ran = await this.runProcess(bin, [...base, item.input], { signal })
    }
    if (ran.code !== 0 && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1800))
      ran = await this.runProcess(bin, [...base, item.input], { signal })
    }
    if (ran.code !== 0) {
      const tail = (ran.stderr || '').trim().slice(-300)
      if (!proxy) throw new Error(`${tail || 'yt-dlp 退出异常'}（本机 7890 没有代理在跑，TikTok 直连通常不通）`)
      throw new Error(tail || 'yt-dlp 退出异常')
    }
    const names = await readdir(work)
    const pick = names.filter((n) => /^source\.(mp4|mkv|webm|mov)$/i.test(n))
      .sort((a, b) => (a.endsWith('.mp4') ? -1 : 1))[0]
    if (!pick) throw new Error('yt-dlp 没有产出文件')
    return { path: path.join(work, pick), name: pick }
  }

  async tikwmSlot() {
    const now = Date.now()
    const next = this._tikwmNext || 0
    this._tikwmNext = Math.max(now, next) + 1300
    const wait = Math.max(0, next - now)
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  async downloadTikwm(job, item, work, signal) {
    item.message = 'tikwm：解析直链'
    const api = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(item.input) + '&hd=1'
    let payload
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.tikwmSlot()
      try {
        const raw = await this.curl([api, '-H', 'Accept: application/json',
          '-H', 'Referer: https://www.tikwm.com/'], signal)
        payload = JSON.parse(raw)
      } catch (err) {
        lastError = err.message
        if (attempt === 3) throw new Error(`解析接口不可用：${lastError}`)
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
        continue
      }
      const message = String((payload && payload.msg) || '')
      if (payload && payload.code === 0 && payload.data) break
      if (/limit|busy|frequent|try again/i.test(message) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
        continue
      }
      throw new Error(`没有直链：${message || '解析失败'}`)
    }
    const data = payload && payload.data
    const play = data && (data.hdplay || data.play || data.wmplay)
    if (!play) throw new Error(`没有直链：${(payload && payload.msg) || '解析失败'}`)
    item.message = 'tikwm：下载视频'
    const dest = path.join(work, 'source.mp4')
    await this.curlToFile(play, dest, signal)
    const st = await stat(dest)
    if (st.size < 20000) throw new Error('下载到的视频过小')
    return {
      path: dest,
      name: String(data.title || data.id || 'tiktok').slice(0, 80),
      author: data.author && data.author.unique_id ? data.author.unique_id : '',
      title: data.title || '',
    }
  }

  async curlArgs(extra = []) {
    const args = ['-sS', '-L', '--fail', '--connect-timeout', '20', '--max-time', '300']
    const proxy = await this.resolveProxy()
    if (proxy) args.push('-x', proxy)
    return args.concat(extra)
  }

  async curl(extra, signal) {
    const args = await this.curlArgs(extra)
    return new Promise((resolve, reject) => {
      const child = spawn('curl', args, { signal })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `curl ${code}`))))
    })
  }

  async curlToFile(url, dest, signal) {
    const args = await this.curlArgs(['-o', dest, '-H', 'Referer: https://www.tiktok.com/', url])
    return new Promise((resolve, reject) => {
      const child = spawn('curl', args, { signal })
      let err = ''
      child.stderr.on('data', (d) => { err += d })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `下载失败 curl ${code}`))))
    })
  }

  runPython(args, job, item, signal, from = 0, to = 1) {
    return new Promise((resolve, reject) => {
      const python = this.config.python || 'python3'
      const script = path.join(RUNTIME, args[0])
      if (!existsSync(script)) return reject(new Error(`缺少脚本 ${script}`))
      const child = spawn(python, [script, ...args.slice(1)], { signal })
      let stdout = ''
      let stderr = ''
      let buf = ''
      child.stdout.on('data', (d) => {
        const text = String(d)
        stdout += text
        buf += text
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          const m = /^PROGRESS ([0-9.]+) (\S+) ?(.*)$/.exec(line)
          if (m && item) {
            const ratio = Number(m[1])
            item.progress = Math.max(item.progress, from + (to - from) * Math.min(1, Math.max(0, ratio)))
            if (m[3]) item.message = m[3].slice(0, 120)
          }
        }
      })
      child.stderr.on('data', (d) => { stderr += String(d) })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`${path.basename(script)} 退出码 ${code}：${stderr.trim().slice(-600) || '无错误输出'}`))
      })
    })
  }

  // ---------- 翻译 ----------
  buildPrompt(review, asr, summary) {
    const events = review.split('\n').filter((l) => l && !l.startsWith('#')).join('\n')
    const segs = (asr.segments || [])
    const asrText = segs.length
      ? segs.map((s, i) => `s${i}\t${s.t0}-${s.t1}\t${s.text}`).join('\n')
      : '（本片没有可用的语音识别结果）'
    return [
      '## 视频信息',
      `时长 ${summary.duration}s；画面文字事件 ${summary.events} 条；口播 ${segs.length} 条；语音识别语言 ${asr.language || '未知'}。`,
      '',
      '## 画面文字（OCR 事件，坐标是 720x1280 画面像素）',
      events || '（无）',
      '',
      '## 口播（ASR，键为 s0、s1…）',
      asrText,
      '',
      '## 任务',
      '把画面文字与口播完整翻译成简体中文，并为本条视频起标题、写正文。',
      '',
      '### 翻译规则',
      '1. 画面文字：每个事件要么给出中文（overlays），要么判为噪声/重复/引流而丢弃（drop）。花字、贴图、标题、对话都要翻译，不能漏。',
      '2. 价格、折扣、货币、优惠券，以及关注/点赞/订阅/私信/链接/主页/店铺类引流信息：写进 promo（会被打码抹除），不要翻译它们。',
      '3. 口播：把碎片按语义合并成短句，键为 s0/s1…；每条不超过 20 个汉字。',
      '4. 口播内容与画面文字完全一致时，只保留一处翻译即可（口播对应的 speech 可以省略）。',
      '5. 中文一律不带标点（用空格断句），不换行，不加表情或话题标签。',
      '5a. 画面里的大标题、花字、信息卡、贴图文字必须逐条翻译，不能因为字号大或在中部就丢弃；只有价格/联系方式/电商卡片小字才抹除或丢弃。',
      '5b. 颜色名与色号要译成中文（Light→浅色 Neutral→自然色 Sand→沙色 等），品牌名保留原文。',
      '6. 品牌名、产品名、成分名、尺码数字如实保留；查不到中文名的品牌保留原文。',
      '7. 电商卡片里的小字（品牌名、品类词、价格、折扣、店铺名，例如 adidas / Tシャツ／カットソー / ¥7,370）不要翻译，也不要当字幕，直接写进 promo 或 drop。',
      '8. 博主信息（账号名、ID、头像旁文字）、其他平台标识（Instagram / YouTube / 小红书 等）、品牌活动或合作标签（#ad / #협찬 / 活动名 / 联名说明）、点赞关注收藏转发引导，全部写进 promo：这些会被裁掉或打码，不要翻译。',
      '9. promo 尽量集中在同一块区域（比如同一个卡片/同一条横幅），不要零散打码，避免把画面打花。',
      '10. promo 只放「确实需要抹掉」的条目：账号名/平台标识/活动或合作标签/关注引导/价格条。普通讲解、字幕、花字、产品名是内容，必须照常翻译，绝不能塞进 promo；拿不准就翻译，不要放 promo。promo 条数一般不应超过事件总数的四分之一。',
      '',
      '### 标题与正文（垂类规则）',
      '- vertical 从「产品 / 潮玩 / 模玩 / 二次元周边 / 美妆 / 穿搭 / 好物 / 其他」里选一个。',
      '- 垂类定义：潮玩=盲盒/设计师玩具/搪胶或毛绒 IP 公仔；模玩=车模/飞机/拼装模型/3D 打印模型/展示座；二次元周边=动漫游戏 IP 的 T恤/海报/立牌/蓝光/画集/挂件。模玩和二次元周边都不是潮玩，不要判成潮玩、不要 reject。',
      '- title：12~20 个汉字，贴合内容，不夸张，无标点，无 AI 废话。产品类带品牌，潮玩/模玩/周边类带 IP 或型号，美妆类突出主题/功效。',
      '- body：30~38 个汉字，概括视频要点，口语，无标点，无话题标签。',
      '- coverT：一个画面干净、适合做封面的时间（秒，0 到时长之间）。',
      '',
      '## 只输出这个 JSON（不要代码块）',
      '{"language":"ja","vertical":"美妆","title":"...","body":"...","coverT":3.2,"overlays":{"0":"..."},"drop":[3],"promo":[7],"speech":{"s0":"..."}}',
    ].join('\n')
  }

  async callModel(prompt, signal, job, item) {
    return this.callModelMessages([{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal, job)
  }

  async callModelMessages(messages, signal, job) {
    const caps = job.caps || (await this.capabilities())
    const provider = caps.llm.provider
    const model = caps.llm.model
    if (!provider || !model) throw new Error('没有可用模型')
    const chunks = []
    let failure = ''
    const timeoutMs = Number(this.config.modelTimeoutMs) || 180000
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch {} }, timeoutMs)
    const onAbort = () => { try { controller.abort() } catch {} }
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    const stream = this.ctx.llm.stream({
      provider,
      model,
      system: SYSTEM_PROMPT,
      messages,
      temperature: 0.25,
      maxTokens: 8000,
      signal: controller.signal,
    })
    try {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : '模型调用失败'
      }
    }
    } finally {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }
    if (failure && chunks.length === 0) throw new Error(failure)
    const text = chunks.join('').trim()
    if (!text) throw new Error('模型没有返回内容')
    return text
  }

  async translate(job, item, work, summary, signal) {
    const review = await readFile(path.join(work, 'review.txt'), 'utf8')
    const asr = JSON.parse(await readFile(path.join(work, 'asr.json'), 'utf8').catch(() => '{}'))
    const events = JSON.parse(await readFile(path.join(work, 'events.json'), 'utf8').catch(() => '[]'))
    const segments = (asr && asr.segments) || []

    // 事件太多时整段 JSON 会超长（模型容易返回空/截断），改成按块翻译再合并
    if (Array.isArray(events) && events.length > 60) {
      return this.translateChunked(job, item, summary, events, segments, asr, signal)
    }
    return this.translateOnce(job, item, review, asr || {}, summary, signal)
  }

  async requestJson(prompt, signal, job, item, label, attempts = 3) {
    let lastError = ''
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal && signal.aborted) throw new Error('已停止')
      item.message = attempt === 1 ? label : `${label}（重试 ${attempt}）`
      let text = ''
      try {
        const tail = attempt === 1 ? '' : '\n\n（只输出一个 JSON 对象，第一行就是 {，不要解释、不要示例。）'
        text = await this.callModel(prompt + tail, signal, job, item)
        return { parsed: parseModelJson(text), text }
      } catch (err) {
        lastError = String(err && err.message ? err.message : err)
        const head = String(text || '').replace(/\s+/g, ' ').slice(0, 160)
        this.note(job, `#${item.index} ${label} 第 ${attempt} 次失败：${lastError}${head ? ' | 输出开头：' + head : '（无输出）'}`)
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt))
      }
    }
    throw new Error(`${label}失败：${lastError}`)
  }

  async translateOnce(job, item, review, asr, summary, signal) {
    const prompt = this.buildPrompt(review, asr, summary)
    const { parsed } = await this.requestJson(prompt, signal, job, item, '翻译并生成标题正文')
    return this.validateZh(parsed, summary)
  }

  eventLines(events) {
    return events.map((e) => `${e.id}\t${e.t0}-${e.t1}\t(${Math.round(e.x0)},${Math.round(e.y0)})-(${Math.round(e.x1)},${Math.round(e.y1)})\tlh=${Math.round(e.h)}\t${e.text}`).join('\n')
  }

  async translateChunked(job, item, summary, events, segments, asr, signal) {
    const overlays = {}
    const drop = []
    const promo = []
    const size = 45
    for (let i = 0; i < events.length; i += size) {
      const part = events.slice(i, i + size)
      const prompt = [
        '## 任务',
        '把下面这些画面外文翻译成简体中文，供短视频中文字幕使用。',
        '',
        '## 规则',
        '1. 每条事件要么给出中文译文（overlays，键=事件编号），要么判为噪声/重复/电商卡片小字而丢弃（drop）。',
        '2. 价格、折扣、货币、优惠券，以及关注/点赞/订阅/私信/链接/主页/店铺类信息：写进 promo，不要翻译。',
        '3. 电商卡片里的品牌名、品类词、价格（如 adidas / Tシャツ／カットソー / ¥7,370）写进 promo 或 drop，不当字幕。',
        '4. 中文不带标点（用空格断句），单行，每条不超过 20 个汉字；品牌名、产品名、成分名、数字如实保留。',
        '5. 花字、贴图、标题、对话都要翻译，不能漏。',
        '',
        '## 画面文字事件',
        this.eventLines(part),
        '',
        '## 只输出这个 JSON',
        '{"overlays":{"0":"..."},"drop":[3],"promo":[7]}',
      ].join('\n')
      const buildPromptFor = (group) => [
        '## 任务',
        '把下面这些画面外文翻译成简体中文，供短视频中文字幕使用。',
        '',
        '## 规则',
        '1. 每条事件要么给出中文译文（overlays，键=事件编号），要么判为噪声/重复/电商卡片小字而丢弃（drop）。',
        '2. 价格、折扣、货币、优惠券，以及关注/点赞/订阅/私信/链接/主页/店铺类信息：写进 promo，不要翻译。',
        '3. 电商卡片里的品牌名、品类词、价格写进 promo 或 drop，不当字幕。',
        '4. 中文不带标点（用空格断句），单行，每条不超过 20 个汉字；品牌名、产品名、成分名、数字如实保留。',
        '5. 花字、贴图、大标题、对话都要翻译，不能漏；颜色名译成中文。',
        '',
        '## 画面文字事件',
        this.eventLines(group),
        '',
        '## 只输出这个 JSON',
        '{"overlays":{"0":"..."},"drop":[3],"promo":[7]}',
      ].join('\n')

      const translateRange = async (group, depth = 0) => {
        try {
          const { parsed } = await this.requestJson(buildPromptFor(group), signal, job, item,
            `翻译画面文字 ${group[0].id}-${group[group.length - 1].id}`, depth === 0 ? 2 : 1)
          return parsed || {}
        } catch (err) {
          if (signal && signal.aborted) throw err
          if (group.length > 6) {
            const mid = Math.ceil(group.length / 2)
            const left = await translateRange(group.slice(0, mid), depth + 1).catch(() => null)
            const right = await translateRange(group.slice(mid), depth + 1).catch(() => null)
            if (left || right) return Object.assign({}, left || {}, right || {}, {
              drop: [...((left && left.drop) || []), ...((right && right.drop) || [])],
              promo: [...((left && left.promo) || []), ...((right && right.promo) || [])],
              overlays: Object.assign({}, (left && left.overlays) || {}, (right && right.overlays) || {}),
            })
            throw err
          }
          this.note(job, `#${item.index} 画面文字 ${group[0].id}-${group[group.length - 1].id} 翻译失败，已跳过`)
          return {}
        }
      }

      const parsed = await translateRange(part)
      if (parsed && typeof parsed.overlays === 'object' && parsed.overlays) {
        for (const [key, value] of Object.entries(parsed.overlays)) {
          if (typeof value === 'string' && value.trim()) overlays[String(key)] = value
        }
      }
      for (const id of Array.isArray(parsed && parsed.drop) ? parsed.drop : []) {
        const n = Number(id)
        if (Number.isFinite(n)) drop.push(n)
      }
      for (const id of Array.isArray(parsed && parsed.promo) ? parsed.promo : []) {
        const n = Number(id)
        if (Number.isFinite(n)) promo.push(n)
      }
    }

    const asrText = segments.length
      ? segments.map((seg, i) => `s${i}\t${seg.t0}-${seg.t1}\t${seg.text}`).join('\n')
      : '（本片没有可用的语音识别结果）'
    const digest = events.slice(0, 24).map((e) => e.text).join(' / ').slice(0, 700)
    const metaPrompt = [
      '## 视频信息',
      `时长 ${summary.duration}s；画面文字 ${events.length} 条；口播 ${segments.length} 条；语音语言 ${(asr && asr.language) || '未知'}。`,
      `画面文字摘要：${digest || '（无）'}`,
      '',
      '## 口播（键为 s0、s1…）',
      asrText,
      '',
      '## 任务',
      '整理口播中文短句，并给这条视频起标题、写正文。',
      '',
      '### 规则',
      '- speech：把碎片按语义合并成短句，键 s0/s1…，每条不超过 20 个汉字，不带标点。',
      '- 口播与画面文字重复时只保留一处翻译即可，对应 speech 可省略。',
      '- vertical 从「产品 / 潮玩 / 模玩 / 二次元周边 / 美妆 / 穿搭 / 好物 / 其他」里选一个。',
      '- 垂类定义：潮玩=盲盒/设计师玩具/搪胶或毛绒 IP 公仔；模玩=车模/飞机/拼装模型/3D 打印模型/展示座；二次元周边=动漫游戏 IP 的 T恤/海报/立牌/蓝光/画集/挂件。模玩和二次元周边都不是潮玩，不要判成潮玩、不要 reject。',
      '- title：12~20 个汉字，贴合内容，不夸张，无标点。产品类带品牌，潮玩/模玩/周边类带 IP 或型号，美妆类突出主题/功效。',
      '- body：30~38 个汉字，概括要点，口语，无标点、无话题标签、无 AI 套话。',
      '- 必须给出 brand（品牌，原文或中文通用名）与 model（型号；没有就留空）。title 必须包含 brand；body 尽量写出 model。',
      '- 禁止模板化水文案：不得使用「太炫酷」「天下豪车」「绝绝子」「无敌了」「谁懂啊」「闭眼入」「爱了爱了」「太顶了」这类空话，要写具体卖点/材质/场景。',
      '- 投放判定只针对「潮玩」（盲盒/设计师玩具/搪胶或毛绒 IP 公仔）：只有泡泡玛特（POP MART）相关才继续；不是泡泡玛特就把 rejected 设为 true 并在 reason 说明。',
      '- 「模玩」（车模/飞机/拼装模型/3D 打印模型/展示座）和「二次元周边」（动漫游戏 IP 的 T恤/海报/立牌/蓝光/画集）不是潮玩，正常出片，rejected 一律为 false。',
      '- coverT：一个画面干净、适合做封面的时间（秒，0 到时长之间）。',
      '',
      '## 只输出这个 JSON',
      '{"language":"ja","vertical":"美妆","title":"...","body":"...","coverT":3.2,"speech":{"s0":"..."}}',
    ].join('\n')
    const { parsed: meta } = await this.requestJson(metaPrompt, signal, job, item, '生成口播字幕与标题正文')
    return this.validateZh({ ...meta, overlays, drop, promo }, summary)
  }

  validateZh(parsed, summary) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('输出不是 JSON 对象')
    const overlays = parsed.overlays && typeof parsed.overlays === 'object' ? parsed.overlays : {}
    const speech = parsed.speech && typeof parsed.speech === 'object' ? parsed.speech : {}
    const drop = Array.isArray(parsed.drop) ? parsed.drop.map(Number).filter((n) => Number.isFinite(n)) : []
    const promo = Array.isArray(parsed.promo) ? parsed.promo.map(Number).filter((n) => Number.isFinite(n)) : []
    const title = String(parsed.title || '').trim()
    const body = String(parsed.body || '').trim()
    if (!title) throw new Error('缺少 title')
    if (!body) throw new Error('缺少 body')
    const cover = Number(parsed.coverT)
    const clean = Array.isArray(summary.cleanTimes) && summary.cleanTimes.length ? summary.cleanTimes[0] : 1
    return {
      language: String(parsed.language || ''),
      vertical: String(parsed.vertical || '其他'),
      brand: String(parsed.brand || '').trim(),
      model: String(parsed.model || '').trim(),
      rejected: parsed.rejected === true,
      rejectReason: String(parsed.reason || ''),
      title,
      body,
      coverT: Number.isFinite(cover) ? cover : clean,
      overlays,
      speech,
      drop,
      promo,
      note: String(parsed.note || ''),
    }
  }
}

function toolDefinition(loc) {
  return {
    name: 'tiktok_localizer',
    description: [
      '批量把 TikTok 链接（或本地视频）做成本地化成品：默认只用画面 OCR 出字幕（没有画面字幕的片子会标注提示，不硬凑口播），',
      '抹除价格/关注等引流信息，烧录单行无标点中文字幕，按垂类生成标题与约 35 字正文，',
        '生成 jpg 封面；全部链接按顺序跑完后，再按序号建「序号 已完成」文件夹并改名归档，',
        '最后导出含原文对照的汇总 Excel。',
        'action=start 提交批次（按链接顺序逐条处理）；status 查看进度与质检；qc 对已有成品补做质检（含视觉审片）；fix 按建议补字幕/补遮罩后重烧；retry 重跑失败条目；stop 停止；open 在访达打开输出目录。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'stop', 'open', 'retry', 'fix', 'qc', 'history', 'chats'], description: '要执行的操作；history 查看历史批次；retry 重跑失败条目；qc 对已有成品做质检；fix 按质检建议修改' },
        links: {
          type: 'array',
          items: { type: 'string' },
          description: 'TikTok 链接、分享文本或本地视频/目录路径（action=start 必填）',
        },
        outputRoot: { type: 'string', description: '输出根目录；省略时用 /Volumes/Data/媒老板/海外视频本地化（卷不在时回退 ~/Downloads/海外视频本地化）' },
        jobId: { type: 'string', description: 'action=status/stop/open/retry 时的任务 id；省略时用最近一次' },
        indexes: { type: 'array', items: { type: 'integer' }, description: 'action=retry/fix 时指定序号；省略则处理全部' },
        scope: { type: 'string', enum: ['all', 'subs'], description: 'fix 范围：subs 只补漏译/补遮罩，不改已润色的文案' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'message'],
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          jobId: { type: 'string' },
          root: { type: 'string' },
          excel: { type: 'string' },
          total: { type: 'integer' },
          done: { type: 'integer' },
          running: { type: 'boolean' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'stage'],
              properties: {
                index: { type: 'integer' },
                stage: { type: 'string' },
                title: { type: 'string' },
                folder: { type: 'string' },
                error: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const action = String(args.action || 'status')
      if (action === 'start') {
        const res = await loc.start({ links: args.links, outputRoot: args.outputRoot, concurrency: args.concurrency })
        if (!res.ok) return { ok: false, message: res.error }
        return {
          ok: true,
          message: `已提交 ${res.job.items.length} 条视频，输出到 ${res.job.root}`,
          jobId: res.jobId,
          root: res.job.root,
          total: res.job.items.length,
          done: 0,
          running: true,
          items: res.job.items.map((it) => ({ index: it.index, stage: it.stage, title: it.title, folder: it.folder, error: it.error, message: it.message })),
        }
      }
      if (action === 'retry') {
        const res = await loc.retry(args.jobId, args.indexes)
        if (!res.ok) return { ok: false, message: res.error }
        return {
          ok: true,
          message: `正在重试 ${res.job.items.length} 条：${res.retried.join(', ')}`,
          jobId: res.jobId,
          root: res.job.root,
          total: res.job.items.length,
          done: 0,
          running: true,
          items: res.job.items.map((it) => ({ index: it.index, stage: it.stage, title: it.title, folder: it.folder, error: it.error, message: it.message })),
        }
      }
      if (action === 'chats') {
        const res = await loc.chats(40)
        const items = res.items || []
        return {
          ok: res.ok !== false,
          message: res.error ? `读取对话失败：${res.error}` : (items.length
            ? `最近 ${items.length} 个对话：\n` + items.slice(0, 20).map((c) => `#${c.sessionId} ${c.title}（${new Date(c.createdAt).toLocaleDateString('zh-CN')}）`).join('\n')
            : '没有读到历史对话'),
        }
      }
      if (action === 'history') {
        const res = await loc.history(args.outputRoot)
        const lines = res.batches.map((b) => `${b.name}｜${b.total} 条｜完成 ${b.done}｜质检待改 ${b.review}｜不合格 ${b.rejected}｜失败 ${b.failed}${b.excel ? '｜' + b.excel : ''}`)
        return {
          ok: true,
          message: lines.length ? `历史批次（${res.root}）：\n` + lines.join('\n') : `还没有历史批次：${res.root}`,
          root: res.root,
        }
      }
      if (action === 'qc') {
        const res = await loc.qcBatch(args.jobId, args.indexes)
        if (!res.ok) return { ok: false, message: res.error }
        const items = res.job.items.map((it) => ({ index: it.index, stage: it.stage, title: it.title,
          folder: it.folder, error: it.error, message: `${it.message}${it.qc ? ' · ' + (it.qc.counts ? JSON.stringify(it.qc.counts) : '') : ''}` }))
        const need = res.job.items.filter((i) => i.qc && i.qc.verdict !== 'pass').length
        return { ok: true, message: `质检完成 ${res.job.items.length} 条：${need} 条有建议待你决定`, jobId: res.job.id,
          root: res.job.root, total: res.job.items.length, done: res.job.items.length, running: false, items }
      }
      if (action === 'fix') {
        const res = await loc.fixJob(args.jobId, args.indexes, args.scope || 'all')
        if (!res.ok) return { ok: false, message: res.error }
        return {
          ok: true,
          message: `已开始按质检建议修改 ${res.started.length} 条（${res.started.join(', ')}）；完成后会自动复检，可在 status 里查看结果`,
          jobId: res.job.id,
          root: res.job.root,
          excel: res.job.excel || '',
          total: res.job.items.length,
          done: res.job.items.filter((i) => i.stage === 'done').length,
          running: true,
          items: res.job.items.filter((i) => res.started.includes(i.index)).map((it) => ({
            index: it.index, stage: it.stage, title: it.title, folder: it.folder,
            error: it.error, message: it.message,
          })),
        }
      }
      if (action === 'stop') {
        const res = loc.stop(args.jobId)
        return { ok: res.ok, message: res.ok ? '已停止当前批次' : res.error }
      }
      if (action === 'open') {
        const job = loc.jobs.get(args.jobId || loc.latestId)
        if (!job) return { ok: false, message: '没有可打开的批次目录' }
        const target = job.excel || job.root
        const res = await loc.reveal(target)
        return { ok: res.ok, message: res.ok ? `已在访达打开 ${target}` : res.error, root: job.root, excel: job.excel || '' }
      }
      const job = loc.jobs.get(args.jobId || loc.latestId)
      if (!job) return { ok: false, message: '还没有任何批次' }
      const snap = loc.snapshot(job)
      const done = snap.items.filter((i) => i.stage === 'done').length
      const lines = snap.items.map((i) => {
        const qc = i.qc ? `[质检 ${i.qc.verdict}${i.qc.issues && i.qc.issues.length ? ' ' + i.qc.issues.length + '项' : ''}]` : '[未质检]'
        const flag = i.notice ? '⚠ 无画面字幕 ' : ''
        return `#${i.index} ${i.stage} ${qc} ${flag}${i.title || i.name} ${i.error || i.message || ''}`.trim()
      })
      return {
        ok: true,
        message: [`任务 ${snap.id}：${snap.status}（${done}/${snap.items.length} 完成）`, `输出：${snap.root}`,
          snap.excel ? `汇总表：${snap.excel}` : '', ...lines].filter(Boolean).join('\n'),
        jobId: snap.id,
        root: snap.root,
        excel: snap.excel || '',
        total: snap.items.length,
        done,
        running: snap.status === 'running',
        items: snap.items.map((it) => ({ index: it.index, stage: it.stage, title: it.title, folder: it.folder, error: it.error, message: it.message })),
      }
    },
  }
}

export const name = 'tiktok-localizer'
export const inject = ['tools', 'connection', 'llm', 'agentDefaultModel', 'attachments', 'sessionQuery']

export function apply(ctx, config) {
  const loc = new Localizer(ctx, config)

  loc.reveal = async (target) => {
    const job = [...loc.jobs.values()].find((j) => String(target).startsWith(j.root + path.sep) || target === j.root)
    if (!job) return { ok: false, error: '只允许打开本插件产出的目录' }
    const child = spawn('open', [target], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true }
  }

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => jsonResponse(loc.state()),
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/start',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {}
        try {
          const out = await loc.start({ links: body.links, outputRoot: body.outputRoot, concurrency: body.concurrency })
          return jsonResponse(out, out.ok ? 200 : 400)
        } catch (err) {
          return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500)
        }
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/retry',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {}
        try {
          const out = await loc.retry(body.jobId, body.indexes)
          return jsonResponse(out, out.ok ? 200 : 400)
        } catch (err) {
          return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500)
        }
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/chats',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try { body = await request.json() } catch {}
        try {
          return jsonResponse(await loc.chats(body.limit || 40))
        } catch (err) {
          return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err), items: [] }, 500)
        }
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/history',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try { body = await request.json() } catch {}
        try {
          const out = await loc.history(body.root)
          return jsonResponse(out)
        } catch (err) {
          return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500)
        }
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/qc',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try { body = await request.json() } catch {}
        try {
          const out = await loc.qcBatch(body.jobId, body.indexes)
          return jsonResponse(out, out.ok ? 200 : 400)
        } catch (err) {
          return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500)
        }
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/fix',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {}
        try {
          const out = await loc.fixJob(body.jobId, body.indexes)
          return jsonResponse(out, out.ok ? 200 : 400)
        } catch (err) {
          return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) }, 500)
        }
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/stop',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {}
        const out = loc.stop(body.jobId)
        return jsonResponse(out, out.ok ? 200 : 400)
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/reveal',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try {
          body = await request.json()
        } catch {}
        const target = String(body.path || '')
        const job = [...loc.jobs.values()].find((j) => target === j.root || target === j.excel
          || target.startsWith(j.root + path.sep))
        if (!job) return jsonResponse({ ok: false, error: '只允许打开本插件产出的文件' }, 403)
        const child = spawn('open', [target], { detached: true, stdio: 'ignore' })
        child.unref()
        return jsonResponse({ ok: true })
      },
    }))
    disposers.push(ctx.connection.fetch.register({
      path: '/api/tiktok-localizer/file',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const job = loc.jobs.get(url.searchParams.get('job') || '')
        const index = Number(url.searchParams.get('index'))
        const item = job && job.items.find((i) => i.index === index)
        if (!job || !item || !item.folder) return new Response('not found', { status: 404 })
        const cover = path.join(job.root, item.folder, '视频封面.jpg')
        try {
          const bytes = await readFile(cover)
          return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })
        } catch {
          return new Response('not found', { status: 404 })
        }
      },
    }))
    return () => { for (const dispose of disposers) void dispose() }
  }, 'tiktok-localizer: api routes')

  ctx.effect(() => ctx.tools.register(toolDefinition(loc)), 'tiktok-localizer: tool')

  return () => {
    for (const ac of loc.aborts.values()) {
      try { ac.abort() } catch {}
    }
  }
}
