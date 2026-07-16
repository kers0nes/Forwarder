const { Client, GatewayIntentBits, EmbedBuilder, Guild } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration
const TOKEN = process.env.TOKEN;
const PREFIX = process.env.PREFIX || '.';

// Data storage
const forwardsPath = path.join(__dirname, 'forwards.json');
let forwards = {};

if (fs.existsSync(forwardsPath)) {
    try {
        forwards = JSON.parse(fs.readFileSync(forwardsPath, 'utf8'));
    } catch (e) {
        forwards = {};
    }
} else {
    fs.writeFileSync(forwardsPath, JSON.stringify({}, null, 2));
}

// Create client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
    ]
});

// Save data
function saveForwards() {
    fs.writeFileSync(forwardsPath, JSON.stringify(forwards, null, 2));
}

// Helper: Get channel from anywhere
async function getChannelFromAnywhere(input) {
    // Try to fetch channel directly (works across servers)
    if (/^\d+$/.test(input)) {
        try {
            const channel = await client.channels.fetch(input);
            if (channel && channel.isTextBased()) {
                return channel;
            }
        } catch (e) {}
        return null;
    }
    
    // Channel mention
    const match = input.match(/<#(\d+)>/);
    if (match) {
        try {
            const channel = await client.channels.fetch(match[1]);
            if (channel && channel.isTextBased()) {
                return channel;
            }
        } catch (e) {}
        return null;
    }
    
    return null;
}

// Find source channel by searching all servers
async function findChannelInAllServers(channelId) {
    try {
        // Try direct fetch first
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
            return channel;
        }
        return null;
    } catch (error) {
        console.error('Error finding channel:', error);
        return null;
    }
}

