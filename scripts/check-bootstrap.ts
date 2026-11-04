import { bootstrap } from '../src/main';

const app = await bootstrap(0);
try {
  const url = await app.getUrl();
  const response = await fetch(url);
  if (response.status !== 404) throw new Error(`Unexpected status: ${response.status}`);
  console.log(`Bootstrap OK: ${url}, HTTP 404 expected (no business endpoints)`);
} finally {
  await app.close();
}
