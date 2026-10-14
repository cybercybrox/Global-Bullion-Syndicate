'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const PHONE_NUMBER = (
    process.env.WHATSAPP_PHONE_NUMBER || ''
).replace(/\D/g, '');

const AUTH_DIR = path.resolve(
    process.env.BAILEYS_AUTH_DIR || './baileys_auth'
);

const PORT = Number(process.env.PORT || 10000);

const INITIAL_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connecting = false;
let shuttingDown = false;
let whatsappStatus = 'starting';
let lastConnectedAt = null;
let server = null;
let pairingCodeRequested = false;

function log(message) {
    console.log(`[GBS] ${message}`);
}

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

            if (pathname === '/' || pathname === '/health') {
                return sendJson(res, 200, {
                    service: 'Global Bullion Syndicate',
                    status: shuttingDown ? 'stopping' : 'running',
                    uptime_seconds: Math.floor(process.uptime())
                });
            }

            if (pathname === '/status') {
                return sendJson(res, 200, {
                    service: 'Global Bullion Syndicate',
                    status: shuttingDown ? 'stopping' : 'running',
                    whatsapp: whatsappStatus,
                    last_connected_at: lastConnectedAt,
                    uptime_seconds: Math.floor(process.uptime())
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
            'Set it in Render Environment Variables.'
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

                            log('WhatsApp pairing is required.');
                            log(`Pairing code: ${code}`);
                            log(
                                'Enter the code in WhatsApp > Linked Devices > ' +
                                'Link a Device > Link with phone number instead.'
                            );
                            log('Keep the pairing code private.');
                        } catch (error) {
                            pairingCodeRequested = false;

                            log(
                                `Pairing code request failed: ${error.message}`
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

                    lastConnectedAt = new Date().toISOString();

                    log('WhatsApp connected successfully.');
                    log('Authentication files are being saved locally.');
                }

                if (connection === 'close') {
                    if (sock !== activeSocket) {
                        return;
                    }

                    activeSocket = null;

                    const error = lastDisconnect?.error;
                    const statusCode =
                        getDisconnectStatusCode(error);

                    log(
                        `WhatsApp disconnected: ${
                            error?.message || 'Connection closed'
                        }`
                    );

                    if (
                        statusCode === DisconnectReason.loggedOut
                    ) {
                        whatsappStatus = 'logged_out';

                        log(
                            'WhatsApp logged out this linked device. ' +
                            'Review the saved session before pairing again.'
                        );

                        return;
                    }

                    scheduleReconnect(
                        error?.message || 'Connection closed'
                    );
                }
            }
        );

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

        log(`WhatsApp startup failed: ${error.message}`);

        scheduleReconnect('WhatsApp startup failed');
    } finally {
        connecting = false;
    }
}

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    whatsappStatus = 'stopping';

    log(`Shutdown requested: ${signal}`);

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (activeSocket) {
        try {
            activeSocket.end(
                new Error(`Process shutdown: ${signal}`)
            );
        } catch (error) {
            log(`Socket shutdown issue: ${error.message}`);
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

async function main() {
    await startHttpServer();

    log('Global Bullion Syndicate started.');
    log('Health endpoint: /health');
    log('Status endpoint: /status');

    await connectToWhatsApp();
}

main().catch((error) => {
    log(`Application startup failed: ${error.message}`);
    process.exitCode = 1;
});
