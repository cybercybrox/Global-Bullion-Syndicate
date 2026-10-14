'use strict';

// ======================================================
// GLOBAL BULLION SYNDICATE
// TELEGRAM CHANNEL LISTENER
// ======================================================

let telegramClient = null;
let messageHandler = null;
let messageEventBuilder = null;

let startupPromise = null;
let telegramStatus = 'not_started';

let onIncomingMessage = null;

const MAX_SEEN_MESSAGES = 10000;

const seenMessageKeys = new Set();
const seenMessageOrder = [];

// ======================================================
// LOGGING
// ======================================================

function log(message) {
    console.log(`[Telegram] ${message}`);
}

// ======================================================
// ENVIRONMENT VALIDATION
// ======================================================

function validateConfig() {
    const apiId = Number.parseInt(
        process.env.API_ID || '',
        10
    );

    const apiHash = (
        process.env.API_HASH || ''
    ).trim();

    const sessionString = (
        process.env.SESSION_STRING || ''
    ).trim();

    const source = (
        process.env.TELEGRAM_CHANNEL ||
        '@traderparadisefp'
    ).trim();

    if (
        !Number.isSafeInteger(apiId) ||
        apiId <= 0
    ) {
        throw new Error(
            'Render environment variable API_ID is missing or invalid.'
        );
    }

    if (!apiHash) {
        throw new Error(
            'Render environment variable API_HASH is missing.'
        );
    }

    if (!sessionString) {
        throw new Error(
            'Render environment variable SESSION_STRING is missing.'
        );
    }

    if (!source) {
        throw new Error(
            'TELEGRAM_CHANNEL cannot be empty.'
        );
    }

    return {
        apiId,
        apiHash,
        sessionString,
        source
    };
}

// ======================================================
// DUPLICATE MESSAGE PROTECTION
// ======================================================

function rememberMessage(key) {
    if (seenMessageKeys.has(key)) {
        return false;
    }

    seenMessageKeys.add(key);
    seenMessageOrder.push(key);

    while (
        seenMessageOrder.length > MAX_SEEN_MESSAGES
    ) {
        const oldest = seenMessageOrder.shift();

        if (oldest !== undefined) {
            seenMessageKeys.delete(oldest);
        }
    }

    return true;
}

// ======================================================
// START TELEGRAM LISTENER
// ======================================================

async function startTelegramListener(options = {}) {
    if (typeof options.onMessage !== 'function') {
        throw new TypeError(
            'startTelegramListener requires an onMessage callback.'
        );
    }

    onIncomingMessage = options.onMessage;

    if (telegramClient && messageHandler) {
        return;
    }

    if (startupPromise) {
        return startupPromise;
    }

    startupPromise = (async () => {
        telegramStatus = 'connecting';

        let candidate = null;

        try {
            const {
                apiId,
                apiHash,
                sessionString,
                source
            } = validateConfig();

            // Load GramJS without changing the existing
            // CommonJS configuration of the project.
            const [
                telegramModule,
                sessionsModule,
                eventsModule
            ] = await Promise.all([
                import('telegram'),
                import('telegram/sessions/index.js'),
                import('telegram/events/index.js')
            ]);

            const TelegramClient =
                telegramModule.TelegramClient;

            const StringSession =
                sessionsModule.StringSession;

            const NewMessage =
                eventsModule.NewMessage;

            if (
                !TelegramClient ||
                !StringSession ||
                !NewMessage
            ) {
                throw new Error(
                    'Could not load the required Telegram modules.'
                );
            }

            candidate = new TelegramClient(
                new StringSession(sessionString),
                apiId,
                apiHash,
                {
                    connectionRetries: 5,
                    autoReconnect: true
                }
            );

            // Connect using the existing authorised session.
            await candidate.connect();

            const me = await candidate.getMe();

            // Resolve the requested public channel or group.
            const sourceEntity =
                await candidate.getEntity(source);

            const handler = async (event) => {
                try {
                    const message = event?.message;

                    if (
                        !message ||
                        message.id === undefined ||
                        message.id === null
                    ) {
                        return;
                    }

                    // Telegram uses this field for ordinary
                    // text and media captions.
                    const text =
                        typeof message.message === 'string'
                            ? message.message
                            : (
                                typeof message.text === 'string'
                                    ? message.text
                                    : ''
                            );

                    // Skip media-only posts.
                    if (!text.trim()) {
                        return;
                    }

                    const messageId = String(message.id);

                    const chatId = String(
                        event.chatId ?? source
                    );

                    const key =
                        `${chatId}:${messageId}`;

                    if (!rememberMessage(key)) {
                        return;
                    }

                    if (
                        typeof onIncomingMessage !== 'function'
                    ) {
                        log(
                            'Message received but no forwarding callback is available.'
                        );

                        return;
                    }

                    // Pass only the original message body
                    // and internal identifiers to WhatsApp.
                    await onIncomingMessage({
                        sourceChatId: chatId,
                        sourceMessageId: messageId,
                        text
                    });
                } catch (error) {
                    log(
                        `Message handler failed: ${error.message}`
                    );
                }
            };

            // Listen only to new incoming messages from
            // the configured Telegram channel or group.
            const eventBuilder = new NewMessage({
                chats: [sourceEntity],
                incoming: true
            });

            candidate.addEventHandler(
                handler,
                eventBuilder
            );

            telegramClient = candidate;
            messageHandler = handler;
            messageEventBuilder = eventBuilder;

            telegramStatus = 'connected';

            const accountName = [
                me.firstName,
                me.lastName
            ]
                .filter(Boolean)
                .join(' ') || 'Telegram account';

            log(
                `Authenticated as ${accountName}.`
            );

            log(
                `Listening for new text posts and captions from ${source}.`
            );
        } catch (error) {
            telegramStatus = 'error';

            if (candidate) {
                try {
                    await candidate.disconnect();
                } catch {}
            }

            throw error;
        }
    })();

    try {
        await startupPromise;
    } finally {
        startupPromise = null;
    }
}

// ======================================================
// STOP TELEGRAM LISTENER
// ======================================================

async function stopTelegramListener() {
    const client = telegramClient;
    const handler = messageHandler;
    const eventBuilder = messageEventBuilder;

    telegramClient = null;
    messageHandler = null;
    messageEventBuilder = null;
    onIncomingMessage = null;

    if (!client) {
        telegramStatus = 'stopped';
        return;
    }

    try {
        if (handler && eventBuilder) {
            client.removeEventHandler(
                handler,
                eventBuilder
            );
        }

        await client.disconnect();
    } finally {
        telegramStatus = 'stopped';

        log('Disconnected.');
    }
}

// ======================================================
// STATUS
// ======================================================

function getTelegramStatus() {
    return telegramStatus;
}

// ======================================================
// EXPORTS FOR WHATSAPP.JS
// ======================================================

module.exports = {
    startTelegramListener,
    stopTelegramListener,
    getTelegramStatus
};
