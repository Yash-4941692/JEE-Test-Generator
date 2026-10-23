FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# No runtime dependencies — copy the app itself.
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY fixtures ./fixtures
COPY scripts ./scripts

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
