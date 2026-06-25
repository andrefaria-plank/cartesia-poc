# Telephony bridge (server/phone.ts) for Fly.io. The Next.js app deploys to Vercel
# separately and is not built here.
FROM node:22-slim

WORKDIR /app

RUN corepack enable

# Install deps (the phone server runs via tsx, so no build step is needed).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Only the code the phone server imports.
COPY tsconfig.json ./
COPY lib ./lib
COPY server ./server

ENV PORT=8080
EXPOSE 8080

CMD ["pnpm", "phone:start"]
