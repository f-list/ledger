import path from 'node:path';
import express from 'express';

const app = express();
const port = process.env.PORT || 3000;
const clientDist = path.join(import.meta.dirname, '..', '..', 'client', 'dist');

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use(express.static(clientDist));

// SPA fallback: send index.html for any non-API GET request
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
