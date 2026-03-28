require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────
const PREFIX              = ';';
const ALLOWED_CHECK_USERS = ['1487137224221921320', '1487134376239042816'];

// ─── MongoDB Schemas ──────────────────────────────────────────────────────────
const linkedSchema = new mongoose.Schema({
  discordId:       { type: String, required: true, unique: true },
  discordUsername: String,
  robloxUsername:  String,
  robloxId:        String,
  linkedAt:        { type: Date, default: Date.now }
});
const logSchema = new mongoose.Schema({
  discordUsername: String,
  invitedBy:       String,
  robloxUsername:  String,
  kills:           String,
  checkedBy:       String,
  messageUrl:      String,
  checkedAt:       { type: Date, default: Date.now }
});
const pendingSchema = new mongoose.Schema({
  discordId:  { type: String, required: true, unique: true },
  code:       String,
  expiresAt:  Date
});

const Linked  = mongoose.model('Linked',  linkedSchema);
const Log     = mongoose.model('Log',     logSchema);
const Pending = mongoose.model('Pending', pendingSchema);

// ─── MongoDB connection (with retries) ────────────────────────────────────────
let dbReady = false;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI not set in environment variables!');
    return;
  }
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await mongoose.connect(uri);
      dbReady = true;
      console.log('✅ MongoDB connected');
      return;
    } catch (err) {
      console.error(`⚠️  MongoDB attempt ${attempt}/10 failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.error('❌ MongoDB could not connect after 10 attempts. Bot commands requiring DB will fail.');
}

// ─── Roblox helpers ───────────────────────────────────────────────────────────
async function getRobloxUser(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  const json = await res.json();
  return json.data?.[0] ?? null;
}
async function getRobloxBio(userId) {
  const res  = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  const json = await res.json();
  return json.description ?? '';
}

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`✅ Discord bot online — ${client.user.tag}`);
});

client.on('error', err => console.error('Discord client error:', err));

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  try {
    if (command === 'link')   return await cmdLink(message);
    if (command === 'verify') return await cmdVerify(message, args);
    if (command === 'check')  return await cmdCheck(message, args);
  } catch (err) {
    console.error(`[${command}] Error:`, err);
    message.reply('❌ An unexpected error occurred. Please try again.').catch(() => {});
  }
});

// ─── ;link ────────────────────────────────────────────────────────────────────
async function cmdLink(message) {
  if (!dbReady) return message.reply('⚠️ Database is not ready yet. Please try again in a few seconds.');

  const userId   = message.author.id;
  const existing = await Linked.findOne({ discordId: userId });
  if (existing) {
    return message.reply(`❌ You are already linked to the Roblox account **${existing.robloxUsername}**.`);
  }

  const code = 'VERIFY-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  await Pending.findOneAndUpdate(
    { discordId: userId },
    { code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    { upsert: true, new: true }
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔗 Roblox Account Verification')
    .setDescription([
      `Hey ${message.author}! Follow these steps to link your Roblox account:`,
      '',
      '**Step 1 —** Copy your personal verification code:',
      `\`\`\`${code}\`\`\``,
      '**Step 2 —** Go to [roblox.com](https://www.roblox.com) → **Edit Profile** → paste the code in your **bio**.',
      '',
      '**Step 3 —** Come back and type:',
      '`;verify <your_roblox_username>`',
      '',
      '⏰ Code expires in **10 minutes**.',
    ].join('\n'))
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// ─── ;verify ─────────────────────────────────────────────────────────────────
async function cmdVerify(message, args) {
  if (!dbReady) return message.reply('⚠️ Database is not ready yet. Please try again in a few seconds.');
  if (!args[0]) return message.reply('❌ Usage: `;verify <roblox_username>`');

  const userId  = message.author.id;
  const pending = await Pending.findOne({ discordId: userId });
  if (!pending) return message.reply('❌ No pending verification. Run `;link` first.');
  if (Date.now() > pending.expiresAt.getTime()) {
    await Pending.deleteOne({ discordId: userId });
    return message.reply('❌ Code expired. Run `;link` again.');
  }

  const status     = await message.reply('🔍 Looking up your Roblox account…');
  const robloxUser = await getRobloxUser(args[0]);
  if (!robloxUser) return status.edit('❌ Roblox user **not found**. Check the username (not display name).');

  const bio = await getRobloxBio(robloxUser.id);
  if (!bio.includes(pending.code)) {
    return status.edit(`❌ Code not found in **${robloxUser.name}**'s bio.\nMake sure you pasted: \`${pending.code}\``);
  }

  await Pending.deleteOne({ discordId: userId });
  await Linked.create({
    discordId:       userId,
    discordUsername: message.author.tag,
    robloxUsername:  robloxUser.name,
    robloxId:        String(robloxUser.id),
  });

  await status.edit({ content: null, embeds: [
    new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('✅ Account Linked!')
      .setDescription(`**${message.author.tag}** verified as **${robloxUser.name}**.\nYou can remove the code from your bio.`)
      .setTimestamp()
  ]});
}

