FROM rust:1-slim-bookworm AS builder
WORKDIR /app

# Build from the workspace root so the API can import the shared crate.
COPY Cargo.toml Cargo.lock ./
COPY apps ./apps
COPY crates ./crates
RUN cargo build --locked --release -p htp-api

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/htp-api /usr/local/bin/htp-api
ENV BIND_ADDR=0.0.0.0:3000
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/htp-api"]
