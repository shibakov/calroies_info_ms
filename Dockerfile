# ============
#  Stage 1 — Build
# ============
FROM node:18-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install deps
RUN npm install --production

# Copy source
COPY . .

# ============
#  Stage 2 — Runtime
# ============
FROM node:18-alpine

WORKDIR /app

# Copy only what is needed for runtime
COPY --from=build /app .

ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
