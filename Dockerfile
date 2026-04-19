FROM node:22-slim

# LibreOffice pour conversion PPTX → PDF sur Linux
RUN apt-get update && apt-get install -y \
    libreoffice \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p tmp

EXPOSE 3000
CMD ["node", "server.js"]
