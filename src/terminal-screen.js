/**
 * Screen half of the bottom terminal dock (lazy chunk).
 *
 * This file is concatenated into `client.terminal.js` after the vendored xterm
 * UMD bundles, so it runs inside that chunk's factory with `React`, `h`,
 * `XTERM`, `FIT` and `XTERM_CSS` already in scope. It renders one
 * `@deepseek-ai/dsh-api-terminal-controller` view: the view owns the Host PTY
 * stream and screen frames, xterm owns the emulation and input.
 */

// The emulator stylesheet rides the same request as the renderer.
const XTERM_CSS_TAG = '@wasp/dsh-terminal-dock/xterm.css';
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${XTERM_CSS_TAG}"]`) === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = '@wasp/dsh-terminal-dock';
  tag.dataset.pluginCss = XTERM_CSS_TAG;
  tag.textContent = XTERM_CSS;
  document.head.appendChild(tag);
}

/** Auto-recovery pacing: at most one respawn per cooldown, a few in a row. */
const AUTO_RESTART_COOLDOWN_MS = 1500;
const AUTO_RESTART_LIMIT = 3;
/** A shell that stays running this long clears the consecutive-respawn count. */
const AUTO_RESTART_STABLE_MS = 5000;

/**
 * Subscribe to a snapshot store (or to nothing, when the source is absent).
 * @param store - a `{ getSnapshot, subscribe }` source, or null.
 * @returns the current snapshot.
 */
function useSnapshot(store) {
  const read = () => (store === null || store === undefined ? null : store.getSnapshot());
  const [value, setValue] = React.useState(read);
  React.useEffect(() => {
    if (store === null || store === undefined) return undefined;
    setValue(store.getSnapshot());
    return store.subscribe(() => setValue(store.getSnapshot()));
  }, [store]);
  return value;
}

/**
 * Paint the emulator from the container's inherited theme colors.
 * @param xterm - the opened terminal.
 * @param node - the screen element supplying resolved colors.
 */
function paintTheme(xterm, node) {
  if (node === null || typeof getComputedStyle !== 'function') return;
  const style = getComputedStyle(node);
  const background = style.backgroundColor;
  const foreground = style.color;
  xterm.options.theme = {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: 'rgba(127, 137, 152, 0.4)',
  };
}

/**
 * Report the fitted size to the Host, under the environment's limits.
 * @param xterm - the terminal to resize.
 * @param fit - the fit addon measuring the container.
 * @param state - current view state.
 * @param view - the terminal view receiving the resize.
 */
function fitScreen(xterm, fit, state, view) {
  const dimensions = fit.proposeDimensions();
  const environment = state.environment;
  if (dimensions === undefined || environment === undefined) return;
  const cols = Math.min(dimensions.cols, environment.maxCols);
  const rows = Math.min(dimensions.rows, environment.maxRows);
  if (cols < 2 || rows < 1) return;
  xterm.resize(cols, rows);
  view.resize(cols, rows);
}

/**
 * The emulator surface for one terminal view.
 * @param props - `{ state, view, visible, theme, themeValue }`.
 * @returns the screen element.
 */