// ─── ;check ──────────────────────────────────────────────────────────────────
async function cmdCheck(message, args) {
  if (!ALLOWED_CHECK_USERS.includes(message.author.id)) {
    return message.reply('❌ You do not have permission to use `;check`.');
  }
  if (!dbReady) return message.reply('⚠️ Database not ready. Try again in a moment.');
  if (args.length < 2) return message.reply('❌ Usage: `;check <discord_username> <message_link>`');

  const discordUsername = args[0];
  const messageLink     = args[1];
  const linkMatch = messageLink.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!linkMatch) return message.reply('❌ Invalid message link.');

  const [, guildId, channelId, messageId] = linkMatch;
  const status = await message.reply('📨 Fetching message…');

  let targetMessage;
  try {
    const guild   = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    targetMessage  = await channel.messages.fetch(messageId);
  } catch {
    return status.edit('❌ Could not fetch that message. Check the bot has access to that channel.');
  }

  const content      = targetMessage.content;
  const robloxMatch  = content.match(/roblox username[^\n:]*:\s*(.+)/i);
  const invitedMatch = content.match(/how you joined[^\n:]*:\s*(.+)/i);
  const killsMatch   = content.match(/kills\s*:\s*(.+)/i);

  if (!robloxMatch || !invitedMatch || !killsMatch) {
    return status.edit('❌ Could not parse the message. Format required:\n```\nRoblox username (no display name): USERNAME\nHow you joined the server: NAME\nKills: 2k\n```');
  }

  await Log.create({
    discordUsername,
    invitedBy:      invitedMatch[1].trim(),
    robloxUsername: robloxMatch[1].trim(),
    kills:          killsMatch[1].trim(),
    checkedBy:      message.author.tag,
    messageUrl:     messageLink,
  });

  await status.edit({ content: null, embeds: [
    new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle('📋 Member Entry Logged')
      .addFields(
        { name: '👤 Discord',       value: discordUsername,        inline: true },
        { name: '🎮 Roblox',        value: robloxMatch[1].trim(),  inline: true },
        { name: '📩 Invited By',    value: invitedMatch[1].trim(), inline: true },
        { name: '⚔️ Kills',         value: killsMatch[1].trim(),   inline: true },
        { name: '🔎 Checked By',    value: message.author.tag,     inline: true },
      )
      .setTimestamp()
  ]});
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/linked', async (_req, res) => {
  if (!dbReady) return res.json([]);
  res.json(await Linked.find().sort({ linkedAt: -1 }));
});
app.get('/api/logs', async (_req, res) => {
  if (!dbReady) return res.json([]);
  res.json(await Log.find().sort({ checkedAt: -1 }));
});
app.get('/api/stats', async (_req, res) => {
  if (!dbReady) return res.json({ totalLinked: 0, totalLogs: 0, pending: 0 });
  const [totalLinked, totalLogs, pending] = await Promise.all([
    Linked.countDocuments(), Log.countDocuments(), Pending.countDocuments()
  ]);
  res.json({ totalLinked, totalLogs, pending });
});

// ─── Startup — Express, DB and Discord all start independently ────────────────
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

connectDB(); // connects in background with retries

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN not set! Bot will not start.');
} else {
  client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('🔑 Discord login successful'))
    .catch(err => console.error('❌ Discord login FAILED:', err.message));
}