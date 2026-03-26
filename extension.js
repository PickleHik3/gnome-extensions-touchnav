import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class TouchNavBackExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.tnav');
        this._settingsSignalIds = [];

        this._dragging = false;
        this._didDragRecently = false;
        this._dragOffset = {x: 0, y: 0};
        this._dragStartPointer = {x: 0, y: 0};

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const size = Math.floor(46 * sf);

        this._virtualKeyboardDevice = Clutter
            .get_default_backend()
            .get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._floatingButton = new St.Button({
            style_class: 'tnav-back-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: size,
            height: size,
        });
        this._floatingButton.set_child(new St.Icon({
            icon_name: 'go-previous-symbolic',
            icon_size: Math.floor(19 * sf),
        }));

        this._floatingButton.connect('clicked', () => {
            if (!this._didDragRecently)
                this._triggerBack();
        });

        this._capturedEventId = this._floatingButton.connect('captured-event', (_w, event) => this._onCapturedEvent(event));

        this._settingsSignalIds.push(
            this._settings.connect('changed::floating', () => this._syncPlacement()),
            this._settings.connect('changed::panel-section', () => this._syncPlacement()),
        );

        this._syncPlacement();
    }

    disable() {
        this._settingsSignalIds?.forEach((id) => this._settings.disconnect(id));
        this._settingsSignalIds = [];

        if (this._floatingButton) {
            if (this._capturedEventId)
                this._floatingButton.disconnect(this._capturedEventId);

            if (this._floatingButtonAdded) {
                Main.layoutManager.removeChrome(this._floatingButton);
            }
            this._floatingButton.destroy();
            this._floatingButton = null;
        }

        this._removePanelButton();

        this._virtualKeyboardDevice = null;
        this._settings = null;
    }

    _syncPlacement() {
        if (!this._settings)
            return;

        const floating = this._settings.get_boolean('floating');
        const section = this._settings.get_string('panel-section');

        if (floating) {
            this._removePanelButton();
            this._ensureFloatingButton();
        } else {
            this._removeFloatingButton();
            this._ensurePanelButton(section);
        }
    }

    _ensureFloatingButton() {
        if (!this._floatingButton)
            return;
        if (!this._floatingButtonAdded) {
            Main.layoutManager.addTopChrome(this._floatingButton, {
                affectsStruts: false,
                trackFullscreen: true,
            });
            this._floatingButtonAdded = true;
        }
        this._placeBottomRight();
    }

    _removeFloatingButton() {
        if (!this._floatingButton || !this._floatingButtonAdded)
            return;
        Main.layoutManager.removeChrome(this._floatingButton);
        this._floatingButtonAdded = false;
    }

    _ensurePanelButton(section) {
        if (this._panelButton)
            this._removePanelButton();

        const box = ['left', 'center', 'right'].includes(section) ? section : 'right';
        const panelButton = new PanelMenu.Button(0.0, 'tnav-back-panel-button', true);
        panelButton.add_child(new St.Icon({
            icon_name: 'go-previous-symbolic',
            style_class: 'system-status-icon',
        }));
        panelButton.connect('button-press-event', () => {
            this._triggerBack();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea('tnav-back-panel-button', panelButton, 0, box);
        this._panelButton = panelButton;
    }

    _removePanelButton() {
        if (!this._panelButton)
            return;
        this._panelButton.destroy();
        this._panelButton = null;
    }

    _placeBottomRight() {
        if (!this._floatingButton)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const margin = Math.floor(18 * sf);
        const size = this._floatingButton.width;

        this._floatingButton.set_position(
            monitor.x + monitor.width - size - margin,
            monitor.y + monitor.height - size - margin,
        );
    }

    _onCapturedEvent(event) {
        if (!this._floatingButton || !this._floatingButtonAdded)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();

        switch (event.type()) {
            case Clutter.EventType.TOUCH_BEGIN:
            case Clutter.EventType.BUTTON_PRESS: {
                const [bx, by] = this._floatingButton.get_position();
                this._dragging = false;
                this._dragOffset = {x: x - bx, y: y - by};
                this._dragStartPointer = {x, y};
                return Clutter.EVENT_PROPAGATE;
            }
            case Clutter.EventType.TOUCH_UPDATE:
            case Clutter.EventType.MOTION: {
                const moved = Math.hypot(x - this._dragStartPointer.x, y - this._dragStartPointer.y) > 8;
                if (!moved && !this._dragging)
                    return Clutter.EVENT_PROPAGATE;

                this._dragging = true;
                this._didDragRecently = true;

                this._floatingButton.set_position(x - this._dragOffset.x, y - this._dragOffset.y);
                this._clampToCurrentMonitor();
                return Clutter.EVENT_STOP;
            }
            case Clutter.EventType.TOUCH_END:
            case Clutter.EventType.TOUCH_CANCEL:
            case Clutter.EventType.BUTTON_RELEASE: {
                if (!this._dragging)
                    return Clutter.EVENT_PROPAGATE;

                this._dragging = false;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    this._didDragRecently = false;
                    return GLib.SOURCE_REMOVE;
                });
                return Clutter.EVENT_STOP;
            }
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    _clampToCurrentMonitor() {
        if (!this._floatingButton)
            return;

        const [x, y] = this._floatingButton.get_position();
        const rect = new Mtk.Rectangle({x, y, width: 1, height: 1});
        const monitorIndex = global.display.get_monitor_index_for_rect(rect);
        const monitor = global.display.get_monitor_geometry(monitorIndex);

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const margin = Math.floor(6 * sf);
        const size = this._floatingButton.width;

        this._floatingButton.set_position(
            Math.max(monitor.x + margin, Math.min(x, monitor.x + monitor.width - size - margin)),
            Math.max(monitor.y + margin, Math.min(y, monitor.y + monitor.height - size - margin)),
        );
    }

    _triggerBack() {
        const handled = this._smartBack();
        if (!handled) {
            // Last-resort app navigation fallback.
            this._sendEsc();
            this._sendAltLeft();
        }
    }

    _smartBack() {
        // 1) Close on-screen keyboard if visible.
        if (Main.keyboard.visible) {
            if (Main.keyboard._keyboard)
                Main.keyboard._keyboard.close(true);
            else
                Main.keyboard.close();
            return true;
        }

        // 2) App drawer -> desktop directly.
        if (Main.overview.dash.showAppsButton.checked) {
            Main.overview.dash.showAppsButton.checked = false;
            Main.overview.hide();
            return true;
        }

        // 3) Workspace/overview -> desktop.
        if (Main.overview.visible) {
            Main.overview.hide();
            return true;
        }

        const focusWindow = global.display.focus_window;

        // 4) Close transient/popups/dialog windows first.
        if (focusWindow?.can_close()) {
            const wt = focusWindow.get_window_type();
            const isTransientLike = (
                wt === Meta.WindowType.DIALOG ||
                wt === Meta.WindowType.MODAL_DIALOG ||
                wt === Meta.WindowType.MENU ||
                wt === Meta.WindowType.DROPDOWN_MENU ||
                wt === Meta.WindowType.POPUP_MENU ||
                wt === Meta.WindowType.COMBO ||
                wt === Meta.WindowType.DND ||
                focusWindow.get_transient_for() !== null
            );
            if (isTransientLike) {
                focusWindow.delete(global.get_current_time());
                return true;
            }
        }

        // 5) Exit fullscreen.
        if (focusWindow?.is_fullscreen()) {
            focusWindow.unmake_fullscreen();
            return true;
        }

        // 6) Leave app-level history/navigation to fallback key synthesis.
        return false;
    }

    _sendEsc() {
        if (!this._virtualKeyboardDevice)
            return;
        const t = Clutter.get_current_event_time() * 1000;
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
    }

    _sendAltLeft() {
        if (!this._virtualKeyboardDevice)
            return;
        const t = Clutter.get_current_event_time() * 1000;
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Left, Clutter.KeyState.PRESSED);
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Left, Clutter.KeyState.RELEASED);
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
    }
}
