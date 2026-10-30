# One image; the process role is the command (§17, §19). Plain JavaScript: no build step.
FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
COPY scripts ./scripts
COPY db ./db
USER app
EXPOSE 3000
CMD ["node", "src/apps/api.js"]
