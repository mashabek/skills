import type { EngineInterface, Register } from 'claude-code'

// The runtime has the ES2025 base64 helpers; the ES2023 lib does not name them.
declare global {
  interface Uint8Array { toBase64(): string }
  interface Uint8ArrayConstructor { fromBase64(text: string): Uint8Array }
}

const PANE = 'projector'
const TITLE = 'Projector'
const FPS = 15
const CACHE_VERSION = 2

// Frames are rendered once at SRC (vertically squashed by two, as cells are
// twice as tall as wide) and box-filtered down to the pane's width when packed.
const SRC = { w: 320, h: 90 } as const
type Size = { cols: number; rows: number }
const sizeFor = (cols: number): Size => {
  const c = Math.max(8, Math.min(cols, SRC.w / 2))
  return { cols: c, rows: Math.max(2, Math.round((c * 9) / 32)) }
}

type Video = { url: string; dir: string; title: string; duration: number; frames: number }
type Mode = 'image' | 'pixels'

// Browser whose session yt-dlp may reuse when a download hits a sign-in check;
// 'off' never touches a browser. Cycled by the Cookies button.
const BROWSERS = ['off', 'chrome', 'safari', 'firefox'] as const
type Browser = (typeof BROWSERS)[number]

let video: Video | undefined
let mode: Mode = 'pixels'
let isModeAuto = true
let cookies: Browser = 'off'
let isPlaying = false
let frame = 1
let startedAt = 0
let timer: { cancel: () => void } | undefined
let audio: AsyncGenerator<unknown, unknown> | undefined
let status = 'idle'
let shown: Size = sizeFor(48)
let imageCols = 48
let urlText = ''
let urlToDraw: string | undefined
let playId = 0
const cellCache = new Map<string, string>()

// Where the cache and the tools are, found once per load.
let cache = ''
const tools: Record<string, string> = {}
const findTool = async ($: EngineInterface, name: string) => {
  if (tools[name]) return tools[name]!
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    if (await exists($, `${dir}/${name}`)) return (tools[name] = `${dir}/${name}`)
  }
  return (tools[name] = name)
}
const cacheDir = async ($: EngineInterface) => {
  if (!cache) {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '/tmp'
    cache = `${home}/.cache/projector`
  }
  return cache
}

const hashOf = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}
const pad = (n: number) => String(n).padStart(5, '0')
const pngPath = (v: Video, n: number) => `${v.dir}/png/f${pad(n)}.png`
const rgbPath = (v: Video, n: number) => `${v.dir}/px/f${pad(n)}.rgb`
const exists = ($: EngineInterface, path: string) => $.fs.stat(path).then(() => true, () => false)

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const setStatus = ($: EngineInterface, text: string) => {
  status = text
  $.ui.invalidate('ui.render')
}

// Which terminal draws this session: the ones that take inline images get them.
const detectMode = async ($: EngineInterface): Promise<Mode> => {
  const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  const term = ((await $.env.get('TERM')) ?? '').toLowerCase()
  const isKitty = Boolean(await $.env.get('KITTY_WINDOW_ID')) || term.includes('kitty')
  const isTmux = Boolean(await $.env.get('TMUX'))
  const takesImages = isKitty || ['ghostty', 'iterm.app', 'wezterm'].includes(program)
  return takesImages && !isTmux ? 'image' : 'pixels'
}

const DEFAULT_COLOR = 0x01000000
// Each cell holds a 2x2 block of pixels, drawn with a quadrant character: the
// brighter pixels in the foreground color, the darker in the background.
// Index: bit 3 top-left, bit 2 top-right, bit 1 bottom-left, bit 0 bottom-right.
const QUADRANT = [
  0x20, 0x2597, 0x2596, 0x2584, 0x259d, 0x2590, 0x259e, 0x259f,
  0x2598, 0x259a, 0x258c, 0x2599, 0x2580, 0x259c, 0x259b, 0x2588,
] as const

const luma = (px: Uint8Array, at: number) =>
  px[at]! * 0.299 + px[at + 1]! * 0.587 + px[at + 2]! * 0.114

