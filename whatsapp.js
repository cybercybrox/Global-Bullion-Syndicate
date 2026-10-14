'use strict';

const path = require('node:path');
const fs = require('node:fs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');

// ============================================
// GLOBAL BULLION SYNDICATE — CONFIGURATION
// ============================================

// Configure this in Render Environment Variables.
// Use your international WhatsApp number with digits only.
const PHONE_NUMBER = (
    process.env.WHATSAPP_PHONE_NUMBER || ''
).replace(/\D/g, '');

// Configure this only when you have selected a
// suitable persistent storage location on Render.
const AUTH_DIR = path.resolve(
    process.env.BAILEYS_AUTH_DIR || './baileys_auth'
);

const INITIAL_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

// ============================================
// VALIDATE CONFIGURATION
// ============================================

if (!PHONE_NUMBER) {
    throw new Error(
        'Missing WHATSAPP_PHONE_NUMBER. ' +
        'Add your international WhatsApp number ' +
        'in Render Environment Variables.'
    );
}

if (!/^\d{8,15}$/.test(PHONE_NUMBER)) {
    throw new Error(
        'Invalid WhatsApp number. Use the full ' +
        'international number with its country code.'
    );
}

// ============================================
// PREPARE AUTHENTICATION DIRECTORY
// ============================================

try {
    fs.mkdirSync(AUTH_DIR, {
        recursive: true
    });

    fs.accessSync(
        AUTH_DIR,
        fs.constants.R_OK | fs.constants.W_OK
    );
} catch (error) {
    throw new Error(
        `Cannot access authentication directory: ${error.message}`
    );
}

// ============================================
// APPLICATION STATE
// ============================================

let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connecting = false;
let shuttingDown = false;

// ============================================
// CONNECTION UTILITIES
// ============================================

function getDisconnectStatusCode(error) {
    return (
        error?.output?.statusCode ??
        error?.statusCode ??
        null
    );
}

function scheduleReconnect(reason) {
    if (shuttingDown || reconnectTimer) {
        return;
    }

    reconnectAttempts += 1;

    // Gradually increase the delay after repeated failures.
    // The delay never exceeds 30 seconds.
    const exponent = Math.min(
        reconnectAttempts - 1,
        4
    );

    const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * (2 ** exponent),
        MAX_RECONNECT_DELAY_MS
    );

    console.warn(
        `[RECONNECT] ${reason || 'Connection closed'}. ` +
        `Retrying in ${Math.round(delay / 1000)} seconds. ` +
        `Attempt ${reconnectAttempts}.`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectToWhatsApp();
    }, delay);
}

// ============================================
// START WHATSAPP CONNECTION
// ============================================

