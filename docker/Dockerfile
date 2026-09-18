# syntax=docker/dockerfile:1
# Image du serveur GuiVault. Trois étapes : le build Vite de l'interface web
# (`web/`), la compilation Rust (cargo-chef met en cache la compilation des
# dépendances, qui ne bougent pas d'un commit à l'autre) qui embarque ce
# build dans le binaire, puis une image Debian minimale sans outillage.
#
#   docker build -f docker/Dockerfile -t guivault .

FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM lukemathwalker/cargo-chef:latest-rust-1 AS chef
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
RUN cargo build --release --locked -p guivault-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --user-group --no-create-home guivault
COPY --from=builder /src/target/release/guivault /usr/local/bin/guivault
USER guivault
ENV GUIVAULT_BIND=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["guivault", "healthcheck"]
ENTRYPOINT ["guivault"]
