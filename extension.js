import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LONG_PRESS_MS = 350;
const GESTURE_START_DISTANCE = 12;
const GESTURE_COMMIT_DISTANCE = 44;
const DIRECTION_DOMINANCE = 1.15;
const GESTURE_NUDGE_MAX = 18;

const SNAP_DURATION_MS = 260;
const PRESS_FEEDBACK_MS = 220;
const COMMIT_PULSE_IN_MS = 180;
const COMMIT_PULSE_OUT_MS = 240;

const SWITCHER_STEP_DISTANCE = 38;
const SWITCHER_CANCEL_DISTANCE = 46;

const DEFAULT_BASE_COLOR = {r: 22, g: 22, b: 22};

const Action = Object.freeze({
    none: 'none',
    back: 'back',
    overview: 'overview',
    apps: 'apps',
    showDesktop: 'show-desktop',
    workspaceLeft: 'workspace-left',
    workspaceRight: 'workspace-right',
    windowSwitcherJoystick: 'window-switcher-joystick',
    closeWindow: 'close-window',
});

const SWIPE_KEYS = Object.freeze({
    left: 'swipe-left-action',
    right: 'swipe-right-action',
    up: 'swipe-up-action',
    down: 'swipe-down-action',
});

const ACCENT_COLOR_MAP = Object.freeze({
    blue: {r: 53, g: 132, b: 228},
    teal: {r: 33, g: 144, b: 164},
    green: {r: 46, g: 194, b: 126},
    yellow: {r: 245, g: 194, b: 17},
    orange: {r: 255, g: 120, b: 0},
    red: {r: 230, g: 73, b: 59},
    pink: {r: 214, g: 93, b: 177},
    purple: {r: 145, g: 108, b: 212},
    slate: {r: 111, g: 129, b: 149},
});

