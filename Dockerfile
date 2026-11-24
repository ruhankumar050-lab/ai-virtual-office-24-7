FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=3000
EXPOSE 3000 7860
CMD ["node", "server.js"]
