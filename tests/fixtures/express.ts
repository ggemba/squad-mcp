import express, { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const app = express();
const router = Router();

router.post('/login', async (req, res) => {
  const hashed = await bcrypt.hash(req.body.password, 10);
  const token = jwt.sign({ user: req.body.email }, 'secret');
  res.json({ token, hashed });
});

app.use(router);
app.listen(3000);
