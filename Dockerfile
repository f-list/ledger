# Stage 1: build the frontend
FROM node:22-alpine AS client-build

WORKDIR /repo

COPY package*.json ./
COPY backend/package.json backend/
COPY client/package.json client/
RUN npm ci

COPY client ./client
RUN npm run build -w client

# Stage 2: the server
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY backend/package.json backend/
COPY client/package.json client/
RUN npm ci --omit=dev

COPY backend/src ./backend/src
COPY --from=client-build /repo/client/dist ./client/dist

RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
EXPOSE 3000

USER node

CMD ["node", "backend/src/index.ts"]
