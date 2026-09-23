import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const content = `BASE_URL=http://localhost:3000\nPORT=3000\nBIND_ADDRESS=127.0.0.1\nPOSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\n`;
try {
  writeFileSync('.env', content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random database password. Review BASE_URL before publishing.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; existing settings were preserved.');
}
