# syntax=docker/dockerfile:1
# Image du serveur GuiVault. Trois étapes : le build Vite de l'interface web
# (`web/`), la compilation Rust (cargo-chef met en cache la compilation des
# dépendances, qui ne bougent pas d'un commit à l'autre) qui embarque ce
# build dans le binaire, puis une image Debian minimale sans outillage.
#
#   docker build -f docker/Dockerfile -t guivault .
#
# Images de base épinglées par empreinte : un tag qui bouge ne change pas
# l'image en silence (le build de l'interface en est reproductible). Dependabot
# (`.github/dependabot.yml`) propose les nouvelles empreintes chaque mois.

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM lukemathwalker/cargo-chef:latest-rust-1@sha256:5650c1203a4f2497c6268427c034efcb98f38ecbab86061b3d78d128aba43a1b AS chef
WORKDIR /src

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json -p guivault-server
COPY . .
# `include_dir!` lit `web/dist` à la compilation : il doit être là avant.
COPY --from=web /web/dist ./web/dist
# Le commit annoncé par `/api/v1/health` (fourni par le CI ; vide sinon).
ARG GUIVAULT_BUILD_COMMIT=
RUN GUIVAULT_BUILD_COMMIT="${GUIVAULT_BUILD_COMMIT}" cargo build --release --locked -p guivault-server

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --user-group --no-create-home guivault \
    && mkdir /backups && chown guivault:guivault /backups && chmod 700 /backups
COPY --from=builder /src/target/release/guivault /usr/local/bin/guivault
USER guivault
ENV GUIVAULT_BIND=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["guivault", "healthcheck"]
ENTRYPOINT ["guivault"]
