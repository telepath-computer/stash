FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY tests/ tests/
COPY docs/ docs/

CMD ["npm", "test"]
