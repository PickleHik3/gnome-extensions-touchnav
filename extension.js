import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class TouchNavBackExtension extends Extension {
    enable() {
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

        this._button = new St.Button({
            style_class: 'tnav-back-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: size,
            height: size,
        });
        this._button.set_child(new St.Icon({
            icon_name: 'go-previous-symbolic',
            icon_size: Math.floor(19 * sf),
        }));

        this._button.connect('clicked', () => {
            if (!this._didDragRecently)
                this._triggerBack();
        });

        this._capturedEventId = this._button.connect('captured-event', (_w, event) => this._onCapturedEvent(event));

        Main.layoutManager.addTopChrome(this._button, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._placeBottomRight();
    }

    disable() {
        if (this._button) {
            if (this._capturedEventId)
                this._button.disconnect(this._capturedEventId);

            Main.layoutManager.removeChrome(this._button);
            this._button.destroy();
            this._button = null;
        }

        this._virtualKeyboardDevice = null;
    }

    _placeBottomRight() {
        if (!this._button)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const margin = Math.floor(18 * sf);
        const size = this._button.width;

        this._button.set_position(
            monitor.x + monitor.width - size - margin,
            monitor.y + monitor.height - size - margin,
        );
    }

    _onCapturedEvent(event) {
        if (!this._button)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();

        switch (event.type()) {
            case Clutter.EventType.TOUCH_BEGIN:
            case Clutter.EventType.BUTTON_PRESS: {
                const [bx, by] = this._button.get_position();
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

                this._button.set_position(x - this._dragOffset.x, y - this._dragOffset.y);
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
        if (!this._button)
            return;

        const [x, y] = this._button.get_position();
        const rect = new Mtk.Rectangle({x, y, width: 1, height: 1});
        const monitorIndex = global.display.get_monitor_index_for_rect(rect);
        const monitor = global.display.get_monitor_geometry(monitorIndex);

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const margin = Math.floor(6 * sf);
        const size = this._button.width;

        this._button.set_position(
            Math.max(monitor.x + margin, Math.min(x, monitor.x + monitor.width - size - margin)),
            Math.max(monitor.y + margin, Math.min(y, monitor.y + monitor.height - size - margin)),
        );
    }

    _triggerBack() {
        const t = Clutter.get_current_event_time() * 1000;

        // Send Alt+Left for browser-style back navigation.
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Left, Clutter.KeyState.PRESSED);
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Left, Clutter.KeyState.RELEASED);
        this._virtualKeyboardDevice.notify_keyval(t, Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
    }
}
