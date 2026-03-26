# gnome-extensions-touchnav

Standalone GNOME Shell extension that provides a floating touch navigation button.

## Install locally

1. Copy this directory to:
   `~/.local/share/gnome-shell/extensions/tnav@picklehik3.github.io`
2. Enable with:
   `gnome-extensions enable tnav@picklehik3.github.io`

## Behavior

- Tap: Smart back chain (hide apps grid/overview, close transient UI, then back key events)
- Long-press + drag: reposition button, then it snaps to nearest screen edge
- Swipe directions: configurable actions (`none`, `back`, `overview`, `apps`)
