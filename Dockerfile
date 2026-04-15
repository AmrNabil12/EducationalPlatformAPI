FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Copy the backend app (scripts, src, etc). `.dockerignore` keeps it clean.
COPY backend/ ./

ENV NODE_ENV=production
EXPOSE 4000

# Railway provides PORT; server_db.js uses process.env.PORT (default 4000)
CMD ["node", "src/server_db.js"]
