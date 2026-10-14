'use strict';

require('dotenv').config();

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const {
    startTelegramListener,
    stopTelegramListener,
    getTelegramStatus
} = require('./telegram');

// ======================================================
// CONFIGURATION
// ======================================================

const PHONE_NUMBER = (
    process.env.WHATSAPP_PHONE_NUMBER || ''
).replace(/\D/g, '');

const AUTH_DIR = path.resolve(
    process.env.BAILEYS_AUTH_DIR || './baileys_auth'
);

const TARGET_GROUP = (
    process.env.WHATSAPP_TARGET_GROUP ||
    'Global_Bullion_Syndicate'
).trim();

const PORT = Number(process.env.PORT || 10000);

const INITIAL_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

const MAX_PENDING_FORWARDS = 1000;
const MAX_REMEMBERED_FORWARDS = 10000;

const FORWARD_RETRY_INTERVAL_MS = 10000;
const GROUP_LOOKUP_CACHE_MS = 30000;

// ======================================================
// APPLICATION STATE
// ======================================================

let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

let connecting = false;
let shuttingDown = false;

let whatsappStatus = 'starting';
let lastConnectedAt = null;

let server = null;
let pairingCodeRequested = false;

let telegramStartPromise = null;
let telegramRetryTimer = null;

let flushTimer = null;
let flushInProgress = false;

let groupCacheSocket = null;
let groupCacheJid = null;
let groupCacheUntil = 0;

let lastMissingGroupLogAt = 0;

const pendingForwards = [];

const rememberedForwardKeys = new Set();
const rememberedForwardOrder = [];

// ======================================================
// LOGGING
// ======================================================

function log(message) {
    console.log(`[GBS] ${message}`);
}

// ======================================================
// HTTP RESPONSES
// ======================================================

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);

    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });

    res.end(body);
}

// ======================================================
// HEALTH AND STATUS SERVER
// ======================================================

function startHttpServer() {
    return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET');

                return sendJson(res, 405, {
                    error: 'Method not allowed'
                });
            }

            let pathname;

            try {
                pathname = new URL(
                    req.url || '/',
                    'http://localhost'
                ).pathname;
            } catch {
                return sendJson(res, 400, {
                    error: 'Invalid request'
                });
            }

            if (
                pathname === '/' ||
                pathname === '/health'
            ) {
                const ready =
                    !shuttingDown &&
                    whatsappStatus === 'connected' &&
                    getTelegramStatus() === 'connected';

                return sendJson(res, ready ? 200 : 503, {
                    service: 'Global Bullion Syndicate',
                    status: shuttingDown
                        ? 'stopping'
                        : 'running',
                    whatsapp: whatsappStatus,
                    telegram: getTelegramStatus(),
                    uptime_seconds: Math.floor(
                        process.uptime()
                    )
                });
            }

            if (pathname === '/status') {
                return sendJson(res, 200, {
                    service: 'Global Bullion Syndicate',
                    status: shuttingDown
                        ? 'stopping'
                        : 'running',
                    whatsapp: whatsappStatus,
                    telegram: getTelegramStatus(),
                    whatsapp_target_group: TARGET_GROUP,
                    pending_telegram_messages:
                        pendingForwards.length,
                    last_connected_at: lastConnectedAt,
                    uptime_seconds: Math.floor(
                        process.uptime()
                    )
                });
            }

            return sendJson(res, 404, {
                error: 'Not found'
            });
        });

        server.once('error', reject);

        server.listen(PORT, '0.0.0.0', () => {
            server.removeListener('error', reject);

            log(`HTTP server listening on port ${PORT}`);

            resolve();
        });
    });
}

// ======================================================
// WHATSAPP GROUP LOOKUP
// ======================================================

function getDisconnectStatusCode(error) {
    return (
        error?.output?.statusCode ??
        error?.statusCode ??
        null
    );
}

