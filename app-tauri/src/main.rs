//! Le binaire du bureau : tout est dans la bibliothèque (`lib.rs`), que
//! Tauri mobile charge aussi.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    guivault_app_lib::run();
}
