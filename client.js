/**
 * TikTok 本地化流水线 — Client 半边。
 * 左侧栏入口（sidebar.panellist）+ 主面板（main key=tiktok-localizer）。
 */
window.__ModuleLoader__.load({
  id: '@local/tiktok-localizer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'tiktok-localizer'
    const PANEL_ID = 'tiktok-localizer'

    const dict = {
      zh: {
        panel: '视频本地化',
        title: 'TikTok 本地化流水线',
        subtitle: '粘贴链接批量出片：抹除引流 单行中文字幕 标题正文 封面 汇总表',
        linksLabel: 'TikTok 链接',
        linksHint: '每行一个链接，也可以粘贴分享文本；本地视频路径同样支持',
        linksPlaceholder: 'https://www.tiktok.com/@user/video/1234567890\nhttps://vm.tiktok.com/xxxxxxx/',
        downloadHint: '链接依次尝试 yt-dlp → tikwm → hellotik；自动带上本机 7890 代理；hellotik 需先在专用 Chrome 看广告解锁点数',
        rootLabel: '输出目录',
        rootPlaceholder: '留空使用 /Volumes/Data/媒老板/海外视频本地化',
        concurrency: '并发',
        orderedHint: '按链接顺序逐条处理，全部跑完后再按序号建文件夹并改名归档',
        start: '开始处理',
        stop: '停止',
        retry: '重试失败',
        qcTitle: '质检',
        qcPass: '质检通过',
        qcWarn: '质检建议',
        qcFail: '质检不通过',
        qcReview: '质检待确认',
        qcFix: '按建议修改',
        qcIgnore: '保持现状',
        qcIssues: '问题',
        qcNone: '未质检',
        newChat: '新建对话',
        chats: '历史对话',
        chatsEmpty: '没有历史对话',
        history: '历史批次',
        historyEmpty: '还没有历史批次',
        historyOpen: '打开',
        noCaption: '无画面字幕',
        running: '处理中',
        idle: '待处理',
        done: '已完成',
        failed: '失败',
        stopped: '已停止',
        output: '输出目录',
        excel: '汇总表',
        open: '在访达打开',
        reveal: '打开',
        progress: '进度',
        emptyTitle: '还没有批次',
        emptyBody: '粘贴 TikTok 链接后开始，成品会出现在输出目录下的「序号 已完成」文件夹里。',
        log: '运行日志',
        stageQueued: '排队',
        stageDownload: '获取视频',
        stageAnalyze: '识别',
        stageTranslate: '翻译',
        stageRender: '合成',
        stageRendered: '待归档',
        stageDeliver: '归档',
        stageDone: '完成',
        stageError: '失败',
        stageStopped: '停止',
        stageRejected: '不合格',
        capsMissing: '缺少组件',
        noModel: '没有可用的对话模型，请先在设置里选择模型',
        openPanel: '打开面板',
        items: '条目',
        total: '共',
        success: '成功',
        warnAsr: '未检测到语音识别组件，本条批次只会翻译画面文字',
        submitError: '提交失败',
        networkError: '无法连接 DSH 主机',
        covers: '封面',
      },
      en: {
        panel: 'Video localizer',
        title: 'TikTok localization pipeline',
        subtitle: 'Batch links into finished clips: promo erased, single-line Chinese subtitles, title/body, cover, summary sheet',
        linksLabel: 'TikTok links',
        linksHint: 'One link per line; share text or local video paths also work',
        linksPlaceholder: 'https://www.tiktok.com/@user/video/1234567890\nhttps://vm.tiktok.com/xxxxxxx/',
        downloadHint: 'Links try yt-dlp, then tikwm, then hellotik, with the local proxy on port 7890 when present',
        rootLabel: 'Output folder',
        rootPlaceholder: 'Empty means /Volumes/Data/媒老板/海外视频本地化',
        concurrency: 'Parallel',
        orderedHint: 'Links run one by one in order; numbered folders are created and renamed in order after the whole batch finishes',
        start: 'Start',
        stop: 'Stop',
        retry: 'Retry failed',
        qcTitle: 'QC',
        qcPass: 'QC passed',
        qcWarn: 'QC warnings',
        qcFail: 'QC failed',
        qcReview: 'QC needs review',
        qcFix: 'Apply fixes',
        qcIgnore: 'Keep as is',
        qcIssues: 'issues',
        qcNone: 'not checked',
        newChat: 'New chat',
        chats: 'History chats',
        chatsEmpty: 'No past chats',
        history: 'History',
        historyEmpty: 'No past batches',
        historyOpen: 'Open',
        noCaption: 'no on-screen captions',
        running: 'Running',
        idle: 'Idle',
        done: 'Done',
        failed: 'Failed',
        stopped: 'Stopped',
        output: 'Output',
        excel: 'Summary sheet',
        open: 'Open in Finder',
        reveal: 'Open',
        progress: 'Progress',
        emptyTitle: 'No batch yet',
        emptyBody: 'Paste TikTok links and start; deliverables land in “序号 已完成” folders under the output folder.',
        log: 'Log',
        stageQueued: 'Queued',
        stageDownload: 'Fetch',
        stageAnalyze: 'Analyze',
        stageTranslate: 'Translate',
        stageRender: 'Render',
        stageRendered: 'Ready',
        stageDeliver: 'Arrange',
        stageDone: 'Done',
        stageError: 'Failed',
        stageStopped: 'Stopped',
        stageRejected: 'Rejected',
        capsMissing: 'Missing components',
        noModel: 'No chat model is available; pick one in Settings first',
        openPanel: 'Open panel',
        items: 'Items',
        total: 'Total',
        success: 'Succeeded',
        warnAsr: 'Speech recognition is unavailable; this batch translates on-screen text only',
        submitError: 'Submit failed',
        networkError: 'Cannot reach the DSH host',
        covers: 'Covers',
      },
    }

    const css = `
.tlz-page{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
.tlz-inner{max-width:920px;margin:0 auto;padding:28px 24px 56px;display:flex;flex-direction:column;gap:18px;}
.tlz-head{display:flex;flex-direction:column;gap:6px;}
.tlz-head h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px;}
.tlz-head p{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.6;}
.tlz-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;}
.tlz-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.4px;text-transform:uppercase;}
.tlz-textarea{width:100%;min-height:132px;resize:vertical;box-sizing:border-box;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px 12px;outline:none;}
.tlz-textarea:focus{border-color:var(--dsw-alias-brand-primary);}
.tlz-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.tlz-input{flex:1 1 280px;min-width:200px;box-sizing:border-box;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;padding:9px 12px;outline:none;}
.tlz-input:focus{border-color:var(--dsw-alias-brand-primary);}
.tlz-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;border-radius:9px;padding:8px 16px;cursor:pointer;transition:filter .15s,border-color .15s;}
.tlz-btn:hover:not(:disabled){filter:brightness(1.06);border-color:var(--dsw-alias-border-l2);}
.tlz-btn:disabled{opacity:.45;cursor:not-allowed;}
.tlz-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff;}
.tlz-btn.ghost{padding:5px 10px;font-size:12px;}
.tlz-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden;}
.tlz-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:7px 12px;cursor:pointer;}
.tlz-seg button.on{background:var(--dsw-alias-brand-primary);color:#fff;}
.tlz-hint{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;}
.tlz-qc{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);}
.tlz-qc-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);}
.tlz-qc-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.tlz-qc-list li{line-height:1.5;}
.tlz-qc-t{font:11px ui-monospace,Menlo,monospace;color:var(--dsw-alias-label-secondary);}
.tlz-qc.high{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);}
.tlz-qc.mid{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);}
.tlz-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary);}
.tlz-err{font-size:12px;color:var(--dsw-alias-state-error-primary);}
.tlz-bar{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.tlz-bar i{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:99px;transition:width .3s ease;}
.tlz-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);}
.tlz-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;border-radius:99px;padding:3px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
.tlz-badge.run{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);}
.tlz-badge.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary);}
.tlz-badge.err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary);}
.tlz-items{display:flex;flex-direction:column;gap:8px;}
.tlz-item{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid transparent;}
.tlz-item.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);}
.tlz-idx{width:26px;height:26px;flex:0 0 26px;border-radius:8px;background:var(--dsw-alias-bg-base);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.tlz-item-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}
.tlz-item-top{display:flex;gap:8px;align-items:center;min-width:0;}
.tlz-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tlz-msg{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word;}
.tlz-thumb{width:54px;height:96px;object-fit:cover;border-radius:8px;background:var(--dsw-alias-bg-base);flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1);}
.tlz-empty{text-align:center;padding:26px 12px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;}
.tlz-empty strong{color:var(--dsw-alias-label-primary);font-size:14px;}
.tlz-log{font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;}
.tlz-hist{display:flex;flex-direction:column;gap:6px;}
.tlz-hist-row{display:flex;gap:10px;align-items:center;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}
.tlz-hist-name{font-weight:600;color:var(--dsw-alias-label-primary);font-size:12px;}
.tlz-path{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--dsw-alias-label-secondary);}
.tlz-rowhead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}
`

    function Icon(props) {
      const size = props.size || 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block' },
        opacity: props.active ? 1 : 0.82,
      },
      h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }),
      h('path', { d: 'M10 9.5v5l4.5-2.5z', fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M3 9h18M3 15h18' }))
    }

    function api(path, init) {
      return fetch(`/api/tiktok-localizer/${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      }).then(async (res) => {
        const text = await res.text()
        let data = {}
        try { data = text ? JSON.parse(text) : {} } catch { data = { error: text } }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        return data
      })
    }

    function stageLabel(t, stage) {
      const key = {
        queued: 'stageQueued', download: 'stageDownload', analyze: 'stageAnalyze',
        translate: 'stageTranslate', render: 'stageRender', rendered: 'stageRendered',
        deliver: 'stageDeliver', done: 'stageDone', rejected: 'stageRejected',
        error: 'stageError', stopped: 'stageStopped',
      }[stage]
      return key ? t(key) : stage
    }

    function Panel() {
      const ctx = React.useContext(PanelContext)
      const t = ctx.t
      const [links, setLinks] = React.useState('')
      const [root, setRoot] = React.useState('')
      const [state, setState] = React.useState(null)
      const [caps, setCaps] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [showLog, setShowLog] = React.useState(false)
      const [openQc, setOpenQc] = React.useState({})
      const [history, setHistory] = React.useState(null)
      const [showHistory, setShowHistory] = React.useState(false)
      const [showChats, setShowChats] = React.useState(false)
      const [chats, setChats] = React.useState(null)
      const [chatsError, setChatsError] = React.useState('')

      const latest = state && state.latest
      const running = Boolean(latest && latest.status === 'running')

      const load = React.useCallback(async () => {
        try {
          const data = await api('state')
          setState(data)
          if (data.latest && data.latest.caps) setCaps((prev) => prev || data.latest.caps)
        } catch (err) {
          setError(String(err.message || err))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        api('state').then((data) => {
          if (!alive) return
          setState(data)
          if (data.latest && data.latest.caps) setCaps((prev) => prev || data.latest.caps)
        }).catch((err) => alive && setError(String(err.message || err)))
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        if (!running) return
        const timer = setInterval(load, 1300)
        return () => clearInterval(timer)
      }, [running, load])

      const start = async () => {
        setError('')
        setBusy(true)
        try {
          const data = await api('start', {
            method: 'POST',
            body: JSON.stringify({ links, outputRoot: root, concurrency: 1 }),
          })
          setState((prev) => ({ ...(prev || {}), latest: data.job }))
          await load()
          if (ctx.onNewSession && data && data.job) {
            const n = (data.job.items || []).length
            const id = data.job.id || ''
            ctx.onNewSession(`批次已开始：${n} 条，任务 #${id}。用 tiktok_localizer action=status 看进度；质检结果出来后我按建议修改。`)
          }
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      const stop = async () => {
        try {
          await api('stop', { method: 'POST', body: JSON.stringify({ jobId: latest && latest.id }) })
          await load()
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      const loadHistory = async () => {
        try {
          const data = await api('history')
          setHistory(Array.isArray(data.batches) ? data.batches : [])
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      const loadChats = async () => {
        try {
          const res = await api('chats')
          const items = (res && res.items) || []
          setChats(items)
          if (items.length) setChatsError('')
        } catch (err) {
          setChats([])
          const msg = String(err && err.message ? err.message : err)
          setChatsError(msg)
          setError(msg)
        }
      }

      const fixQc = async () => {
        setError('')
        try {
          const data = await api('fix', { method: 'POST', body: JSON.stringify({ jobId: latest && latest.id }) })
          setState((prev) => ({ ...(prev || {}), latest: data.job }))
          await load()
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      const retry = async () => {
        try {
          const data = await api('retry', {
            method: 'POST',
            body: JSON.stringify({ jobId: latest && latest.id }),
          })
          setState((prev) => ({ ...(prev || {}), latest: data.job }))
          await load()
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      const reveal = async (target) => {
        if (!target) return
        try {
          await api('reveal', { method: 'POST', body: JSON.stringify({ path: target }) })
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      const total = latest ? latest.items.length : 0
      const doneCount = latest ? latest.items.filter((i) => i.stage === 'done').length : 0
      const overall = latest && total > 0
        ? Math.round((latest.items.reduce((sum, i) => sum + (i.stage === 'done' ? 1 : (i.progress || 0)), 0) / total) * 100)
        : 0

      const reviewBanner = latest && latest.status === 'review'
        ? h('div', { className: 'tlz-row' },
          h('span', { className: 'tlz-badge err' }, `${t('qcReview')} ${latest.items.filter((i) => i.qc && i.qc.verdict !== 'pass').length}`),
          h('button', { className: 'tlz-btn primary', onClick: fixQc }, t('qcFix')),
          h('button', { className: 'tlz-btn ghost', onClick: () => setState((prev) => ({ ...prev, latest: { ...latest, status: 'done' } })) }, t('qcIgnore')))
        : null

      const renderQc = (item) => {
        if (!item.qc) return null
        const issues = item.qc.issues || []
        const tone = item.qc.verdict === 'fail' ? 'high' : item.qc.verdict === 'warn' ? 'mid' : ''
        const badgeClass = item.qc.verdict === 'pass' ? 'ok' : item.qc.verdict === 'fail' ? 'err' : ''
        const label = item.qc.verdict === 'pass' ? t('qcPass') : item.qc.verdict === 'fail' ? t('qcFail') : t('qcWarn')
        const rows = issues.slice(0, 10).map((issue, k) => {
          const head = issue.detail || issue.problem || issue.type
          const tail = issue.text ? '：' + String(issue.text).slice(0, 24) : ''
          const advice = issue.advice ? ' → ' + issue.advice : ''
          return h('li', { key: k }, h('span', { className: 'tlz-qc-t' }, `${Math.round(issue.t || 0)}s `), head + tail + advice)
        })
        return h('div', { className: `tlz-qc ${tone}` },
          h('div', { className: 'tlz-qc-head' },
            h('span', { className: `tlz-badge ${badgeClass}` }, label),
            h('span', null, `${issues.length} ${t('qcIssues')}`),
            issues.length
              ? h('button', {
                className: 'tlz-btn ghost',
                onClick: () => setOpenQc((prev) => ({ ...prev, [item.index]: !prev[item.index] })),
              }, openQc[item.index] ? '收起' : '查看')
              : null),
          openQc[item.index] ? h('ul', { className: 'tlz-qc-list' }, rows) : null)
      }

      const missing = []
      if (caps) {
        if (!caps.ffmpeg) missing.push('ffmpeg')
        if (!caps.ocr) missing.push('OCR')
        if (!caps.python) missing.push('python3')
        if (!caps.llm || !caps.llm.model) missing.push(t('noModel'))
        if (!caps.asr) missing.push('ASR')
        if (caps.download && !caps.download.hellotik && !caps.download.ytdlp) missing.push('下载组件')
      }

      return h('div', { className: 'tlz-page' },
        h('style', null, css),
        h('div', { className: 'tlz-inner' },
          h('div', { className: 'tlz-head' },
            h('div', { className: 'tlz-rowhead' },
              h('h1', null, t('title')),
              h('div', { className: 'tlz-row' },
                ctx.onNewSession ? h('button', { className: 'tlz-btn ghost', onClick: () => ctx.onNewSession() }, t('newChat')) : null,
                h('button', { className: 'tlz-btn ghost', onClick: () => { setShowChats(!showChats); loadChats() } }, t('chats')),
                h('button', { className: 'tlz-btn ghost', onClick: () => { setShowHistory(!showHistory); if (!history) loadHistory() } }, t('history')))),
            h('p', null, t('subtitle'))),

          showChats
            ? h('div', { className: 'tlz-card' },
              h('div', { className: 'tlz-rowhead' },
                h('span', { className: 'tlz-label' }, t('chats')),
                h('button', { className: 'tlz-btn ghost', onClick: loadChats }, '刷新')),
              chats && chats.length
                ? h('div', { className: 'tlz-hist' }, chats.slice(0, 20).map((c) => h('div', { className: 'tlz-hist-row', key: c.sessionId || c.id },
                  h('span', { className: 'tlz-hist-name' }, String(c.title || c.sessionId || '').slice(0, 40)),
                  c.createdAt ? h('span', { className: 'tlz-hint' }, new Date(c.createdAt).toLocaleDateString('zh-CN')) : null,
                  h('button', { className: 'tlz-btn ghost', onClick: () => ctx.onOpenSession(c.sessionId || c.id) }, t('historyOpen')))))
                : h('div', { className: 'tlz-hint' }, chatsError || t('chatsEmpty')))
            : null,
          showHistory
            ? h('div', { className: 'tlz-card' },
              h('div', { className: 'tlz-rowhead' },
                h('span', { className: 'tlz-label' }, t('history')),
                h('button', { className: 'tlz-btn ghost', onClick: loadHistory }, '刷新')),
              history && history.length
                ? h('div', { className: 'tlz-hist' }, history.map((b) => h('div', { className: 'tlz-hist-row', key: b.name },
                  h('span', { className: 'tlz-hist-name' }, b.name),
                  h('span', null, `${b.total} 条 · 完成 ${b.done}`),
                  b.review ? h('span', { className: 'tlz-badge' }, `质检待改 ${b.review}`) : null,
                  b.rejected ? h('span', { className: 'tlz-badge err' }, `不合格 ${b.rejected}`) : null,
                  b.failed ? h('span', { className: 'tlz-badge' }, `失败 ${b.failed}`) : null,
                  h('button', { className: 'tlz-btn ghost', onClick: () => reveal(b.root) }, t('historyOpen')))))
                : h('div', { className: 'tlz-hint' }, t('historyEmpty')))
            : null,
          h('div', { className: 'tlz-card' },
            h('div', { className: 'tlz-rowhead' },
              h('span', { className: 'tlz-label' }, t('linksLabel')),
              h('span', { className: 'tlz-hint' }, t('linksHint'))),
            h('textarea', {
              className: 'tlz-textarea',
              value: links,
              placeholder: t('linksPlaceholder'),
              spellCheck: false,
              onChange: (e) => setLinks(e.target.value),
            }),
            h('div', { className: 'tlz-hint' }, t('downloadHint')),
            h('div', { className: 'tlz-row' },
              h('input', {
                className: 'tlz-input',
                value: root,
                placeholder: t('rootPlaceholder'),
                onChange: (e) => setRoot(e.target.value),
              }),
              h('button', {
                className: 'tlz-btn primary',
                disabled: busy || running || !links.trim(),
                onClick: start,
              }, running ? t('running') : t('start')),
              running ? h('button', { className: 'tlz-btn', onClick: stop }, t('stop')) : null),

            h('div', { className: 'tlz-hint' }, t('orderedHint')),
            missing.length > 0
              ? h('div', { className: 'tlz-warn' }, `${t('capsMissing')}：${missing.join(' · ')}`)
              : null,
            error ? h('div', { className: 'tlz-err' }, error) : null),

          latest
            ? h('div', { className: 'tlz-card' },
              h('div', { className: 'tlz-rowhead' },
                h('div', { className: 'tlz-row' },
                  h('span', { className: `tlz-badge ${latest.status === 'running' ? 'run' : latest.status === 'done' ? 'ok' : 'err'}` },
                    latest.status === 'running' ? t('running') : latest.status === 'done' ? t('done') : latest.status === 'stopped' ? t('stopped') : t('failed')),
                  h('span', { className: 'tlz-meta' },
                    h('span', null, `${t('total')} ${total}`),
                    h('span', null, `${t('success')} ${doneCount}`),
                    h('span', null, `${overall}%`))),
                h('div', { className: 'tlz-row' },
                  latest.status !== 'running' && latest.items.some((i) => i.stage === 'error')
                    ? h('button', { className: 'tlz-btn ghost', onClick: retry }, t('retry'))
                    : null,
                  latest.root
                    ? h('button', { className: 'tlz-btn ghost', onClick: () => reveal(latest.root) }, t('open'))
                    : null)),
              h('div', { className: 'tlz-bar' }, h('i', { style: { width: `${Math.max(3, overall)}%` } })),
              h('div', { className: 'tlz-items' },
                latest.items.map((item) => h('div', {
                  key: item.index,
                  className: `tlz-item${item.stage === 'error' ? ' err' : ''}`,
                },
                h('div', { className: 'tlz-idx' }, String(item.index)),
                h('div', { className: 'tlz-item-body' },
                  h('div', { className: 'tlz-item-top' },
                    h('span', { className: `tlz-badge ${item.stage === 'done' ? 'ok' : item.stage === 'error' ? 'err' : item.stage === 'queued' ? '' : 'run'}` },
                      stageLabel(t, item.stage)),
                    h('span', { className: 'tlz-name' }, item.title || (item.kind === 'url' ? item.input : item.name))),
                  item.notice
                    ? h('div', { className: 'tlz-warn' }, `⚠ ${item.notice}`)
                    : null,
                  item.stage === 'done'
                    ? h('div', { className: 'tlz-meta' },
                      h('span', null, item.folder),
                      h('span', null, item.message))
                    : h('div', { className: 'tlz-msg' }, item.error || item.message || ''),
                  item.stage !== 'done' && item.stage !== 'queued'
                    ? h('div', { className: 'tlz-bar', style: { marginTop: 2 } }, h('i', { style: { width: `${Math.round((item.progress || 0) * 100)}%` } }))
                    : null,
                  renderQc(item)),
                item.stage === 'done' && item.coverUrl
                  ? h('img', { className: 'tlz-thumb', src: item.coverUrl, alt: '' })
                  : null))),
              latest.excel
                ? h('div', { className: 'tlz-row' },
                  h('span', { className: 'tlz-label' }, t('excel')),
                  h('span', { className: 'tlz-path' }, latest.excel),
                  h('button', { className: 'tlz-btn ghost', onClick: () => reveal(latest.excel) }, t('reveal')))
                : null,
              reviewBanner,
              h('div', { className: 'tlz-row' },
                h('button', { className: 'tlz-btn ghost', onClick: () => setShowLog(!showLog) }, t('log')),
                h('span', { className: 'tlz-path' }, latest.root)),
              showLog && latest.log && latest.log.length
                ? h('div', { className: 'tlz-log' }, latest.log.join('\n'))
                : null)
            : h('div', { className: 'tlz-card' },
              h('div', { className: 'tlz-empty' },
                h('strong', null, t('emptyTitle')),
                h('span', null, t('emptyBody'))))))
    }

    const PanelContext = React.createContext({ t: (k) => dict.zh[k] || k })

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dict), 'tiktok-localizer: dictionaries')
      const t = ctx.locale.bind(NS)
      const onSearchChats = (signal) => ctx.sessions.search('', signal)
      const onOpenSession = (id) => {
        try { ctx.uiWorkspace.openSession(id) } catch (err) { console.error('openSession failed', err) }
      }
      const onNewSession = async (customPrompt) => {
        const prompt = typeof customPrompt === 'string' && customPrompt.trim()
          ? customPrompt
          : '用 tiktok_localizer 处理新一批 TikTok 链接：'
        try {
          const ws = await ctx.workspaces.create({ path: '/Volumes/Data/媒老板' })
          ctx.uiWorkspace.startSession(ws.workspaceId, { prompt, whenDraftExists: 'append' })
        } catch (err) {
          console.error('startSession failed', err)
          try { ctx.uiWorkspace.startSession(undefined, { prompt }) } catch {}
        }
      }

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel'),
      }, Icon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t, onNewSession, onSearchChats, onOpenSession }),
      }, function PanelEntry(props) {
        return h(PanelContext.Provider, { value: { t: props.t || t, onNewSession: props.onNewSession || onNewSession, onSearchChats: props.onSearchChats || onSearchChats, onOpenSession: props.onOpenSession || onOpenSession } }, h(Panel, null))
      }))
    }

    return { inject: ['slots', 'locale', 'uiWorkspace', 'sessions', 'workspaces'], apply }
  },
})
