FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY docs ./docs

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV DATA_FILE=/app/data/app-data.json

EXPOSE 4173

CMD ["node", "src/server.mjs"]
