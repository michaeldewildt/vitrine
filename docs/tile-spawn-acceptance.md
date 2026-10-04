# Tile-spawn live acceptance (silent route + background join)

Manual re-run procedure for the tile-spawn fix that yanks nothing: a worker tile is
spawned onto the dispatcher panel's workspace **silently** and joins the panel's window
group **in the background** — no focus operations, no workspace switch, no cursor warp.

**Pinned to Hyprland 0.56.2 (Omarchy).** The join rides on a Lua IIFE evaluated through
`hyprctl dispatch '(function() … end)()'` — an internal, undocumented compositor channel.
If a Hyprland upgrade breaks it, the symptom is a tile that maps but never joins
(`joined: false` in the spawn log) — the dispatch degrades to a plain spawn, it does not
fail the task. Re-run this procedure after any Hyprland upgrade.

## Preconditions

- The dispatcher panel (the pi foot window) is on some workspace; the human is anywhere —
  ideally on a **different** workspace than the panel, with a known active window.
- The panel is **ungrouped** (`grouped` = `[]`), so the ensure-group IIFE path is exercised.
- At least one free ninfer lane (`~/.local/state/omarchy/ninfer/stats.json`:
  `active_requests + queued_requests < max-concurrency`).

## Procedure

1. **Snapshot** the pre-spawn state (identifies what a yank would change):

   ```sh
   hyprctl activewindow -j | python3 -c "import json,sys; w=json.load(sys.stdin); print('PRE:', w['pid'], w['workspace']['id'], w.get('class'))"
   ```

2. **Dispatch** a small task (e.g. a one-line `explore` question, `timeout: 120`) through
   `vitrine_dispatch`.

3. **Poll a few seconds later** and assert all four:

   - **No focus steal** — `hyprctl activewindow -j` still reports the step-1 window.
   - **No workspace switch** — the step-1 workspace id is still the active one.
   - **The tile routed to the panel's workspace** — `hyprctl clients -j`: the
     `vitrine-worker` window's `workspace.id` equals the panel's.
   - **The background join landed** — the tile's `grouped` array is **identical** to the
     panel's (same member addresses; the panel, ungrouped at step 1, now shares its group
     with the tile).

4. **Clean up** — close the tile
   (`hyprctl dispatch 'hl.dsp.window.close({window="pid:<foot_pid>"})'`) and, if the panel
   was ungrouped before, ungroup it again
   (`hyprctl dispatch 'hl.dsp.group.toggle({window="pid:<panel_pid>"})'`).

## Sanity check for the IIFE channel (standalone)

```sh
hyprctl dispatch '(function() return hl.dsp.no_op() end)()'   # ⇒ ok
```

A non-`ok` response means the channel changed: the spawn path will log `joined: false` and
degrade to plain spawns until this procedure passes again.