function normaliseGroupName(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

async function resolveTargetGroup(sock) {
    // Allow an exact WhatsApp group JID if supplied.
    if (TARGET_GROUP.endsWith('@g.us')) {
        return TARGET_GROUP;
    }

    const now = Date.now();

    if (
        groupCacheSocket === sock &&
        now < groupCacheUntil
    ) {
        return groupCacheJid;
    }

    const wanted = normaliseGroupName(TARGET_GROUP);

    if (!wanted) {
        throw new Error(
            'WHATSAPP_TARGET_GROUP is empty.'
        );
    }

    const groups = await sock.groupFetchAllParticipating();

    const matches = Object.entries(groups || {})
        .filter(([, metadata]) => {
            return (
                normaliseGroupName(metadata?.subject) ===
                wanted
            );
        });

    groupCacheSocket = sock;
    groupCacheUntil = now + GROUP_LOOKUP_CACHE_MS;

    if (matches.length === 1) {
        groupCacheJid = matches[0][0];

        log(
            'WhatsApp destination group found: ' +
            `${matches[0][1]?.subject || TARGET_GROUP}`
        );

        return groupCacheJid;
    }

    groupCacheJid = null;

    if (
        Date.now() - lastMissingGroupLogAt > 60000
    ) {
        lastMissingGroupLogAt = Date.now();

        if (matches.length > 1) {
            log(
                `More than one WhatsApp group matches ` +
                `'${TARGET_GROUP}'. Set ` +
                'WHATSAPP_TARGET_GROUP to the exact group JID.'
            );
        } else {
            log(
                `WhatsApp group '${TARGET_GROUP}' was not found. ` +
                'Confirm the linked account is a member and ' +
                'the group title matches.'
            );
        }
    }

    return null;
}

// ======================================================
// DUPLICATE MESSAGE PROTECTION
// ======================================================

function rememberForwardKey(key) {
    if (rememberedForwardKeys.has(key)) {
        return false;
    }

    rememberedForwardKeys.add(key);
    rememberedForwardOrder.push(key);

    while (
        rememberedForwardOrder.length >
        MAX_REMEMBERED_FORWARDS
    ) {
        const oldKey = rememberedForwardOrder.shift();

        if (oldKey !== undefined) {
            rememberedForwardKeys.delete(oldKey);
        }
    }

    return true;
}

// ======================================================
// TELEGRAM MESSAGE QUEUE
// ======================================================

function enqueueTelegramMessage(message) {
    if (shuttingDown) {
        return;
    }

    const text =
        typeof message?.text === 'string'
            ? message.text
            : '';

    if (!text.trim()) {
        return;
    }

    const sourceChatId = String(
        message.sourceChatId || 'telegram-source'
    );

    const sourceMessageId = String(
        message.sourceMessageId || 'unknown'
    );

    const key = `${sourceChatId}:${sourceMessageId}`;

    if (rememberedForwardKeys.has(key)) {
        return;
    }

    if (
        pendingForwards.length >= MAX_PENDING_FORWARDS
    ) {
        log(
            'Forward queue is full. Message was not queued: ' +
            sourceMessageId
        );

        return;
    }

    rememberForwardKey(key);

    pendingForwards.push({
        key,
        sourceMessageId,
        text
    });

    log(
        `Queued Telegram message ${sourceMessageId} ` +
        'for WhatsApp delivery.'
    );

    void flushForwardQueue();
}

// ======================================================
// FORWARD MESSAGES TO WHATSAPP
// ======================================================

async function flushForwardQueue() {
    if (
        flushInProgress ||
        shuttingDown ||
        whatsappStatus !== 'connected' ||
        !activeSocket ||
        pendingForwards.length === 0
    ) {
        return;
    }

    flushInProgress = true;

    const sock = activeSocket;

    try {
        const groupJid = await resolveTargetGroup(sock);

        if (!groupJid) {
            return;
        }

        while (
            pendingForwards.length > 0 &&
            sock === activeSocket &&
            whatsappStatus === 'connected' &&
            !shuttingDown
        ) {
            const item = pendingForwards[0];

            try {
                // Forward the original text only.
                // No source label, author name, or introduction.
                await sock.sendMessage(groupJid, {
                    text: item.text
                });

                pendingForwards.shift();

                log(
                    `Delivered Telegram message ` +
                    `${item.sourceMessageId} to WhatsApp.`
                );
            } catch (error) {
                log(
                    `WhatsApp delivery failed for Telegram ` +
                    `message ${item.sourceMessageId}: ` +
                    `${error.message}`
                );

                // Leave the message in the queue for retry.
                break;
            }
        }
    } catch (error) {
        log(
            'Could not prepare Telegram-to-WhatsApp delivery: ' +
            error.message
        );
    } finally {
        flushInProgress = false;
    }
}

// ======================================================
// WHATSAPP RECONNECTION
// ======================================================

function scheduleReconnect(reason) {
    if (shuttingDown || reconnectTimer) {
        return;
    }

    reconnectAttempts += 1;

    const exponent = Math.min(
        reconnectAttempts - 1,
        4
    );

    const delay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * (2 ** exponent),
        MAX_RECONNECT_DELAY_MS
    );

    whatsappStatus = 'reconnecting';

    log(
        `${reason || 'Connection closed'}. ` +
        `Retrying in ${Math.ceil(delay / 1000)} seconds.`
    );

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        void connectToWhatsApp();
    }, delay);
}

