FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY src/ src/
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
