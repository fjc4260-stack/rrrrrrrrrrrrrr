// ===================================================================
// سرور بازی تپ‌کوین (Tap Coin) برای مینی‌اپ تلگرام
// نسخه‌ی ساده‌شده: به‌جای MongoDB، سکه‌ها رو داخل یک فایل JSON
// روی همین سیستم ذخیره می‌کنه. برای تست محلی و تونل مناسبه.
// ===================================================================

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const {
  BOT_TOKEN,
  ADMIN_PASSWORD,
  PORT = 3000,
  ALLOW_DEV_MODE = "true",
} = process.env;

if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN تنظیم نشده - اعتبارسنجی تلگرام کار نمی‌کنه");
if (!ADMIN_PASSWORD) console.warn("⚠️  ADMIN_PASSWORD تنظیم نشده - پنل مدیریت باز نمیشه");

// -------------------- دیتابیس ساده مبتنی بر فایل JSON --------------------
const DB_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DB_DIR, "db.json");

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));

let db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

// نوشتن روی دیسک با کمی تاخیر جمع‌شده، تا هر تپ باعث یک نوشتن جدا نشه
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (err) => {
      if (err) console.error("❌ خطا در ذخیره دیتابیس:", err.message);
    });
    saveTimeout = null;
  }, 300);
}

function getUser(telegramId) {
  return db.users[telegramId] || null;
}
function saveUser(user) {
  db.users[user.telegramId] = user;
  scheduleSave();
}

// -------------------- تنظیمات بازی (اینا رو می‌تونی تغییر بدی) --------------------
const ENERGY_REGEN_SECONDS_FOR_FULL = 600; // پر شدن کامل انرژی طی ۱۰ دقیقه
const MAX_TAPS_PER_SYNC = 500; // سقف تعداد تپ در هر بار ارسال، برای جلوگیری از تقلب

function maxEnergyForLevel(level) {
  return 1000 + (level - 1) * 200;
}
function coinsPerTapForLevel(level) {
  return 1 + Math.floor(level / 5);
}
function levelForCoins(coins) {
  return 1 + Math.floor(Math.sqrt(coins / 2000));
}

// -------------------- اعتبارسنجی initData تلگرام --------------------
function verifyTelegramInitData(initData) {
  if (!initData || typeof initData !== "string") return null;

  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get("hash");
  if (!hash) return null;
  urlParams.delete("hash");

  const dataCheckArr = [];
  for (const [key, value] of urlParams.entries()) {
    dataCheckArr.push(`${key}=${value}`);
  }
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return null;

  const authDate = Number(urlParams.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (authDate && now - authDate > 60 * 60 * 24) return null;

  const userRaw = urlParams.get("user");
  if (!userRaw) return null;

  try {
    const user = JSON.parse(userRaw);
    return {
      id: String(user.id),
      username: user.username || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
    };
  } catch {
    return null;
  }
}

function verifyDevFallback(initData) {
  if (ALLOW_DEV_MODE !== "true") return null;
  if (typeof initData === "string" && initData.startsWith("dev:")) {
    const [, id, name] = initData.split(":");
    if (!id) return null;
    return { id: `dev_${id}`, username: name || "", firstName: name || "تست", lastName: "" };
  }
  return null;
}

function authenticate(initData) {
  return verifyTelegramInitData(initData) || verifyDevFallback(initData);
}

// -------------------- API: ورود / گرفتن وضعیت کاربر --------------------
app.post("/api/auth", (req, res) => {
  try {
    const { initData } = req.body;
    const tgUser = authenticate(initData);
    if (!tgUser) return res.status(401).json({ error: "invalid_init_data" });

    let user = getUser(tgUser.id);
    if (!user) {
      user = {
        telegramId: tgUser.id,
        username: tgUser.username,
        firstName: tgUser.firstName,
        lastName: tgUser.lastName,
        coins: 0,
        level: 1,
        energy: maxEnergyForLevel(1),
        maxEnergy: maxEnergyForLevel(1),
        coinsPerTap: coinsPerTapForLevel(1),
        lastEnergyTs: Date.now(),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
    } else {
      user.username = tgUser.username || user.username;
      user.firstName = tgUser.firstName || user.firstName;
      user.lastSeenAt = new Date().toISOString();
      applyEnergyRegen(user);
    }
    saveUser(user);

    res.json(publicUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// -------------------- API: ارسال تعداد تپ‌ها --------------------
app.post("/api/tap", (req, res) => {
  try {
    const { initData, taps } = req.body;
    const tgUser = authenticate(initData);
    if (!tgUser) return res.status(401).json({ error: "invalid_init_data" });

    const requestedTaps = Math.max(0, Math.min(Number(taps) || 0, MAX_TAPS_PER_SYNC));

    const user = getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: "user_not_found" });

    applyEnergyRegen(user);

    const actualTaps = Math.min(requestedTaps, Math.floor(user.energy));
    user.energy -= actualTaps;
    user.coins += actualTaps * user.coinsPerTap;

    const newLevel = levelForCoins(user.coins);
    if (newLevel > user.level) {
      user.level = newLevel;
      user.maxEnergy = maxEnergyForLevel(newLevel);
      user.coinsPerTap = coinsPerTapForLevel(newLevel);
    }

    user.lastSeenAt = new Date().toISOString();
    saveUser(user);

    res.json(publicUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

function applyEnergyRegen(user) {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - (user.lastEnergyTs || now)) / 1000);
  const regenPerSecond = user.maxEnergy / ENERGY_REGEN_SECONDS_FOR_FULL;
  user.energy = Math.min(user.maxEnergy, user.energy + elapsedSeconds * regenPerSecond);
  user.lastEnergyTs = now;
}

function publicUser(user) {
  return {
    coins: Math.floor(user.coins),
    level: user.level,
    energy: Math.floor(user.energy),
    maxEnergy: user.maxEnergy,
    coinsPerTap: user.coinsPerTap,
    username: user.username,
    firstName: user.firstName,
  };
}

// -------------------- API: پنل مدیریت --------------------
function checkAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!ADMIN_PASSWORD || key !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/api/admin/users", checkAdmin, (req, res) => {
  const users = Object.values(db.users).sort((a, b) => b.coins - a.coins);
  res.json(
    users.map((u) => ({
      telegramId: u.telegramId,
      username: u.username,
      firstName: u.firstName,
      lastName: u.lastName,
      coins: Math.floor(u.coins),
      level: u.level,
      lastSeenAt: u.lastSeenAt,
      createdAt: u.createdAt,
    }))
  );
});

app.get("/api/admin/stats", checkAdmin, (req, res) => {
  const users = Object.values(db.users);
  const totalCoins = users.reduce((sum, u) => sum + Math.floor(u.coins), 0);
  res.json({ totalUsers: users.length, totalCoins });
});

app.use("/admin", express.static(path.join(__dirname, "admin")));

app.get("/", (req, res) => {
  res.send("Tap Coin backend is running.");
});

app.listen(PORT, () => console.log(`🚀 سرور روی پورت ${PORT} بالا اومد (ذخیره‌سازی: فایل JSON محلی)`));
