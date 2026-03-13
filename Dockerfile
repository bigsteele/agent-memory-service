FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Data directory for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3005
ENV MEMORY_DB_PATH=/data/memory.db

EXPOSE 3005

CMD ["node", "server.js"]
