FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e

ARG HERDR_VERSION=0.8.0
ARG HERDR_SHA256_AMD64=b872ea7e40fa2cb17e857ac9b62b1bf26db7b403c622f5d2f3f5b35f6e9acd28
ARG HERDR_SHA256_ARM64=f647ac66468d9efbc642fe534fb284468f0aea60641606fc008dfc0d82a3ca87
ARG CODEX_VERSION=0.150.1
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps python3 \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) herdr_arch=x86_64; herdr_sha="$HERDR_SHA256_AMD64" ;; \
         arm64) herdr_arch=aarch64; herdr_sha="$HERDR_SHA256_ARM64" ;; \
         *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${herdr_arch}" -o /usr/local/bin/herdr \
    && echo "${herdr_sha}  /usr/local/bin/herdr" | sha256sum --check --strict - \
    && chmod 0755 /usr/local/bin/herdr \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

RUN mkdir -p /app /opt/herdr-supervisor \
    && chown node:node /app

COPY --chown=node:node package.json package-lock.json /opt/herdr-supervisor/
COPY --chown=node:node container /opt/herdr-supervisor/container
COPY --chown=node:node skills /opt/herdr-supervisor/skills
COPY --chown=node:node src /opt/herdr-supervisor/src
RUN npm ci --prefix /opt/herdr-supervisor --omit=dev \
    && npm cache clean --force \
    && chmod 0755 /opt/herdr-supervisor/container/bin/codex /opt/herdr-supervisor/container/bin/pi /opt/herdr-supervisor/container/container-entrypoint.sh \
    && mv /usr/local/bin/codex /usr/local/bin/codex-agent \
    && ln -s /opt/herdr-supervisor/node_modules/.bin/pi /usr/local/bin/pi-agent \
    && ln -s /opt/herdr-supervisor/container/bin/codex /usr/local/bin/codex \
    && ln -s /opt/herdr-supervisor/container/bin/pi /usr/local/bin/pi

USER node
WORKDIR /app
ENV HERDR_SUPERVISOR_GOALS=/home/node/.local/state/herdr-supervisor/goals
ENV HERDR_SUPERVISOR_DIRECTORY=/app

ENTRYPOINT ["/opt/herdr-supervisor/container/container-entrypoint.sh"]
CMD ["herdr", "server"]
