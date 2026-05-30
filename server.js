import "dotenv/config";
import express from "express";
import apiApp from "./api/index.js";

const PORT = Number(process.env.PORT || 5177);
const app = express();

app.use("/api", apiApp);
app.use(express.static("."));

app.listen(PORT, () => {
  console.log(`Dialogos ready: http://127.0.0.1:${PORT}/`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL ? "configured" : "missing"}`);
  console.log(`  Stripe: ${process.env.STRIPE_SECRET_KEY ? "configured" : "missing"}`);
  console.log(`  OpenAI: ${process.env.OPENAI_API_KEY ? "configured" : "missing"}`);
});
