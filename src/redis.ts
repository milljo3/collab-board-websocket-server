import Redis from "ioredis";

let redis: Redis | null = null;

export async function getRedisClient() {
    if (!process.env.REDIS_URL) {
        throw new Error('Redis URL is missing');
    }

    if (!redis) {
        redis = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
        });

        redis.on("error", (err) => {
            console.error("Redis connection error:", err);
        });

        redis.on("connect", () => {
            console.log("Connected to Redis");
        });
    }

    return redis;
}
