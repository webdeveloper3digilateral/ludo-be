import dotenv from "dotenv";
import db from "./src/config/db.js";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import uploadRoute from "./src/routes/uploadRoute.js";
import authRoute from "./src/routes/authRoutes.js";
import adminRoute from "./src/routes/adminRoutes.js";
import flmRoute from "./src/routes/flmRoutes.js";
import mrRoute from "./src/routes/mrRoutes.js";
import path from "path";
import { fileURLToPath } from "url";
import { setupSocketHandlers } from "./src/socket/socketHandlers.js";
import { startExpiredBoardsCron } from "./src/utils/cronJobs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
dotenv.config();

// Configure body parsing - skip for multipart/form-data (handled by multer)
app.use((req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    // Skip body parsing for multipart - let multer handle it
    return next();
  }
  // Parse JSON and URL-encoded bodies
  express.json()(req, res, () => {
    express.urlencoded({ extended: true })(req, res, next);
  });
});

// Serve static files (prescription images)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = process.env.PORT || 4500;

app.get("/", (req, res) => {
  res.send("Ludo-Backend is running...");
});

app.use("/api/upload", uploadRoute);
app.use("/api/auth", authRoute);
app.use("/api/admin", adminRoute);
app.use("/api/flm", flmRoute);
app.use("/api/mr", mrRoute);

try {
  // Just test once
  const [rows] = await db.execute("SELECT NOW() AS currentTime");
  console.info("✅ MySQL connected | ⏰ DB Time:", rows[0].currentTime);

  // Create HTTP server
  const httpServer = createServer(app);

  // Initialize Socket.IO with CORS
  const io = new Server(httpServer, {
    cors: {
      origin: "*", // Configure this based on your frontend URL (e.g., "http://localhost:3000")
      methods: ["GET", "POST"],
    },
  });

  // Setup socket handlers
  setupSocketHandlers(io);

  // Start cron job for checking expired boards
  startExpiredBoardsCron();

  httpServer.listen(PORT, () => {
    console.info(`🚀 Server running at http://localhost:${PORT}`);
    console.info(`🔌 Socket.IO server ready`);
  });
} catch (err) {
  console.error("❌ MYSQL DB connection error:", err.message);
  process.exit(1);
}
 