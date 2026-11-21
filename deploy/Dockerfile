# Build with the authored starter project as context: docker build -f deploy/Dockerfile .
FROM node:24-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p /app/.tendriller && chown node:node /app/.tendriller && chmod 700 /app/.tendriller
USER node
ENV NODE_ENV=production
# local.mjs resolves state relative to the project, not the working directory.
VOLUME ["/app/.tendriller"]
STOPSIGNAL SIGTERM
CMD ["node", "deploy/participant.mjs", "--session", "/app/session.mjs"]
