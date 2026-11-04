FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
RUN mkdir -p /data && chown -R pwuser:pwuser /data
USER pwuser
ENV NODE_ENV=production PORT=8080 BROWSER_PROFILE=/data/chromium-profile COOKIE_SECURE=1
EXPOSE 8080
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24", "node", "src/server.js"]