// One frame's cells, packed as RasterProps wants: [codePoint, fg, bg] per cell.
const cellsOf = async ($: EngineInterface, v: Video, size: Size, n: number) => {
  const id = `${v.dir}:${size.cols}:${n}`
  const hit = cellCache.get(id)
  if (hit) return hit
  const { base64 } = await $.fs.read(rgbPath(v, n), { as: 'bytes' })
  const src = Uint8Array.fromBase64(base64)
  if (src.length < SRC.w * SRC.h * 3) throw new Error('frame not written yet')
  const width = size.cols * 2
  const height = size.rows * 2
  const px = new Uint8Array(width * height * 3)
  const xs = Array.from({ length: width + 1 }, (_, i) => Math.round((i * SRC.w) / width))
  const ys = Array.from({ length: height + 1 }, (_, i) => Math.round((i * SRC.h) / height))
  for (let y = 0; y < height; y++) {
    const y0 = ys[y]!, y1 = Math.max(ys[y]! + 1, ys[y + 1]!)
    for (let x = 0; x < width; x++) {
      const x0 = xs[x]!, x1 = Math.max(xs[x]! + 1, xs[x + 1]!)
      let r = 0, g = 0, b = 0, count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * SRC.w + sx) * 3
          r += src[o]!; g += src[o + 1]!; b += src[o + 2]!; count++
        }
      }
      const t = (y * width + x) * 3
      px[t] = r / count; px[t + 1] = g / count; px[t + 2] = b / count
    }
  }
  const words = new Uint32Array(size.cols * size.rows * 3)
  const at = new Array<number>(4)
  const lum = new Array<number>(4)
  let i = 0
  for (let r = 0; r < size.rows; r++) {
    for (let c = 0; c < size.cols; c++) {
      at[0] = ((r * 2) * width + c * 2) * 3
      at[1] = at[0]! + 3
      at[2] = ((r * 2 + 1) * width + c * 2) * 3
      at[3] = at[2]! + 3
      let mean = 0
      for (let k = 0; k < 4; k++) { lum[k] = luma(px, at[k]!); mean += lum[k]! }
      mean /= 4
      let bits = 0
      let fr = 0, fg = 0, fb = 0, fn = 0
      let br = 0, bg = 0, bb = 0, bn = 0
      for (let k = 0; k < 4; k++) {
        const o = at[k]!
        if (lum[k]! >= mean) {
          bits |= 8 >> k
          fr += px[o]!; fg += px[o + 1]!; fb += px[o + 2]!; fn++
        } else {
          br += px[o]!; bg += px[o + 1]!; bb += px[o + 2]!; bn++
        }
      }
      const fore = fn ? ((fr / fn) << 16) | ((fg / fn) << 8) | (fb / fn) : 0
      const back = bn ? ((br / bn) << 16) | ((bg / bn) << 8) | (bb / bn) : fore
      words[i++] = QUADRANT[bits]!
      words[i++] = fore
      words[i++] = back
    }
  }
  const cells = new Uint8Array(words.buffer).toBase64()
  if (cellCache.size > 8) cellCache.clear()
  cellCache.set(id, cells)
  return cells
}

const blank = (size: Size) => {
  const words = new Uint32Array(size.cols * size.rows * 3)
  for (let i = 0; i < words.length; i += 3) {
    words[i] = 0x20
    words[i + 1] = DEFAULT_COLOR
    words[i + 2] = DEFAULT_COLOR
  }
  return new Uint8Array(words.buffer).toBase64()
}

// A one-row strip of text as Raster cells, repainted by blit without a redraw.
const CLOCK_COLS = 16
const textCells = (text: string, cols: number) => {
  const words = new Uint32Array(cols * 3)
  for (let i = 0; i < cols; i++) {
    const code = text.charCodeAt(i)
    words[i * 3] = i < text.length && code >= 0x20 && code < 0xffff ? code : 0x20
    words[i * 3 + 1] = DEFAULT_COLOR
    words[i * 3 + 2] = DEFAULT_COLOR
  }
  return new Uint8Array(words.buffer).toBase64()
}

// Frames cost about 100 MB a minute, so the cache keeps only the video being
// played; every other cached video is removed.
const prune = async ($: EngineInterface, keep: string) => {
  const root = await cacheDir($)
  const entries = await $.fs.list(root).catch(() => [])
  const gone = entries
    .filter(entry => entry.kind === 'dir' && entry.name.startsWith('v_'))
    .map(entry => `${root}/${entry.name}`)
    .filter(dir => dir !== keep)
  if (gone.length) await $.process.run(['/bin/rm', '-rf', ...gone])
}

