window.__ModuleLoader__.load({ id: "dsh-restart-button", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-restart-button — browser half.
//
// Registers one action beside Settings at the sidebar foot. The button owns the
// whole rest of the feature, because the interesting part is not the click: it is
// making the page come back by itself once the app has been killed and relaunched
// underneath it.
//
// THE PROBLEM THE POLLING SOLVES
//
// Clicking restart deliberately kills the process serving this page. The page
// itself is NOT unloaded - it is only its connection that dies - so it survives
// the restart and can bring itself back. But it cannot simply poll until the
// server answers: the server is still answering for the ~1.2 s between the
// response and the kill, so "the server answered" would fire immediately and
// reload into the OLD process, which looks like the button did nothing.
//
// So the Host half stamps every response with a token that identifies the
// process it came from. The page remembers the token it is talking to and waits
// for a DIFFERENT one. A different token can only mean a different process, which
// is exactly the thing being waited for - no timeouts, no guessing.
//
// Everything here is reached through the dynamic `ctx.inject` form, never
// `ctx.get`: a required service would leave the fiber pending and the action
// would silently never register.

/** Dedicated route the Host half serves. */
const ROUTE = '/plugins/dsh-restart-button'

/** Slot the action lands in: the row beside Settings at the sidebar foot. */
const SLOT = 'sidebar.footer.action'

/** This entry's id inside that slot. */
const ENTRY_ID = 'restart-button'

/** Style tag id, so the stylesheet is installed exactly once. */
const STYLE_ID = 'dsh-restart-button-style'

/** How long the "click again to confirm" state stays armed. */
const CONFIRM_MS = 5000

/** How long to wait for the app to come back before giving up. */
const RETURN_TIMEOUT_MS = 90000

/** Gap between liveness polls while waiting for the new process. */
const POLL_MS = 800

// Geometry copied from the shipped footer action (`ui-cordis`' panel button) so
// this reads as part of the sidebar rather than as a guest: 42px row, 12px
// radius, the same padding and hover token, and a 36px circle in rail mode.
// No backticks anywhere in this sheet - a stray one has already cost this project
// a silent build failure.
const CSS = [
  '.dsrb-btn{width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;',
  'display:inline-flex;align-items:center;gap:8px;overflow:hidden;',
  'background:0 0;border:none;border-radius:12px;color:var(--dsw-alias-label-primary);',
  'font-family:inherit;font-size:14px;cursor:pointer;text-align:left}',
  '.dsrb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsrb-btn:disabled{cursor:default;opacity:.75}',
  '.dsrb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f9dd9);',
  'outline-offset:-2px}',
  '.dsrb-icon{flex:none;width:18px;height:18px;display:block}',
  '.dsrb-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsrb-rail{width:36px;height:36px;padding:0;border-radius:50%;justify-content:center;gap:0}',
  '.dsrb-btn[data-armed="1"]{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsrb-btn[data-armed="1"] .dsrb-label{color:var(--dsw-alias-label-error,#d24a43);',
  'font-weight:600}',
  '.dsrb-btn[data-busy="1"] .dsrb-icon{animation:dsrb-spin 1s linear infinite}',
  '@keyframes dsrb-spin{to{transform:rotate(360deg)}}',
  '.dsrb-note{margin:6px 2px 0;font-size:11.5px;line-height:1.5;',
  'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}',
  '.dsrb-note.err{color:var(--dsw-alias-label-error,#d24a43)}',
].join('')

/** Install the stylesheet once per document. */
function ensureStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * The restart glyph: a circular arrow, drawn inline so the button needs no asset
 * and no network request.
 * @param React - the React runtime handed in through the inject face.
 * @returns the icon element.
 */
function RestartIcon(React) {
  return React.createElement('svg', {
    className: 'dsrb-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  React.createElement('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
  React.createElement('polyline', { points: '21 3 21 9 15 9' }))
}

/**
 * The sidebar action.
 *
 * Three states, in one component: idle, armed (one more click confirms), and
 * busy (restart under way, then waiting for the app to come back). The confirm
 * step exists because the click destroys running work - a single stray click on
 * a footer button should not end an agent turn.
 * @param props - the slot's inject face plus the owner's `wide` flag.
 * @returns the button element.
 */
function RestartButton(props) {
  const React = props.runtime
  const wide = props.wide !== false
  const [armed, setArmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  // 'restarting' once the Host has accepted, 'waiting' once the app has actually
  // gone away, 'failed' when it never came back.
  const [phase, setPhase] = React.useState(null)
  const [failure, setFailure] = React.useState(null)
  const tokenRef = React.useRef(null)
  const timerRef = React.useRef(null)

  ensureStyle()

  // The token of the process this page is currently served by. Read once, so the
  // wait after a restart can tell the new process from the old one.
  React.useEffect(() => {
    let live = true
    fetch(`${ROUTE}/info`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((info) => { if (live && info !== null) tokenRef.current = info.token })
      .catch(() => { /* the token simply stays unknown; see the fallback below */ })
    return () => { live = false }
  }, [])

  // Disarm the confirm state on its own, so an abandoned click does not leave a
  // button that restarts on the next touch.
  React.useEffect(() => {
    if (!armed) return undefined
    const handle = setTimeout(() => setArmed(false), CONFIRM_MS)
    return () => clearTimeout(handle)
  }, [armed])

  // Stop polling if the component goes away mid-wait.
  React.useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])

  /**
   * Wait for a DIFFERENT Host process to answer, then reload into it.
   *
   * A failed fetch is the expected state for most of the wait - the app is down -
   * so it is not an error. The only outcomes are "another process answered"
   * (reload) or the deadline (report it).
   */
  const waitForReturn = () => {
    const known = tokenRef.current
    const deadline = Date.now() + RETURN_TIMEOUT_MS
    let sawOutage = false
    setPhase('waiting')

    const poll = () => {
      if (Date.now() > deadline) {
        setBusy(false)
        setPhase('failed')
        setFailure('DSH 在规定时间内没有回来。请看重启日志，或者手动打开 DSH。')
        return
      }
      fetch(`${ROUTE}/info`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((info) => {
          if (info === null || typeof info.token !== 'string') {
            sawOutage = true
            timerRef.current = setTimeout(poll, POLL_MS)
            return
          }
          // Both conditions matter. A different token is proof of a new process;
          // seeing an outage first is what keeps a fast, cached, or partially
          // failed response from being mistaken for the relaunched app.
          if (info.token !== known && (sawOutage || known === null)) {
            window.location.reload()
            return
          }
          if (info.token !== known) {
            // New process already answering, but this page never saw the outage.
            // Reloading is still correct; the token is the authority.
            window.location.reload()
            return
          }
          timerRef.current = setTimeout(poll, POLL_MS)
        })
        .catch(() => {
          sawOutage = true
          timerRef.current = setTimeout(poll, POLL_MS)
        })
    }
    timerRef.current = setTimeout(poll, POLL_MS)
  }

  /** Ask the Host to restart the app, then wait for it to come back. */
  const restart = () => {
    setArmed(false)
    setBusy(true)
    setPhase('restarting')
    setFailure(null)
    fetch(`${ROUTE}/restart`, { method: 'POST', cache: 'no-store' })
      .then((response) => response.json()
        .catch(() => ({ ok: false, error: `Host 回答了 HTTP ${String(response.status)}` })))
      .then((answer) => {
        if (answer !== null && typeof answer === 'object' && answer.ok === true) {
          // The response is sent just before the app is killed, so the wait
          // starts now and survives the connection dropping.
          if (typeof answer.token === 'string') tokenRef.current = answer.token
          waitForReturn()
          return
        }
        setBusy(false)
        setPhase('failed')
        setFailure(answer !== null && typeof answer === 'object' && answer.error !== undefined
          ? String(answer.error)
          : '重启请求没有被接受。')
      })
      // A network failure here is ambiguous: it is what a successful restart also
      // looks like once the kill lands mid-request. Waiting is the safe reading -
      // if the app is in fact still up, the token simply never changes and the
      // deadline reports it.
      .catch(() => { waitForReturn() })
  }

  const label = phase === 'failed'
    ? '重启失败'
    : busy
      ? (phase === 'waiting' ? '等待 DSH 回来…' : '正在重启…')
      : armed
        ? '再点一次确认'
        : '重启 DSH'

  const title = phase === 'failed'
    ? (failure ?? '重启失败')
    : busy
      ? 'DSH 正在关闭并重新启动，页面会自动恢复。'
      : armed
        ? '会中断正在运行的任务，再点一次就重启。'
        : '关闭并重新启动 DSH（正在运行的任务会被中断）'

  const button = React.createElement('button', {
    type: 'button',
    className: wide ? 'dsrb-btn' : 'dsrb-btn dsrb-rail',
    'data-armed': armed ? '1' : '0',
    'data-busy': busy ? '1' : '0',
    disabled: busy,
    title,
    'aria-label': title,
    onClick: () => {
      if (busy) return
      if (armed) restart()
      else setArmed(true)
    },
  },
  RestartIcon(React),
  wide ? React.createElement('span', { className: 'dsrb-label' }, label) : null)

  // In rail mode the sidebar is 56px wide and every neighbour is a bare icon, so
  // a message under the button would be clipped and would push the row out of
  // shape. The failure is still reachable: it is in the button's tooltip.
  if (!wide || failure === null) return button

  return React.createElement('div', null,
    button,
    React.createElement('div', { className: 'dsrb-note err' }, failure))
}

/**
 * Read one awaited service from the injected owner context.
 * @param owner - the context passed to the inject callback.
 * @param serviceName - service name.
 * @returns the service, or undefined when it is not reachable.
 */
function serviceAt(owner, serviceName) {
  try {
    if (owner !== null && owner !== undefined && typeof owner.get === 'function') {
      const value = owner.get(serviceName)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) {
    // A global-store miss is the expected miss; the property may still answer.
  }
  try {
    return owner === null || owner === undefined ? undefined : owner[serviceName]
  } catch (error) {
    return undefined
  }
}

/**
 * Contribute the sidebar action.
 * @param ctx - Client plugin context.
 */
exports.apply = function apply(ctx) {
  try {
    let React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }
    if (React === null || typeof React.createElement !== 'function') return
    if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return

    ctx.inject(['slots'], (owner) => {
      try {
        const slots = serviceAt(owner, 'slots')
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return

        // Registration has to be idempotent. A list slot THROWS when it already
        // holds an entry with the same id and priority, and that throw lands
        // inside the slot ledger's store notification - where it does not merely
        // log, it kills the updates of everything subscribed, leaving a button
        // that is visible and completely dead. Disposing the previous
        // registration before taking a new one makes a re-entry harmless.
        let registration = null
        const contribute = function () {
          if (registration !== null) return
          try {
            registration = slots.inject(SLOT, () => slots.register({
              name: SLOT,
              id: ENTRY_ID,
              order: 50,
              label: () => '重启 DSH',
              inject: () => ({ runtime: React }),
            }, RestartButton))
          } catch (error) {
            registration = null
            console.warn('restart-button: action not registered', error)
          }
        }
        const withdraw = function () {
          if (registration === null) return
          const dispose = registration
          registration = null
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            console.warn('restart-button: action not withdrawn', error)
          }
        }

        if (typeof owner.effect === 'function') {
          owner.effect(() => withdraw, 'restart-button: sidebar action')
        }
        contribute()
      } catch (error) {
        console.warn('restart-button: sidebar action wiring failed', error)
      }
    })
  } catch (error) {
    console.warn('restart-button: client half failed', error)
  }
}

return module.exports; } });