// Forward a single message
async function forwardMessage(message, targetChannel, sourceChannel) {
    try {
        // Check if already forwarded (prevent duplicates)
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setAuthor({
                name: message.author.tag,
                iconURL: message.author.displayAvatarURL()
            })
            .setDescription(message.content || '*No text content*')
            .addFields(
                { name: '📌 Source', value: `<#${sourceChannel.id}>`, inline: true },
                { name: '👤 Author', value: message.author.toString(), inline: true },
                { name: '📅 Sent', value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`, inline: true }
            )
            .setTimestamp(message.createdAt)
            .setFooter({ text: `ID: ${message.id}` });

        // Process attachments
        let files = [];
        let otherAttachments = [];

        for (const [, attachment] of message.attachments) {
            if (attachment.contentType?.startsWith('image/') || 
                attachment.contentType?.startsWith('video/') ||
                attachment.contentType?.startsWith('audio/')) {
                files.push({
                    attachment: attachment.url,
                    name: attachment.name
                });
            } else {
                otherAttachments.push(`[${attachment.name}](${attachment.url})`);
            }
        }

        if (otherAttachments.length > 0) {
            const links = otherAttachments.join('\n');
            embed.addFields({ 
                name: `📎 Files`, 
                value: links.length > 1024 ? links.substring(0, 1020) + '...' : links
            });
        }

        // Add source server info
        if (message.guild) {
            embed.addFields({ 
                name: '🏠 Server', 
                value: message.guild.name,
                inline: true 
            });
        }

        const messageData = { embeds: [embed] };
        if (files.length > 0) {
            messageData.files = files.slice(0, 10);
        }

        await targetChannel.send(messageData);
        
        if (files.length > 10) {
            await targetChannel.send(`⚠️ ${files.length - 10} more files not included (Discord limit)`);
        }

        return { success: true };

    } catch (error) {
        console.error('Forward error:', error);
        return { success: false, error: error.message };
    }
}

// Copy entire channel
async function copyChannel(sourceChannel, targetChannel) {
    try {
        // Check if bot can access source
        try {
            await sourceChannel.sendTyping();
        } catch (error) {
            return { success: false, message: 'Cannot access source channel. Bot may not be in that server.' };
        }

        const messages = await sourceChannel.messages.fetch({ limit: 100 });
        
        if (messages.size === 0) {
            return { success: false, message: 'No messages found in source channel.' };
        }

        const sortedMessages = Array.from(messages.values()).reverse();
        let forwarded = 0;
        let failed = 0;
        let totalAttachments = 0;

        for (const msg of sortedMessages) {
            totalAttachments += msg.attachments.size;
        }

        // Send start message
        const startEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🔄 Starting Copy')
            .setDescription(`Copying ${sortedMessages.length} messages`)
            .addFields(
                { name: '📌 Source', value: `<#${sourceChannel.id}>`, inline: true },
                { name: '🏠 Server', value: sourceChannel.guild?.name || 'Unknown', inline: true },
                { name: '📁 Files', value: `${totalAttachments} attachments`, inline: true }
            )
            .setTimestamp();

        await targetChannel.send({ embeds: [startEmbed] });

        // Forward each message
        for (let i = 0; i < sortedMessages.length; i++) {
            const result = await forwardMessage(sortedMessages[i], targetChannel, sourceChannel);
            
            if (result.success) {
                forwarded++;
            } else {
                failed++;
            }

            if ((i + 1) % 10 === 0) {
                await targetChannel.send(`⏳ Progress: ${i + 1}/${sortedMessages.length} messages...`);
            }

            await new Promise(resolve => setTimeout(resolve, 800));
        }

        // Save continuous forward
        const guildId = targetChannel.guildId;
        const targetId = targetChannel.id;
        
        if (!forwards[guildId]) {
            forwards[guildId] = {};
        }
        if (!forwards[guildId][targetId]) {
            forwards[guildId][targetId] = [];
        }
        
        if (!forwards[guildId][targetId].includes(sourceChannel.id)) {
            forwards[guildId][targetId].push(sourceChannel.id);
            saveForwards();
        }

        // Send completion
        const resultEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Copy Complete!')
            .setDescription(`Copied from <#${sourceChannel.id}>`)
            .addFields(
                { name: '✅ Copied', value: `${forwarded} messages`, inline: true },
                { name: '❌ Failed', value: `${failed} messages`, inline: true },
                { name: '📁 Files', value: `${totalAttachments} files`, inline: true },
                { name: '🔄 Auto-Forward', value: '✅ New messages will be forwarded!' }
            )
            .setTimestamp();

        await targetChannel.send({ embeds: [resultEmbed] });

        return { 
            success: true, 
            forwarded, 
            failed, 
            total: sortedMessages.length,
            attachments: totalAttachments
        };

    } catch (error) {
        console.error('Copy error:', error);
        return { success: false, message: error.message };
    }
}

// Bot ready
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`🌐 Bot is in ${client.guilds.cache.size} servers`);
    console.log(`📝 Use ${PREFIX}forward <channel_id> to copy messages`);
});

