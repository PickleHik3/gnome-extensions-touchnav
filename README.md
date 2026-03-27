# TouchNav

Floating navigation button for GNOME Shell.

## Features

- Floating pill or panel button mode
- Tap + swipe actions (up, down, left, right)
- Actions:
  - `None`
  - `Back`
  - `Forward`
  - `Overview/Workspaces`
  - `Apps Launcher`
  - `Show Desktop`
  - `Workspace Left`
  - `Workspace Right`
  - `Alt Tab`
  - `Close Window`
- Long-press and drag to move pill
- Position is saved across reboot/login
- Opacity and color controls
- System accent color support

## Install (local)

1. Copy folder to:
   `~/.local/share/gnome-shell/extensions/tnav@picklehik3.github.io`
2. Compile schema:
   `glib-compile-schemas ~/.local/share/gnome-shell/extensions/tnav@picklehik3.github.io/schemas`
3. Enable:
   `gnome-extensions enable tnav@picklehik3.github.io`

## Open Settings

`gnome-extensions prefs tnav@picklehik3.github.io`
