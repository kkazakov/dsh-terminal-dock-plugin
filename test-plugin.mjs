/**
 * Smoke test for the Terminal Dock bundle.
 *
 * It loads both browser halves the way the Harness module loader does — a
 * classic script calling `window.__ModuleLoader__.load` — and drives the plugin
 * body with stub Cordis services, then checks the package manifest against the
 * files on disk. It does not need a Harness installation or a browser.
 *
 * Run: node test-plugin.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

/** Minimal React surface the two halves touch at load time. */
const React = {
  createElement: (...args) => ({ args }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  lazy: (factory) => factory,
  Suspense: () => null,
};

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

let failures = 0;
let checks = 0;

/**
 * Assert one condition and print its result.
 * @param label - what is being checked.
 * @param ok - the condition.
 * @param detail - value printed with a failure.
 */
function check(label, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
}

/**
 * Load one client half and return its registration.
 * @param path - file to evaluate as a classic script.
 * @returns the `__ModuleLoader__.load` registration.
 */
function loadBundle(path) {
  const registrations = [];
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
  new Function('window', read(path))(window);
  if (registrations.length !== 1) throw new Error(`${path}: expected one registration, got ${registrations.length}`);
  return registrations[0];
}

/** The plugin's stub Cordis context, recording slots and effects. */
function stubContext() {
  const rows = [];
  const effects = [];
  const view = { id: 'stub-terminal', mount: () => () => {}, connect: () => {}, refresh: () => {}, write: () => {}, resize: () => {}, acknowledge: () => {}, close: () => Promise.resolve(), dispose: () => Promise.resolve(), state: { getSnapshot: () => ({ phase: 'idle', writable: false }), subscribe: () => () => {} } };
  const terminals = {
    view: () => view,
    close: () => {},
    retainTabs: (tabs) => {
      terminals.lastTabs = tabs;
    },
  };
  return {
    rows,
    effects,
    terminals,
    ctx: {
      locale: { bind: () => (key) => key, register: () => () => {} },
      get: (name) => (name === 'webTerminals' ? terminals : undefined),
      on: () => () => {},
      slots: {
        inject: (_key, callback) => {
          callback();
          return () => {};
        },
        register: (options) => {
          rows.push(options);
          return () => {};
        },
      },
      effect: (callback) => {
        effects.push(typeof callback);
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      },
    },
  };
}

// ── package manifest ────────────────────────────────────────────────────────

const manifest = JSON.parse(read('./package.json'));
check('package name is @wasp/dsh-terminal-dock', manifest.name === '@wasp/dsh-terminal-dock', manifest.name);
check('client platform is web', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client));
check('manifest exports the client half', manifest.exports?.['./client'] === './client.js', manifest.exports?.['./client']);
check('manifest declares the bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', manifest.dsh?.bundle?.patch);
check('cordis patch inserts the package row', read('./cordis.patch.yml').includes(`name: '${manifest.name}'`));

const required = ['index.js', 'client.js', 'client.terminal.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/bg.json'];
const missing = required.filter((file) => !existsSync(new URL(`./${file}`, import.meta.url)));
check('every packaged file exists', missing.length === 0, missing.join(', '));

// ── client entry ────────────────────────────────────────────────────────────

const entry = loadBundle('./client.js');
check('entry registers the package id', entry.id === manifest.name, entry.id);
check('entry is an entry, not a chunk', entry.chunk === undefined, String(entry.chunk));

const module_ = entry.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require: ${specifier}`);
});
check('entry injects the services it uses', Array.isArray(module_.inject) && module_.inject.includes('webTerminals') && module_.inject.includes('slots') && module_.inject.includes('locale'), JSON.stringify(module_.inject));
check('entry exposes apply()', typeof module_.apply === 'function');

const { ctx, rows, effects, terminals } = stubContext();
module_.apply(ctx);
check('apply registers two dock rows', rows.length === 2, String(rows.length));
check('both rows target conversation.input.dock', rows.every((row) => row.name === 'conversation.input.dock'), JSON.stringify(rows.map((row) => row.name)));
check('the panel sorts above the toggle', rows[0].order < rows[1].order, `${rows[0].order} / ${rows[1].order}`);
check('apply owns three effects', effects.length === 3, String(effects.length));
check('retainTabs is patched for this plugin', typeof terminals.retainTabs === 'function' && terminals.retainTabs !== Object.prototype.retainTabs);
terminals.retainTabs([{ sessionId: 'sidebar-session', contentId: 'sidebar', tabId: 'tab' }]);
check('patched retainTabs merges instead of replacing', Array.isArray(terminals.lastTabs) && terminals.lastTabs.length === 1 && terminals.lastTabs[0].sessionId === 'sidebar-session', JSON.stringify(terminals.lastTabs));

// ── lazy chunk ──────────────────────────────────────────────────────────────

const chunk = loadBundle('./client.terminal.js');
check('chunk registers under the same owner', chunk.id === manifest.name, chunk.id);
check('chunk name matches the lazy reference', chunk.chunk === 'client.terminal.js' && read('./client.js').includes("require.async('./client.terminal.js')"), String(chunk.chunk));

const chunkModule = chunk.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require: ${specifier}`);
});
check('chunk exports TerminalScreen', typeof chunkModule.TerminalScreen === 'function');
check('chunk carries the emulator stylesheet', read('./client.terminal.js').includes('xterm-viewport'));

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