// ======================================================
// TELEGRAM STARTUP AND RETRIES
// ======================================================

function scheduleTelegramRetry() {
    if (shuttingDown || telegramRetryTimer) {
        return;
    }

    telegramRetryTimer = setTimeout(() => {
        telegramRetryTimer = null;

        void ensureTelegramListener();
    }, 30000);

    if (
        typeof telegramRetryTimer.unref === 'function'
    ) {
        telegramRetryTimer.unref();
    }
}

async function ensureTelegramListener() {
    if (
        shuttingDown ||
        telegramStartPromise ||
        getTelegramStatus() === 'connected'
    ) {
        return;
    }

    telegramStartPromise = (async () => {
        try {
            await startTelegramListener({
                onMessage: enqueueTelegramMessage
            });

            log(
                'Telegram listener is ready for ' +
                '@traderparadisefp.'
            );

            void flushForwardQueue();
        } catch (error) {
            log(
                `Telegram startup failed: ${error.message}`
            );

            scheduleTelegramRetry();
        }
    })();

    try {
        await telegramStartPromise;
    } finally {
        telegramStartPromise = null;
    }
}

// ======================================================
// CONNECT TO WHATSAPP
// ======================================================

async function connectToWhatsApp() {
    if (
        shuttingDown ||
        connecting ||
        activeSocket
    ) {
        return;
    }

    if (!/^\d{8,15}$/.test(PHONE_NUMBER)) {
        whatsappStatus = 'configuration_error';

        log(
            'WHATSAPP_PHONE_NUMBER is missing or invalid. ' +
            'Set it in Render Environment Variables using ' +
            'country code and digits only.'
        );

        return;
    }

    connecting = true;
    whatsappStatus = 'connecting';

    let sock = null;

    try {
        fs.mkdirSync(AUTH_DIR, {
            recursive: true
        });

        fs.accessSync(
            AUTH_DIR,
            fs.constants.R_OK | fs.constants.W_OK
        );

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(AUTH_DIR);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000
        });

        activeSocket = sock;

        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (error) {
                log(
                    `Authentication save failed: ${error.message}`
                );
            }
        });

        sock.ev.on(
            'connection.update',
            async (update) => {
                const {
                    connection,
                    lastDisconnect
                } = update;

                if (
                    !state.creds.registered &&
                    !pairingCodeRequested &&
                    connection === 'connecting'
                ) {
                    pairingCodeRequested = true;

                    setTimeout(async () => {
                        if (
                            shuttingDown ||
                            sock !== activeSocket ||
                            state.creds.registered
                        ) {
                            return;
                        }

                        try {
                            const code =
                                await sock.requestPairingCode(
                                    PHONE_NUMBER
                                );

                            log(
                                'WhatsApp pairing is required.'
                            );

                            log(`Pairing code: ${code}`);

                            log(
                                'Enter the code in WhatsApp > ' +
                                'Linked Devices > Link a Device > ' +
                                'Link with phone number instead.'
                            );

                            log(
                                'Keep the pairing code private.'
                            );
                        } catch (error) {
                            pairingCodeRequested = false;

                            log(
                                `Pairing code request failed: ` +
                                error.message
                            );
                        }
                    }, 3000);
                }

                if (connection === 'connecting') {
                    whatsappStatus = 'connecting';

                    log('Connecting to WhatsApp.');
                }

                if (connection === 'open') {
                    reconnectAttempts = 0;
                    pairingCodeRequested = false;

                    whatsappStatus = 'connected';

                    lastConnectedAt =
                        new Date().toISOString();

                    groupCacheSocket = null;
                    groupCacheJid = null;
                    groupCacheUntil = 0;

                    log(
                        'WhatsApp connected successfully.'
                    );

                    log(
                        'Authentication files are being saved locally.'
                    );

                    void ensureTelegramListener();
                    void flushForwardQueue();
                }

                if (connection === 'close') {
                    if (sock !== activeSocket) {
                        return;
                    }

                    activeSocket = null;

                    groupCacheSocket = null;
                    groupCacheJid = null;
                    groupCacheUntil = 0;

                    const error = lastDisconnect?.error;

                    const statusCode =
                        getDisconnectStatusCode(error);

                    log(
                        `WhatsApp disconnected: ` +
                        `${error?.message || 'Connection closed'}`
                    );

                    if (
                        statusCode === DisconnectReason.loggedOut
                    ) {
                        whatsappStatus = 'logged_out';

                        log(
                            'WhatsApp logged out this linked device. ' +
                            'Re-link it in WhatsApp before continuing.'
                        );

                        return;
                    }

                    scheduleReconnect(
                        error?.message || 'Connection closed'
                    );
                }
            }
        );

        // Basic private-message ping test.
        // This does not forward incoming WhatsApp messages.
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

                        log('Private ping test answered.');
                    } catch (error) {
                        log(
                            `Message send failed: ${error.message}`
                        );
                    }
                }
            }
        );
    } catch (error) {
        if (sock && sock === activeSocket) {
            activeSocket = null;

            try {
                sock.end(error);
            } catch {}
        }

        whatsappStatus = 'error';

        log(
            `WhatsApp startup failed: ${error.message}`
        );

        scheduleReconnect(
            'WhatsApp startup failed'
        );
    } finally {
        connecting = false;
    }
}

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    whatsappStatus = 'stopping';

    log(`Shutdown requested: ${signal}`);

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    if (telegramRetryTimer) {
        clearTimeout(telegramRetryTimer);
    }

    if (flushTimer) {
        clearInterval(flushTimer);
    }

    reconnectTimer = null;
    telegramRetryTimer = null;
    flushTimer = null;

    try {
        await stopTelegramListener();
    } catch (error) {
        log(
            `Telegram shutdown issue: ${error.message}`
        );
    }

    if (activeSocket) {
        try {
            activeSocket.end(
                new Error(`Process shutdown: ${signal}`)
            );
        } catch (error) {
            log(
                `WhatsApp socket shutdown issue: ${error.message}`
            );
        }

        activeSocket = null;
    }

    if (server?.listening) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    process.exit(0);
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

// ======================================================
// APPLICATION ENTRY POINT
// ======================================================

async function main() {
    await startHttpServer();

    log('Global Bullion Syndicate bridge started.');
    log('Health endpoint: /health');
    log('Status endpoint: /status');

    log(
        `WhatsApp destination group: ${TARGET_GROUP}`
    );

    flushTimer = setInterval(() => {
        void flushForwardQueue();
    }, FORWARD_RETRY_INTERVAL_MS);

    if (typeof flushTimer.unref === 'function') {
        flushTimer.unref();
    }

    await connectToWhatsApp();
}

main().catch((error) => {
    log(
        `Application startup failed: ${error.message}`
    );

    process.exitCode = 1;
});
