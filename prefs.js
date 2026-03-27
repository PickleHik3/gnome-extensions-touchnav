import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TouchNavPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.tnav');

        const page = new Adw.PreferencesPage({
            title: 'TouchNav',
            icon_name: 'preferences-system-symbolic',
        });

        const placement = new Adw.PreferencesGroup({title: 'Placement'});
        const floatingRow = new Adw.SwitchRow({
            title: 'Floating',
        });
        settings.bind('floating', floatingRow, 'active', 0);
        placement.add(floatingRow);

        const panelSectionRow = this._buildDropdownRow({
            title: 'Panel Section',
            subtitle: 'Used when Floating is disabled',
            values: ['left', 'center', 'right'],
            labels: ['Left', 'Center', 'Right'],
            get: () => settings.get_string('panel-section'),
            set: (v) => settings.set_string('panel-section', v),
        });
        panelSectionRow.row.visible = !settings.get_boolean('floating');
        settings.connect('changed::floating', () => {
            panelSectionRow.row.visible = !settings.get_boolean('floating');
        });
        placement.add(panelSectionRow.row);
        page.add(placement);

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        const opacityRow = new Adw.SpinRow({
            title: 'Opacity',
            subtitle: 'Floating button opacity in percent',
            adjustment: new Gtk.Adjustment({
                lower: 20,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('floating-opacity'),
            }),
        });
        opacityRow.connect('notify::value', () => {
            settings.set_int('floating-opacity', Math.round(opacityRow.value));
        });
        settings.connect('changed::floating-opacity', () => {
            const v = settings.get_int('floating-opacity');
            if (Math.round(opacityRow.value) !== v)
                opacityRow.value = v;
        });
        appearance.add(opacityRow);

        const useDefaultRow = new Adw.SwitchRow({
            title: 'Use System Accent Color',
        });
        settings.bind('floating-use-gnome-default-color', useDefaultRow, 'active', 0);
        appearance.add(useDefaultRow);

        const colorRow = new Adw.ActionRow({
            title: 'Floating Color',
        });
        const colorButton = new Gtk.ColorButton({valign: Gtk.Align.CENTER});
        colorRow.add_suffix(colorButton);
        const updateColorButton = () => {
            const rgba = new Gdk.RGBA();
            rgba.parse(settings.get_string('floating-color'));
            colorButton.rgba = rgba;
            colorRow.visible = !settings.get_boolean('floating-use-gnome-default-color');
        };
        updateColorButton();
        colorButton.connect('color-set', () => {
            settings.set_string('floating-color', colorButton.rgba.to_string());
        });
        settings.connect('changed::floating-color', updateColorButton);
        settings.connect('changed::floating-use-gnome-default-color', updateColorButton);
        appearance.add(colorRow);
        page.add(appearance);

        const gestures = new Adw.PreferencesGroup({title: 'Swipe Actions'});
        const actions = {
            values: [
                'none',
                'back',
                'forward',
                'overview',
                'apps',
                'show-desktop',
                'workspace-left',
                'workspace-right',
                'window-switcher-joystick',
                'close-window',
            ],
            labels: [
                'None',
                'Back',
                'Forward',
                'Overview/Workspaces',
                'Apps Launcher',
                'Show Desktop',
                'Workspace Left',
                'Workspace Right',
                'Alt Tab',
                'Close Window',
            ],
        };

        gestures.add(this._buildDropdownRow({
            title: 'Tap / Click',
            values: actions.values,
            labels: actions.labels,
            get: () => settings.get_string('click-action'),
            set: (v) => settings.set_string('click-action', v),
        }).row);

        gestures.add(this._buildDropdownRow({
            title: 'Swipe Left',
            values: actions.values,
            labels: actions.labels,
            get: () => settings.get_string('swipe-left-action'),
            set: (v) => settings.set_string('swipe-left-action', v),
        }).row);

        gestures.add(this._buildDropdownRow({
            title: 'Swipe Up',
            values: actions.values,
            labels: actions.labels,
            get: () => settings.get_string('swipe-up-action'),
            set: (v) => settings.set_string('swipe-up-action', v),
        }).row);

        gestures.add(this._buildDropdownRow({
            title: 'Swipe Down',
            values: actions.values,
            labels: actions.labels,
            get: () => settings.get_string('swipe-down-action'),
            set: (v) => settings.set_string('swipe-down-action', v),
        }).row);

        gestures.add(this._buildDropdownRow({
            title: 'Swipe Right',
            values: actions.values,
            labels: actions.labels,
            get: () => settings.get_string('swipe-right-action'),
            set: (v) => settings.set_string('swipe-right-action', v),
        }).row);

        page.add(gestures);
        window.add(page);
    }

    _buildDropdownRow(props) {
        const row = new Adw.ActionRow({
            title: props.title,
            subtitle: props.subtitle ?? '',
        });
        const dd = Gtk.DropDown.new_from_strings(props.labels);
        dd.valign = Gtk.Align.CENTER;
        row.add_suffix(dd);

        const sync = () => {
            const value = props.get();
            const idx = Math.max(0, props.values.indexOf(value));
            if (dd.selected !== idx)
                dd.selected = idx;
        };
        sync();
        dd.connect('notify::selected', () => props.set(props.values[dd.selected] ?? props.values[0]));

        return {row, dd, sync};
    }
}
