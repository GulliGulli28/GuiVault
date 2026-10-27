fn main() {
    // La bulle, la biométrie, le remplissage et les archives de coffre
    // d'Android (`src/bubble.rs`, `src/biometric.rs`, `src/autofill.rs`,
    // `src/coffre_file.rs`) : des plugins de l'app elle-même,
    // dont les commandes Kotlin ont leurs permissions (`bubble:allow-…`…).
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
                ]),
            )
            .plugin(
                "autofill",
                tauri_build::InlinedPlugin::new().commands(&[
                    "status", "request", "disable", "update", "clear", "forget", "password", "pending", "offer",
                ]),
            )
            .plugin(
                "coffrefile",
                tauri_build::InlinedPlugin::new().commands(&["save", "pick"]),
            )
            .plugin(
                "biometric",
                tauri_build::InlinedPlugin::new()
                    .commands(&["status", "state", "enable", "unlock", "touch", "disable"]),
            ),
    )
    .expect("échec de tauri-build");
}
