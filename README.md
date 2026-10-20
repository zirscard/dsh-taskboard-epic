# dsh-taskboard-epic

Epic panel for **DeepSeek Harness**. It stacks the `[总任务]` (epic) cards of a
dsh-taskboard project in their `epic:children` order and lets the order of the
module arcs be rearranged by drag or by buttons.

The panel is client-only: it reads the taskboard's public same-origin API
(`/dsh-taskboard/state`, `/dsh-taskboard/tasks/:id/update`) and renders into the
`sidebar.panellist` and `main` slots. There is no host-side state and no new
route, so the host half of this package intentionally does nothing.

## What it does

- Groups the cards of one epic into a stack, ordered by `epic:children`.
- Shows each module's position, code, name and version on the arc.
- Reorders the arc by dragging a module or by using the move buttons; the new
  order is written back to the taskboard through its public update API.
- Marks the start module, the middle modules and the end module of the arc, so
  the dependency shape of a project is visible at a glance.

## Requirements

- `dsh-taskboard` (the taskboard plugin) must be installed; the panel renders
  data that the taskboard exposes.
- A browser client (the panel is a web-client plugin).

## Install

```bash
dsh plugin add https://github.com/zirscard/dsh-taskboard-epic
```

Or from a local directory:

```bash
dsh plugin add link:/path/to/plugins/dsh-taskboard-epic
```

Restart DSH and open the Plugins page; the epic panel appears next to the
installed taskboard.

## Layout

```text
dsh-taskboard-epic/
├── index.js        # host half (intentionally a no-op; the panel is client-side)
├── client.js       # client half: data fetch, epic parsing, rendering
├── cordis.patch.yml
└── package.json
```

## Test

The repository ships a small harness that renders the panel against a fixture
tree and asserts the produced order and the reorder round-trip:

```bash
node tests/harness.mjs
```

## Notes

- The panel writes only through the taskboard's own update endpoint; it never
  edits project data directly.
- Card ordering is stored on the epic card itself, so the order survives a
  restart and is shared by everyone looking at the same project.

## English summary

`dsh-taskboard-epic` is a client-side panel for DeepSeek Harness. It stacks the
epic cards of a dsh-taskboard project in their `epic:children` order, shows each
module's position, code, name and version along the arc, and marks the start,
middle and end modules. The order can be changed by drag or by buttons, and the
new order is written back through the taskboard's public update API, so it
persists and is shared across everyone viewing the project.

## License

MIT.
