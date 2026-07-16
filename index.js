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

// Track forwarded messages
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

// Forward a message with ALL content properly
async function forwardMessage(message, targetChannel, sourceChannel) {
    try {
        // Check if message has content or attachments
        const hasContent = message.content && message.content.length > 0;
        const hasAttachments = message.attachments.size > 0;
        const hasEmbeds = message.embeds.length > 0;

        if (!hasContent && !hasAttachments && !hasEmbeds) {
            return { success: false, message: 'Empty message' };
        }

        // Prepare files
        const files = [];
        const attachmentLinks = [];

        for (const [, attachment] of message.attachments) {
            files.push({
                attachment: attachment.url,
                name: attachment.name
            });
            attachmentLinks.push(`📎 ${attachment.name}`);
        }

        // If there are attachments, send them with context
        if (hasAttachments) {
            let content = '';
            
            // Add message content if exists
            if (hasContent) {
                content += `**${message.author.username}:** ${message.content}\n`;
            }
            
            // Add attachment info
            if (attachmentLinks.length > 0) {
                content += `\n📁 **${attachmentLinks.length} file(s)**\n`;
                content += attachmentLinks.join('\n');
            }
            
            // Add source info
            content += `\n\n📌 From: <#${sourceChannel.id}>`;
            if (message.guild) {
                content += `\n🏠 Server: ${message.guild.name}`;
            }
            content += `\n👤 Author: ${message.author.toString()}`;
            content += `\n📅 Sent: <t:${Math.floor(message.createdTimestamp / 1000)}:F>`;

            // Send with files
            const messageData = {
                content: content,
                files: files.slice(0, 10)
            };

            await targetChannel.send(messageData);

            // Send remaining files if more than 10
            if (files.length > 10) {
                for (let i = 10; i < files.length; i += 10) {
                    await targetChannel.send({
                        content: `📁 More files (${i + 1}-${Math.min(i + 10, files.length)}):`,
                        files: files.slice(i, i + 10)
                    });
                }
            }

            return { success: true, files: files.length };
        }

        // If no attachments but has content, send as embed
        if (hasContent) {
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setAuthor({
                    name: message.author.tag,
                    iconURL: message.author.displayAvatarURL()
                })
                .setDescription(message.content)
                .addFields(
                    { name: '📌 Source', value: `<#${sourceChannel.id}>`, inline: true },
                    { name: '👤 Author', value: message.author.toString(), inline: true },
                    { name: '📅 Sent', value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`, inline: true }
                )
                .setTimestamp(message.createdAt);

            if (message.guild) {
                embed.addFields({ 
                    name: '🏠 Server', 
                    value: message.guild.name,
                    inline: true 
                });
            }

            // Copy original embeds if any
            if (message.embeds.length > 0) {
                // Just send the original embed
                await targetChannel.send({
                    content: `📨 **Forwarded from <#${sourceChannel.id}>**`,
                    embeds: message.embeds
                });
                return { success: true };
            }

            await targetChannel.send({ embeds: [embed] });
            return { success: true };
        }

        return { success: false, message: 'No content to forward' };

    } catch (error) {
        console.error('Forward error:', error);
        return { success: false, error: error.message };
    }
}