// Fetches the video once and renders its frames into the cache, in the
// background: one ffmpeg decode, two outputs (PNG for images, raw RGB for
// pixel art). Resolves once the metadata is known and frames flow.
const prepare = async ($: EngineInterface, url: string): Promise<Video | undefined> => {
  const dir = `${await cacheDir($)}/v_${hashOf(url)}`
  const metaPath = `${dir}/meta.json`
  await prune($, dir)
  if (await exists($, metaPath)) {
    const meta = JSON.parse(await $.fs.read(metaPath)) as Omit<Video, 'url' | 'dir'> & { version?: number }
    if (meta.version === CACHE_VERSION) return { url, dir, ...meta }
    await $.process.run(['/bin/rm', '-rf', dir])
  }
  await $.process.run(['/bin/mkdir', '-p', `${dir}/png`, `${dir}/px`])
  const ffmpeg = await findTool($, 'ffmpeg')
  const ffprobe = await findTool($, 'ffprobe')
  let source = url
  let title = url
  if (!url.startsWith('/') && !url.startsWith('~')) {
    setStatus($, 'downloading…')
    const ytdlp = await findTool($, 'yt-dlp')
    const download = (extra: readonly string[]) => $.process.run(
      [ytdlp, '-q', '--no-simulate', '--print', 'title', ...extra,
        '-f', 'bv*[height<=360][ext=mp4]+ba[ext=m4a]/b[height<=360]/bv*+ba/b',
        '--merge-output-format', 'mp4', '-o', `${dir}/video.mp4`, url],
      { timeoutMs: 600000 },
    ).catch((error: unknown) => ({ exitCode: 127, stdout: '', stderr: `${ytdlp}: ${String(error)}` }))
    let dl = await download([])
    if (dl.exitCode !== 0 && cookies !== 'off' && /sign in|cookies|age/i.test(dl.stderr)) {
      // Anonymous download refused: retry as the person, with their browser's session.
      setStatus($, `downloading with ${cookies} cookies…`)
      dl = await download(['--cookies-from-browser', cookies])
    }
    if (dl.exitCode !== 0) { setStatus($, `download failed: ${dl.stderr.trim().split('\n').pop()}`); return undefined }
    title = dl.stdout.trim().split('\n')[0] || url
    source = `${dir}/video.mp4`
  } else if (url.startsWith('~')) {
    source = `${(await $.env.get('HOME')) ?? ''}${url.slice(1)}`
    title = url.split('/').pop() || url
  } else {
    title = url.split('/').pop() || url
  }
  setStatus($, 'reading the video…')
  const probe = await $.process.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source])
    .catch((error: unknown) => ({ exitCode: 127, stdout: '', stderr: `${ffprobe}: ${String(error)}` }))
  const duration = Number(probe.stdout.trim())
  if (probe.exitCode !== 0 || !Number.isFinite(duration) || duration <= 0) { setStatus($, `not a video: ${probe.stderr.trim()}`); return undefined }
  const au = await $.process.run(
    [ffmpeg, '-v', 'error', '-y', '-i', source, '-vn', '-ac', '2', '-ar', '44100', `${dir}/audio.wav`],
    { timeoutMs: 600000 },
  )
  if (au.exitCode !== 0) { setStatus($, `ffmpeg failed: ${au.stderr.trim()}`); return undefined }
  const graph = [
    `[0:v]fps=${FPS},split=2[png][px]`,
    `[png]scale=640:360[png_out]`,
    `[px]scale=w=${SRC.w}:h=${SRC.h}:flags=lanczos,unsharp=5:5:0.8[px_out]`,
  ].join(';')
  const argv = [ffmpeg, '-v', 'error', '-y', '-i', source, '-an', '-filter_complex', graph,
    '-map', '[png_out]', `${dir}/png/f%05d.png`,
    '-map', '[px_out]', '-f', 'image2', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', `${dir}/px/f%05d.rgb`,
  ]
  // Rendering runs on in the background; playback follows the frames as they land.
  void (async () => {
    const render = $.process.spawn({ argv })
    let err = ''
    try {
      for await (const { stream, text } of render) if (stream === 'stderr') err += text
    } catch { /* module unloaded */ }
    if (err.trim()) $.ui.log(`projector: ffmpeg: ${err.trim()}`, { to: 'debug' })
  })()
  const meta = { title, duration, frames: Math.max(1, Math.ceil(duration * FPS)), version: CACHE_VERSION }
  await $.fs.write(metaPath, JSON.stringify(meta))
  return { url, dir, ...meta }
}

