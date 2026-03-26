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

const SNAP_DURATION_MS = 260;
const PRESS_FEEDBACK_MS = 220;
const COMMIT_PULSE_IN_MS = 180;
const COMMIT_PULSE_OUT_MS = 240;

const DEFAULT_BASE_COLOR = {r: 22, g: 22, b: 22};

const SwipeAction = Object.freeze({
    none: 'none',
    back: 'back',
    overview: 'overview',
    apps: 'apps',
});

const SWIPE_KEYS = Object.freeze({
    left: 'swipe-left-action',
    right: 'swipe-right-action',
    up: 'swipe-up-action',
    down: 'swipe-down-action',
});

export default class TouchNavExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.tnav');
        this._settingsSignalIds = [];
        this._visualState = 'idle';

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
        const size = Math.floor(54 * sf);
        const faceSize = Math.floor(28 * sf);

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

        this._floatingFace = new St.Bin({
            style_class: 'tnav-back-button-face',
            width: faceSize,
            height: faceSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._floatingIcon = new St.Icon({
            icon_name: 'go-previous-symbolic',
            icon_size: Math.floor(18 * sf),
            style_class: 'tnav-back-button-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });

        this._floatingFace.set_child(this._floatingIcon);
        this._floatingButton.set_child(this._floatingFace);

        this._capturedEventId = this._floatingButton.connect('captured-event', (_w, event) => this._onCapturedEvent(event));

        this._settingsSignalIds.push(
            this._settings.connect('changed::floating', () => this._syncPlacement()),
            this._settings.connect('changed::panel-section', () => this._syncPlacement()),
            this._settings.connect('changed::floating-opacity', () => this._refreshFloatingStyle()),
            this._settings.connect('changed::floating-use-gnome-default-color', () => this._refreshFloatingStyle()),
            this._settings.connect('changed::floating-color', () => this._refreshFloatingStyle()),
            this._settings.connect('changed::swipe-left-action', () => this._refreshFloatingStyle()),
            this._settings.connect('changed::swipe-right-action', () => this._refreshFloatingStyle()),
            this._settings.connect('changed::swipe-up-action', () => this._refreshFloatingStyle()),
            this._settings.connect('changed::swipe-down-action', () => this._refreshFloatingStyle()),
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
            this._floatingFace = null;
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
        this._snapHomeToNearestEdge();
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
            this._snapHomeToNearestEdge();
            this._snapToHomePosition({animate: true});
            state.repositionMode = false;
            this._setVisualState('idle');
            return;
        }

        if (state.gestureMode) {
            const [x, y] = this._floatingButton.get_position();
            const dx = x - state.homePosition.x;
            const dy = y - state.homePosition.y;
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
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRESS_FEEDBACK_MS, () => {
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
                duration: SNAP_DURATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._floatingButton.set_position(home.x, home.y);
        }
    }

    _snapHomeToNearestEdge() {
        if (!this._floatingButton || !this._floatingState.homePosition)
            return;

        const size = this._floatingButton.width;
        const monitor = this._monitorForPoint(this._floatingState.homePosition.x + size / 2, this._floatingState.homePosition.y + size / 2);
        if (!monitor)
            return;

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const margin = Math.floor(8 * sf);
        const leftX = monitor.x + margin;
        const rightX = monitor.x + monitor.width - size - margin;

        const currentX = this._floatingState.homePosition.x;
        this._floatingState.homePosition.x = Math.abs(currentX - leftX) <= Math.abs(currentX - rightX) ? leftX : rightX;
        this._floatingState.homePosition.y = Math.max(
            monitor.y + margin,
            Math.min(this._floatingState.homePosition.y, monitor.y + monitor.height - size - margin),
        );
    }

    _monitorForPoint(x, y) {
        const rect = new Mtk.Rectangle({x: Math.floor(x), y: Math.floor(y), width: 1, height: 1});
        const index = global.display.get_monitor_index_for_rect(rect);
        if (index < 0)
            return Main.layoutManager.primaryMonitor ?? null;
        return global.display.get_monitor_geometry(index);
    }

    _detectSwipeAction(dx, dy) {
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);

        if (Math.hypot(dx, dy) < GESTURE_START_DISTANCE)
            return SwipeAction.none;

        if (absX > absY * DIRECTION_DOMINANCE)
            return this._actionForDirection(dx < 0 ? 'left' : 'right');

        if (absY > absX * DIRECTION_DOMINANCE)
            return this._actionForDirection(dy < 0 ? 'up' : 'down');

        return SwipeAction.none;
    }

    _actionForDirection(direction) {
        const key = SWIPE_KEYS[direction];
        if (!key || !this._settings)
            return SwipeAction.none;

        const value = this._settings.get_string(key);
        return Object.values(SwipeAction).includes(value) ? value : SwipeAction.none;
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
        if (!this._floatingButton || !this._floatingIcon || !this._floatingFace)
            return;

        this._visualState = state;

        const classes = [
            'tnav-back-button--pressed',
            'tnav-back-button--reposition',
            'tnav-back-button--preview-back',
            'tnav-back-button--preview-overview',
            'tnav-back-button--preview-apps',
            'tnav-back-button--preview-none',
        ];
        for (const c of classes)
            this._floatingButton.remove_style_class_name(c);

        switch (state) {
            case 'idle':
                this._floatingIcon.icon_name = 'go-previous-symbolic';
                this._floatingIcon.opacity = 0;
                this._floatingButton.set_scale(1.0, 1.0);
                break;
            case 'pressed':
            case 'pressed-back':
                this._floatingIcon.icon_name = 'go-previous-symbolic';
                this._floatingIcon.opacity = 255;
                this._floatingButton.add_style_class_name('tnav-back-button--pressed');
                this._floatingButton.ease({
                    scale_x: 0.94,
                    scale_y: 0.94,
                    duration: 140,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._floatingButton.set_scale(1.0, 1.0),
                });
                break;
            case 'reposition':
                this._floatingIcon.icon_name = 'view-pin-symbolic';
                this._floatingIcon.opacity = 255;
                this._floatingButton.add_style_class_name('tnav-back-button--reposition');
                break;
            case `preview-${SwipeAction.back}`:
                this._floatingIcon.icon_name = 'go-previous-symbolic';
                this._floatingIcon.opacity = 255;
                this._floatingButton.add_style_class_name('tnav-back-button--preview-back');
                break;
            case `preview-${SwipeAction.overview}`:
                this._floatingIcon.icon_name = 'focus-windows-symbolic';
                this._floatingIcon.opacity = 255;
                this._floatingButton.add_style_class_name('tnav-back-button--preview-overview');
                break;
            case `preview-${SwipeAction.apps}`:
                this._floatingIcon.icon_name = 'view-app-grid-symbolic';
                this._floatingIcon.opacity = 255;
                this._floatingButton.add_style_class_name('tnav-back-button--preview-apps');
                break;
            default:
                this._floatingIcon.icon_name = 'go-previous-symbolic';
                this._floatingIcon.opacity = 0;
                this._floatingButton.add_style_class_name('tnav-back-button--preview-none');
                break;
        }

        this._refreshFloatingStyle();
    }

    _refreshFloatingStyle() {
        if (!this._floatingButton || !this._floatingFace || !this._settings)
            return;

        const opacity = Math.max(20, Math.min(100, this._settings.get_int('floating-opacity'))) / 100;
        const color = this._getConfiguredBaseColor();

        const visual = this._computeVisualStyle(this._visualState, color, opacity);
        this._floatingButton.set_style(`background-color: ${visual.buttonBg};`);
        this._floatingFace.set_style(`
            border-radius: 999px;
            border-width: ${visual.faceBorderWidth}px;
            border-color: ${visual.faceBorderColor};
            background-color: ${visual.faceBg};
            padding: 0;
        `);
    }

    _computeVisualStyle(state, color, opacity) {
        const colorToCss = (c, a) => `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
        const withMul = (mul) => ({
            r: Math.max(0, Math.min(255, Math.round(color.r * mul))),
            g: Math.max(0, Math.min(255, Math.round(color.g * mul))),
            b: Math.max(0, Math.min(255, Math.round(color.b * mul))),
        });

        let buttonColor = color;
        let buttonAlpha = opacity;
        let faceBg = 'transparent';
        let faceBorderColor = colorToCss({r: 255, g: 255, b: 255}, 0.84);
        let faceBorderWidth = 2;

        if (state === 'pressed' || state === 'pressed-back') {
            buttonColor = withMul(1.25);
            buttonAlpha = Math.min(1, opacity + 0.06);
            faceBg = colorToCss({r: 255, g: 255, b: 255}, 0.16);
            faceBorderColor = colorToCss({r: 255, g: 255, b: 255}, 0.96);
            faceBorderWidth = 1;
        } else if (state === 'reposition') {
            buttonColor = withMul(1.32);
            buttonAlpha = Math.min(1, opacity + 0.06);
            faceBg = colorToCss({r: 255, g: 255, b: 255}, 0.12);
            faceBorderColor = colorToCss({r: 255, g: 255, b: 255}, 0.92);
            faceBorderWidth = 1;
        } else if (state === `preview-${SwipeAction.back}`) {
            buttonColor = {r: 58, g: 74, b: 110};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 76, g: 133, b: 255}, 0.24);
            faceBorderColor = colorToCss({r: 206, g: 224, b: 255}, 0.95);
            faceBorderWidth = 1;
        } else if (state === `preview-${SwipeAction.overview}`) {
            buttonColor = {r: 56, g: 94, b: 78};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 95, g: 220, b: 165}, 0.22);
            faceBorderColor = colorToCss({r: 221, g: 255, b: 241}, 0.95);
            faceBorderWidth = 1;
        } else if (state === `preview-${SwipeAction.apps}`) {
            buttonColor = {r: 92, g: 73, b: 52};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 255, g: 170, b: 92}, 0.22);
            faceBorderColor = colorToCss({r: 255, g: 236, b: 213}, 0.95);
            faceBorderWidth = 1;
        }

        return {
            buttonBg: colorToCss(buttonColor, buttonAlpha),
            faceBg,
            faceBorderColor,
            faceBorderWidth,
        };
    }

    _getConfiguredBaseColor() {
        if (this._settings.get_boolean('floating-use-gnome-default-color'))
            return DEFAULT_BASE_COLOR;

        const colorText = this._settings.get_string('floating-color') || '#161616';
        const [ok, parsed] = Clutter.Color.from_string(colorText);
        if (!ok)
            return DEFAULT_BASE_COLOR;

        return {
            r: parsed.red,
            g: parsed.green,
            b: parsed.blue,
        };
    }

    _animateCommitPulse() {
        if (!this._floatingButton)
            return;

        this._floatingButton.ease({
            scale_x: 1.12,
            scale_y: 1.12,
            duration: COMMIT_PULSE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this._floatingButton.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: COMMIT_PULSE_OUT_MS,
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
