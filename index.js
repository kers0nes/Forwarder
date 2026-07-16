const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Data storage for forwards
const forwardsPath = path.join(__dirname, 'forwards.json');
let forwards = {};

if (fs.existsSync(forwardsPath)) {
    forwards = JSON.parse(fs.readFileSync(forwardsPath, 'utf8'));
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

// Save forwards data
function saveForwards() {
    fs.writeFileSync(forwardsPath, JSON.stringify(forwards, null, 2));
}

// Helper: Get channel from input
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

// Forward message with all attachments
async function forwardMessage(message, targetChannel, sourceChannel) {
    try {
        // Create embed
        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setAuthor({
                name: message.author.tag,
                iconURL: message.author.displayAvatarURL()
            })
            .setDescription(message.content || '*No text content*')
            .addFields(
                { 
                    name: '📌 Source Channel', 
                    value: `<#${sourceChannel.id}>`, 
                    inline: true 
                },
                { 
                    name: '👤 Author', 
                    value: message.author.toString(), 
                    inline: true 
                },
                { 
                    name: '📅 Sent', 
                    value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`, 
                    inline: true 
                }
            )
            .setTimestamp(message.createdAt)
            .setFooter({ text: `Message ID: ${message.id}` });

        // Handle attachments
        let files = [];
        let attachmentLinks = [];

        // Process attachments
        for (const [, attachment] of message.attachments) {
            // If it's an image, we can re-upload it
            if (attachment.contentType?.startsWith('image/')) {
                files.push({
                    attachment: attachment.url,
                    name: attachment.name
                });
            } else {
                // For other files, add as links
                attachmentLinks.push(`[${attachment.name}](${attachment.url})`);
            }
        }

        // Add attachment links to embed
        if (attachmentLinks.length > 0) {
            const links = attachmentLinks.join('\n');
            embed.addFields({ 
                name: `📎 Other Attachments`, 
                value: links.length > 1024 ? links.substring(0, 1020) + '...' : links
            });
        }

        // Check if there's an image to send
        let messageData = { embeds: [embed] };
        
        if (files.length > 0) {
            messageData.files = files;
        }

        // Send to target channel
        await targetChannel.send(messageData);
        
        return { success: true };

    } catch (error) {
        console.error(`Failed to forward message:`, error);
        return { success: false, error: error.message };
    }
}

// Command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('forward')
        .setDescription('Forward messages from source channel to this channel')
        .addStringOption(option =>
            option.setName('source')
                .setDescription('Source channel ID or mention')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription('Number of recent messages to forward (1-100)')
                .setMinValue(1)
                .setMaxValue(100))
        .addBooleanOption(option =>
            option.setName('continuous')
                .setDescription('Continuously forward new messages?')),
    
    new SlashCommandBuilder()
        .setName('forwardstop')
        .setDescription('Stop forwarding to this channel'),
    
    new SlashCommandBuilder()
        .setName('forwardstatus')
        .setDescription('View active forwards in this server'),
];

// Register global commands
const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
    try {
        console.log('🔄 Registering slash commands...');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands.map(cmd => cmd.toJSON()) }
        );
        console.log('✅ Commands registered globally!');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
}

// Event: Ready
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    console.log(`🌐 Bot is ready for all servers!`);
    await registerCommands();
});

// Event: Interaction Create
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // FORWARD COMMAND
    if (commandName === 'forward') {
        await interaction.deferReply({ ephemeral: false });

        const sourceInput = interaction.options.getString('source');
        const limit = interaction.options.getInteger('limit') || 10;
        const continuous = interaction.options.getBoolean('continuous') || false;

        // Get source channel
        const sourceChannel = await getChannel(sourceInput, interaction.guild);
        if (!sourceChannel) {
            return interaction.editReply({
                content: '❌ Source channel not found. Please provide a valid channel ID or mention.'
            });
        }

        // Get target channel (current channel)
        const targetChannel = interaction.channel;
        if (!targetChannel) {
            return interaction.editReply({
                content: '❌ Target channel not found.'
            });
        }

        // Check if same channel
        if (sourceChannel.id === targetChannel.id) {
            return interaction.editReply({
                content: '❌ Source and target channels cannot be the same!'
            });
        }

        // Check permissions
        const botMember = interaction.guild.members.cache.get(client.user.id);
        if (!targetChannel.permissionsFor(botMember).has(['SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'])) {
            return interaction.editReply({
                content: '❌ I don\'t have permission to send messages/embeds/files in this channel.'
            });
        }

        // Fetch messages from source
        const messages = await sourceChannel.messages.fetch({ limit: limit });
        if (messages.size === 0) {
            return interaction.editReply({
                content: `❌ No messages found in <#${sourceChannel.id}>.`
            });
        }

        // Sort messages chronologically
        const sortedMessages = Array.from(messages.values()).reverse();
        
        // Send initial message
        await interaction.editReply({
            content: `🔄 Forwarding ${sortedMessages.length} messages from <#${sourceChannel.id}> to <#${targetChannel.id}>...`
        });

        let forwarded = 0;
        let failed = 0;

        // Forward each message
        for (const message of sortedMessages) {
            const result = await forwardMessage(message, targetChannel, sourceChannel);
            if (result.success) {
                forwarded++;
            } else {
                failed++;
            }
            // Delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Save continuous forward
        if (continuous) {
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
        }

        // Send completion message
        const resultEmbed = new EmbedBuilder()
            .setColor(continuous ? 0x00FF00 : 0x0099FF)
            .setTitle(continuous ? '✅ Continuous Forwarding Started' : '✅ Forward Complete')
            .setDescription(`Forwarded messages from <#${sourceChannel.id}> to <#${targetChannel.id}>`)
            .addFields(
                { name: '✅ Forwarded', value: `${forwarded} messages`, inline: true },
                { name: '❌ Failed', value: `${failed} messages`, inline: true },
                { name: '📊 Total', value: `${sortedMessages.length} messages`, inline: true }
            )
            .setTimestamp();

        if (continuous) {
            resultEmbed.addFields({
                name: '🔄 Continuous Mode',
                value: '✅ New messages will be forwarded automatically with all attachments'
            });
        }

        await interaction.editReply({
            content: null,
            embeds: [resultEmbed]
        });
    }

    // FORWARDSTOP COMMAND
    else if (commandName === 'forwardstop') {
        const targetChannelId = interaction.channelId;
        const guildId = interaction.guildId;

        if (!forwards[guildId] || !forwards[guildId][targetChannelId]) {
            return interaction.reply({
                content: '❌ No forwards are set up for this channel.',
                ephemeral: true
            });
        }

        const count = forwards[guildId][targetChannelId].length;
        delete forwards[guildId][targetChannelId];
        saveForwards();

        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🛑 Forwarding Stopped')
            .setDescription(`Stopped ${count} forward(s) to <#${targetChannelId}>.`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }

    // FORWARDSTATUS COMMAND
    else if (commandName === 'forwardstatus') {
        const guildId = interaction.guildId;

        if (!forwards[guildId] || Object.keys(forwards[guildId]).length === 0) {
            return interaction.reply({
                content: '📭 No active forwards in this server.',
                ephemeral: true
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📋 Active Forwards')
            .setDescription('List of all active forwards in this server.')
            .setTimestamp();

        let hasForwards = false;
        for (const [targetId, sourceIds] of Object.entries(forwards[guildId])) {
            if (sourceIds.length > 0) {
                hasForwards = true;
                const sources = sourceIds.map(id => `<#${id}>`).join(', ');
                embed.addFields({
                    name: `📥 To: <#${targetId}>`,
                    value: `📤 From: ${sources}`,
                    inline: false
                });
            }
        }

        if (!hasForwards) {
            embed.setDescription('No active forwards found.');
        }

        await interaction.reply({ embeds: [embed] });
    }
});

// Event: Message Create (for continuous forwarding)
client.on('messageCreate', async message => {
    // Ignore bot messages and DMs
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const sourceChannelId = message.channel.id;

    // Check if this channel is being forwarded
    if (!forwards[guildId]) return;

    let forwardedCount = 0;
    for (const [targetChannelId, sourceIds] of Object.entries(forwards[guildId])) {
        if (sourceIds.includes(sourceChannelId)) {
            const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
            if (!targetChannel) {
                // Remove invalid target channel
                delete forwards[guildId][targetChannelId];
                saveForwards();
                continue;
            }

            try {
                // Forward the new message
                await forwardMessage(message, targetChannel, message.channel);
                forwardedCount++;
            } catch (error) {
                console.error(`Failed to forward message:`, error);
            }
        }
    }

    if (forwardedCount > 0) {
        console.log(`📤 Forwarded new message from ${message.channel.name} to ${forwardedCount} channel(s)`);
    }
});

// Error handling
client.on('error', error => {
    console.error('Client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error);
});

// Login
client.login(TOKEN);
