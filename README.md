# Terminal Dock (`@wasp/dsh-terminal-dock`)

A terminal one click away inside the conversation: a terminal icon sits at the
right-hand end of the row directly above the text input box, and clicking it
opens an interactive shell panel at the bottom of the conversation.

![Terminal dock icon](icon.svg)

## What it gives you

| Surface | Behaviour |
|---|---|
| **Icon** | A terminal glyph at the right-hand end of the composer's dock row, directly above the text input box. Click to open or close; pressed state is visible. |
| **Panel** | Grows upward from the composer, inside the conversation column — the left menu and the right sidebar keep their full height and are never covered. |
| **Header** | Title, **New terminal** and a close button; the top edge drags to resize within 120 px – 70 % of the window. |
| **Auto-recovery** | A shell that is gone — reclaimed while the panel was closed, exited on its own, or failed to start — is respawned automatically while the panel is open, with no click. A 1.5 s cooldown and a three-attempt cap keep a shell that dies on startup from looping; five seconds of a running shell clear the count, and after the cap the **New terminal** button takes over. |
| **Per-session state** | Open/closed is remembered **per session**, and a session you have never opened starts closed. Panel height is a browser-wide preference. |
| **Multi-session** | One terminal per session, created on first open, so switching conversations never kills a running command — and never shows another session's terminal. |
| **Persistence** | The terminal reattaches to the same shell after a reload; closing only hides the panel, so the shell keeps running and its screen buffer is kept. |
| **Localized** | English and Bulgarian copy. |

A shell that exits still reports its exit code in the panel's status line until
the respawn replaces it; if respawning is exhausted, the status stays with the
**New terminal** button next to it.

## Requirements

- DeepSeek Harness with the Web UI (Desktop, or a `web` profile). The panel
  reuses the shipped terminal controller
  (`@deepseek-ai/dsh-api-terminal-controller`), which `@deepseek-ai/dsh-web-app`
  already mounts, so nothing else is needed.

## Install

**Web (recommended).** Open the **Plugins** page in the sidebar, click **Add
plugin**, and paste the package name:

```
@wasp/dsh-terminal-dock
```

**From GitHub** instead of npm:

```
github:kkazakov/dsh-terminal-dock-plugin
```

**Agent / tool surface:** `plugin_manager` with `action: install_bundle` and the
same spec.

**CLI:** `dsh plugin add @wasp/dsh-terminal-dock` runs pnpm in the profile
directory (it does not select the bundle for you — use the Web page to get
bundle selection and patch application).

Installing runs the plugin **in-process with your permissions**. Only install it
from a source you trust.

### Upgrading

DeepSeek Harness does not auto-update plugins yet: **uninstall and reinstall**
to move to a new version. Pin a version with e.g.
`@wasp/dsh-terminal-dock@1.0.1` if you need reproducibility.

## The shell it runs

The panel opens the shell the terminal controller resolves for your execution
environment — the environment's default shell, or the shell you last picked in
the right-sidebar terminal's shell menu (the `dsh.terminal.shell` browser
preference, shared by both surfaces).

User terminals run with the execution environment's **system-user permissions**,
independently of the agent's sandbox mode and approval policy; operating-system
and container restrictions still apply. Terminal output stays outside the agent
transcript.

The plugin has no `config` row of its own: the Host half is a no-op.

## How it works

- The client half registers two entries in the conversation's
  `conversation.input.dock` slot — the row the composer stack renders directly
  above the input card — so the panel is laid out by the conversation itself and
  is confined to the centre column.
- The panel drives one `@deepseek-ai/dsh-api-terminal-controller` view per
  session: the same PTY ownership, shell discovery, screen recovery, idle
  reclamation and process lifetime as the shipped right-sidebar terminal. Only
  the placement differs.
- Each session keeps its own view and its own open flag
  (`dsh.terminal-dock.open.v2.<sessionId>` in `localStorage`), and the panel is
  tagged with the session it was built for, so a session switch can neither show
  nor respawn another session's shell.
- When the controller reports a session's shell as missing, exited or failed
  while the panel is open, the screen respawns it through the same close-then-
  create path as the **New terminal** button, pacing the attempts so a shell
  that dies immediately cannot loop.
- xterm.js is vendored into a package-local lazy chunk (`client.terminal.js`),
  loaded through `require.async('./client.terminal.js')` the first time the
  panel opens, so the emulator costs nothing until you use it.
- The controller rebuilds its window holds from the sidebar terminal's tab
  inventory; the plugin unions its own terminals into that bookkeeping so a
  sidebar layout change cannot release a hold this panel owns.

## Privacy

- No telemetry, no analytics, no network requests of its own.
- Terminal input and output travel between your browser and your local Harness
  Host (and the shell process). Nothing is sent anywhere else.
- No `@deepseek-ai/*` dependencies or peer dependencies, no build step and no
  install scripts, so installation never needs a build-script approval and
  install-time compatibility checks never apply.

## Compatibility

Deliberately conservative so it keeps working across Harness releases:

- The client half imports only `react` from the Harness module table and resolves
  everything else through slots and services, with lazy service lookups so
  activation order cannot silently disable it.
- The vendored xterm is pinned and self-contained in the chunk; it is not
  resolved from the Harness at run time.

## Development

```bash
node build.mjs        # regenerate client.terminal.js from src/ + vendor/
node test-plugin.mjs  # load both halves the way the loader does, with stubs
```

`client.terminal.js` is generated: vendored
[@xterm/xterm](https://github.com/xtermjs/xterm.js) 6.0.0 and
`@xterm/addon-fit` 0.11.0 (both MIT) plus `src/terminal-screen.js`. `vendor/`
holds those unmodified downloads; `prepack` rebuilds the chunk before publishing.

`test-plugin.mjs` (excluded from the published package) checks the manifest, the
`cordis.patch.yml` row name, the slot registrations, the window-hold union and
the lazy chunk's owner id — it needs no Harness installation and no browser.

Checking what would be published:

```bash
npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE). The bundled xterm.js and addon-fit are MIT as
well.
