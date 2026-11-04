FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "src/server.js"]
