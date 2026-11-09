FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
