# syntax=docker/dockerfile:1
# Image du serveur GuiVault. Deux étapes : compilation (cargo-chef met en
# cache la compilation des dépendances, qui ne bougent pas d'un commit à
# l'autre) puis une image Debian minimale sans outillage.
#
#   docker build -f docker/Dockerfile -t guivault .

FROM lukemathwalker/cargo-chef:latest-rust-1 AS chef
WORKDIR /src

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json -p guivault-server
COPY . .
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