async function connectToWhatsApp() {
    if (
        shuttingDown ||
        connecting ||
        activeSocket
    ) {
        return;
    }

    connecting = true;

    try {
        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(AUTH_DIR);

        let pairingCodeRequested = false;

        const sock = makeWASocket({
            auth: state,

            // We want a pairing code, not a displayed QR.
            printQRInTerminal: false,

            // Do not unnecessarily mark the account online.
            markOnlineOnConnect: false
        });

        activeSocket = sock;

        // ========================================
        // SAVE AUTHENTICATION CHANGES
        // ========================================

        sock.ev.on('creds.update', () => {
            saveCreds().catch((error) => {
                console.error(
                    '[AUTH SAVE ERROR]',
                    error.message
                );
            });
        });

        // ========================================
        // CONNECTION EVENTS AND PAIRING CODE
        // ========================================

        sock.ev.on(
            'connection.update',
            async (update) => {
                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update;

                // Baileys emits a QR field as part of its
                // connection lifecycle. We use that event
                // to request a pairing code instead of
                // displaying the QR itself.

                if (
                    qr &&
                    !state.creds.registered &&
                    !pairingCodeRequested
                ) {
                    pairingCodeRequested = true;

                    try {
                        console.log('');
                        console.log(
                            '========================================'
                        );
                        console.log(
                            ' GLOBAL BULLION SYNDICATE'
                        );
                        console.log(
                            ' WHATSAPP PHONE-NUMBER PAIRING'
                        );
                        console.log(
                            '========================================'
                        );

                        const code =
                            await sock.requestPairingCode(
                                PHONE_NUMBER
                            );

                        console.log(
                            `Pairing code: ${code}`
                        );

                        console.log('');
                        console.log(
                            'On your phone:'
                        );
                        console.log(
                            '1. Open WhatsApp.'
                        );
                        console.log(
                            '2. Open Linked Devices.'
                        );
                        console.log(
                            '3. Tap Link a Device.'
                        );
                        console.log(
                            '4. Choose Link with phone number instead.'
                        );
                        console.log(
                            '5. Enter the pairing code above.'
                        );

                        console.log('');
                        console.log(
                            'Keep this code private.'
                        );

                        console.log(
                            '========================================'
                        );
                        console.log('');

                    } catch (error) {
                        pairingCodeRequested = false;

                        console.error(
                            '[PAIRING CODE ERROR]',
                            error.stack ||
                            error.message ||
                            error
                        );
                    }
                }

                // ====================================
                // CONNECTING
                // ====================================

                if (connection === 'connecting') {
                    console.log(
                        '[STATE] Connecting to WhatsApp...'
                    );
                }

                // ====================================
                // CONNECTED
                // ====================================

                if (connection === 'open') {
                    reconnectAttempts = 0;

                    console.log('');
                    console.log(
                        '========================================'
                    );
                    console.log(
                        ' GLOBAL BULLION SYNDICATE'
                    );
                    console.log(
                        ' WHATSAPP CONNECTED'
                    );
                    console.log(
                        '========================================'
                    );
                    console.log(
                        'Connection: Ready'
                    );
                    console.log(
                        'Authentication directory:',
                        AUTH_DIR
                    );
                    console.log(
                        'Private-chat test command: !ping'
                    );
                    console.log(
                        '========================================'
                    );
                    console.log('');
                }

                // ====================================
                // DISCONNECTED
                // ====================================

                if (connection === 'close') {
                    // Ignore late events from an older socket.
                    if (sock !== activeSocket) {
                        return;
                    }

                    activeSocket = null;

                    const error = lastDisconnect?.error;

                    const statusCode =
                        getDisconnectStatusCode(error);

                    console.warn(
                        '[DISCONNECTED]',
                        error?.message ||
                        'Connection closed'
                    );

                    if (statusCode !== null) {
                        console.warn(
                            '[DISCONNECT STATUS]',
                            statusCode
                        );
                    }

                    // Do not endlessly retry a logged-out session.
                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {
                        console.error(
                            '[AUTH] WhatsApp logged out this linked device.'
                        );

                        console.error(
                            '[AUTH] Check your account and saved session.'
                        );

                        console.error(
                            '[AUTH] Only clear saved authentication data ' +
                            'if you deliberately intend to pair again.'
                        );

                        return;
                    }

                    // Try to restore the connection for other failures.
                    scheduleReconnect(
                        error?.message ||
                        'WhatsApp connection closed'
                    );
                }
            }
        );

        // ========================================
        // PRIVATE-CHAT TEST COMMAND
        // ========================================

        // This command lets you verify that the bot can
        // receive a message and send a reply.
        //
        // It responds only to !ping or /ping in private
        // chats. It does not reply to group messages.

        sock.ev.on(
            'messages.upsert',
            async ({ messages, type }) => {
                if (type !== 'notify') {
                    return;
                }

                for (const message of messages || []) {
                    if (
                        !message?.message ||
                        message.key?.fromMe
                    ) {
                        continue;
                    }

                    const remoteJid =
                        message.key?.remoteJid;

                    if (
                        !remoteJid ||
                        remoteJid === 'status@broadcast' ||
                        remoteJid.endsWith('@g.us')
                    ) {
                        continue;
                    }

                    const text = (
                        message.message.conversation ||
                        message.message
                            .extendedTextMessage?.text ||
                        ''
                    ).trim().toLowerCase();

                    if (
                        text !== '!ping' &&
                        text !== '/ping'
                    ) {
                        continue;
                    }

                    try {
                        await sock.sendMessage(
                            remoteJid,
                            {
                                text:
                                    '🐂 Global Bullion Syndicate is online.'
                            }
                        );

                        console.log(
                            '[MESSAGE] Replied to a private ping test.'
                        );

                    } catch (error) {
                        console.error(
                            '[MESSAGE ERROR]',
                            error.message
                        );
                    }
                }
            }
        );

    } catch (error) {
        console.error(
            '[STARTUP ERROR]',
            error.stack ||
            error.message ||
            error
        );

        scheduleReconnect(
            error?.message || 'Startup failed'
        );

    } finally {
        connecting = false;
    }
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `\n[SHUTDOWN] Received ${signal}.`
    );

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (activeSocket) {
        try {
            activeSocket.end(
                new Error(`Process shutdown: ${signal}`)
            );

            activeSocket = null;

        } catch (error) {
            console.error(
                '[SHUTDOWN ERROR]',
                error.message
            );
        }
    }

    // Allow a brief moment for shutdown operations.
    setTimeout(() => {
        process.exit(0);
    }, 500).unref();
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

// ============================================
// RUN APPLICATION
// ============================================

console.log(
    'Starting Global Bullion Syndicate...'
);

console.log(
    'WhatsApp library: Baileys'
);

console.log(
    'Browser requirement: No Chrome installation'
);

console.log(
    'Authentication: Phone-number pairing'
);

console.log(
    'Authentication directory:',
    AUTH_DIR
);

void connectToWhatsApp();
