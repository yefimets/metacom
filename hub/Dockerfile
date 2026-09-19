# metacom hub: one Node process, no database. Built from the repo root so the metacom
# checkout next to hub/ is copied in (hub depends on it with file:../metacom).
#   docker build -f hub/Dockerfile -t metacom-hub .
FROM node:24-alpine
WORKDIR /app
COPY metacom/package.json metacom/package-lock.json ./metacom/
RUN cd metacom && npm ci --omit=dev --ignore-scripts
COPY metacom/ ./metacom/
COPY hub/package.json ./hub/
RUN cd hub && npm install --omit=dev --ignore-scripts
COPY hub/ ./hub/
ENV HUB_HOST=0.0.0.0 HUB_PORT=8900 HUB_DATA=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8900
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8900/health || exit 1
CMD ["node", "hub/server.js"]