function Screen({ state, view, visible, theme, themeValue }) {
  const element = React.useRef(null);
  const terminal = React.useRef(null);
  const fit = React.useRef(null);
  const lastRevision = React.useRef(0);
  const live = React.useRef({ state, visible });
  live.current = { state, visible };

  React.useLayoutEffect(() => {
    const node = element.current;
    if (node === null) return undefined;
    const xterm = new XTERM.Terminal({
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: live.current.state.environment?.scrollback ?? 1000,
    });
    const addon = new FIT.FitAddon();
    xterm.loadAddon(addon);
    xterm.open(node);
    xterm.textarea?.setAttribute('aria-label', 'Terminal');
    paintTheme(xterm, node);
    terminal.current = xterm;
    fit.current = addon;
    lastRevision.current = 0;
    const input = xterm.onData((data) => view.write(data));
    const measure = () => {
      const current = live.current;
      if (!current.visible || !current.state.writable) return;
      if (node.clientWidth === 0 || node.clientHeight === 0) return;
      fitScreen(xterm, addon, current.state, view);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // A remounted screen has no snapshot for what the stream already drew, so
    // ask the view for a fresh generation instead of waiting for the next delta.
    if (live.current.state.phase === 'connected') view.connect();
    return () => {
      observer.disconnect();
      input.dispose();
      xterm.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [view]);

  React.useLayoutEffect(() => {
    const xterm = terminal.current;
    const render = state.render;
    if (xterm === null || render === undefined || render.revision <= lastRevision.current) return;
    lastRevision.current = render.revision;
    if (render.frame.type === 'snapshot') {
      xterm.reset();
      xterm.resize(render.frame.info.cols, render.frame.info.rows);
      xterm.write(render.frame.screen, () => view.acknowledge(render.revision));
      return;
    }
    xterm.write(render.frame.data, () => view.acknowledge(render.revision));
  }, [state.render, view]);

  React.useLayoutEffect(() => {
    const xterm = terminal.current;
    if (xterm === null) return;
    xterm.options.disableStdin = !state.writable;
    const node = element.current;
    if (visible && state.writable && node !== null && node.clientWidth > 0 && node.clientHeight > 0) {
      fitScreen(xterm, fit.current, state, view);
      return;
    }
    if (state.info !== undefined && !state.writable) xterm.resize(state.info.cols, state.info.rows);
  }, [visible, state.writable, state.info?.cols, state.info?.rows, view]);

  // Repaint on a theme switch; the emulator keeps its buffer and input.
  React.useLayoutEffect(() => {
    if (terminal.current !== null) paintTheme(terminal.current, element.current);
  }, [themeValue, theme]);

  React.useEffect(() => {
    if (visible && state.writable) terminal.current?.focus();
  }, [visible, state.writable]);

  return h('div', { className: 'tdock-screen', ref: element, 'data-terminal-screen': true });
}

/**
 * Status strip plus the emulator, over one terminal view.
 * @param props - `{ view, visible, t, theme, onRestart, onFocusRequest }`.
 * @returns the pane body.
 */
function TerminalScreen({ view, visible, t, theme, onRestart }) {
  const state = useSnapshot(view.state);
  const themeValue = useSnapshot(theme);

  const ended = state.info?.state === 'exited' || state.phase === 'closed';
  const issue = state.issue;
  const missing = issue === 'missingTerminal';
  const readOnly = state.phase === 'connected' && state.info?.state === 'running' && !state.writable;
  const retry = !ended && !missing && (state.phase === 'failed' || state.phase === 'disconnected');
  /**
   * A shell that is gone for good: reclaimed while the panel was closed, exited
   * on its own, or failed to start. All three are respawned without a click
   * while the panel is open.
   */
  const dead = missing || ended || state.info?.state === 'failed';

  const recovery = React.useRef({ at: 0, strikes: 0 });
  React.useEffect(() => {
    if (!visible || !dead) return;
    const now = Date.now();
    if (now - recovery.current.at < AUTO_RESTART_COOLDOWN_MS) return;
    if (recovery.current.strikes >= AUTO_RESTART_LIMIT) return;
    recovery.current.at = now;
    recovery.current.strikes += 1;
    onRestart();
  }, [visible, dead, onRestart]);

  // A shell that keeps running is a healthy one: forget the failed attempts.
  React.useEffect(() => {
    if (state.phase !== 'connected' || state.info?.state !== 'running') return undefined;
    const timer = setTimeout(() => {
      recovery.current.strikes = 0;
    }, AUTO_RESTART_STABLE_MS);
    return () => clearTimeout(timer);
  }, [state.phase, state.info?.state, state.info?.id]);

  let status;
  if (state.phase === 'idle' || state.phase === 'loading') status = t('loading');
  else if (state.phase === 'creating' || state.phase === 'connecting' || state.phase === 'disconnected') status = t(state.phase);
  else if (state.info?.state === 'exited') status = t('exited', { code: String(state.info.exitCode ?? '—') });
  else if (state.info?.state === 'failed') status = t('unavailable');
  else if (state.phase === 'closed') status = t('closed');
  else if (issue !== undefined) status = t(issue);
  const error = state.phase === 'disconnected' || issue !== undefined ? undefined : state.error;

  const button = (label, onClick) =>
    h('button', { type: 'button', className: 'tdock-button', onClick }, label);

  return h(
    'div',
    { className: 'tdock-pane', 'data-phase': state.phase },
    status !== undefined || retry || readOnly || ended || issue !== undefined
      ? h(
          'div',
          { className: 'tdock-status', role: 'status' },
          status !== undefined ? h('span', { className: 'tdock-status-text' }, status) : null,
          readOnly ? h('span', { className: 'tdock-status-text' }, t('readonly')) : null,
          readOnly ? button(t('control'), () => view.connect()) : null,
          retry ? button(state.info === undefined ? t('retry') : t('reconnect'), () => (state.info === undefined ? view.refresh() : view.connect())) : null,
          ended || dead ? button(t('newTerminal'), onRestart) : null,
        )
      : null,
    state.info !== undefined ? h(Screen, { state, view, visible, theme, themeValue }) : null,
    error !== undefined ? h('p', { className: 'tdock-error', role: 'alert' }, t('failed', { message: error })) : null,
  );
}
