require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const express = require('express');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const PREFIX = ';';
const ALLOWED_CHECK_USERS = ['1487137224221921320', '1487134376239042816'];
const DATA_FILE = path.join(__dirname, 'data', 'db.json');

// ─── Data helpers ─────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { linked: [], logs: [], pending: {} };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Roblox helpers ───────────────────────────────────────────────────────────
async function getRobloxUser(username) {
  // POST endpoint for exact-username lookup (avoids display-name confusion)
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  const json = await res.json();
  return json.data?.[0] ?? null; // { id, name, displayName }
}

async function getRobloxBio(userId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  const json = await res.json();
  return json.description ?? '';
}

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`✅ Bot ready — logged in as ${client.user.tag}`);
});

// ─── Message handler ──────────────────────────────────────────────────────────
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
  const data   = loadData();
  const userId = message.author.id;

  if (data.linked.find(l => l.discordId === userId)) {
    const existing = data.linked.find(l => l.discordId === userId);
    return message.reply(`❌ You are already linked to the Roblox account **${existing.robloxUsername}**.`);
  }

  const code = 'VERIFY-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  data.pending[userId] = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
  saveData(data);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔗 Roblox Account Verification')
    .setDescription([
      `Hey ${message.author}! Follow these steps to link your Roblox account:`,
      '',
      '**Step 1 —** Copy your personal verification code below:',
      `\`\`\`${code}\`\`\``,
      '**Step 2 —** Go to [roblox.com](https://www.roblox.com) → **Edit Profile** → paste the code in your **bio / description**.',
      '',
      '**Step 3 —** Come back here and type:',
      '`;verify <your_roblox_username>`',
      '',
      '⏰ This code expires in **10 minutes**.',
      '> You can remove it from your bio once verification is complete.'
    ].join('\n'))
    .setFooter({ text: 'Only you can see your code — do not share it.' })
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// ─── ;verify <roblox_username> ────────────────────────────────────────────────
async function cmdVerify(message, args) {
  if (!args[0]) {
    return message.reply('❌ Usage: `;verify <roblox_username>`');
  }

  const data    = loadData();
  const userId  = message.author.id;
  const pending = data.pending[userId];

  if (!pending) {
    return message.reply('❌ No pending verification found. Run `;link` first.');
  }
  if (Date.now() > pending.expiresAt) {
    delete data.pending[userId];
    saveData(data);
    return message.reply('❌ Your code expired. Please run `;link` again to get a new one.');
  }

  const status = await message.reply('🔍 Looking up your Roblox account…');

  const robloxUser = await getRobloxUser(args[0]);
  if (!robloxUser) {
    return status.edit('❌ Roblox user **not found**. Double-check the username (no display names) and try again.');
  }

  const bio = await getRobloxBio(robloxUser.id);
  if (!bio.includes(pending.code)) {
    return status.edit(
      `❌ Code not found in **${robloxUser.name}**'s bio.\n` +
      `Make sure you pasted exactly: \`${pending.code}\``
    );
  }

  // ✅ Link confirmed
  delete data.pending[userId];
  data.linked.push({
    discordId:       userId,
    discordUsername: message.author.tag,
    robloxUsername:  robloxUser.name,
    robloxId:        robloxUser.id,
    linkedAt:        new Date().toISOString()
  });
  saveData(data);

  const successEmbed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Account Linked!')
    .setDescription(
      `**${message.author.tag}** is now verified as Roblox user **${robloxUser.name}**.\n\n` +
      `You can safely remove the code from your Roblox bio.`
    )
    .setTimestamp();

  await status.edit({ content: null, embeds: [successEmbed] });
}

// ─── ;check <discord_username> <message_link> ─────────────────────────────────
async function cmdCheck(message, args) {
  if (!ALLOWED_CHECK_USERS.includes(message.author.id)) {
    return message.reply('❌ You do not have permission to use `;check`.');
  }

  if (args.length < 2) {
    return message.reply('❌ Usage: `;check <discord_username> <message_link>`');
  }

  const discordUsername = args[0];
  const messageLink     = args[1];

  // Parse Discord message link → guildId / channelId / messageId
  const linkMatch = messageLink.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!linkMatch) {
    return message.reply('❌ Invalid message link. It should look like:\n`https://discord.com/channels/GUILD/CHANNEL/MESSAGE`');
  }

  const [, guildId, channelId, messageId] = linkMatch;
  const status = await message.reply('📨 Fetching message…');

  // Fetch the target message
  let targetMessage;
  try {
    const guild   = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    targetMessage  = await channel.messages.fetch(messageId);
  } catch {
    return status.edit('❌ Could not fetch that message. Make sure the bot is in that server/channel and the link is correct.');
  }

  const content = targetMessage.content;

  // ── Parse the standard application/info format ──────────────────────────────
  // Roblox username (no display name): ogmhabas
  // How you joined the server: pepephone
  // Kills: 2k
  const robloxMatch  = content.match(/roblox username[^\n:]*:\s*(.+)/i);
  const invitedMatch = content.match(/how you joined[^\n:]*:\s*(.+)/i);
  const killsMatch   = content.match(/kills\s*:\s*(.+)/i);

  if (!robloxMatch || !invitedMatch || !killsMatch) {
    return status.edit(
      '❌ Could not parse the message. Make sure it follows this format:\n```\n' +
      'Roblox username (no display name): USERNAME\nHow you joined the server: NAME\nKills: 2k\n```'
    );
  }

  const robloxUsername = robloxMatch[1].trim();
  const invitedBy      = invitedMatch[1].trim();
  const kills          = killsMatch[1].trim();

  // Save log entry
  const data = loadData();
  data.logs.push({
    discordUsername,
    invitedBy,
    robloxUsername,
    kills,
    checkedBy:  message.author.tag,
    checkedAt:  new Date().toISOString(),
    messageUrl: messageLink
  });
  saveData(data);

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('📋 Member Entry Logged')
    .addFields(
      { name: '👤 Discord Username', value: discordUsername,  inline: true },
      { name: '🎮 Roblox Username',  value: robloxUsername,   inline: true },
      { name: '📩 Invited By',       value: invitedBy,        inline: true },
      { name: '⚔️ Kills',            value: kills,            inline: true },
      { name: '🔎 Checked By',       value: message.author.tag, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'Entry saved to the dashboard.' });

  await status.edit({ content: null, embeds: [embed] });
}

// ─── Express web server ───────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/linked', (_req, res) => {
  res.json(loadData().linked);
});

app.get('/api/logs', (_req, res) => {
  res.json(loadData().logs);
});

app.get('/api/stats', (_req, res) => {
  const data = loadData();
  res.json({
    totalLinked: data.linked.length,
    totalLogs:   data.logs.length,
    pending:     Object.keys(data.pending).length
  });
});

app.listen(PORT, () => console.log(`🌐 Dashboard running on port ${PORT}`));

// ─── Start bot ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
