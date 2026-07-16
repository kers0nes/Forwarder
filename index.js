const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
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

// Save data
function saveForwards() {
    fs.writeFileSync(forwardsPath, JSON.stringify(forwards, null, 2));
}

// Helper: Get channel from ID or mention
async function getChannel(input, guild) {
    // Direct ID
    if (/^\d+$/.test(input)) {
        try {
            const channel = await client.channels.fetch(input);
            if (channel && channel.guildId === guild.id && channel.isTextBased()) {
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
            if (channel && channel.guildId === guild.id && channel.isTextBased()) {
                return channel;
            }
        } catch (e) {}
        return null;
    }
    
    return null;
}

// Forward a single message with all attachments
async function forwardMessage(message, targetChannel, sourceChannel) {
    try {
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

        // Process all attachments
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
            embed.addFields({ 
                name: `📎 Files`, 
                value: otherAttachments.join('\n').substring(0, 1024)
            });
        }

        // Send message with attachments
        const messageData = { embeds: [embed] };
        if (files.length > 0) {
            messageData.files = files.slice(0, 10); // Discord max 10 files per message
        }

        await targetChannel.send(messageData);
        
        // If there are more than 10 files, send a follow-up
        if (files.length > 10) {
            await targetChannel.send(`⚠️ ${files.length - 10} more files were not included due to Discord's 10 file limit. Check the source channel for all files.`);
        }

        return { success: true };

    } catch (error) {
        console.error('Forward error:', error);
        return { success: false, error: error.message };
    }
}

// Copy entire channel
async function copyChannel(sourceChannel, targetChannel, limit = 100) {
    try {
        const messages = await sourceChannel.messages.fetch({ limit: Math.min(limit, 100) });
        
        if (messages.size === 0) {
            return { success: false, message: 'No messages found in source channel.' };
        }

        const sortedMessages = Array.from(messages.values()).reverse();
        let forwarded = 0;
        let failed = 0;
        let totalAttachments = 0;

        // Count total attachments
        for (const msg of sortedMessages) {
            totalAttachments += msg.attachments.size;
        }

        // Send start message
        const startEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('🔄 Starting Copy')
            .setDescription(`Copying ${sortedMessages.length} messages from <#${sourceChannel.id}>`)
            .addFields(
                { name: '📁 Files', value: `${totalAttachments} attachments`, inline: true },
                { name: '📝 Messages', value: `${sortedMessages.length}`, inline: true }
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

            // Show progress every 10 messages
            if ((i + 1) % 10 === 0) {
                await targetChannel.send(`⏳ Progress: ${i + 1}/${sortedMessages.length} messages copied...`);
            }

            // Rate limit protection
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

        // Send completion message
        const resultEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Copy Complete!')
            .setDescription(`Successfully copied from <#${sourceChannel.id}>`)
            .addFields(
                { name: '✅ Copied', value: `${forwarded} messages`, inline: true },
                { name: '❌ Failed', value: `${failed} messages`, inline: true },
                { name: '📁 Total Files', value: `${totalAttachments} files`, inline: true },
                { name: '🔄 Auto-Forward', value: '✅ New messages will be forwarded automatically!' }
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

// Command definitions for slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('forward')
        .setDescription('Copy everything from source channel to this channel')
        .addStringOption(option =>
            option.setName('source')
                .setDescription('Source channel ID or mention')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription('Number of messages to copy (1-100)')
                .setMinValue(1)
                .setMaxValue(100)),
    
    new SlashCommandBuilder()
        .setName('forwardstop')
        .setDescription('Stop auto-forwarding to this channel'),
    
    new SlashCommandBuilder()
        .setName('forwardstatus')
        .setDescription('View active forwards in this server'),
];

// Register commands
const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
    try {
        console.log('🔄 Registering commands...');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands.map(cmd => cmd.toJSON()) }
        );
        console.log('✅ Commands registered!');
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// Bot ready
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`🌐 Ready for all servers!`);
    await registerCommands();
});

// Handle commands
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // .forward <source_channel_id>
    if (command === 'forward') {
        const sourceInput = args[0];
        if (!sourceInput) {
            return message.reply('❌ Please provide a source channel ID!\nUsage: `.forward <channel_id>`');
        }

        const targetChannel = message.channel;
        const sourceChannel = await getChannel(sourceInput, message.guild);

        if (!sourceChannel) {
            return message.reply('❌ Source channel not found. Please provide a valid channel ID or mention.');
        }

        if (sourceChannel.id === targetChannel.id) {
            return message.reply('❌ Source and target channels cannot be the same!');
        }

        // Check permissions
        const botMember = message.guild.members.cache.get(client.user.id);
        if (!targetChannel.permissionsFor(botMember).has(['SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'])) {
            return message.reply('❌ I don\'t have permission to send messages/embeds/files in this channel.');
        }

        await message.reply(`🔄 Starting copy from <#${sourceChannel.id}>... This may take a moment.`);

        // Start copying
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
                const sources = sourceIds.map(id => `<#${id}>`).join(', ');
                embed.addFields({
                    name: `📥 To: <#${targetId}>`,
                    value: `📤 From: ${sources}`,
                    inline: false
                });
            }
        }

        await message.reply({ embeds: [embed] });
    }
});

// Slash command handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'forward') {
        await interaction.deferReply();

        const sourceInput = interaction.options.getString('source');
        const limit = interaction.options.getInteger('limit') || 100;
        const targetChannel = interaction.channel;
        const sourceChannel = await getChannel(sourceInput, interaction.guild);

        if (!sourceChannel) {
            return interaction.editReply('❌ Source channel not found.');
        }

        if (sourceChannel.id === targetChannel.id) {
            return interaction.editReply('❌ Source and target channels cannot be the same!');
        }

        const result = await copyChannel(sourceChannel, targetChannel, limit);
        
        if (!result.success) {
            return interaction.editReply(`❌ Failed: ${result.message}`);
        }
    }

    else if (commandName === 'forwardstop') {
        const targetChannelId = interaction.channelId;
        const guildId = interaction.guildId;

        if (!forwards[guildId] || !forwards[guildId][targetChannelId]) {
            return interaction.reply({ content: '❌ No forwards for this channel.', ephemeral: true });
        }

        delete forwards[guildId][targetChannelId];
        saveForwards();
        await interaction.reply('✅ Forwarding stopped for this channel.');
    }

    else if (commandName === 'forwardstatus') {
        const guildId = interaction.guildId;

        if (!forwards[guildId] || Object.keys(forwards[guildId]).length === 0) {
            return interaction.reply({ content: '📭 No active forwards.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📋 Active Forwards');

        for (const [targetId, sourceIds] of Object.entries(forwards[guildId])) {
            if (sourceIds.length > 0) {
                embed.addFields({
                    name: `📥 To: <#${targetId}>`,
                    value: `📤 From: ${sourceIds.map(id => `<#${id}>`).join(', ')}`,
                    inline: false
                });
            }
        }

        await interaction.reply({ embeds: [embed] });
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

            try {
                await forwardMessage(message, targetChannel, message.channel);
                console.log(`📤 Auto-forwarded message from ${message.channel.name}`);
            } catch (error) {
                console.error('Auto-forward error:', error);
            }
        }
    }
});

// Error handling
client.on('error', console.error);
process.on('unhandledRejection', console.error);

// Login
client.login(TOKEN);
