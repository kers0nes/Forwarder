const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
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
    ]
});

// Track forwarded messages to prevent duplicates
const forwardedMessageIds = new Set();

// Save data
function saveForwards() {
    fs.writeFileSync(forwardsPath, JSON.stringify(forwards, null, 2));
}

// Helper: Find channel anywhere
async function findChannelInAllServers(channelId) {
    try {
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

// Forward a single message with all content
async function forwardMessage(message, targetChannel, sourceChannel) {
    try {
        // Create embed with full content
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
            .setFooter({ text: `Original ID: ${message.id}` });

        // Add source server info
        if (message.guild) {
            embed.addFields({ 
                name: '🏠 Server', 
                value: message.guild.name,
                inline: true 
            });
        }

        // Add reactions info if any
        if (message.reactions.cache.size > 0) {
            const reactions = message.reactions.cache.map(r => `${r.emoji} ${r.count}`).join(' ');
            embed.addFields({ name: '💭 Reactions', value: reactions || 'None' });
        }

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

// Copy ALL messages from a channel
async function copyAllMessages(sourceChannel, targetChannel, statusChannel) {
    try {
        let totalCopied = 0;
        let totalFailed = 0;
        let totalFiles = 0;
        let lastMessageId = null;
        let hasMore = true;
        let batchCount = 0;
        let totalMessages = 0;

        // Get initial count
        try {
            const initialFetch = await sourceChannel.messages.fetch({ limit: 1 });
            if (initialFetch.size === 0) {
                return { success: false, message: 'No messages found in source channel.' };
            }
        } catch (error) {
            return { success: false, message: 'Cannot access source channel. Bot may not be in that server.' };
        }

        // Send initial status
        await statusChannel.send(`🔄 **Starting FULL COPY from <#${sourceChannel.id}>**`);
        await statusChannel.send(`⏳ This will copy ALL messages. It may take a while...`);

        // Keep fetching until no more messages
        while (hasMore) {
            batchCount++;
            let options = { limit: 100 };
            
            // If we have a last message ID, fetch older messages
            if (lastMessageId) {
                options.before = lastMessageId;
            }

            try {
                const messages = await sourceChannel.messages.fetch(options);
                
                if (messages.size === 0) {
                    hasMore = false;
                    break;
                }

                totalMessages += messages.size;
                const sortedMessages = Array.from(messages.values()).reverse();
                
                // Send status update every 5 batches
                if (batchCount % 5 === 0) {
                    await statusChannel.send(`⏳ Copied ${totalMessages} messages so far... Continuing...`);
                }

                // Process each message in this batch
                for (const message of sortedMessages) {
                    lastMessageId = message.id;
                    
                    // Count files
                    totalFiles += message.attachments.size;
                    
                    // Forward the message
                    const result = await forwardMessage(message, targetChannel, sourceChannel);
                    
                    if (result.success) {
                        totalCopied++;
                    } else {
                        totalFailed++;
                    }

                    // Rate limit protection
                    await new Promise(resolve => setTimeout(resolve, 300));
                }

                // Check if we got less than 100 messages (means we reached the end)
                if (messages.size < 100) {
                    hasMore = false;
                }

                // Save progress every 10 batches
                if (batchCount % 10 === 0) {
                    saveForwards();
                }

            } catch (error) {
                console.error('Error fetching messages:', error);
                hasMore = false;
                break;
            }
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

        // Send completion message
        const completionEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ FULL COPY COMPLETE!')
            .setDescription(`Successfully copied ALL messages from <#${sourceChannel.id}>`)
            .addFields(
                { name: '📊 Total Messages', value: `${totalCopied + totalFailed}`, inline: true },
                { name: '✅ Copied', value: `${totalCopied} messages`, inline: true },
                { name: '❌ Failed', value: `${totalFailed} messages`, inline: true },
                { name: '📁 Total Files', value: `${totalFiles} files`, inline: true },
                { name: '📦 Batches', value: `${batchCount} batches`, inline: true },
                { name: '🔄 Auto-Forward', value: '✅ New messages will be forwarded!' }
            )
            .setTimestamp();

        await statusChannel.send({ embeds: [completionEmbed] });

        return { 
            success: true, 
            total: totalCopied + totalFailed,
            copied: totalCopied,
            failed: totalFailed,
            files: totalFiles,
            batches: batchCount
        };

    } catch (error) {
        console.error('Copy error:', error);
        return { success: false, message: error.message };
    }
}

// Command to copy specific number of messages
async function copyMessages(sourceChannel, targetChannel, limit = 100) {
    try {
        const messages = await sourceChannel.messages.fetch({ limit: Math.min(limit, 1000) });
        
        if (messages.size === 0) {
            return { success: false, message: 'No messages found.' };
        }

        const sortedMessages = Array.from(messages.values()).reverse();
        let copied = 0;
        let failed = 0;
        let files = 0;

        for (const message of sortedMessages) {
            files += message.attachments.size;
            const result = await forwardMessage(message, targetChannel, sourceChannel);
            if (result.success) {
                copied++;
            } else {
                failed++;
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        return { success: true, copied, failed, total: sortedMessages.length, files };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

// Bot ready
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`🌐 Bot is in ${client.guilds.cache.size} servers`);
    console.log(`📝 Use ${PREFIX}forwardall <channel_id> to copy EVERYTHING`);
});

// Handle commands
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // .forwardall - Copy ALL messages
    if (command === 'forwardall') {
        const sourceInput = args[0];
        if (!sourceInput) {
            return message.reply('❌ Please provide a source channel ID!\nUsage: `.forwardall <channel_id>`');
        }

        const targetChannel = message.channel;
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

        await message.reply(`🔄 **Starting FULL COPY** from <#${sourceChannel.id}>... This will copy EVERY message. It may take a while!`);

        const result = await copyAllMessages(sourceChannel, targetChannel, targetChannel);

        if (!result.success) {
            return message.reply(`❌ Failed: ${result.message}`);
        }
    }

    // .forward - Copy limited messages
    else if (command === 'forward') {
        const sourceInput = args[0];
        const limit = parseInt(args[1]) || 100;
        
        if (!sourceInput) {
            return message.reply('❌ Please provide a source channel ID!\nUsage: `.forward <channel_id> [limit]`');
        }

        const targetChannel = message.channel;
        const sourceChannel = await findChannelInAllServers(sourceInput);

        if (!sourceChannel) {
            return message.reply('❌ Source channel not found.');
        }

        if (sourceChannel.id === targetChannel.id) {
            return message.reply('❌ Source and target channels cannot be the same!');
        }

        await message.reply(`🔄 Copying ${limit} messages from <#${sourceChannel.id}>...`);

        const result = await copyMessages(sourceChannel, targetChannel, limit);

        if (!result.success) {
            return message.reply(`❌ Failed: ${result.message}`);
        }

        await message.reply(`✅ Copied ${result.copied} messages with ${result.files} files from <#${sourceChannel.id}>`);
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

        await message.reply(`🛑 Stopped ${count} forward(s) to this channel.`);
    }

    // .forwardstatus
    else if (command === 'forwardstatus') {
        const guildId = message.guild.id;

        if (!forwards[guildId] || Object.keys(forwards[guildId]).length === 0) {
            return message.reply('📭 No active forwards in this server.');
        }

        let status = '📋 **Active Forwards:**\n\n';
        for (const [targetId, sourceIds] of Object.entries(forwards[guildId])) {
            if (sourceIds.length > 0) {
                const sources = sourceIds.map(id => `<#${id}>`).join(', ');
                status += `📥 To: <#${targetId}>\n📤 From: ${sources}\n\n`;
            }
        }

        await message.reply(status);
    }

    // .servers
    else if (command === 'servers') {
        const serverList = client.guilds.cache.map(g => `• ${g.name} (${g.id})`).join('\n');
        await message.reply(`🌐 **Bot is in ${client.guilds.cache.size} servers:**\n\n${serverList}`);
    }

    // .invite
    else if (command === 'invite') {
        const inviteLink = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=274877990912&scope=bot`;
        await message.reply(`📨 **Invite me to another server:**\n${inviteLink}`);
    }
});

// Auto-forward new messages
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const sourceChannelId = message.channel.id;

    if (!forwards[guildId]) return;

    for (const [targetChannelId, sourceIds] of Object.entries(forwards[guildId])) {
        if (sourceIds.includes(sourceChannelId)) {
            const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
            if (!targetChannel) continue;

            const forwardKey = `${message.id}-${targetChannelId}`;
            if (forwardedMessageIds.has(forwardKey)) {
                continue;
            }

            try {
                await forwardMessage(message, targetChannel, message.channel);
                forwardedMessageIds.add(forwardKey);
                console.log(`📤 Auto-forwarded message ${message.id}`);
                
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

// Clean up invalid forwards
setInterval(() => {
    let changed = false;
    for (const [guildId, targets] of Object.entries(forwards)) {
        for (const [targetId, sourceIds] of Object.entries(targets)) {
            const targetChannel = client.channels.cache.get(targetId);
            if (!targetChannel) {
                delete forwards[guildId][targetId];
                changed = true;
                continue;
            }
            
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
}, 60000);

// Error handling
client.on('error', console.error);
process.on('unhandledRejection', console.error);

// Login
client.login(TOKEN);
