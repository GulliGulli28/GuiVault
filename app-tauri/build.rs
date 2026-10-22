fn main() {
    // La bulle d'Android (`src/bubble.rs`) : un plugin de l'app elle-même,
    // dont les commandes Kotlin ont leurs permissions (`bubble:allow-…`).
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "bubble",
        tauri_build::InlinedPlugin::new().commands(&["available", "allowed", "ask", "show", "hide", "locked", "auto"]),
    ))
    .expect("échec de tauri-build");
}
