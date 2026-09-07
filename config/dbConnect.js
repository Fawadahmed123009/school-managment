const mongoose = require("mongoose");
require("dotenv").config();
require("colors");

const dbConnect = async () => {
  if (!process.env.DB) {
    console.error("FATAL: DB environment variable is not set. Cannot connect to MongoDB.".red.bold);
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.DB);
    console.log("Database connected! ".yellow.bold);
  } catch (err) {
    console.error(`Failed to connect database: ${err}`.red.bold);
  }
};

// Log connection drops / errors after initial connect (Atlas free tier
// can close idle connections — Mongoose auto-reconnects, but logging
// helps diagnose transient issues).
mongoose.connection.on("error", (err) => {
  console.error(`MongoDB connection error: ${err}`.red.bold);
});

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected — Mongoose will attempt to reconnect automatically.".yellow.bold);
});

dbConnect();
