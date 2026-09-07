// M1-1: system tray (hands-owned surface).
// Tray menu drives host commands via the kkrpc/stdio bridge (M1-4) later;
// for now this wires the tray icon + a minimal menu with a Quit item.

use tauri::{
    menu::{MenuItem},
    tray::TrayIconBuilder,
    AppHandle,
};

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = MenuBuilder::new(app).item(&quit).build()?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