const stop = ($: EngineInterface) => {
  playId++
  timer?.cancel()
  timer = undefined
  void audio?.return(undefined)
  audio = undefined
  if (cache) void $.process.run(['/usr/bin/pkill', '-f', `(afplay|ffplay) .*${cache}/`])
  isPlaying = false
  setStatus($, 'stopped')
}

const play = async ($: EngineInterface, url: string) => {
  stop($)
  const me = playId
  if (isModeAuto) mode = await detectMode($)
  const v = await prepare($, url.trim())
  if (me !== playId) { status = 'replaced by a newer play'; return false }
  if (!v) return false
  video = v
  setStatus($, 'waiting for the first frames…')
  for (let i = 0; i < 300 && !(await exists($, pngPath(v, Math.min(v.frames, FPS)))); i++) await $.clock.sleep(100)
  if (me !== playId) { status = 'replaced by a newer play'; return false }
  isPlaying = true
  frame = 1
  startedAt = await $.clock.now()
  setStatus($, 'playing')

  // Sound: the player lives as long as this loop; ending the loop kills it.
  // afplay on macOS, ffplay elsewhere; without either the video plays silent.
  void (async () => {
    const player = (await exists($, '/usr/bin/afplay'))
      ? ['/usr/bin/afplay', `${v.dir}/audio.wav`]
      : [await findTool($, 'ffplay'), '-nodisp', '-autoexit', '-loglevel', 'quiet', `${v.dir}/audio.wav`]
    if (me !== playId) return
    const child = $.process.spawn({ argv: player })
    audio = child
    try { for await (const _ of child) { /* nothing to read */ } } catch { /* killed or no player */ }
  })()

  let lastSecond = -1
  let isBusy = false
  timer = $.clock.every(Math.round(1000 / FPS), async () => {
    if (isBusy || me !== playId) return
    isBusy = true
    try {
      const elapsed = (await $.clock.now()) - startedAt
      if (elapsed / 1000 >= v.duration) { stop($); setStatus($, 'finished'); return }
      const next = Math.min(v.frames, Math.floor((elapsed / 1000) * FPS) + 1)
      if (next === frame) return
      frame = next
      if (mode === 'image') {
        if (!(await exists($, pngPath(v, frame)))) return
        const { deny } = await $.ui.blit({ requestId: PANE, key: 'video', source: { file: pngPath(v, frame), format: 'png' } })
        if (deny && !deny.startsWith('no-surface')) {
          // The terminal will not draw images: fall back to pixel art for good.
          mode = 'pixels'
          isModeAuto = false
          $.ui.log(`projector: inline images refused (${deny}); drawing pixel art`, { to: 'debug' })
          $.ui.invalidate('ui.render')
        }
      } else {
        const size = shown
        const cells = await cellsOf($, v, size, frame).catch(() => undefined)
        if (!cells) return
        await $.ui.blit({ requestId: PANE, key: 'video', cells, columns: size.cols, rows: size.rows })
      }
      const second = Math.floor(elapsed / 1000)
      if (second !== lastSecond) {
        lastSecond = second
        await $.ui.blit({ requestId: PANE, key: 'clock', cells: textCells(`> ${clock(second)} / ${clock(v.duration)}`, CLOCK_COLS), columns: CLOCK_COLS, rows: 1 })
      }
    } finally {
      isBusy = false
    }
  })
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'projector',
      description: 'Play a video in a pane: a YouTube or other yt-dlp URL, or a local file; no URL opens the pane',
      argumentHint: '[url or file]',
    })
    return next(e)
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    if (isPlaying || timer) stop($)
    return next(e)
  })

  on('command.run', { command: 'projector' }, async ($, e) => {
    const url = e.args.trim()
    await $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
    if (!url) return { text: 'Projector pane opened. Paste a video URL or a file path into it.' }
    urlText = url
    urlToDraw = url
    const ok = await play($, url)
    return { text: ok ? `Playing ${video?.title ?? url} in the Projector pane.` : `Could not play it: ${status}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return <Box><Text dimColor>The video draws on the terminal only.</Text></Box>
    }
    const { Box, Text, Button, Input, Raster, Image } = $.ui.resolve(e)
    const v = video
    const drawValue = urlToDraw
    urlToDraw = undefined
    const toggle = () => { if (isPlaying) stop($); else if (v) void play($, v.url) }
    // One size for this whole draw: a redraw that overlaps (a resize) must not
    // relabel cells packed for another width.
    const width = e.props.bodyColumns
    const size = sizeFor(width)
    shown = size
    if (mode === 'image') imageCols = Math.max(8, Math.min(width, 255))
    const barWidth = mode === 'image' ? imageCols : size.cols
    const barText = isPlaying ? 'click to stop' : v ? 'click to play' : 'paste a URL below'
    const side = Math.max(0, Math.floor((barWidth - barText.length - 2) / 2))
    const bar = (
      <Button key="bar" plain dimColor onPress={toggle}>
        {'─'.repeat(side) + ' ' + barText + ' ' + '─'.repeat(Math.max(0, barWidth - side - barText.length - 2))}
      </Button>
    )
    const controls = (
      <Box flexDirection="column">
        {bar}
        <Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden" marginRight={1}>
            <Text bold>{(v?.title ?? 'Nothing loaded').slice(0, Math.max(8, barWidth - CLOCK_COLS - 1))}</Text>
          </Box>
          <Raster key="clock" columns={CLOCK_COLS} rows={1} cells={textCells(isPlaying ? `> ${clock((frame - 1) / FPS)} / ${clock(v?.duration ?? 0)}` : `  0:00 / ${clock(v?.duration ?? 0)}`, CLOCK_COLS)} />
        </Box>
        <Input
          key="url"
          label="URL "
          placeholder="paste a video URL or a file path and press Enter"
          value={drawValue}
          submitLabel="play"
          onInput={text => { urlText = text }}
          onSubmit={text => { urlText = text; if (text.trim()) void play($, text.trim()) }}
        />
        <Box>
          <Button key="play" hotkey="p" variant="primary" onPress={() => { const url = v?.url ?? urlText.trim(); if (url) void play($, url) }}>Play</Button>
          <Text> </Text>
          <Button key="stop" hotkey="s" onPress={() => stop($)}>Stop</Button>
          <Text> </Text>
          <Button key="mode" hotkey="m" onPress={() => { mode = mode === 'image' ? 'pixels' : 'image'; isModeAuto = false; $.ui.invalidate('ui.render') }}>
            {mode === 'image' ? 'Pixel art' : 'Image'}
          </Button>
          <Text> </Text>
          <Button key="cookies" hotkey="c" onPress={() => { cookies = BROWSERS[(BROWSERS.indexOf(cookies) + 1) % BROWSERS.length]!; $.ui.invalidate('ui.render') }}>
            Cookies: {cookies}
          </Button>
        </Box>
        {!['idle', 'playing', 'stopped', 'finished'].includes(status) && <Text dimColor>{status}</Text>}
      </Box>
    )
    if (mode === 'image') {
      const rows = Math.max(2, Math.round(imageCols * (9 / 16) / 2))
      const source = v && (await exists($, pngPath(v, isPlaying ? frame : 1)))
        ? { file: pngPath(v, isPlaying ? frame : 1), format: 'png' as const }
        : { rgba: new Uint8Array(4).toBase64(), width: 1, height: 1 }
      return (
        <Box flexDirection="column">
          <Image key="video" source={source} columns={imageCols} rows={rows} alt="(inline images need Ghostty, Kitty, WezTerm or iTerm2; press m for pixel art)" />
          {controls}
        </Box>
      )
    }
    const cells = isPlaying && v
      ? await cellsOf($, v, size, frame).catch(() => blank(size))
      : blank(size)

    return (
      <Box flexDirection="column">
        <Raster key="video" columns={size.cols} rows={size.rows} cells={cells} />
        {controls}
      </Box>
    )
  })
}
