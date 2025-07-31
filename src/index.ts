import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createClient, RedisClientType } from 'redis';
import cors from 'cors';
import type { IncomingMessage } from 'http';

type ClientMessage =
    | {
    type: 'identify';
    userId: string;
}
    | {
    type: 'subscribe' | 'unsubscribe';
    channel: string;
};

type ServerMessage =
    | { type: 'connected'; connectionId: string }
    | { type: 'error'; message: string }
    | { type: 'subscribed' | 'unsubscribed'; channel: string }
    | {
    type: 'message';
    channel: string;
    message: string;
    timestamp: string;
};

interface Connection {
    ws: WebSocket;
    subscriptions: Set<string>;
    userId: string | null;
}

const app = express();
const server = createServer(app);

app.use(
    cors({
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true,
    })
);

const wss = new WebSocketServer({
    server,
    path: '/',
});

const subscriber: RedisClientType = createClient({ url: process.env.REDIS_URL });
const publisher: RedisClientType = createClient({ url: process.env.REDIS_URL });

const connections = new Map<string, Connection>();
const channelSubscriptions = new Map<string, Set<string>>();

async function initializeRedis(): Promise<void> {
    try {
        await subscriber.connect();
        await publisher.connect();
        console.log('Connected to Redis');
    }
    catch (error) {
        console.error('Failed to connect to Redis:', error);
        process.exit(1);
    }
}

wss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    try {
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        const sessionToken = url.searchParams.get('token');

        if (!sessionToken) {
            ws.close(4401, 'Unauthorized: No session token');
            return;
        }

        const sessionRaw = await publisher.get(sessionToken);
        if (!sessionRaw) {
            ws.close(4402, 'Unauthorized: Invalid session');
            return;
        }

        const session = JSON.parse(sessionRaw);
        const userId = session?.user?.id;
        if (!userId) {
            ws.close(4403, 'Unauthorized: Malformed session');
            return;
        }

        const connectionId = generateConnectionId();

        console.log(`User authenticated: ${userId} (conn: ${connectionId})`);

        connections.set(connectionId, {
            ws,
            subscriptions: new Set(),
            userId,
        });

        ws.on('message', async (data: RawData) => {
            try {
                const message = JSON.parse(data.toString()) as ClientMessage;
                await handleClientMessage(connectionId, message);
            }
            catch (error) {
                console.error('Message parse error:', error);
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Invalid message format',
                    } satisfies ServerMessage)
                );
            }
        });

        ws.on('close', () => {
            console.log(`WebSocket disconnected: ${connectionId}`);
            handleConnectionClose(connectionId);
        });

        ws.on('error', (error) => {
            console.error(`WebSocket error for ${connectionId}:`, error);
            handleConnectionClose(connectionId);
        });

        ws.send(
            JSON.stringify({
                type: 'connected',
                connectionId,
            } satisfies ServerMessage)
        );
    }
    catch (err) {
        console.error('Authentication error:', err);
        ws.close(4400, 'Unauthorized');
    }
});

async function handleClientMessage(connectionId: string, message: ClientMessage): Promise<void> {
    const connection = connections.get(connectionId);
    if (!connection) return;

    switch (message.type) {
        case 'identify':
            connection.userId = message.userId;
            console.log(`Connection ${connectionId} identified as user ${message.userId}`);
            break;

        case 'subscribe':
            if (!message.channel) {
                connection.ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Channel is required for subscription',
                    } satisfies ServerMessage)
                );
                return;
            }
            await subscribeToChannel(connectionId, message.channel);
            connection.ws.send(
                JSON.stringify({
                    type: 'subscribed',
                    channel: message.channel,
                } satisfies ServerMessage)
            );
            break;

        case 'unsubscribe':
            if (!message.channel) {
                connection.ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'Channel is required for unsubscription',
                    } satisfies ServerMessage)
                );
                return;
            }
            await unsubscribeFromChannel(connectionId, message.channel);
            connection.ws.send(
                JSON.stringify({
                    type: 'unsubscribed',
                    channel: message.channel,
                } satisfies ServerMessage)
            );
            break;

        default:
            connection.ws.send(
                JSON.stringify({
                    type: 'error',
                    message: `Unknown message type: ${(message as any).type}`,
                } satisfies ServerMessage)
            );
    }
}

async function subscribeToChannel(connectionId: string, channel: string): Promise<void> {
    const connection = connections.get(connectionId);
    if (!connection) return;

    connection.subscriptions.add(channel);

    if (!channelSubscriptions.has(channel)) {
        channelSubscriptions.set(channel, new Set());
        await subscriber.subscribe(channel, (message) => {
            handleRedisMessage(channel, message);
        });
        console.log(`Subscribed to Redis channel: ${channel}`);
    }

    channelSubscriptions.get(channel)!.add(connectionId);
    console.log(`Connection ${connectionId} subscribed to ${channel}`);
}

async function unsubscribeFromChannel(connectionId: string, channel: string): Promise<void> {
    const connection = connections.get(connectionId);
    if (!connection) return;

    connection.subscriptions.delete(channel);

    const channelConnections = channelSubscriptions.get(channel);
    if (channelConnections) {
        channelConnections.delete(connectionId);

        if (channelConnections.size === 0) {
            channelSubscriptions.delete(channel);
            await subscriber.unsubscribe(channel);
            console.log(`Unsubscribed from Redis channel: ${channel}`);
        }
    }

    console.log(`Connection ${connectionId} unsubscribed from ${channel}`);
}

function handleRedisMessage(channel: string, message: string): void {
    console.log(`Redis message on ${channel}:`, message);

    const channelConnections = channelSubscriptions.get(channel);
    if (!channelConnections) return;

    const payload: ServerMessage = {
        type: 'message',
        channel,
        message,
        timestamp: new Date().toISOString(),
    };

    channelConnections.forEach((connectionId) => {
        const connection = connections.get(connectionId);
        if (connection && connection.ws.readyState === WebSocket.OPEN) {
            try {
                connection.ws.send(JSON.stringify(payload));
            }
            catch (error) {
                console.error(`Error sending message to ${connectionId}:`, error);
                handleConnectionClose(connectionId);
            }
        }
    });
}

function handleConnectionClose(connectionId: string): void {
    const connection = connections.get(connectionId);
    if (!connection) return;

    connection.subscriptions.forEach((channel) => {
        const channelConnections = channelSubscriptions.get(channel);
        if (channelConnections) {
            channelConnections.delete(connectionId);

            if (channelConnections.size === 0) {
                channelSubscriptions.delete(channel);
                subscriber.unsubscribe(channel).catch(console.error);
            }
        }
    });

    connections.delete(connectionId);
    console.log(`Cleaned up connection: ${connectionId}`);
}

function generateConnectionId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function shutdown(): Promise<void> {
    console.log('Shutting down gracefully...');

    connections.forEach((connection) => {
        connection.ws.close();
    });

    await subscriber.quit();
    await publisher.quit();

    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 8080;

async function startServer(): Promise<void> {
    try {
        await initializeRedis();

        server.listen(PORT, () => {
            console.log(`WebSocket server running on port ${PORT}`);
        });
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();