// Handle messages - FIXED DUPLICATE ISSUE
client.on('messageCreate', async message => {
    // Skip bot messages
    if (message.author.bot) return;
    if (!message.guild) return;
    
    // Only handle prefix commands
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // .forward command
    if (command === 'forward') {
        const sourceInput = args[0];
        if (!sourceInput) {
            return message.reply('❌ Please provide a source channel ID!\nUsage: `.forward <channel_id>`');
        }

        const targetChannel = message.channel;
        
        // Find channel anywhere (cross-server)
        const sourceChannel = await findChannelInAllServers(sourceInput);

        if (!sourceChannel) {
            return message.reply('❌ Source channel not found. Make sure:\n1. The ID is correct\n2. The bot is in that server\n3. The bot can see that channel');
        }

        if (sourceChannel.id === targetChannel.id) {
            return message.reply('❌ Source and target channels cannot be the same!');
        }

        // Check permissions
        const botMember = message.guild.members.cache.get(client.user.id);
        if (!targetChannel.permissionsFor(botMember).has(['SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'])) {
            return message.reply('❌ I don\'t have permission to send messages/embeds/files in this channel.');
        }

        await message.reply(`🔄 Starting copy from <#${sourceChannel.id}>...`);

        const result = await copyChannel(sourceChannel, targetChannel);

        if (!result.success) {
            return message.reply(`❌ Failed: ${result.message}`);
        }
    }

    // .forwardstop
    else if (command === 'forwardstop') {
        const targetChannelId = message.channel.id;
        const guildId = message.guild.id;

        if (!forwards[guildId] || !forwards[guildId][targetChannelId]) {
            return message.reply('❌ No forwards are set up for this channel.');
        }

        const count = forwards[guildId][targetChannelId].length;
        delete forwards[guildId][targetChannelId];
        saveForwards();

        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🛑 Forwarding Stopped')
            .setDescription(`Stopped ${count} forward(s) to this channel.`);

        await message.reply({ embeds: [embed] });
    }

    // .forwardstatus
    else if (command === 'forwardstatus') {
        const guildId = message.guild.id;

        if (!forwards[guildId] || Object.keys(forwards[guildId]).length === 0) {
            return message.reply('📭 No active forwards in this server.');
        }

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📋 Active Forwards');

        for (const [targetId, sourceIds] of Object.entries(forwards[guildId])) {
            if (sourceIds.length > 0) {
                const sources = sourceIds.map(id => {
                    // Try to get channel info
                    const channel = client.channels.cache.get(id);
                    return channel ? `<#${id}>` : `Unknown Channel (${id})`;
                }).join(', ');
                embed.addFields({
                    name: `📥 To: <#${targetId}>`,
                    value: `📤 From: ${sources}`,
                    inline: false
                });
            }
        }

        await message.reply({ embeds: [embed] });
    }

    // .servers - Check which servers the bot is in
    else if (command === 'servers') {
        const serverList = client.guilds.cache.map(g => `${g.name} (${g.id})`).join('\n');
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`🌐 Bot is in ${client.guilds.cache.size} servers`)
            .setDescription(serverList || 'No servers')
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }

    // .join - Generate invite link
    else if (command === 'invite') {
        const inviteLink = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=274877990912&scope=bot`;
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📨 Invite Bot to Another Server')
            .setDescription(`[Click here to invite me to another server](${inviteLink})`)
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }
});

// Auto-forward new messages (with duplicate prevention)
const forwardedMessageIds = new Set();

client.on('messageCreate', async message => {
    // Skip bot messages and DMs
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const sourceChannelId = message.channel.id;

    if (!forwards[guildId]) return;

    // Check if this message should be forwarded
    for (const [targetChannelId, sourceIds] of Object.entries(forwards[guildId])) {
        if (sourceIds.includes(sourceChannelId)) {
            const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
            if (!targetChannel) continue;

            // Generate unique ID for this forward to prevent duplicates
            const forwardKey = `${message.id}-${targetChannelId}`;
            if (forwardedMessageIds.has(forwardKey)) {
                continue; // Skip if already forwarded
            }

            try {
                await forwardMessage(message, targetChannel, message.channel);
                forwardedMessageIds.add(forwardKey);
                console.log(`📤 Auto-forwarded message ${message.id} from ${message.channel.name}`);
                
                // Clean up old entries (keep last 1000)
                if (forwardedMessageIds.size > 1000) {
                    const iterator = forwardedMessageIds.values();
                    for (let i = 0; i < 100; i++) {
                        forwardedMessageIds.delete(iterator.next().value);
                    }
                }
            } catch (error) {
                console.error('Auto-forward error:', error);
            }
        }
    }
});

// Clean up invalid forwards periodically
setInterval(() => {
    let changed = false;
    for (const [guildId, targets] of Object.entries(forwards)) {
        for (const [targetId, sourceIds] of Object.entries(targets)) {
            // Check if target channel exists
            const targetChannel = client.channels.cache.get(targetId);
            if (!targetChannel) {
                delete forwards[guildId][targetId];
                changed = true;
                continue;
            }
            
            // Filter out invalid source channels
            const validSources = sourceIds.filter(sourceId => {
                const sourceChannel = client.channels.cache.get(sourceId);
                return sourceChannel !== undefined;
            });
            
            if (validSources.length !== sourceIds.length) {
                forwards[guildId][targetId] = validSources;
                changed = true;
            }
        }
    }
    if (changed) {
        saveForwards();
        console.log('🧹 Cleaned up invalid forwards');
    }
}, 60000); // Check every minute

// Error handling
client.on('error', console.error);
process.on('unhandledRejection', console.error);

// Login
client.login(TOKEN);