// Copy ALL messages from a channel
async function copyAllMessages(sourceChannel, targetChannel) {
    try {
        let totalCopied = 0;
        let totalFailed = 0;
        let totalFiles = 0;
        let lastMessageId = null;
        let hasMore = true;
        let batchCount = 0;
        let totalMessages = 0;

        // Check if we can access the channel
        try {
            const testFetch = await sourceChannel.messages.fetch({ limit: 1 });
            if (testFetch.size === 0) {
                return { success: false, message: 'No messages found in source channel.' };
            }
        } catch (error) {
            return { success: false, message: 'Cannot access source channel. Bot may not be in that server or lacks permissions.' };
        }

        // Send initial status
        await targetChannel.send(`🔄 **Starting FULL COPY from <#${sourceChannel.id}>**`);
        await targetChannel.send(`⏳ This will copy ALL messages. It may take a while...`);

        // Keep fetching until no more messages
        while (hasMore) {
            batchCount++;
            let options = { limit: 100 };
            
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
                
                // Status update every 5 batches
                if (batchCount % 5 === 0) {
                    await targetChannel.send(`⏳ Progress: Copied ${totalMessages} messages so far...`);
                }

                // Process each message
                for (const message of sortedMessages) {
                    lastMessageId = message.id;
                    totalFiles += message.attachments.size;
                    
                    const result = await forwardMessage(message, targetChannel, sourceChannel);
                    
                    if (result.success) {
                        totalCopied++;
                    } else {
                        totalFailed++;
                    }

                    // Rate limit protection
                    await new Promise(resolve => setTimeout(resolve, 200));
                }

                // Check if we reached the end
                if (messages.size < 100) {
                    hasMore = false;
                }

                // Save progress
                if (batchCount % 10 === 0) {
                    saveForwards();
                }

            } catch (error) {
                console.error('Error fetching messages:', error);
                hasMore = false;
                break;
            }
        }

        // Save forward configuration
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

        await targetChannel.send({ embeds: [completionEmbed] });

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

// Bot ready
client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`🌐 Bot is in ${client.guilds.cache.size} servers`);
    console.log(`📝 Use ${PREFIX}forwardall <channel_id> to copy EVERYTHING`);
    console.log(`👥 Anyone in the server can use this command!`);
});

// Handle commands - Available to EVERYONE in the server
client.on('messageCreate', async message => {
    // Only skip bots, allow all users
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // .forwardall - Copy ALL messages (anyone can use)
    if (command === 'forwardall') {
        const sourceInput = args[0];
        if (!sourceInput) {
            return message.reply('❌ Please provide a source channel ID!\nUsage: `.forwardall <channel_id>`\n\nGet the channel ID by right-clicking the channel and selecting "Copy ID" (Developer Mode must be enabled)');
        }

        const targetChannel = message.channel;
        const sourceChannel = await findChannelInAllServers(sourceInput);

        if (!sourceChannel) {
            return message.reply('❌ Source channel not found. Make sure:\n1. The ID is correct\n2. The bot is in that server\n3. The bot can see that channel');
        }

        if (sourceChannel.id === targetChannel.id) {
            return message.reply('❌ Source and target channels cannot be the same!');
        }

        // Check bot permissions
        const botMember = message.guild.members.cache.get(client.user.id);
        if (!targetChannel.permissionsFor(botMember).has(['SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'])) {
            return message.reply('❌ I don\'t have permission to send messages/embeds/files in this channel.');
        }

        await message.reply(`🔄 **Starting FULL COPY** from <#${sourceChannel.id}>... This will copy EVERY message. It may take a while!`);

        const result = await copyAllMessages(sourceChannel, targetChannel);

        if (!result.success) {
            return message.reply(`❌ Failed: ${result.message}`);
        }
    }

    // .forward - Copy limited messages (anyone can use)
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

        await message.reply(`🔄 Copying up to ${limit} messages from <#${sourceChannel.id}>...`);

        // Copy limited messages
        try {
            const messages = await sourceChannel.messages.fetch({ limit: Math.min(limit, 1000) });
            let copied = 0;
            let failed = 0;
            let files = 0;

            for (const msg of messages.values()) {
                files += msg.attachments.size;
                const result = await forwardMessage(msg, targetChannel, sourceChannel);
                if (result.success) copied++;
                else failed++;
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            await message.reply(`✅ Copied ${copied} messages with ${files} files from <#${sourceChannel.id}>`);
        } catch (error) {
            await message.reply(`❌ Failed: ${error.message}`);
        }
    }

    // .forwardstop - Stop forwarding (anyone can use)
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

    // .forwardstatus - Check status (anyone can use)
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

    // .servers - See servers (anyone can use)
    else if (command === 'servers') {
        const serverList = client.guilds.cache.map(g => `• ${g.name} (${g.id})`).join('\n');
        await message.reply(`🌐 **Bot is in ${client.guilds.cache.size} servers:**\n\n${serverList}`);
    }

    // .invite - Get invite link (anyone can use)
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
