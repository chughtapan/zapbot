FROM oven/bun:1-slim
WORKDIR /app
COPY gateway/package.json gateway/bun.lock ./
RUN bun install --production
COPY gateway/src/ src/
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
