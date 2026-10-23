fn main() {
    // La bulle et la biométrie d'Android (`src/bubble.rs`, `src/biometric.rs`) :
    // des plugins de l'app elle-même, dont les commandes Kotlin ont leurs
    // permissions (`bubble:allow-…`, `biometric:allow-…`).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "bubble",
                tauri_build::InlinedPlugin::new().commands(&[
                    "available",
                    "allowed",
                    "ask",
                    "show",
                    "hide",
                    "locked",
                    "auto",
                    "anchor",
                ]),
            )
            .plugin(
                "biometric",
                tauri_build::InlinedPlugin::new()
                    .commands(&["status", "state", "enable", "unlock", "touch", "disable"]),
            ),
    )
    .expect("échec de tauri-build");
}
