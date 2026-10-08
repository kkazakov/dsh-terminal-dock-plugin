/**
 * Client half of the terminal dock.
 *
 * Two occupants of the conversation's `conversation.input.dock` slot, the row
 * the composer stack renders directly above the text input box:
 *  - a right-aligned terminal icon that opens and closes the panel;
 *  - the panel itself, which grows upward from the composer inside the centre
 *    column (it never spans the left menu or the right sidebar).
 *
 * The panel drives a `@deepseek-ai/dsh-api-terminal-controller` view, so it runs
 * a real PTY in the session workspace with the same shell preference, recovery
 * and process lifetime as the shipped right-sidebar terminal — this only changes
 * where the terminal lives.
 *
 * Plain React and no Harness Client package import, so a change in those
 * packages cannot break this bundle. xterm is vendored into the lazy
 * `client.terminal.js` chunk and loaded on first expand.
 */
window.__ModuleLoader__.load({
  id: '@wasp/dsh-terminal-dock',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace owned by this bundle. */
    const NS = 'terminal-dock';
    /** Panel state keys; both survive a reload. The open flag is per Session. */
    const OPEN_KEY = 'dsh.terminal-dock.open.v2';
    const HEIGHT_KEY = 'dsh.terminal-dock.height.v1';
    /**
     * Content identity of this panel's terminal. It is the persistence key the
     * controller binds to a Host terminal, so a reload reattaches to the same
     * shell instead of opening another one.
     */
    const CONTENT_ID = 'terminal-dock';
    /** Occurrence key of the single view this panel owns per Session. */
    const OCCURRENCE_KEY = 'terminal-dock';
    /** Slot orders inside the dock list: the panel sits above the icon row. */
    const PANEL_ORDER = 5;
    const TOGGLE_ORDER = 10;
    const MIN_HEIGHT = 120;
    const DEFAULT_HEIGHT = 300;
    const MAX_HEIGHT_RATIO = 0.7;

    /** English copy. */
    const en = {
      title: 'Terminal',
      expand: 'Open the terminal',
      collapse: 'Close the terminal',
      resize: 'Drag to resize the terminal',
      loading: 'Starting shell…',
      creating: 'Starting shell…',
      connecting: 'Connecting…',
      disconnected: 'Disconnected',
      reconnect: 'Reconnect',
      retry: 'Retry',
      closed: 'Terminal closed',
      exited: 'Shell exited (code {code})',
      unavailable: 'Terminal unavailable',
      missingTerminal: 'This shell is gone. Start a new one.',
      terminalLimit: 'The session terminal limit is reached. Close an unused terminal and try again.',
      inputFull: 'Too much input is queued for this shell.',
      newTerminal: 'New terminal',
      close: 'Close',
      readonly: 'Read-only — another page owns input',
      control: 'Take control',
      failed: 'Terminal failed: {message}',
    };

    /** Bulgarian copy, matching the deployment language. */
    const bg = {
      title: 'Терминал',
      expand: 'Отвори терминала',
      collapse: 'Затвори терминала',
      resize: 'Плъзни, за да промениш височината',
      loading: 'Стартиране на shell…',
      creating: 'Стартиране на shell…',
      connecting: 'Свързване…',
      disconnected: 'Връзката е прекъсната',
      reconnect: 'Свържи отново',
      retry: 'Опитай отново',
      closed: 'Терминалът е затворен',
      exited: 'Shell-ът излезе (код {code})',
      unavailable: 'Терминалът не е наличен',
      missingTerminal: 'Този shell вече го няма. Стартирай нов.',
      terminalLimit: 'Достигнат е лимитът за терминали в сесията. Затвори неизползван терминал и опитай отново.',
      inputFull: 'Твърде много въведени данни чакат за този shell.',
      newTerminal: 'Нов терминал',
      close: 'Затвори',
      readonly: 'Само за четене — друг раздел управлява въвеждането',
      control: 'Поеми контрола',
      failed: 'Терминалът се провали: {message}',
    };

    /** Fill `{name}` placeholders for the pre-locale fallback translator. */
    function format(text, params) {
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
    }

    /** Active translator; the Client locale service replaces this during apply. */
    let t = (key, params) => format(en[key] ?? key, params);
    /** Client services captured during apply. */
    let terminals = null;
    /** Theme change source; null when the theme service is absent. */
    let themeSource = null;
    /** Views by Session, all mounted for the page's lifetime. */
    const views = new Map();
    /** Lazy chunk component, resolved on first use. */
    let LazyScreen = null;

    /**
     * Read a persisted string preference.
     * @param key - localStorage key.
     * @returns the stored value, or null.
     */
    function readPreference(key) {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
      } catch (_storageUnavailable) {
        return null;
      }
    }

    /**
     * Store a preference without making storage a dependency.
     * @param key - localStorage key.
     * @param value - value to store.
     */
    function writePreference(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
      } catch (_storageUnavailable) {
        /* storage is optional */
      }
    }

    /**
     * The open flag, per Session, shared by the icon row and the panel; both
     * slot entries are separate components, so the flag lives here rather than
     * in React state. A Session with no stored flag starts closed.
     */
    const openState = {
      bySession: new Map(),
      listeners: new Set(),
    };

    /**
     * Read a Session's open flag, falling back to its stored value and then to
     * closed — a new Session never inherits another Session's panel.
     * @param sessionId - owning Session.
     * @returns whether the panel is open in that Session.
     */
    function readOpen(sessionId) {
      if (sessionId === undefined || sessionId === null) return false;
      const known = openState.bySession.get(sessionId);
      if (known !== undefined) return known;
      const stored = readPreference(`${OPEN_KEY}.${sessionId}`) === '1';
      openState.bySession.set(sessionId, stored);
      return stored;
    }

    /**
     * Subscribe a component to its Session's open flag.
     * @param sessionId - owning Session.
     * @returns whether the panel is open in that Session.
     */
    function useOpen(sessionId) {
      const [known, setKnown] = React.useState(() => ({ sessionId, open: readOpen(sessionId) }));
      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined;
        setKnown({ sessionId, open: readOpen(sessionId) });
        const listener = (changed) => {
          if (changed === sessionId) setKnown({ sessionId, open: readOpen(sessionId) });
        };
        openState.listeners.add(listener);
        return () => {
          openState.listeners.delete(listener);
        };
      }, [sessionId]);
      // A render that no longer matches the current Session reads the store
      // directly, so the previous Session's flag is never shown for a frame.
      return known.sessionId === sessionId ? known.open : readOpen(sessionId);
    }

    /**
     * Set one Session's open flag and persist it under that Session's key.
     * @param sessionId - owning Session.
     * @param next - the new flag.
     */
    function setOpen(sessionId, next) {
      if (sessionId === undefined || sessionId === null) return;
      if (readOpen(sessionId) === next) return;
      openState.bySession.set(sessionId, next);
      writePreference(`${OPEN_KEY}.${sessionId}`, next ? '1' : '0');
      for (const listener of [...openState.listeners]) listener(sessionId);
    }

    /**
     * The Session's live terminal view, created and mounted on first use.
     *
     * Created lazily so opening the conversation does not start a shell, then
     * kept for the page's lifetime: the panel only hides it, so closing never
     * kills the shell and never loses the screen.
     * @param sessionId - owning Session.
     * @returns the mounted terminal view.
     */
    function ensureView(sessionId) {
      const existing = views.get(sessionId);
      if (existing !== undefined) return existing;
      const view = terminals.view(sessionId, OCCURRENCE_KEY, CONTENT_ID, undefined, undefined);
      views.set(sessionId, view);
      view.mount();
      return view;
    }

    /**
     * Replace a Session's terminal with a fresh one.
     *
     * Closing releases the content binding (the Host cleanup runs in the
     * background) and disposing drops the view, so the next `ensureView` both
     * creates a new shell and publishes the new identity to the controller's
     * window-hold bookkeeping.
     * @param sessionId - owning Session.
     * @returns the newly created view.
     */
    function restartView(sessionId) {
      const view = views.get(sessionId);
      if (view !== undefined) {
        try {
          terminals.close(sessionId, OCCURRENCE_KEY, CONTENT_ID, view.id);
        } catch (error) {
          console.error('terminal-dock: close failed', error);
        }
        views.delete(sessionId);
        void view.dispose();
      }
      return ensureView(sessionId);
    }

    /**
     * Keep this panel's terminals in the controller's window-hold inventory.
     *
     * The controller rebuilds its holds from `retainTabs`, which the sidebar
     * terminal provider owns and rewrites on every layout change. Without the
     * union, a sidebar commit would release the holds of terminals this panel
     * opened and their output streams would stop.
     * @returns a disposer restoring the original method.
     */
    function installHoldUnion() {
      const service = terminals;
      const original = service.retainTabs.bind(service);
      const patched = (tabs) => {
        const mine = [];
        for (const [sessionId] of views) {
          mine.push({ sessionId, contentId: CONTENT_ID, tabId: OCCURRENCE_KEY });
        }
        original([...(Array.isArray(tabs) ? tabs : []), ...mine]);
      };
      service.retainTabs = patched;
      return () => {
        if (service.retainTabs === patched) service.retainTabs = original;
      };
    }

    /** Static artwork: the terminal glyph. */
    function TerminalIcon({ size }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 28 28', fill: 'none', 'aria-hidden': true, focusable: false },
        h('rect', { x: 3, y: 5, width: 22, height: 19, rx: 3, fill: 'currentColor', opacity: 0.14 }),
        h('path', {
          d: 'm8 10 4 4-4 4M15 18h5',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** Static artwork: the close glyph. */
    function CloseIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    /** Component-local styles, removed with the component that renders them. */
    function Styles() {
      return h('style', {
        dangerouslySetInnerHTML: {
          __html: `
.tdock-tools { display: flex; align-items: center; justify-content: flex-end; flex: none; margin: 0 auto; width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) * 4); max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4); }
.tdock-icon { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.tdock-icon:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.tdock-icon:focus-visible { outline: 1px solid var(--dsw-alias-border-l2); outline-offset: 1px; }
.tdock-icon[data-active="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.tdock-panel { box-sizing: border-box; flex: none; display: flex; flex-direction: column; margin: 0 auto; width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) * 4); max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4); border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-panel); overflow: hidden; }
.tdock-panel[data-open="false"] { display: none; }
.tdock-resize { flex: none; height: 6px; cursor: row-resize; touch-action: none; position: relative; }
.tdock-resize::after { content: ''; position: absolute; inset: 2px 0 auto; height: 1px; background: var(--dsw-alias-border-l2); opacity: 0; transition: opacity 120ms ease; }
.tdock-resize:hover::after { opacity: 1; }
.tdock-head { display: flex; align-items: center; gap: 8px; flex: none; padding: 4px 8px 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tdock-head-icon { display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.tdock-title { font-weight: 500; color: var(--dsw-alias-label-primary); }
.tdock-spacer { flex: 1 1 auto; }
.tdock-button { height: 22px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: none; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; cursor: pointer; }
.tdock-button:hover { background: var(--dsw-alias-bg-layer-2); }
.tdock-close { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.tdock-close:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.tdock-body { flex: 1 1 auto; min-height: 0; display: flex; background: var(--dsw-alias-bg-base); }
.tdock-pane { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; padding: 2px 6px 6px; }
.tdock-status { display: flex; align-items: center; gap: 10px; padding: 2px 2px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.tdock-status-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tdock-error { margin: 4px 2px 0; font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.tdock-empty { display: flex; align-items: center; justify-content: center; flex: 1 1 auto; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tdock-screen { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary); }
.tdock-screen .xterm { height: 100%; padding: 0; }
.tdock-screen .xterm-viewport { background: transparent !important; }
`,
        },
      });
    }

    /**
     * The dock's icon row: a right-aligned terminal button above the input box.
     * @param props - the session-scoped slot props.
     * @returns the toggle row, or null when no Session is bound yet.
     */
    function TerminalToggle({ sessionId }) {
      const open = useOpen(sessionId);
      if (sessionId === undefined || sessionId === null) return null;
      return h(
        'div',
        { className: 'tdock-tools' },
        h(Styles, null),
        h(
          'button',
          {
            type: 'button',
            className: 'tdock-icon',
            'data-active': open ? 'true' : 'false',
            'aria-pressed': open,
            'aria-label': open ? t('collapse') : t('expand'),
            title: open ? t('collapse') : t('expand'),
            onClick: () => setOpen(sessionId, !open),
          },
          h(TerminalIcon, { size: 16 }),
        ),
      );
    }

    /**
     * The terminal panel: header, resizer and the lazily loaded emulator.
     * @param props - the session-scoped slot props.
     * @returns the panel, or null before it has ever been opened in this Session.
     */
    function TerminalPanel({ sessionId }) {
      const open = useOpen(sessionId);
      /**
       * The Session's view, tagged with the Session it belongs to: a render that
       * no longer matches the current Session reads as "no view yet" instead of
       * briefly drawing the previous Session's terminal.
       */
      const [created, setCreated] = React.useState({ sessionId: null, view: null });
      const view = created.sessionId === sessionId ? created.view : null;
      const [height, setHeight] = React.useState(() => {
        const stored = Number.parseInt(readPreference(HEIGHT_KEY) ?? '', 10);
        return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
      });
      // The lazy chunk component; resolved once, on the first render.
      const [Screen, setScreen] = React.useState(LazyScreen);

      React.useEffect(() => {
        if (LazyScreen === null) {
          LazyScreen = React.lazy(async () => {
            try {
              return { default: (await require.async('./client.terminal.js')).TerminalScreen };
            } catch (error) {
              console.error('terminal-dock: renderer chunk failed to load', error);
              const message = error instanceof Error ? error.message : String(error);
              return { default: () => h('p', { className: 'tdock-error', role: 'alert' }, t('failed', { message })) };
            }
          });
        }
        setScreen(LazyScreen);
      }, []);

      React.useEffect(() => {
        if (!open || sessionId === undefined || sessionId === null) return;
        try {
          setCreated({ sessionId, view: ensureView(sessionId) });
        } catch (error) {
          console.error('terminal-dock: could not open a terminal', error);
        }
      }, [open, sessionId]);

      React.useEffect(() => {
        writePreference(HEIGHT_KEY, String(Math.round(height)));
      }, [height]);

      const startResize = (event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = height;
        const ceiling = Math.round(window.innerHeight * MAX_HEIGHT_RATIO);
        const move = (moveEvent) => {
          const next = startHeight + (startY - moveEvent.clientY);
          setHeight(Math.max(MIN_HEIGHT, Math.min(ceiling, next)));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      };

      /**
       * Respawn this Session's shell. The header button calls it, and the
       * screen calls it on its own when a shell is missing, exited or failed.
       */
      const restart = React.useCallback(() => {
        if (sessionId === undefined || sessionId === null) return;
        setCreated({ sessionId, view: restartView(sessionId) });
      }, [sessionId]);

      if (view === null) return null;
      return h(
        'div',
        {
          className: 'tdock-panel',
          'data-terminal-dock': true,
          'data-open': open ? 'true' : 'false',
          style: open ? { height: `${height}px` } : undefined,
        },
        h(Styles, null),
        h('div', { className: 'tdock-resize', onPointerDown: startResize, title: t('resize'), role: 'separator', 'aria-orientation': 'horizontal' }),
        h(
          'div',
          { className: 'tdock-head' },
          h('span', { className: 'tdock-head-icon' }, h(TerminalIcon, { size: 14 })),
          h('span', { className: 'tdock-title' }, t('title')),
          h('span', { className: 'tdock-spacer' }),
          h('button', { type: 'button', className: 'tdock-button', onClick: restart }, t('newTerminal')),
          h(
            'button',
            { type: 'button', className: 'tdock-close', onClick: () => setOpen(sessionId, false), 'aria-label': t('close'), title: t('close') },
            h(CloseIcon, null),
          ),
        ),
        h(
          'div',
          { className: 'tdock-body' },
          Screen === null
            ? h('div', { className: 'tdock-empty' }, t('loading'))
            : h(
                React.Suspense,
                { fallback: h('div', { className: 'tdock-empty' }, t('loading')) },
                h(Screen, { key: sessionId, view, visible: open, t, theme: themeSource, onRestart: restart }),
              ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'webTerminals'],
      apply(ctx) {
        t = ctx.locale.bind(NS);
        terminals = ctx.get('webTerminals');
        const themeService = ctx.get('theme');
        if (themeService !== null && themeService !== undefined) {
          themeSource = {
            getSnapshot: () => themeService.getTheme(),
            subscribe: (listener) => ctx.on('theme/change', listener),
          };
        }
        ctx.effect(() => {
          const disposers = [];
          for (const [locale, dictionary] of [
            ['en', en],
            ['bg', bg],
          ]) {
            try {
              disposers.push(ctx.locale.register(NS, locale, dictionary));
            } catch (error) {
              console.error(`terminal-dock: ${locale} dictionary not registered`, error);
            }
          }
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, 'terminal-dock: dictionaries');
        ctx.effect(() => installHoldUnion(), 'terminal-dock: window holds');
        ctx.effect(
          () => () => {
            for (const view of views.values()) void view.dispose();
            views.clear();
          },
          'terminal-dock: views',
        );
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'terminal-dock-panel', order: PANEL_ORDER }, TerminalPanel),
        );
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'terminal-dock-toggle', order: TOGGLE_ORDER }, TerminalToggle),
        );
      },
    };
  },
});
