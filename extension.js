import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LONG_PRESS_MS = 350;
const GESTURE_START_DISTANCE = 12;
const GESTURE_COMMIT_DISTANCE = 44;
const DIRECTION_DOMINANCE = 1.15;

const SwipeAction = Object.freeze({
    none: 'none',
    back: 'back',
    overview: 'overview',
    apps: 'apps',
});

export default class TouchNavBackExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.tnav');
        this._settingsSignalIds = [];

        this._floatingState = {
            pressed: false,
            gestureMode: false,
            repositionMode: false,
            pressStart: {x: 0, y: 0},
            dragOffset: {x: 0, y: 0},
            activeAction: SwipeAction.none,
            longPressTimeoutId: 0,
            homePosition: null,
        };

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
        this._floatingIcon = new St.Icon({
            icon_name: 'media-record-symbolic',
            icon_size: Math.floor(16 * sf),
            style_class: 'tnav-back-button-icon',
        });
        this._floatingButton.set_child(this._floatingIcon);
        this._capturedEventId = this._floatingButton.connect('captured-event', (_w, event) => this._onCapturedEvent(event));

        this._settingsSignalIds.push(
            this._settings.connect('changed::floating', () => this._syncPlacement()),
            this._settings.connect('changed::panel-section', () => this._syncPlacement()),
        );

        this._syncPlacement();
    }

    disable() {
        this._cancelLongPressTimer();
        this._settingsSignalIds?.forEach((id) => this._settings.disconnect(id));
        this._settingsSignalIds = [];

        if (this._floatingButton) {
            if (this._capturedEventId)
                this._floatingButton.disconnect(this._capturedEventId);

            if (this._floatingButtonAdded)
                Main.layoutManager.removeChrome(this._floatingButton);

            this._floatingButton.destroy();
            this._floatingButton = null;
            this._floatingIcon = null;
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
        this._ensureHomePosition();
        this._snapToHomePosition({animate: false});
        this._setVisualState('idle');
    }

    _removeFloatingButton() {
        if (!this._floatingButton || !this._floatingButtonAdded)
            return;
        this._cancelLongPressTimer();
        this._floatingState.pressed = false;
        Main.layoutManager.removeChrome(this._floatingButton);
        this._floatingButtonAdded = false;
    }

    _ensurePanelButton(section) {
        if (this._panelButton)
            this._removePanelButton();

        const box = ['left', 'center', 'right'].includes(section) ? section : 'right';
        const panelButton = new St.Button({
            style_class: 'panel-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        panelButton.add_child(new St.Icon({
            icon_name: 'go-previous-symbolic',
            style_class: 'system-status-icon',
        }));
        panelButton.connect('clicked', () => this._triggerBack());
        this._getPanelBox(box).insert_child_at_index(panelButton, 0);
        this._panelButton = panelButton;
    }

    _removePanelButton() {
        if (!this._panelButton)
            return;
        this._panelButton.get_parent()?.remove_child(this._panelButton);
        this._panelButton.destroy();
        this._panelButton = null;
    }

    _getPanelBox(section) {
        const left = Main.panel._leftBox ?? Main.panel.leftBox;
        const center = Main.panel._centerBox ?? Main.panel.centerBox;
        const right = Main.panel._rightBox ?? Main.panel.rightBox;
        return section === 'left' ? left : section === 'center' ? center : right;
    }

    _ensureHomePosition() {
        if (this._floatingState.homePosition)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._floatingButton)
            return;

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const margin = Math.floor(18 * sf);
        const size = this._floatingButton.width;
        this._floatingState.homePosition = {
            x: monitor.x + monitor.width - size - margin,
            y: monitor.y + monitor.height - size - margin,
        };
    }

    _onCapturedEvent(event) {
        if (!this._floatingButton || !this._floatingButtonAdded)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();

        switch (event.type()) {
            case Clutter.EventType.TOUCH_BEGIN:
            case Clutter.EventType.BUTTON_PRESS:
                this._onPressBegin(x, y);
                return Clutter.EVENT_STOP;
            case Clutter.EventType.TOUCH_UPDATE:
            case Clutter.EventType.MOTION:
                if (!this._floatingState.pressed)
                    return Clutter.EVENT_PROPAGATE;
                this._onPressMotion(x, y);
                return Clutter.EVENT_STOP;
            case Clutter.EventType.TOUCH_END:
            case Clutter.EventType.TOUCH_CANCEL:
            case Clutter.EventType.BUTTON_RELEASE:
                if (!this._floatingState.pressed)
                    return Clutter.EVENT_PROPAGATE;
                this._onPressEnd();
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    _onPressBegin(x, y) {
        this._cancelLongPressTimer();
        this._ensureHomePosition();

        const [bx, by] = this._floatingButton.get_position();
        this._floatingState.pressed = true;
        this._floatingState.gestureMode = false;
        this._floatingState.repositionMode = false;
        this._floatingState.activeAction = SwipeAction.none;
        this._floatingState.pressStart = {x, y};
        this._floatingState.dragOffset = {x: x - bx, y: y - by};
        this._setVisualState('pressed');

        this._floatingState.longPressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
            if (!this._floatingState.pressed || this._floatingState.gestureMode)
                return GLib.SOURCE_REMOVE;
            this._floatingState.repositionMode = true;
            this._setVisualState('reposition');
            this._floatingState.longPressTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onPressMotion(x, y) {
        const state = this._floatingState;
        const dx = x - state.pressStart.x;
        const dy = y - state.pressStart.y;
        const distance = Math.hypot(dx, dy);

        if (!state.repositionMode && !state.gestureMode && distance >= GESTURE_START_DISTANCE) {
            state.gestureMode = true;
            this._cancelLongPressTimer();
        }

        if (state.repositionMode) {
            this._moveButtonWithOffset(x, y);
            this._clampFloatingButtonToCurrentMonitor();
            return;
        }

        if (state.gestureMode) {
            this._moveButtonToPointerCenter(x, y);
            this._clampFloatingButtonToCurrentMonitor();
            const action = this._detectSwipeAction(dx, dy);
            state.activeAction = action;
            this._setVisualState(`preview-${action}`);
        }
    }

    _onPressEnd() {
        const state = this._floatingState;
        this._cancelLongPressTimer();
        state.pressed = false;

        if (state.repositionMode) {
            const [x, y] = this._floatingButton.get_position();
            state.homePosition = {x, y};
            state.repositionMode = false;
            this._setVisualState('idle');
            return;
        }

        if (state.gestureMode) {
            const dx = this._floatingButton.get_position()[0] - state.homePosition.x;
            const dy = this._floatingButton.get_position()[1] - state.homePosition.y;
            const committed = Math.hypot(dx, dy) >= GESTURE_COMMIT_DISTANCE && state.activeAction !== SwipeAction.none;

            if (committed) {
                this._runSwipeAction(state.activeAction);
                this._animateCommitPulse();
            }

            state.gestureMode = false;
            state.activeAction = SwipeAction.none;
            this._snapToHomePosition({animate: true});
            this._setVisualState('idle');
            return;
        }

        this._setVisualState('pressed-back');
        this._triggerBack();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._setVisualState('idle');
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelLongPressTimer() {
        if (this._floatingState?.longPressTimeoutId) {
            GLib.source_remove(this._floatingState.longPressTimeoutId);
            this._floatingState.longPressTimeoutId = 0;
        }
    }

    _moveButtonWithOffset(pointerX, pointerY) {
        this._floatingButton.set_position(
            pointerX - this._floatingState.dragOffset.x,
            pointerY - this._floatingState.dragOffset.y,
        );
    }

    _moveButtonToPointerCenter(pointerX, pointerY) {
        const size = this._floatingButton.width;
        this._floatingButton.set_position(pointerX - size / 2, pointerY - size / 2);
    }

    _snapToHomePosition({animate}) {
        const home = this._floatingState.homePosition;
        if (!home || !this._floatingButton)
            return;

        if (animate) {
            this._floatingButton.ease({
                x: home.x,
                y: home.y,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._floatingButton.set_position(home.x, home.y);
        }
    }

    _detectSwipeAction(dx, dy) {
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);

        if (Math.hypot(dx, dy) < GESTURE_START_DISTANCE)
            return SwipeAction.none;

        if (absX > absY * DIRECTION_DOMINANCE) {
            return dx < 0 ? SwipeAction.back : SwipeAction.none;
        }
        if (absY > absX * DIRECTION_DOMINANCE) {
            return dy < 0 ? SwipeAction.overview : SwipeAction.apps;
        }
        return SwipeAction.none;
    }

    _runSwipeAction(action) {
        switch (action) {
            case SwipeAction.back:
                this._triggerBack();
                break;
            case SwipeAction.overview:
                this._triggerOverview();
                break;
            case SwipeAction.apps:
                this._triggerApps();
                break;
            default:
                break;
        }
    }

    _setVisualState(state) {
        if (!this._floatingButton || !this._floatingIcon)
            return;

        const classes = [
            'tnav-back-button--pressed',
            'tnav-back-button--reposition',
            'tnav-back-button--preview-back',
            'tnav-back-button--preview-overview',
            'tnav-back-button--preview-apps',
        ];
        for (const c of classes)
            this._floatingButton.remove_style_class_name(c);

        switch (state) {
            case 'idle':
                this._floatingIcon.icon_name = 'media-record-symbolic';
                this._floatingButton.set_scale(1.0, 1.0);
                break;
            case 'pressed':
            case 'pressed-back':
                this._floatingIcon.icon_name = 'go-previous-symbolic';
                this._floatingButton.add_style_class_name('tnav-back-button--pressed');
                this._floatingButton.ease({
                    scale_x: 0.94,
                    scale_y: 0.94,
                    duration: 90,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._floatingButton.set_scale(1.0, 1.0),
                });
                break;
            case 'reposition':
                this._floatingIcon.icon_name = 'media-record-symbolic';
                this._floatingButton.add_style_class_name('tnav-back-button--reposition');
                break;
            case `preview-${SwipeAction.back}`:
                this._floatingIcon.icon_name = 'go-previous-symbolic';
                this._floatingButton.add_style_class_name('tnav-back-button--preview-back');
                break;
            case `preview-${SwipeAction.overview}`:
                this._floatingIcon.icon_name = 'view-grid-symbolic';
                this._floatingButton.add_style_class_name('tnav-back-button--preview-overview');
                break;
            case `preview-${SwipeAction.apps}`:
                this._floatingIcon.icon_name = 'view-app-grid-symbolic';
                this._floatingButton.add_style_class_name('tnav-back-button--preview-apps');
                break;
            default:
                this._floatingIcon.icon_name = 'media-record-symbolic';
                break;
        }
    }

    _animateCommitPulse() {
        if (!this._floatingButton)
            return;
        this._floatingButton.ease({
            scale_x: 1.13,
            scale_y: 1.13,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this._floatingButton.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 110,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
    }

    _clampFloatingButtonToCurrentMonitor() {
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

    _triggerOverview() {
        Main.overview.show();
        Main.overview.dash.showAppsButton.checked = false;
    }

    _triggerApps() {
        Main.overview.show();
        Main.overview.dash.showAppsButton.checked = true;
    }

    _triggerBack() {
        const handled = this._smartBack();
        if (!handled) {
            this._sendEsc();
            this._sendAltLeft();
        }
    }

    _smartBack() {
        if (Main.keyboard.visible) {
            if (Main.keyboard._keyboard)
                Main.keyboard._keyboard.close(true);
            else
                Main.keyboard.close();
            return true;
        }

        if (Main.overview.dash.showAppsButton.checked) {
            Main.overview.dash.showAppsButton.checked = false;
            Main.overview.hide();
            return true;
        }

        if (Main.overview.visible) {
            Main.overview.hide();
            return true;
        }

        const focusWindow = global.display.focus_window;

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

        if (focusWindow?.is_fullscreen()) {
            focusWindow.unmake_fullscreen();
            return true;
        }

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
