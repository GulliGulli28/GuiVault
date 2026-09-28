//! `guivault admin …` : donner ou retirer le rôle d'administrateur du
//! serveur, depuis son shell (`docker exec guivault guivault admin grant
//! moi@exemple.fr`). C'est le seul chemin : l'API ne sait pas le faire,
//! pour qu'une session d'administrateur volée ne puisse pas en créer
//! d'autres. Il ne faut que `GUIVAULT_DATABASE_URL`.
use crate::audit::Audit;
use sqlx::PgPool;

pub const USAGE: &str = "usage : guivault admin list | grant <email> | revoke <email>";

/// Donne (`true`) ou retire le rôle. `Ok(false)` : aucun compte à cette
/// adresse.
pub async fn set_admin(db: &PgPool, email: &str, admin: bool) -> anyhow::Result<bool> {
    let email = email.trim().to_lowercase();
    let mut tx = db.begin().await?;
    let id: Option<uuid::Uuid> = sqlx::query_scalar("UPDATE users SET is_admin = $2 WHERE email = $1 RETURNING id")
        .bind(&email)
        .bind(admin)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(id) = id else { return Ok(false) };
    Audit::new(if admin { "admin.grant" } else { "admin.revoke" })
        .target(id)
        .meta(serde_json::json!({ "by": "shell" }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn list(db: &PgPool) -> anyhow::Result<Vec<String>> {
    Ok(
        sqlx::query_scalar("SELECT email::text FROM users WHERE is_admin ORDER BY created_at")
            .fetch_all(db)
            .await?,
    )
}

/// `args` : ce qui suit `guivault admin`. Écrit sur la sortie standard.
pub async fn run(args: &[String]) -> anyhow::Result<()> {
    let url = std::env::var("GUIVAULT_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .map_err(|_| anyhow::anyhow!("GUIVAULT_DATABASE_URL manquant"))?;
    let db = crate::connect_url(&url).await?;
    match args {
        [cmd] if cmd == "list" => {
            let admins = list(&db).await?;
            if admins.is_empty() {
                println!("aucun administrateur");
            }
            for a in admins {
                println!("{a}");
            }
        }
        [cmd, email] if cmd == "grant" || cmd == "revoke" => {
            let grant = cmd == "grant";
            anyhow::ensure!(set_admin(&db, email, grant).await?, "aucun compte à l'adresse {email}");
            println!(
                "{email} {}",
                if grant {
                    "est administrateur du serveur"
                } else {
                    "n'est plus administrateur du serveur"
                }
            );
        }
        _ => anyhow::bail!(USAGE),
    }
    Ok(())
}