export default class TouchNavExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.tnav');
        this._settingsSchema = this._settings.settings_schema;
        this._settingsSignalIds = [];
        this._interfaceSettings = null;
        this._interfaceSettingsChangedId = 0;
        this._visualState = 'idle';
        this._altHeld = false;

        this._floatingState = {
            pressed: false,
            gestureMode: false,
            repositionMode: false,
            switcherActive: false,
            switcherCancelled: false,
            switcherReferenceX: 0,
            pressStart: {x: 0, y: 0},
            dragOffset: {x: 0, y: 0},
            activeAction: Action.none,
            longPressTimeoutId: 0,
            homePosition: null,
        };

        try {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            if (this._interfaceSettings.settings_schema?.has_key('accent-color')) {
                this._interfaceSettingsChangedId = this._interfaceSettings.connect('changed::accent-color', () => this._refreshFloatingStyle());
            }
        } catch (_e) {
            this._interfaceSettings = null;
        }

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
        if (this._hasSetting('click-action'))
            this._settingsSignalIds.push(this._settings.connect('changed::click-action', () => this._refreshFloatingStyle()));

        this._syncPlacement();
    }

    disable() {
        this._cancelLongPressTimer();
        this._endWindowSwitcher({commit: false});

        this._settingsSignalIds?.forEach(id => this._settings.disconnect(id));
        this._settingsSignalIds = [];

        if (this._interfaceSettings && this._interfaceSettingsChangedId)
            this._interfaceSettings.disconnect(this._interfaceSettingsChangedId);
        this._interfaceSettingsChangedId = 0;
        this._interfaceSettings = null;

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
        this._settingsSchema = null;
        this._settings = null;
    }

    _hasSetting(key) {
        return this._settingsSchema?.has_key(key) ?? false;
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
        this._endWindowSwitcher({commit: false});
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

        panelButton.connect('clicked', () => {
            this._runAction(this._getClickAction(), {fromTap: true});
        });

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
        this._floatingState.activeAction = Action.none;
        this._floatingState.switcherActive = false;
        this._floatingState.switcherCancelled = false;
        this._floatingState.switcherReferenceX = x;
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

        if (!state.gestureMode)
            return;

        const action = this._detectSwipeAction(dx, dy);
        state.activeAction = action;

        this._moveButtonWithGestureNudge(dx, dy);

        if (state.switcherActive && action !== Action.windowSwitcherJoystick)
            this._endWindowSwitcher({commit: false});

        if (action === Action.windowSwitcherJoystick) {
            if (!state.switcherActive && distance >= GESTURE_COMMIT_DISTANCE)
                this._startWindowSwitcherJoystick(x);

            if (state.switcherActive)
                this._updateWindowSwitcherJoystick(x, dx, dy);
        }

        this._setVisualState(`preview-${action}`);
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
            if (state.switcherActive)
                this._endWindowSwitcher({commit: !state.switcherCancelled});
            else {
                const [x, y] = this._floatingButton.get_position();
                const dx = x - state.homePosition.x;
                const dy = y - state.homePosition.y;
                const committed = Math.hypot(dx, dy) >= GESTURE_COMMIT_DISTANCE && state.activeAction !== Action.none;

                if (committed) {
                    this._runAction(state.activeAction, {fromGesture: true});
                    this._animateCommitPulse();
                }
            }

            state.gestureMode = false;
            state.activeAction = Action.none;
            state.switcherActive = false;
            state.switcherCancelled = false;
            this._snapToHomePosition({animate: true});
            this._setVisualState('idle');
            return;
        }

        this._setVisualState('pressed-back');
        this._runAction(this._getClickAction(), {fromTap: true});
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

    _moveButtonWithGestureNudge(dx, dy) {
        const home = this._floatingState.homePosition;
        if (!home)
            return;

        const sf = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const maxNudge = Math.floor(GESTURE_NUDGE_MAX * sf);
        const nx = Math.max(-maxNudge, Math.min(maxNudge, Math.round((dx / GESTURE_COMMIT_DISTANCE) * maxNudge)));
        const ny = Math.max(-maxNudge, Math.min(maxNudge, Math.round((dy / GESTURE_COMMIT_DISTANCE) * maxNudge)));

        this._floatingButton.set_position(home.x + nx, home.y + ny);
        this._clampFloatingButtonToCurrentMonitor();
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
            return Action.none;

        if (absX > absY * DIRECTION_DOMINANCE)
            return this._actionForDirection(dx < 0 ? 'left' : 'right');

        if (absY > absX * DIRECTION_DOMINANCE)
            return this._actionForDirection(dy < 0 ? 'up' : 'down');

        return Action.none;
    }

    _actionForDirection(direction) {
        const key = SWIPE_KEYS[direction];
        if (!key || !this._settings)
            return Action.none;

        const value = this._settings.get_string(key);
        return Object.values(Action).includes(value) ? value : Action.none;
    }

    _getClickAction() {
        if (!this._settings || !this._hasSetting('click-action'))
            return Action.back;

        const value = this._settings.get_string('click-action');
        return Object.values(Action).includes(value) ? value : Action.back;
    }

    _runAction(action, options = {}) {
        switch (action) {
            case Action.none:
                break;
            case Action.back:
                this._triggerBack();
                break;
            case Action.overview:
                this._triggerOverview();
                break;
            case Action.apps:
                this._triggerApps();
                break;
            case Action.showDesktop:
                this._triggerShowDesktop();
                break;
            case Action.workspaceLeft:
                this._switchWorkspace(Meta.MotionDirection.LEFT);
                break;
            case Action.workspaceRight:
                this._switchWorkspace(Meta.MotionDirection.RIGHT);
                break;
            case Action.windowSwitcherJoystick:
                if (options.fromTap)
                    this._triggerWindowSwitcherQuick();
                break;
            case Action.closeWindow:
                this._triggerCloseWindow();
                break;
            default:
                break;
        }
    }

    _startWindowSwitcherJoystick(pointerX) {
        const state = this._floatingState;
        this._pressAlt();
        this._sendTabStep(+1);
        state.switcherActive = true;
        state.switcherCancelled = false;
        state.switcherReferenceX = pointerX;
    }

    _updateWindowSwitcherJoystick(pointerX, dx, dy) {
        const state = this._floatingState;
        if (!state.switcherActive)
            return;

        if (Math.abs(dy) >= SWITCHER_CANCEL_DISTANCE && Math.abs(dy) > Math.abs(dx) * DIRECTION_DOMINANCE) {
            state.switcherCancelled = true;
            this._setVisualState('preview-none');
            return;
        }

        if (state.switcherCancelled)
            return;

        while (pointerX - state.switcherReferenceX >= SWITCHER_STEP_DISTANCE) {
            this._sendTabStep(+1);
            state.switcherReferenceX += SWITCHER_STEP_DISTANCE;
        }

        while (pointerX - state.switcherReferenceX <= -SWITCHER_STEP_DISTANCE) {
            this._sendTabStep(-1);
            state.switcherReferenceX -= SWITCHER_STEP_DISTANCE;
        }
    }

    _endWindowSwitcher({commit}) {
        if (this._floatingState.switcherActive && !commit)
            this._tapKey(Clutter.KEY_Escape);

        this._floatingState.switcherActive = false;
        this._floatingState.switcherCancelled = false;
        this._releaseAlt();
    }

    _triggerWindowSwitcherQuick() {
        this._pressAlt();
        this._sendTabStep(+1);
        this._releaseAlt();
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
            'tnav-back-button--preview-workspace',
            'tnav-back-button--preview-switcher',
            'tnav-back-button--preview-close',
            'tnav-back-button--preview-none',
        ];

        for (const cssClass of classes)
            this._floatingButton.remove_style_class_name(cssClass);

        const iconForAction = {
            [Action.back]: 'go-previous-symbolic',
            [Action.overview]: 'focus-windows-symbolic',
            [Action.apps]: 'view-app-grid-symbolic',
            [Action.showDesktop]: 'user-desktop-symbolic',
            [Action.workspaceLeft]: 'go-previous-symbolic',
            [Action.workspaceRight]: 'go-next-symbolic',
            [Action.windowSwitcherJoystick]: 'view-list-symbolic',
            [Action.closeWindow]: 'window-close-symbolic',
        };

        if (state === 'idle') {
            this._floatingIcon.icon_name = 'go-previous-symbolic';
            this._floatingIcon.opacity = 0;
            this._floatingButton.set_scale(1.0, 1.0);
        } else if (state === 'pressed' || state === 'pressed-back') {
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
        } else if (state === 'reposition') {
            this._floatingIcon.icon_name = 'view-pin-symbolic';
            this._floatingIcon.opacity = 255;
            this._floatingButton.add_style_class_name('tnav-back-button--reposition');
        } else if (state.startsWith('preview-')) {
            const action = state.slice('preview-'.length);
            this._floatingIcon.icon_name = iconForAction[action] ?? 'go-previous-symbolic';
            this._floatingIcon.opacity = action === Action.none ? 0 : 255;

            if (action === Action.back)
                this._floatingButton.add_style_class_name('tnav-back-button--preview-back');
            else if (action === Action.overview || action === Action.showDesktop)
                this._floatingButton.add_style_class_name('tnav-back-button--preview-overview');
            else if (action === Action.apps)
                this._floatingButton.add_style_class_name('tnav-back-button--preview-apps');
            else if (action === Action.workspaceLeft || action === Action.workspaceRight)
                this._floatingButton.add_style_class_name('tnav-back-button--preview-workspace');
            else if (action === Action.windowSwitcherJoystick)
                this._floatingButton.add_style_class_name('tnav-back-button--preview-switcher');
            else if (action === Action.closeWindow)
                this._floatingButton.add_style_class_name('tnav-back-button--preview-close');
            else
                this._floatingButton.add_style_class_name('tnav-back-button--preview-none');
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
        const withMul = mul => ({
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
        } else if (state === `preview-${Action.back}`) {
            buttonColor = {r: 58, g: 74, b: 110};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 76, g: 133, b: 255}, 0.24);
            faceBorderColor = colorToCss({r: 206, g: 224, b: 255}, 0.95);
            faceBorderWidth = 1;
        } else if (state === `preview-${Action.overview}` || state === `preview-${Action.showDesktop}`) {
            buttonColor = {r: 56, g: 94, b: 78};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 95, g: 220, b: 165}, 0.22);
            faceBorderColor = colorToCss({r: 221, g: 255, b: 241}, 0.95);
            faceBorderWidth = 1;
        } else if (state === `preview-${Action.apps}`) {
            buttonColor = {r: 92, g: 73, b: 52};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 255, g: 170, b: 92}, 0.22);
            faceBorderColor = colorToCss({r: 255, g: 236, b: 213}, 0.95);
            faceBorderWidth = 1;
        } else if (state === `preview-${Action.workspaceLeft}` || state === `preview-${Action.workspaceRight}`) {
            buttonColor = {r: 64, g: 88, b: 122};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 129, g: 178, b: 244}, 0.2);
            faceBorderColor = colorToCss({r: 216, g: 234, b: 255}, 0.95);
            faceBorderWidth = 1;
        } else if (state === `preview-${Action.windowSwitcherJoystick}`) {
            buttonColor = {r: 88, g: 69, b: 116};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 190, g: 150, b: 255}, 0.2);
            faceBorderColor = colorToCss({r: 239, g: 226, b: 255}, 0.95);
            faceBorderWidth = 1;
        } else if (state === `preview-${Action.closeWindow}`) {
            buttonColor = {r: 116, g: 62, b: 62};
            buttonAlpha = Math.min(1, opacity + 0.08);
            faceBg = colorToCss({r: 255, g: 130, b: 130}, 0.2);
            faceBorderColor = colorToCss({r: 255, g: 225, b: 225}, 0.95);
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
            return this._getGnomeAccentColor() ?? DEFAULT_BASE_COLOR;

        const colorText = this._settings.get_string('floating-color') || '#161616';
        return this._parseColorString(colorText) ?? DEFAULT_BASE_COLOR;
    }

    _getGnomeAccentColor() {
        if (!this._interfaceSettings)
            return null;

        try {
            if (!this._interfaceSettings.settings_schema?.has_key('accent-color'))
                return null;
            const accent = this._interfaceSettings.get_string('accent-color');
            return ACCENT_COLOR_MAP[accent] ?? null;
        } catch (_e) {
            return null;
        }
    }

    _parseColorString(value) {
        if (!value)
            return null;

        const text = value.trim().toLowerCase();
        const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (hex) {
            const h = hex[1];
            if (h.length === 3) {
                return {
                    r: parseInt(h[0] + h[0], 16),
                    g: parseInt(h[1] + h[1], 16),
                    b: parseInt(h[2] + h[2], 16),
                };
            }
            return {
                r: parseInt(h.slice(0, 2), 16),
                g: parseInt(h.slice(2, 4), 16),
                b: parseInt(h.slice(4, 6), 16),
            };
        }

        const rgb = text.match(/^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:\d*\.?\d+))?\)$/);
        if (!rgb)
            return null;

        return {
            r: Math.max(0, Math.min(255, Number(rgb[1]))),
            g: Math.max(0, Math.min(255, Number(rgb[2]))),
            b: Math.max(0, Math.min(255, Number(rgb[3]))),
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

    _triggerShowDesktop() {
        if (Main.overview.dash.showAppsButton.checked)
            Main.overview.dash.showAppsButton.checked = false;
        if (Main.overview.visible)
            Main.overview.hide();
    }

    _switchWorkspace(direction) {
        const workspaceManager = global.workspace_manager;
        const active = workspaceManager.get_active_workspace();
        const neighbor = active.get_neighbor(direction);
        if (neighbor && neighbor !== active)
            neighbor.activate(global.get_current_time());
    }

    _triggerCloseWindow() {
        const focusWindow = global.display.focus_window;
        if (focusWindow?.can_close())
            focusWindow.delete(global.get_current_time());
    }

    _triggerBack() {
        const handled = this._smartBack();
        if (!handled) {
            this._tapKey(Clutter.KEY_Escape);
            this._pressAlt();
            this._tapKey(Clutter.KEY_Left);
            this._releaseAlt();
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

    _sendTabStep(direction) {
        if (!this._virtualKeyboardDevice)
            return;

        if (direction < 0)
            this._notifyKey(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);

        this._tapKey(Clutter.KEY_Tab);

        if (direction < 0)
            this._notifyKey(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
    }

    _pressAlt() {
        if (this._altHeld || !this._virtualKeyboardDevice)
            return;

        this._notifyKey(Clutter.KEY_Alt_L, Clutter.KeyState.PRESSED);
        this._altHeld = true;
    }

    _releaseAlt() {
        if (!this._altHeld || !this._virtualKeyboardDevice)
            return;

        this._notifyKey(Clutter.KEY_Alt_L, Clutter.KeyState.RELEASED);
        this._altHeld = false;
    }

    _tapKey(keyval) {
        this._notifyKey(keyval, Clutter.KeyState.PRESSED);
        this._notifyKey(keyval, Clutter.KeyState.RELEASED);
    }

    _notifyKey(keyval, keyState) {
        if (!this._virtualKeyboardDevice)
            return;

        const eventTimeUs = Clutter.get_current_event_time() * 1000;
        const time = eventTimeUs > 0 ? eventTimeUs : GLib.get_monotonic_time();
        this._virtualKeyboardDevice.notify_keyval(time, keyval, keyState);
    }
}
