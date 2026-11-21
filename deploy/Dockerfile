# Minimal non-root OCI image for a Tendriller participant (W10)
FROM node:22-alpine

RUN addgroup -S tendriller && adduser -S tendriller -G tendriller
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .

RUN mkdir -p /data/.tendriller && chown -R tendriller:tendriller /app /data
USER tendriller

ENV NODE_ENV=production
VOLUME ["/data/.tendriller"]

STOPSIGNAL SIGTERM
CMD ["node", "session.mjs"]
