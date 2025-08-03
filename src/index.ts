import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Redis from 'ioredis';
import cors from 'cors';
import { z } from 'zod';
import {getRedisClient} from "./redis";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
    }
});

if (!process.env.REDIS_URL) {
    throw new Error('Redis URL is missing');
}

const redisSubscriber = new Redis(process.env.REDIS_URL);
const redisPublisher = new Redis(process.env.REDIS_URL);

interface UserPresence {
    userId: string;
    name: string;
    avatar?: string;
    boardId: string;
    lastSeen: Date;
}

const userPresence = new Map<string, UserPresence>();
const boardUsers = new Map<string, Set<string>>();

const JoinBoardSchema = z.object({
    boardId: z.string(),
});

io.use(async (socket, next) => {
    try {
        let token = socket.handshake.auth.token || socket.handshake.query.token;

        console.log(token);

        if (!token) {
            return next(new Error("Unauthorized: No session token"));
        }

        const redis = await getRedisClient();
        const sessionRaw = await redis.get(token);

        if (!sessionRaw) {
            return next(new Error("Unauthorized: Invalid session"));
        }

        const session = JSON.parse(sessionRaw);
        const userId = session?.user?.id;
        if (!userId) {
            return next(new Error("Unauthorized: Malformed session"));
        }

        socket.data.user = session.user;

        next();
    }
    catch (err) {
        console.error("Auth error:", err);
        next(new Error("Authentication failed"));
    }
});

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('join-dashboard', () => {
        try {
            const userId = socket.data.user.id;
            socket.join(`dashboard:${userId}`);
            console.log(`User ${userId} joined dashboard`);
        }
        catch (error) {
            console.error('Error joining dashboard:', error);
        }
    });

    socket.on('join-board', (data: unknown) => {
        try {
            const { boardId } = JoinBoardSchema.parse(data);

            socket.join(`board:${boardId}`);

            const presence: UserPresence = {
                userId: socket.data.user.id,
                name: socket.data.user.name,
                avatar: socket.data.user.image,
                boardId,
                lastSeen: new Date()
            };

            userPresence.set(socket.id, presence);

            if (!boardUsers.has(boardId)) {
                boardUsers.set(boardId, new Set());
            }
            boardUsers.get(boardId)!.add(socket.id);

            broadcastPresence(boardId);

            console.log(`User ${socket.data.user.name} joined board ${boardId}`);
        }
        catch (error) {
            console.error('Error joining board:', error);
            socket.emit('error', { message: 'Invalid join-board data' });
        }
    });

    socket.on('leave-board', (data: { boardId: string }) => {
        try {
            const { boardId } = data;
            socket.leave(`board:${boardId}`);

            const presence = userPresence.get(socket.id);
            if (presence && presence.boardId === boardId) {
                userPresence.delete(socket.id);
                boardUsers.get(boardId)?.delete(socket.id);

                broadcastPresence(boardId);
            }

            console.log(`Socket ${socket.id} left board ${boardId}`);
        }
        catch (error) {
            console.error('Error leaving board:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);

        const presence = userPresence.get(socket.id);
        if (presence) {
            userPresence.delete(socket.id);
            boardUsers.get(presence.boardId)?.delete(socket.id);
            broadcastPresence(presence.boardId);
        }
    });

    socket.on('heartbeat', () => {
        const presence = userPresence.get(socket.id);
        if (presence) {
            presence.lastSeen = new Date();
            userPresence.set(socket.id, presence);
        }
    });
});


function broadcastPresence(boardId: string) {
    const boardSocketIds = boardUsers.get(boardId);
    if (!boardSocketIds) return;

    const activeUsers = Array.from(boardSocketIds)
        .map(socketId => userPresence.get(socketId))
        .filter(Boolean)
        .map(presence => ({
            userId: presence!.userId,
            name: presence!.name,
            avatar: presence!.avatar,
            lastSeen: presence!.lastSeen
        }));

    io.to(`board:${boardId}`).emit('presence-update', { users: activeUsers });
}

async function setupRedisSubscriptions() {
    await redisSubscriber.psubscribe('board:update:*');
    await redisSubscriber.psubscribe('users:update:*');
    await redisSubscriber.psubscribe('boards:update:*');

    redisSubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
        console.log(`Redis message - Pattern: ${pattern}, Channel: ${channel}, Message: ${message}`);

        try {
            if (pattern === 'board:update:*') {
                const boardId = channel.split(':')[2];

                io.to(`board:${boardId}`).emit('invalidate-query', {
                    queryKey: ['board', boardId],
                    type: 'board-update'
                });

                console.log(`Sent board update to board:${boardId}`);
            }

            if (pattern === 'users:update:*') {
                const boardId = channel.split(':')[2];

                io.to(`board:${boardId}`).emit('invalidate-query', {
                    queryKey: ['board-users', boardId],
                    type: 'board-users-update'
                });

                console.log(`Sent board users update to board:${boardId}`);
            }

            if (pattern === 'boards:update:*') {
                const userId = channel.split(':')[2];

                io.to(`dashboard:${userId}`).emit('invalidate-query', {
                    queryKey: ['all-boards'],
                    type: 'all-boards-update'
                });

                console.log(`Sent all boards update to dashboard:${userId}`);
            }
        }
        catch (error) {
            console.error('Error processing Redis message:', error);
        }
    });
}

app.use(cors());

const PORT = process.env.WEBSOCKET_PORT || 3001;

async function startServer() {
    try {
        await setupRedisSubscriptions();
        console.log('Redis subscriptions set up successfully');

        httpServer.listen(PORT, () => {
            console.log(`Socket.IO server running on port ${PORT}`);
        });
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    httpServer.close(() => {
        redisSubscriber.disconnect();
        redisPublisher.disconnect();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    httpServer.close(() => {
        redisSubscriber.disconnect();
        redisPublisher.disconnect();
        process.exit(0);
    });
});

startServer();