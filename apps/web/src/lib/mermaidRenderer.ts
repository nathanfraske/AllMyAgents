import createDOMPurify from 'dompurify'
import mermaidBundle from 'mermaid/dist/mermaid.min.js?url'

export const MERMAID_MAX_CHARS = 20_000
export const MERMAID_TIMEOUT_MS = 10_000
const MAX_SVG_CHARS = 1_000_000
const CACHE_BYTES = 4 * 1024 * 1024
const cache = new Map<string, string>()
let cacheBytes = 0
let queue: Promise<unknown> = Promise.resolve()

export function mermaidSourceError(source: string): string | undefined {
  if (source.length > MERMAID_MAX_CHARS) return 'Diagram exceeds the 20,000-character preview limit. Its source is still available.'
  if (!source.trim()) return 'The diagram is empty.'
  // A chat diagram describes data, not renderer configuration. In particular, themeCSS/font URLs,
  // callbacks, HTML labels and renderer/plugin overrides must not be supplied by message content.
  if (/%%\s*\{|^\s*---(?:\r?\n|$)/.test(source)) return 'Diagram configuration directives/frontmatter are not supported. Remove them to preview the diagram.'
  return undefined
}

function attr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** The model source NEVER enters srcdoc. Only our local, pinned bundle and fixed bootstrap run here.
 * Opaque-origin sandbox: no parent DOM, cookies, storage, navigation, popups, forms or network requests.
 * A nonce permits precisely these two scripts; Mermaid-generated scripts cannot run even in the frame.
 */
export function mermaidFrameDocument(bundleUrl: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${attr(nonce)}'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<style>body{margin:0;background:white;font-family:Arial,sans-serif}</style>
</head><body><div id="diagram"></div>
<script nonce="${attr(nonce)}" src="${attr(bundleUrl)}"></script>
<script nonce="${attr(nonce)}">
const channel=${JSON.stringify(nonce)};
const send=(data)=>parent.postMessage({channel,...data},'*');
const receive=async(event)=>{
  if(event.source!==parent || event.data?.channel!==channel || typeof event.data?.source!=='string')return;
  removeEventListener('message',receive);
  try{
    if(event.data.source.length>${MERMAID_MAX_CHARS})throw Error('Diagram is too large');
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default',fontFamily:'Arial, sans-serif',
      htmlLabels:false,flowchart:{htmlLabels:false},layout:'dagre',maxTextSize:${MERMAID_MAX_CHARS},maxEdges:200,
      suppressErrorRendering:true,secure:['securityLevel','startOnLoad','maxTextSize','maxEdges','htmlLabels','flowchart','theme','themeCSS','fontFamily','layout']});
    const {svg}=await mermaid.render('chat-diagram',event.data.source,document.getElementById('diagram'));
    if(svg.length>${MAX_SVG_CHARS})throw Error('Rendered diagram is too large');
    send({kind:'rendered',svg});
  }catch(error){send({kind:'error',message:String(error?.message||error).slice(0,300)});}
};
addEventListener('message',receive);
send({kind:'ready'});
</script></body></html>`
}

/** Defense in depth: the result is an inert SVG image, NEVER app DOM via {@html}. */
export function mermaidImage(svg: string): string {
  if (svg.length > MAX_SVG_CHARS) throw new Error('Rendered diagram is too large')
  // Separate instance: Markdown's app-specific link/reveal hooks do not belong on diagram SVGs.
  const purify = createDOMPurify(window)
  const clean = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'use', 'animate', 'animateTransform', 'set'],
    FORBID_ATTR: ['href', 'xlink:href', 'src'],
    ADD_TAGS: ['style'],
  })
  if (!/^<svg[\s>]/i.test(clean)) throw new Error('Renderer did not return an SVG diagram')
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || document.querySelector('parsererror')) throw new Error('Renderer returned invalid SVG')
  const dimensions = root.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number)
  if (dimensions?.length === 4 && dimensions.every(Number.isFinite) && dimensions[2]! > 0 && dimensions[3]! > 0) {
    // Mermaid's width="100%" is intended for inline SVG. As an image it would stretch a small sequence
    // diagram to the whole bubble. Give the image its real intrinsic dimensions; CSS only scales down.
    root.setAttribute('width', String(dimensions[2]))
    root.setAttribute('height', String(dimensions[3]))
  }
  // SVG loaded as an image cannot execute scripts or fetch external resources. Its CSS has no access
  // to the app document, including model-supplied classDef/style rules.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
}

function isolatedRender(source: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    const channel = crypto.randomUUID()
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.referrerPolicy = 'no-referrer'
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:1000px;border:0;pointer-events:none'
    let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      signal.removeEventListener('abort', abort)
      frame.remove()
      if (error) reject(error)
      else resolve(value!)
    }
    const abort = () => finish(new DOMException('Diagram rendering cancelled', 'AbortError'))
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.channel !== channel) return
      if (event.data.kind === 'ready') frame.contentWindow?.postMessage({ channel, source }, '*')
      else if (event.data.kind === 'rendered' && typeof event.data.svg === 'string') {
        try { finish(undefined, mermaidImage(event.data.svg)) } catch (error) { finish(error as Error) }
      } else if (event.data.kind === 'error') {
        finish(new Error(typeof event.data.message === 'string' ? event.data.message.slice(0, 300) : 'Diagram rendering failed'))
      }
    }
    const timer = setTimeout(() => finish(new Error('Diagram preview timed out. Its source is still available.')), MERMAID_TIMEOUT_MS)
    window.addEventListener('message', receive)
    signal.addEventListener('abort', abort, { once: true })
    frame.srcdoc = mermaidFrameDocument(new URL(mermaidBundle, document.baseURI).href, channel)
    document.body.append(frame)
    if (signal.aborted) abort()
  })
}

/** One renderer at a time; completed diagrams are cached within explicit byte/count ceilings. */
export function renderMermaid(source: string, signal: AbortSignal): Promise<string> {
  const error = mermaidSourceError(source)
  if (error) return Promise.reject(new Error(error))
  const work = queue.then(async () => {
    if (signal.aborted) throw new DOMException('Diagram rendering cancelled', 'AbortError')
    const prior = cache.get(source)
    if (prior) { cache.delete(source); cache.set(source, prior); return prior }
    const result = await isolatedRender(source, signal)
    const bytes = 2 * (source.length + result.length)
    if (bytes <= CACHE_BYTES) {
      cache.set(source, result); cacheBytes += bytes
      while (cacheBytes > CACHE_BYTES || cache.size > 16) {
        const key = cache.keys().next().value!
        cacheBytes -= 2 * (key.length + cache.get(key)!.length)
        cache.delete(key)
      }
    }
    return result
  })
  queue = work.catch(() => {})
  return work
}
