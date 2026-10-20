/**
 * Host half of dsh-taskboard-epic.
 *
 * The panel is Client-only: it reads the taskboard's public same-origin API
 * (`/dsh-taskboard/state`, `/dsh-taskboard/tasks/:id/update`) and renders in the
 * `sidebar.panellist` + `main` slots. No host-side state or routes are needed,
 * so this module intentionally does nothing.
 */
export function apply() {}
