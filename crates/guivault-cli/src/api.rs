//! Le client HTTP de `gv`, bloquant (une commande, quelques requêtes) :
//! connexion, rafraîchissement des jetons, `/sync` et les items. Les jetons
//! tournent à chaque rafraîchissement ; ils sont réécrits dans
//! `account.json` aussitôt, sous le verrou de synchronisation.
use crate::store::{Account, Tokens};
use anyhow::{Result, anyhow, bail};
use guivault_protocol::{
    ApiError, ItemsPage, LoginRequest, LoginResponse, PreloginRequest, PreloginResponse, RefreshRequest, SyncResponse,
    TokenPair, TotpChallenge, TotpVerifyRequest,
};
use reqwest::StatusCode;
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use uuid::Uuid;

pub struct Api {
    base: String,
    http: Client,
}

pub enum LoginStep {
    Done(Box<LoginResponse>),
    Totp(String),
}

impl Api {
    pub fn new(server: &str) -> Result<Self> {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(concat!("gv/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            base: format!("{}/api/v1", server.trim_end_matches('/')),
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn send<T: DeserializeOwned>(req: RequestBuilder) -> Result<T> {
        let res = req.send().map_err(|e| anyhow!("serveur injoignable : {e}"))?;
        decode(res)
    }

    pub fn prelogin(&self, email: &str) -> Result<PreloginResponse> {
        Self::send(
            self.http
                .post(self.url("/auth/prelogin"))
                .json(&PreloginRequest { email: email.into() }),
        )
    }

    pub fn login(&self, req: &LoginRequest) -> Result<LoginStep> {
        let res = self
            .http
            .post(self.url("/auth/login"))
            .json(req)
            .send()
            .map_err(|e| anyhow!("serveur injoignable : {e}"))?;
        if res.status() == StatusCode::ACCEPTED {
            let c: TotpChallenge = res.json()?;
            return Ok(LoginStep::Totp(c.totp_token));
        }
        Ok(LoginStep::Done(Box::new(decode(res)?)))
    }

    pub fn totp_verify(&self, token: &str, code: &str) -> Result<LoginResponse> {
        Self::send(self.http.post(self.url("/auth/totp/verify")).json(&TotpVerifyRequest {
            totp_token: token.into(),
            code: code.into(),
        }))
    }

    pub fn logout(&self, access: &str) -> Result<()> {
        let res = self.http.post(self.url("/auth/logout")).bearer_auth(access).send()?;
        if !res.status().is_success() {
            bail!("déconnexion refusée ({})", res.status());
        }
        Ok(())
    }

    /// Un jeton d'accès valable (rafraîchi s'il expire dans la minute) ;
    /// `account` est mis à jour, à l'appelant de l'enregistrer.
    pub fn access_token(&self, account: &mut Account) -> Result<String> {
        if account.tokens.access_expires_at > chrono::Utc::now() + chrono::Duration::seconds(60) {
            return Ok(account.tokens.access_token.clone());
        }
        self.refresh(account)?;
        Ok(account.tokens.access_token.clone())
    }

    fn refresh(&self, account: &mut Account) -> Result<()> {
        let pair: TokenPair = Self::send(self.http.post(self.url("/auth/refresh")).json(&RefreshRequest {
            refresh_token: account.tokens.refresh_token.clone(),
        }))
        .map_err(|e| anyhow!("{e} — session expirée ou révoquée ? `gv login`"))?;
        account.tokens = tokens(&pair);
        Ok(())
    }

    pub fn sync(&self, access: &str) -> Result<SyncResponse> {
        Self::send(self.http.get(self.url("/sync")).bearer_auth(access))
    }

    pub fn items(&self, access: &str, vault: Uuid) -> Result<ItemsPage> {
        Self::send(
            self.http
                .get(self.url(&format!("/vaults/{vault}/items")))
                .bearer_auth(access),
        )
    }
}

pub fn tokens(pair: &TokenPair) -> Tokens {
    Tokens {
        access_token: pair.access_token.clone(),
        refresh_token: pair.refresh_token.clone(),
        access_expires_at: chrono::Utc::now() + chrono::Duration::seconds(pair.access_expires_in as i64),
    }
}

fn decode<T: DeserializeOwned>(res: Response) -> Result<T> {
    let status = res.status();
    if status.is_success() {
        return Ok(res.json()?);
    }
    match res.json::<ApiError>() {
        Ok(e) => bail!("{} ({})", e.message, e.code),
        Err(_) => bail!("le serveur a répondu {status}"),
    }
}
