//! `web/dist` est embarqué par `include_dir!` (voir `src/web.rs`), qui exige
//! que le dossier existe à la compilation. On le crée vide s'il manque : le
//! serveur compile sans Node (tests, `cargo check`), et répond alors sur `/`
//! que l'interface n'a pas été construite.
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    std::fs::create_dir_all(&dist).expect("créer web/dist");
    // `include_dir!` ne déclare pas de dépendance sur son dossier : sans
    // ceci, un `npm run build` suivi d'un `cargo build` ne re-embarquerait
    // pas la nouvelle version.
    println!("cargo:rerun-if-changed={}", dist.display());
}
