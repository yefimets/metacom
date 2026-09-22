# metacom: one Node process, no database.
#   docker build -t metacom .
FROM node:24-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js ./
COPY lib/ ./lib/
COPY api/ ./api/
COPY web/ ./web/
ENV MC_HOST=0.0.0.0 MC_PORT=8900 MC_DATA=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8900
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8900/health || exit 1
CMD ["node", "server.js"]
